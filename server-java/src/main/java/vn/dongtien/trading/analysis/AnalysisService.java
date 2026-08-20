package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import vn.dongtien.trading.analysis.IndicatorService.Indicators;
import vn.dongtien.trading.analysis.IndicatorService.Level;
import vn.dongtien.trading.analysis.IndicatorService.SupportResistance;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.market.Candle;
import vn.dongtien.trading.ml.FeatureService;
import vn.dongtien.trading.ml.GbdtPredictor;
import vn.dongtien.trading.model.ModelStore;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class AnalysisService {
    private static final int MIN_CANDLES = 30;
    private final BinanceClient binance;
    private final IndicatorService indicators;
    private final FeatureService features;
    private final GbdtPredictor predictor;
    private final ModelStore models;
    private final HistoricalPatternService historicalPatterns;

    public AnalysisService(BinanceClient binance, IndicatorService indicators, FeatureService features,
                           GbdtPredictor predictor, ModelStore models, HistoricalPatternService historicalPatterns) {
        this.binance = binance;
        this.indicators = indicators;
        this.features = features;
        this.predictor = predictor;
        this.models = models;
        this.historicalPatterns = historicalPatterns;
    }

    public Map<String, Object> analyze(String symbol, String interval, JsonNode strategy, int seriesBars) {
        int candleCount = integer(strategy.path("analysis"), "candles", 400);
        JsonNode historicalConfig = strategy.path("historicalPattern");
        int requested = candleCount;
        if (historicalConfig.path("enabled").asBoolean(true)) {
            long intervalMs = BinanceClient.INTERVAL_MS.getOrDefault(interval, 14_400_000L);
            int months = Math.max(1, Math.min(6, historicalConfig.path("maxMonths").asInt(6)));
            requested = Math.max(requested, (int) Math.ceil(months * 31d * 86_400_000d / intervalMs)
                    + historicalConfig.path("lookbackBars").asInt(24) + historicalConfig.path("futureBars").asInt(12));
        }
        List<Candle> raw = requested > 1000 ? binance.fetchKlinesHistory(symbol, interval, requested)
                : binance.fetchKlines(symbol, interval, requested);
        List<Candle> closed = raw.stream().filter(Candle::closed).toList();
        if (closed.size() < MIN_CANDLES) {
            throw new IllegalArgumentException("Chỉ có " + closed.size() + " nến đã đóng - cần tối thiểu " + MIN_CANDLES
                    + " nến cho khung " + interval + ". Thử khung nhỏ hơn.");
        }
        JsonNode indicatorConfig = strategy.path("indicators");
        Indicators ind = indicators.compute(closed, integer(indicatorConfig, "volumeAvg", 20),
                integer(indicatorConfig, "cvdSlope", 20));
        SupportResistance sr = indicators.supportResistance(closed, 3, 3, .6, 6);
        Candle current = closed.get(closed.size() - 1);
        JsonNode ticker = safely(() -> binance.fetchTicker24h(symbol));
        JsonNode derivatives = safely(() -> binance.fetchDerivatives(symbol));
        JsonNode orderBook = safely(() -> binance.fetchOrderBook(symbol, 1000));
        JsonNode positioning = safely(() -> binance.fetchPositioning(symbol, interval));
        Map<String, Object> historical = historicalPatterns.analyze(closed, historicalConfig);

        Score score = score(closed, ind, sr, derivatives, orderBook, positioning, historical, strategy);
        MlResult ml = predictModel(symbol, interval, closed, ind, strategy);
        double mlWeight = ml.available() && !"low".equals(ml.reliability())
                ? number(strategy.path("ml"), "weightVsRules", .4) : 0;
        double combined = ml.available() && mlWeight > 0
                ? score.value() * (1 - mlWeight) + ml.score() * mlWeight : score.value();
        Signal signal = signal(combined, strategy.path("thresholds"));
        Map<String, Object> levels = levels(current.close(), sr, signal, strategy.path("risk"));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("symbol", symbol);
        result.put("interval", interval);
        result.put("market", raw.isEmpty() ? "spot" : raw.get(0).market());
        result.put("generatedAt", Instant.now().toString());
        result.put("lastClosedCandleTime", Instant.ofEpochMilli(current.openTime()).toString());
        Map<String, Object> price = new LinkedHashMap<>();
        price.put("lastClose", current.close());
        price.put("live", raw.isEmpty() ? current.close() : raw.get(raw.size() - 1).close());
        price.put("change24hPercent", jsonNumber(ticker, "priceChangePercent"));
        price.put("high24h", jsonNumber(ticker, "highPrice"));
        price.put("low24h", jsonNumber(ticker, "lowPrice"));
        price.put("quoteVolume24h", jsonNumber(ticker, "quoteVolume"));
        result.put("price", price);
        result.put("indicatorParams", Map.of("volumeAvg", ind.volumePeriod(), "cvdSlope", ind.cvdPeriod()));
        int last = closed.size() - 1;
        Map<String, Object> indicatorValues = new LinkedHashMap<>();
        indicatorValues.put("volume", round(current.volume(), 2));
        indicatorValues.put("volumeAvg", round(ind.volumeAverage().get(last), 2));
        indicatorValues.put("volumeRatio", round(current.volume() / nonZero(ind.volumeAverage().get(last)), 2));
        indicatorValues.put("cvd", round(ind.cvd().get(last), 2));
        indicatorValues.put("cvdDelta", round(ind.cvdDelta().get(last), 2));
        indicatorValues.put("cvdDeltaShare", round(ind.cvdDelta().get(last) / nonZero(current.volume()), 4));
        indicatorValues.put("cvdSlope", round(ind.cvdSlope().get(last), 4));
        result.put("indicators", indicatorValues);
        result.put("historicalPattern", historical);
        result.put("entryQuality", entryQuality(signal, current, closed, ind, strategy.path("entryQuality")));
        result.put("structure", structure(sr, current.close()));
        result.put("derivatives", derivativeResult(derivatives));
        result.put("orderBook", orderBookResult(orderBook));
        result.put("positioning", positioningResult(positioning));
        result.put("rules", Map.of("score", round(score.value(), 1), "consensus", score.consensus(), "breakdown", score.breakdown()));
        result.put("ml", ml.output());
        result.put("combined", Map.of("score", round(combined, 1), "mlWeightUsed", mlWeight,
                "signal", signal.label(), "side", signal.side(), "strength", signal.strength()));
        result.put("levels", levels);
        result.put("higherTimeframe", null);
        result.put("conflicts", conflicts(signal, current, closed, ind));
        result.put("featureNames", FeatureService.NAMES);
        if (seriesBars > 0) result.put("series", series(closed, ind, seriesBars));
        return result;
    }

    private Score score(List<Candle> candles, Indicators ind, SupportResistance sr, JsonNode derivatives,
                        JsonNode orderBook, JsonNode positioning, Map<String, Object> historical, JsonNode strategy) {
        int i = candles.size() - 1;
        Candle candle = candles.get(i);
        JsonNode thresholds = strategy.path("thresholds");
        Map<String, Group> groups = new LinkedHashMap<>();
        int lookback = Math.min(50, i);
        double high = Double.NEGATIVE_INFINITY, low = Double.POSITIVE_INFINITY;
        for (int j = Math.max(0, i - lookback + 1); j <= i; j++) {
            high = Math.max(high, candles.get(j).high()); low = Math.min(low, candles.get(j).low());
        }
        double rangePosition = high > low ? (candle.close() - low) / (high - low) : .5;
        Double average = ind.volumeAverage().get(i);
        double volumeScore = 0;
        List<String> volumeReasons = new ArrayList<>();
        if (average != null) {
            double ratio = candle.volume() / average;
            double direction = Math.signum(candle.close() - candle.open());
            volumeReasons.add(String.format("Khối lượng %.2fx trung bình %d nến", ratio, ind.volumePeriod()));
            if (ratio >= number(thresholds, "volumeSpikeRatio", 1.6)) {
                if (rangePosition < .1 && direction < 0) volumeScore += .5;
                else if (rangePosition > .9 && direction > 0) volumeScore -= .5;
                else volumeScore += direction * .7;
            } else if (ratio < .6) volumeScore += direction * .1;
            else volumeScore += direction * .3 * ratio;
        }
        groups.put("volume", new Group(clamp(volumeScore), average != null, volumeReasons));

        Double slope = ind.cvdSlope().get(i);
        double cvdScore = 0;
        List<String> cvdReasons = new ArrayList<>();
        if (slope != null) {
            int back = ind.cvdPeriod();
            double prior = candles.get(Math.max(0, i - back)).close();
            double priceChange = (candle.close() - prior) / prior * 100;
            cvdScore += clamp(slope * 3) * .45;
            if (Math.abs(priceChange) < number(thresholds, "sidewaysPercent", 1.5)) {
                if (slope > .02) cvdScore += .6; else if (slope < -.02) cvdScore -= .6;
            } else if ((priceChange > 0) == (slope > 0)) cvdScore += priceChange > 0 ? .3 : -.3;
            else cvdScore += priceChange > 0 ? -.5 : .5;
            cvdReasons.add(String.format("CVD %d nến: %.1f%% khối lượng chủ động ròng", back, Math.abs(slope) * 100));
        }
        if (ind.cvdDelta().get(i) != null && candle.volume() > 0) cvdScore += clamp(ind.cvdDelta().get(i) / candle.volume()) * .2;
        groups.put("cvd", new Group(clamp(cvdScore), slope != null, cvdReasons));

        double structureScore = clamp((rangePosition - .5) * 2) * .5;
        List<String> structureReasons = new ArrayList<>(List.of(String.format("Giá ở %.0f%% biên độ %d nến gần nhất", rangePosition * 100, lookback)));
        if (!sr.resistance().isEmpty()) {
            double distance = (sr.resistance().get(0).price() - candle.close()) / candle.close() * 100;
            if (distance < 1) structureScore -= .25;
        }
        if (!sr.support().isEmpty()) {
            double distance = (candle.close() - sr.support().get(0).price()) / candle.close() * 100;
            if (distance < 1) structureScore += .2;
        }
        groups.put("structure", new Group(clamp(structureScore), true, structureReasons));

        boolean derivativeAvailable = derivatives != null && !derivatives.path("fundingRate").isMissingNode();
        double derivativeScore = 0;
        List<String> derivativeReasons = new ArrayList<>();
        if (derivativeAvailable) {
            double funding = derivatives.path("fundingRate").asDouble();
            double extreme = number(thresholds, "fundingExtreme", .0004);
            if (funding > extreme) derivativeScore -= .5;
            else if (funding < -extreme) derivativeScore += .5;
            else derivativeScore += clamp(-funding / extreme) * .15;
            derivativeReasons.add(String.format("Funding rate %.4f%%", funding * 100));
        }
        groups.put("derivatives", new Group(clamp(derivativeScore), derivativeAvailable, derivativeReasons));
        double orderScore = 0;
        if (orderBook != null) orderScore = clamp(orderBook.path("imbalance").asDouble() * 2) * .5;
        groups.put("orderBook", new Group(orderScore, orderBook != null,
                List.of(orderBook == null ? "Không lấy được sổ lệnh" : String.format("Sổ lệnh lệch %.1f%%", orderBook.path("imbalance").asDouble() * 100))));
        double positioningScore = 0;
        List<String> positioningReasons = new ArrayList<>();
        if (positioning != null) {
            double crowd = positioning.path("longAccountRatio").asDouble(.5);
            double skew = number(thresholds, "crowdSkew", .12);
            if (crowd > .5 + skew) positioningScore -= .4;
            else if (crowd < .5 - skew) positioningScore += .4;
            double gap = positioning.path("topLongRatio").asDouble(crowd) - crowd;
            if (Math.abs(gap) > .05) positioningScore += Math.signum(gap) * .35;
            positioningScore += clamp((positioning.path("takerBuySellRatio").asDouble(1) - 1) * 2) * .25;
            positioningReasons.add(String.format("%.1f%% tài khoản đang long", crowd * 100));
        }
        groups.put("positioning", new Group(clamp(positioningScore), positioning != null, positioningReasons));
        boolean historicalAvailable = Boolean.TRUE.equals(historical.get("available"));
        groups.put("historicalPattern", new Group(((Number) historical.getOrDefault("score", 0)).doubleValue(), historicalAvailable,
                (List<String>) historical.getOrDefault("reasons", List.of())));

        JsonNode weights = strategy.path("weights");
        double weighted = 0, total = 0;
        Map<String, Object> breakdown = new LinkedHashMap<>();
        for (Map.Entry<String, Group> entry : groups.entrySet()) {
            double weight = number(weights, entry.getKey(), 0);
            Group group = entry.getValue();
            boolean skipped = !group.available();
            if (weight > 0 && group.available()) { weighted += group.score() * weight; total += weight; }
            breakdown.put(entry.getKey(), Map.of("score", round(group.score(), 3), "weight", weight,
                    "contributionPct", 0d, "skipped", skipped, "reasons", group.reasons()));
        }
        double value = total == 0 ? 0 : weighted / total * 100;
        double direction = Math.signum(value);
        double minimum = number(thresholds, "consensusMinGroupScore", .15);
        List<String> agreeing = groups.entrySet().stream().filter(entry -> entry.getValue().available()
                        && number(weights, entry.getKey(), 0) > 0 && Math.signum(entry.getValue().score()) == direction
                        && Math.abs(entry.getValue().score()) >= minimum).map(Map.Entry::getKey).toList();
        long active = groups.entrySet().stream().filter(entry -> entry.getValue().available() && number(weights, entry.getKey(), 0) > 0).count();
        Map<String, Object> consensus = Map.of("direction", direction > 0 ? "long" : direction < 0 ? "short" : "none",
                "agree", agreeing.size(), "activeGroups", active, "percent", active == 0 ? 0 : agreeing.size() * 100d / active,
                "agreeing", agreeing);
        return new Score(value, breakdown, consensus);
    }

    private MlResult predictModel(String symbol, String interval, List<Candle> candles, Indicators ind, JsonNode strategy) {
        if (!strategy.path("ml").path("enabled").asBoolean(true)) return unavailable("ML bị tắt trong cấu hình");
        JsonNode stored = models.load(symbol, interval);
        if (stored == null) return unavailable("Chưa có model cho " + symbol + " " + interval + " - hãy train trước.");
        double[] vector = features.vector(candles, ind, candles.size() - 1);
        if (vector == null) return unavailable("Không đủ dữ liệu lịch sử để tạo feature");
        JsonNode model = stored.path("model");
        if (model.path("nFeatures").asInt() != vector.length) return unavailable("Model cũ không khớp bộ feature hiện tại - hãy train lại");
        double probability = predictor.predict(model, vector);
        double auc = stored.path("metrics").path("test").path("auc").asDouble(Double.NaN);
        double walkForward = stored.path("metrics").path("walkForward").path("meanAuc").asDouble(Double.NaN);
        double minAuc = number(strategy.path("ml"), "minTestAuc", .52);
        String reliability = "low";
        if (Double.isFinite(auc) && Double.isFinite(walkForward)) {
            if (auc >= minAuc + .05 && walkForward >= minAuc) reliability = "high";
            else if (auc >= minAuc && walkForward >= minAuc - .02) reliability = "medium";
        } else if (Double.isFinite(auc) && auc >= minAuc) reliability = "medium";
        double mlScore = clamp((probability - .5) / .25) * 100;
        Map<String, Object> output = new LinkedHashMap<>();
        output.put("available", true); output.put("probUp", round(probability, 4));
        output.put("probUpPercent", round(probability * 100, 2)); output.put("score", round(mlScore, 1));
        output.put("confident", Math.abs(probability - .5) >= number(strategy.path("ml"), "confidenceMargin", .12));
        output.put("reliability", reliability); output.put("trainedAt", stored.path("trainedAt").asText(null));
        output.put("testAuc", round(auc, 4)); output.put("walkForwardAuc", round(walkForward, 4));
        return new MlResult(true, mlScore, reliability, output);
    }

    private static MlResult unavailable(String reason) {
        return new MlResult(false, 0, "low", Map.of("available", false, "reason", reason));
    }

    private static Signal signal(double score, JsonNode thresholds) {
        if (score >= number(thresholds, "strongBuy", 50)) return new Signal("MUA MẠNH", "long", "strong");
        if (score >= number(thresholds, "buy", 30)) return new Signal("MUA", "long", "normal");
        if (score <= number(thresholds, "strongSell", -50)) return new Signal("BÁN MẠNH", "short", "strong");
        if (score <= number(thresholds, "sell", -30)) return new Signal("BÁN", "short", "normal");
        return new Signal("TRUNG LẬP", "none", "weak");
    }

    private static Map<String, Object> levels(double price, SupportResistance sr, Signal signal, JsonNode risk) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("side", signal.side()); result.put("entry", roundPrice(price));
        if ("none".equals(signal.side())) { result.put("note", "Không có hướng rõ ràng - chờ tín hiệu."); return result; }
        boolean longSide = "long".equals(signal.side());
        double baseRisk = price * number(risk, "slPercent", 2.5) / 100;
        double stop = longSide ? price - baseRisk : price + baseRisk;
        List<Level> preferred = longSide ? sr.support() : sr.resistance();
        if (risk.path("preferSrLevels").asBoolean(false) && !preferred.isEmpty()) {
            double candidate = preferred.get(0).price() + (longSide ? -.3 : .3) * baseRisk;
            double distance = Math.abs(price - candidate);
            if (distance > baseRisk * .4 && distance < baseRisk * 2.5) stop = candidate;
        }
        double unit = Math.abs(price - stop);
        List<Map<String, Object>> targets = new ArrayList<>();
        JsonNode configured = risk.path("takeProfitR");
        List<Double> multipliers = new ArrayList<>();
        if (configured.isArray()) for (JsonNode value : configured) multipliers.add(value.asDouble());
        if (multipliers.isEmpty()) multipliers = List.of(1d, 2d, 3d);
        for (int i = 0; i < multipliers.size(); i++) {
            double multiplier = multipliers.get(i);
            targets.add(Map.of("label", "TP" + (i + 1), "r", multiplier,
                    "price", roundPrice(price + (longSide ? 1 : -1) * unit * multiplier)));
        }
        result.put("stopLoss", roundPrice(stop)); result.put("riskPercent", round(unit / price * 100, 2));
        result.put("targets", targets); result.put("srTargets", List.of());
        return result;
    }

    private static Map<String, Object> structure(SupportResistance sr, double price) {
        return Map.of("support", structureLevels(sr.support(), price), "resistance", structureLevels(sr.resistance(), price));
    }
    private static List<Map<String, Object>> structureLevels(List<Level> levels, double price) {
        return levels.stream().map(level -> Map.<String, Object>of("price", roundPrice(level.price()), "touches", level.touches(),
                "distancePct", round((level.price() - price) / price * 100, 2))).toList();
    }
    private static Map<String, Object> entryQuality(Signal signal, Candle candle, List<Candle> candles, Indicators ind, JsonNode config) {
        int i = candles.size() - 1;
        double ratio = candle.volume() / nonZero(ind.volumeAverage().get(i));
        double slope = ind.cvdSlope().get(i) == null ? 0 : ind.cvdSlope().get(i);
        boolean passed = "none".equals(signal.side()) || !config.path("enabled").asBoolean(true)
                || (Math.abs(slope) >= number(config, "minAbsCvdSlope", .03) && ratio >= number(config, "minVolumeRatio", 1));
        return Map.of("passed", passed, "reasons", passed ? List.of() : List.of("CVD hoặc volume chưa đạt cổng vào lệnh"));
    }
    private static Object derivativeResult(JsonNode derivatives) {
        if (derivatives == null) return null;
        double rate = derivatives.path("fundingRate").asDouble();
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("fundingRate", rate); value.put("fundingRatePercent", round(rate * 100, 5));
        value.put("openInterest", derivatives.path("openInterest").isNumber() ? derivatives.path("openInterest").asDouble() : null);
        value.put("openInterestChangePct", derivatives.path("openInterestChangePct").isNumber() ? round(derivatives.path("openInterestChangePct").asDouble(), 2) : null);
        return value;
    }
    private static Object orderBookResult(JsonNode orderBook) {
        if (orderBook == null) return null;
        Map<String, Object> value = new LinkedHashMap<>();
        for (String field : List.of("imbalance", "bidValue", "askValue", "spreadPct", "depthSpanPct"))
            value.put(field, orderBook.path(field).asDouble());
        value.put("levels", orderBook.path("levels").asInt()); value.put("walls", List.of()); return value;
    }
    private static Object positioningResult(JsonNode positioning) {
        if (positioning == null) return null;
        Map<String, Object> value = new LinkedHashMap<>(); value.put("period", positioning.path("period").asText());
        value.put("samples", positioning.path("samples").asInt());
        value.put("longAccountPercent", round(positioning.path("longAccountRatio").asDouble() * 100, 2));
        value.put("longShortRatio", round(positioning.path("longShortRatio").asDouble(), 3));
        value.put("longAccountChangePoints", round(positioning.path("longAccountChange").asDouble() * 100, 2));
        value.put("topLongPercent", round(positioning.path("topLongRatio").asDouble() * 100, 2));
        value.put("topLongShortRatio", round(positioning.path("topLongShortRatio").asDouble(), 3));
        value.put("takerBuySellRatio", round(positioning.path("takerBuySellRatio").asDouble(), 3)); return value;
    }
    private static List<String> conflicts(Signal signal, Candle current, List<Candle> candles, Indicators ind) {
        List<String> result = new ArrayList<>();
        int i = candles.size() - 1;
        Double slope = ind.cvdSlope().get(i);
        if (slope != null) {
            boolean priceUp = current.close() > candles.get(Math.max(0, i - ind.cvdPeriod())).close();
            if (priceUp != (slope > 0)) result.add(priceUp ? "Giá tăng nhưng CVD ròng là bán" : "Giá giảm nhưng CVD ròng là mua");
        }
        if (current.volume() / nonZero(ind.volumeAverage().get(i)) < .6) result.add("Khối lượng thấp - tín hiệu giá kém tin cậy");
        return result;
    }

    private static Map<String, Object> series(List<Candle> candles, Indicators indicators, int bars) {
        int from = Math.max(0, candles.size() - bars);
        List<Candle> values = candles.subList(from, candles.size());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("bars", values.size()); result.put("time", values.stream().map(Candle::openTime).toList());
        result.put("open", values.stream().map(c -> roundPrice(c.open())).toList());
        result.put("high", values.stream().map(c -> roundPrice(c.high())).toList());
        result.put("low", values.stream().map(c -> roundPrice(c.low())).toList());
        result.put("close", values.stream().map(c -> roundPrice(c.close())).toList());
        result.put("volume", values.stream().map(c -> round(c.volume(), 2)).toList());
        result.put("volumeAvg", indicators.volumeAverage().subList(from, candles.size()).stream().map(v -> round(v, 2)).toList());
        result.put("cvd", indicators.cvd().subList(from, candles.size()).stream().map(v -> round(v, 2)).toList());
        result.put("cvdDelta", indicators.cvdDelta().subList(from, candles.size()).stream().map(v -> round(v, 2)).toList());
        result.put("cvdSlope", indicators.cvdSlope().subList(from, candles.size()).stream().map(v -> round(v, 4)).toList());
        return result;
    }

    private static JsonNode safely(Source source) { try { return source.get(); } catch (RuntimeException ignored) { return null; } }
    private static Double jsonNumber(JsonNode node, String field) { return node == null ? null : parseNumber(node.path(field)); }
    private static double parseNumber(JsonNode node) { try { return Double.parseDouble(node.asText()); } catch (RuntimeException e) { return Double.NaN; } }
    private static double number(JsonNode parent, String field, double fallback) {
        JsonNode value = parent == null ? null : parent.get(field);
        return value != null && value.isNumber() ? value.asDouble() : fallback;
    }
    private static int integer(JsonNode parent, String field, int fallback) { return (int) number(parent, field, fallback); }
    private static double nonZero(Double value) { return value == null || value == 0 ? 1 : value; }
    private static double clamp(double value) { return Math.max(-1, Math.min(1, value)); }
    private static Double round(Double value, int digits) {
        if (value == null || !Double.isFinite(value)) return null;
        double scale = Math.pow(10, digits); return Math.round(value * scale) / scale;
    }
    private static Double roundPrice(double value) {
        int digits = value == 0 ? 2 : Math.abs(value) < .001 ? 10 : Math.abs(value) < 1 ? 8 : Math.abs(value) < 100 ? 6 : 4;
        return round(value, digits);
    }

    private record Group(double score, boolean available, List<String> reasons) {}
    private record Score(double value, Map<String, Object> breakdown, Map<String, Object> consensus) {}
    private record Signal(String label, String side, String strength) {}
    private record MlResult(boolean available, double score, String reliability, Map<String, Object> output) {}
    @FunctionalInterface private interface Source { JsonNode get(); }
}
