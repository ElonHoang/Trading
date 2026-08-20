package vn.dongtien.trading.backtest;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import vn.dongtien.trading.analysis.HistoricalPatternService;
import vn.dongtien.trading.analysis.IndicatorService;
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

/**
 * Historical simulator used by the CLI, API and review jobs. It keeps the
 * former Node runtime's safety invariants: closed candles only, no look-ahead,
 * one position at a time, and stop loss wins ties inside the same candle.
 */
@Service
public class BacktestService {
    private final BinanceClient binance;
    private final IndicatorService indicators;
    private final FeatureService features;
    private final GbdtPredictor predictor;
    private final ModelStore models;
    private final HistoricalPatternService historicalPatterns;

    public BacktestService(BinanceClient binance, IndicatorService indicators, FeatureService features,
                           GbdtPredictor predictor, ModelStore models, HistoricalPatternService historicalPatterns) {
        this.binance = binance;
        this.indicators = indicators;
        this.features = features;
        this.predictor = predictor;
        this.models = models;
        this.historicalPatterns = historicalPatterns;
    }

    public Map<String, Object> run(String symbol, String interval, int requestedCandles, JsonNode strategy) {
        if (!BinanceClient.INTERVAL_MS.containsKey(interval)) {
            throw new IllegalArgumentException("Khung thời gian không hợp lệ: " + interval);
        }
        int wanted = Math.max(400, Math.min(20_000, requestedCandles));
        JsonNode patternConfig = strategy.path("historicalPattern");
        boolean usePattern = patternConfig.path("enabled").asBoolean(true);
        int patternWarmup = usePattern ? historicalCandleCount(interval, patternConfig) : 0;
        int fetch = Math.min(20_000, wanted + patternWarmup);
        boolean historyLimited = wanted + patternWarmup > 20_000;
        List<Candle> candles = binance.fetchKlinesHistory(symbol, interval, fetch).stream().filter(Candle::closed).toList();
        return runWithCandles(symbol, interval, candles, wanted, patternWarmup, historyLimited, strategy);
    }

    /** Lets review/research code reuse the simulator on a supplied historical window. */
    public Map<String, Object> runWithCandles(String symbol, String interval, List<Candle> source,
                                               int requestedCandles, int warmupCandles, boolean historyLimited,
                                               JsonNode strategy) {
        List<Candle> candles = source.stream().filter(Candle::closed).toList();
        if (candles.size() < 400) {
            throw new IllegalArgumentException("Chỉ tải được " + candles.size() + " nến — cần tối thiểu 400.");
        }
        int start = Math.max(220, warmupCandles);
        if (start >= candles.size() - 1) {
            throw new IllegalArgumentException("Không còn đủ nến để backtest sau phần warmup.");
        }
        JsonNode indicatorConfig = strategy.path("indicators");
        Indicators ind = indicators.compute(candles, indicatorConfig.path("volumeAvg").asInt(20),
                indicatorConfig.path("cvdSlope").asInt(20));
        JsonNode stored = models.load(symbol, interval);
        double mlWeight = reliableModelWeight(stored, strategy);
        JsonNode risk = strategy.path("risk");
        double fee = number(strategy.path("dailyReview"), "feePercent", .06);
        int maxHold = Math.max(12, strategy.path("ml").path("horizon").asInt(6) * 4);
        String exitStrategy = risk.path("exitStrategy").asText("scaled");
        double partialFraction = clamp(number(risk, "partialFraction", .5), 0, 1);
        int srEvery = 5;
        List<Map<String, Object>> trades = new ArrayList<>();
        Position position = null;
        SupportResistance sr = null;
        int srAt = Integer.MIN_VALUE;
        int skippedConsensus = 0;
        int skippedEntryQuality = 0;

        for (int i = start; i < candles.size(); i++) {
            Candle candle = candles.get(i);
            if (position != null) {
                Close close = advance(position, candle, i, fee, exitStrategy, maxHold);
                if (close != null) {
                    trades.add(closeTrade(position, close, candles, i, fee));
                    position = null;
                }
                if (position != null) continue;
            }
            if (i - srAt >= srEvery) {
                sr = indicators.supportResistance(candles.subList(Math.max(0, i - 200), i + 1), 3, 3, .6, 6);
                srAt = i;
            }
            Map<String, Object> historical = strategy.path("historicalPattern").path("enabled").asBoolean(true)
                    ? historicalPatterns.analyze(candles.subList(0, i + 1), strategy.path("historicalPattern")) : unavailablePattern();
            Score score = scoreAt(candles, ind, i, sr, historical, strategy);
            Signal signal = label(score.value(), strategy.path("thresholds"));
            if ("none".equals(signal.side())) continue;
            double combined = score.value();
            Double probability = null;
            if (mlWeight > 0) {
                double[] vector = features.vector(candles, ind, i);
                if (vector != null && stored != null && stored.path("model").path("nFeatures").asInt(-1) == vector.length) {
                    probability = predictor.predict(stored.path("model"), vector);
                    combined = score.value() * (1 - mlWeight) + (probability - .5) * 200 * mlWeight;
                    signal = label(combined, strategy.path("thresholds"));
                    if ("none".equals(signal.side())) continue;
                }
            }
            Diagnostics diagnostics = diagnostics(candles, ind, i, score, combined, historical);
            if (!entryQuality(signal.side(), interval, diagnostics, strategy.path("entryQuality"))) {
                skippedEntryQuality++;
                continue;
            }
            double consensusRequired = number(strategy.path("thresholds"), "consensusPercent", -1);
            if (consensusRequired >= 0 && score.consensusPercent() < consensusRequired) {
                skippedConsensus++;
                continue;
            }
            Levels levels = levels(candle.close(), sr, signal.side(), risk);
            if (levels.stopLoss() == null || levels.targets().isEmpty() || levels.riskPercent() < .1 || levels.riskPercent() > 20) continue;
            double tp1 = levels.targets().get(0);
            double tp2 = levels.targets().size() > 1 ? levels.targets().get(1) : tp1;
            position = new Position(signal.side(), candle.close(), i, levels.stopLoss(), tp1, tp2, 1, 0,
                    false, false, partialFraction, round(combined, 1), probability == null ? null : round(probability, 4), diagnostics);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("symbol", symbol);
        result.put("interval", interval);
        result.put("period", Map.of("from", Instant.ofEpochMilli(candles.get(start).openTime()).toString(),
                "to", Instant.ofEpochMilli(candles.get(candles.size() - 1).openTime()).toString(),
                "candles", candles.size() - start, "warmupCandles", start));
        Map<String, Object> settings = new LinkedHashMap<>();
        settings.put("feePercent", fee);
        settings.put("maxHoldBars", maxHold);
        settings.put("mlWeight", mlWeight);
        settings.put("usedModel", mlWeight > 0);
        settings.put("storedModelAvailable", stored != null);
        settings.put("srEvery", srEvery);
        settings.put("exitStrategy", exitStrategy);
        settings.put("partialFraction", "scaled".equals(exitStrategy) ? partialFraction : null);
        settings.put("consensusPercent", number(strategy.path("thresholds"), "consensusPercent", -1));
        settings.put("historicalPatternEnabled", strategy.path("historicalPattern").path("enabled").asBoolean(true));
        settings.put("historicalPatternWarmupBars", warmupCandles);
        settings.put("historicalPatternHistoryLimitedByApi", historyLimited);
        settings.put("requestedEvaluationCandles", requestedCandles);
        settings.put("effectiveEvaluationCandles", candles.size() - start);
        settings.put("entryQualityEnabled", strategy.path("entryQuality").path("enabled").asBoolean(false));
        settings.put("skippedByEntryQuality", skippedEntryQuality);
        settings.put("skippedByConsensus", skippedConsensus);
        result.put("settings", settings);
        Map<String, Object> stats = summarize(trades, candles, start, fee);
        result.put("stats", stats);
        result.put("trades", trades.size() <= 40 ? trades : trades.subList(Math.max(0, trades.size() - 40), trades.size()));
        result.put("allTradeCount", trades.size());
        // Compatibility fields used by the first Java port.
        result.put("closedTrades", trades.size());
        result.put("wins", trades.stream().filter(row -> number(row.get("netPercent"), 0) > 0).count());
        result.put("losses", trades.stream().filter(row -> number(row.get("netPercent"), 0) <= 0).count());
        result.put("netReturnPercent", number(stats.get("totalReturnPercent"), 0));
        return result;
    }

    private Close advance(Position position, Candle candle, int index, double fee, String exitStrategy, int maxHold) {
        boolean longSide = "long".equals(position.side());
        boolean stop = longSide ? candle.low() <= position.stopLoss() : candle.high() >= position.stopLoss();
        boolean tp1 = longSide ? candle.high() >= position.tp1() : candle.low() <= position.tp1();
        boolean tp2 = longSide ? candle.high() >= position.tp2() : candle.low() <= position.tp2();
        // Conservative OHLC handling: a stop takes precedence over a target.
        if (stop) return new Close(position.stopLoss(), position.movedStop() ? "breakeven" : "stoploss");
        if ("scaled".equals(exitStrategy) && !position.partialDone() && tp1) {
            double gain = gain(position, position.tp1());
            position.realizedPercent += (gain - fee) * position.partialFraction();
            position.remaining = 1 - position.partialFraction();
            position.partialDone = true;
            position.movedStop = true;
            position.stopLoss = position.entry();
        }
        if ("scaled".equals(exitStrategy) && position.partialDone() && tp2) return new Close(position.tp2(), "take-profit TP2");
        if (!"scaled".equals(exitStrategy)) {
            boolean second = "tp2".equals(exitStrategy);
            if (second ? tp2 : tp1) return new Close(second ? position.tp2() : position.tp1(), second ? "take-profit TP2" : "take-profit TP1");
        }
        if (index - position.entryIndex() >= maxHold) return new Close(candle.close(), "hết thời gian giữ");
        return null;
    }

    private Map<String, Object> closeTrade(Position position, Close close, List<Candle> candles, int exitIndex, double fee) {
        double net = position.realizedPercent + (gain(position, close.price()) - fee) * position.remaining - fee;
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("side", position.side());
        row.put("entryTime", Instant.ofEpochMilli(candles.get(position.entryIndex()).openTime()).toString());
        row.put("exitTime", Instant.ofEpochMilli(candles.get(exitIndex).openTime()).toString());
        row.put("bars", exitIndex - position.entryIndex());
        row.put("entry", position.entry());
        row.put("exit", close.price());
        row.put("stopLoss", position.stopLoss());
        row.put("tp1", position.tp1());
        row.put("tp2", position.tp2());
        row.put("partialTaken", position.partialDone());
        row.put("reason", close.reason());
        row.put("netPercent", round(net, 3));
        row.put("score", position.score());
        row.put("mlProb", position.mlProbability());
        row.put("entryDiagnostics", position.diagnostics().asMap());
        return row;
    }

    private Score scoreAt(List<Candle> candles, Indicators ind, int i, SupportResistance sr,
                          Map<String, Object> historical, JsonNode strategy) {
        Candle candle = candles.get(i);
        int from = Math.max(0, i - 49);
        double high = Double.NEGATIVE_INFINITY;
        double low = Double.POSITIVE_INFINITY;
        for (int j = from; j <= i; j++) {
            high = Math.max(high, candles.get(j).high());
            low = Math.min(low, candles.get(j).low());
        }
        double rangePos = high > low ? (candle.close() - low) / (high - low) : .5;
        int cvdPeriod = ind.cvdPeriod();
        double priceChange = percent(candle.close(), candles.get(Math.max(0, i - cvdPeriod)).close());
        Double avg = ind.volumeAverage().get(i);
        Double slope = ind.cvdSlope().get(i);
        Double delta = ind.cvdDelta().get(i);
        double volume = 0;
        if (avg != null && avg > 0) {
            double ratio = candle.volume() / avg;
            double direction = Math.signum(candle.close() - candle.open());
            boolean brokeUp = !sr.resistance().isEmpty() && candle.close() > sr.resistance().get(0).price();
            boolean brokeDown = !sr.support().isEmpty() && candle.close() < sr.support().get(0).price();
            if (ratio >= number(strategy.path("thresholds"), "volumeSpikeRatio", 1.6)) {
                if (rangePos < .1 && direction < 0) volume += .5;
                else if (rangePos > .9 && direction > 0) volume -= .5;
                else volume += direction * (brokeUp || brokeDown ? 1 : .7);
            } else if (brokeUp || brokeDown) volume -= direction * .5;
            else if (ratio < .6) volume += direction * .1;
            else volume += direction * .3 * ratio;
        }
        double cvd = 0;
        if (slope != null) {
            cvd += clamp(slope * 3, -1, 1) * .45;
            boolean sideways = Math.abs(priceChange) < number(strategy.path("thresholds"), "sidewaysPercent", 1.5);
            if (sideways) cvd += slope > .02 ? .6 : slope < -.02 ? -.6 : 0;
            else if ((priceChange > 0) == (slope > 0)) cvd += priceChange > 0 ? .3 : -.3;
            else cvd += priceChange > 0 ? -.5 : .5;
        }
        if (delta != null && candle.volume() > 0) cvd += clamp(delta / candle.volume(), -1, 1) * .2;
        double structure = clamp((rangePos - .5) * 2, -1, 1) * .5;
        if (!sr.resistance().isEmpty()) {
            double distance = (sr.resistance().get(0).price() - candle.close()) / candle.close() * 100;
            if (distance < 1) structure -= .25;
            if (candle.close() > sr.resistance().get(0).price()) structure += .3;
        }
        if (!sr.support().isEmpty() && (candle.close() - sr.support().get(0).price()) / candle.close() * 100 < 1) structure += .2;
        double pattern = Boolean.TRUE.equals(historical.get("available")) ? number(historical.get("score"), 0) : 0;
        Map<String, Double> groups = new LinkedHashMap<>();
        groups.put("cvd", clamp(cvd, -1, 1));
        groups.put("volume", clamp(volume, -1, 1));
        groups.put("structure", clamp(structure, -1, 1));
        groups.put("historicalPattern", clamp(pattern, -1, 1));
        Map<String, Boolean> available = Map.of("cvd", slope != null, "volume", avg != null,
                "structure", true, "historicalPattern", Boolean.TRUE.equals(historical.get("available")));
        Map<String, Object> breakdown = new LinkedHashMap<>();
        double weighted = 0;
        double total = 0;
        for (Map.Entry<String, Double> group : groups.entrySet()) {
            double weight = number(strategy.path("weights"), group.getKey(), 0);
            boolean usable = available.get(group.getKey());
            if (usable && weight > 0) {
                weighted += group.getValue() * weight;
                total += weight;
            }
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("score", round(group.getValue(), 3));
            item.put("weight", weight);
            item.put("skipped", !usable);
            item.put("contribution", usable ? round(group.getValue() * weight, 3) : 0);
            breakdown.put(group.getKey(), item);
        }
        double value = total == 0 ? 0 : weighted / total * 100;
        int active = 0;
        int agreeing = 0;
        double minGroup = number(strategy.path("thresholds"), "consensusMinGroupScore", .15);
        for (Map.Entry<String, Double> group : groups.entrySet()) {
            if (!available.get(group.getKey()) || number(strategy.path("weights"), group.getKey(), 0) <= 0) continue;
            active++;
            if (Math.signum(group.getValue()) == Math.signum(value) && Math.abs(group.getValue()) >= minGroup) agreeing++;
        }
        return new Score(value, active == 0 ? 0 : agreeing * 100d / active, active, agreeing, breakdown, rangePos,
                priceChange, avg == null || avg == 0 ? 0 : candle.volume() / avg, slope == null ? 0 : slope);
    }

    private static Levels levels(double entry, SupportResistance sr, String side, JsonNode risk) {
        if ("none".equals(side)) return new Levels(null, List.of(), 0);
        boolean longSide = "long".equals(side);
        double baseRisk = entry * number(risk, "slPercent", 2.5) / 100;
        double stop = longSide ? entry - baseRisk : entry + baseRisk;
        List<Level> preferred = longSide ? sr.support() : sr.resistance();
        if (risk.path("preferSrLevels").asBoolean(false) && !preferred.isEmpty()) {
            double candidate = preferred.get(0).price() + (longSide ? -.3 : .3) * baseRisk;
            double distance = Math.abs(entry - candidate);
            if (distance > baseRisk * .4 && distance < baseRisk * 2.5) stop = candidate;
        }
        double unit = Math.abs(entry - stop);
        List<Double> targets = new ArrayList<>();
        JsonNode multiples = risk.path("takeProfitR");
        if (multiples.isArray()) {
            for (JsonNode multiple : multiples) targets.add(entry + (longSide ? 1 : -1) * unit * multiple.asDouble());
        }
        if (targets.isEmpty()) {
            for (double multiple : List.of(1d, 2d, 3d)) targets.add(entry + (longSide ? 1 : -1) * unit * multiple);
        }
        return new Levels(stop, targets, unit / entry * 100);
    }

    private static boolean entryQuality(String side, String interval, Diagnostics d, JsonNode cfg) {
        if (!cfg.path("enabled").asBoolean(false) || "none".equals(side)) return true;
        double direction = "long".equals(side) ? 1 : -1;
        if (d.cvdSlope() * direction < number(cfg, "minAbsCvdSlope", .03)) return false;
        if (d.volumeRatio() < number(cfg, "minVolumeRatio", 1)) return false;
        if (cfg.path("requireStructureAgreement").asBoolean(false) && d.structureScore() * direction < 0) return false;
        double maxMove = number(cfg, "maxDirectionalMove20Pct", Double.NaN);
        if (Double.isFinite(maxMove) && maxMove > 0 && d.priceChange20Pct() * direction > maxMove) return false;
        if (cfg.path("avoidRangeExtremes").asBoolean(false)) {
            if ("long".equals(side) && d.rangePosition50() > number(cfg, "maxLongRangePosition", .8)) return false;
            if ("short".equals(side) && d.rangePosition50() < number(cfg, "minShortRangePosition", .2)) return false;
        }
        for (JsonNode blocked : cfg.path("blockedIntervals")) if (interval.equals(blocked.asText())) return false;
        return true;
    }

    private static Diagnostics diagnostics(List<Candle> candles, Indicators ind, int i, Score score, double combined,
                                           Map<String, Object> historical) {
        Map<String, Double> groups = new LinkedHashMap<>();
        score.breakdown().forEach((key, value) -> {
            if (!Boolean.TRUE.equals(value.get("skipped"))) groups.put(key, number(value.get("score"), 0));
        });
        return new Diagnostics(round(score.value(), 2), round(combined, 2), round(score.consensusPercent(), 1),
                score.activeGroups(), score.agreeing(), round(score.volumeRatio(), 3), round(score.cvdSlope(), 4),
                round(score.priceChange20Pct(), 2), round(score.rangePosition(), 3), groups.getOrDefault("structure", 0d),
                groups, historical);
    }

    private static Map<String, Object> summarize(List<Map<String, Object>> trades, List<Candle> candles, int start, double fee) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (trades.isEmpty()) {
            out.put("trades", 0);
            out.put("note", "Không có lệnh nào — ngưỡng tín hiệu có thể quá cao.");
            out.put("totalReturnPercent", 0d);
            return out;
        }
        List<Double> nets = trades.stream().map(row -> number(row.get("netPercent"), 0)).toList();
        List<Double> wins = nets.stream().filter(value -> value > 0).toList();
        List<Double> losses = nets.stream().filter(value -> value <= 0).toList();
        double grossWin = wins.stream().mapToDouble(Double::doubleValue).sum();
        double grossLoss = -losses.stream().mapToDouble(Double::doubleValue).sum();
        double equity = 100;
        double peak = 100;
        double drawdown = 0;
        List<Double> curve = new ArrayList<>();
        for (double value : nets) {
            equity *= 1 + value / 100;
            peak = Math.max(peak, equity);
            drawdown = Math.max(drawdown, (peak - equity) / peak * 100);
            curve.add(round(equity, 2));
        }
        double mean = nets.stream().mapToDouble(Double::doubleValue).average().orElse(0);
        double variance = nets.stream().mapToDouble(value -> Math.pow(value - mean, 2)).average().orElse(0);
        long longTrades = trades.stream().filter(row -> "long".equals(row.get("side"))).count();
        long shortTrades = trades.size() - longTrades;
        Map<String, Integer> exitReasons = new LinkedHashMap<>();
        for (Map<String, Object> trade : trades) {
            String reason = String.valueOf(trade.getOrDefault("reason", "unknown"));
            exitReasons.merge(reason, 1, Integer::sum);
        }
        double buyHold = percent(candles.get(candles.size() - 1).close(), candles.get(start).close());
        out.put("trades", trades.size());
        out.put("winRatePercent", round(wins.size() * 100d / trades.size(), 1));
        out.put("avgWinPercent", wins.isEmpty() ? null : round(grossWin / wins.size(), 3));
        out.put("avgLossPercent", losses.isEmpty() ? null : round(-grossLoss / losses.size(), 3));
        out.put("profitFactor", grossLoss == 0 ? null : round(grossWin / grossLoss, 2));
        out.put("expectancyPercent", round(mean, 3));
        out.put("stdDevPercent", round(Math.sqrt(variance), 3));
        out.put("sharpeLike", variance == 0 ? null : round(mean / Math.sqrt(variance), 3));
        out.put("finalEquity", round(equity, 2));
        out.put("totalReturnPercent", round(equity - 100, 2));
        out.put("maxDrawdownPercent", round(drawdown, 2));
        out.put("buyHoldReturnPercent", round(buyHold, 2));
        out.put("beatBuyHold", equity - 100 > buyHold);
        out.put("longTrades", longTrades);
        out.put("shortTrades", shortTrades);
        out.put("longWinRate", winRateFor(trades, "long"));
        out.put("shortWinRate", winRateFor(trades, "short"));
        out.put("exitReasons", exitReasons);
        out.put("feePercentPerSide", fee);
        out.put("equityCurveTail", curve.size() <= 30 ? curve : curve.subList(curve.size() - 30, curve.size()));
        return out;
    }

    private static double reliableModelWeight(JsonNode stored, JsonNode strategy) {
        if (stored == null || !strategy.path("ml").path("enabled").asBoolean(true)) return 0;
        double auc = stored.path("metrics").path("test").path("auc").asDouble(Double.NaN);
        double walkForward = stored.path("metrics").path("walkForward").path("meanAuc").asDouble(Double.NaN);
        double minimum = number(strategy.path("ml"), "minTestAuc", .52);
        boolean reliable = Double.isFinite(auc) && (Double.isFinite(walkForward) ? walkForward >= minimum - .02 : true) && auc >= minimum;
        return reliable ? clamp(number(strategy.path("ml"), "weightVsRules", .4), 0, 1) : 0;
    }

    private static int historicalCandleCount(String interval, JsonNode config) {
        long ms = BinanceClient.INTERVAL_MS.get(interval);
        int months = Math.max(1, Math.min(6, config.path("maxMonths").asInt(6)));
        return (int) Math.ceil(months * 31d * 86_400_000d / ms) + config.path("lookbackBars").asInt(24) + config.path("futureBars").asInt(12);
    }

    private static Map<String, Object> unavailablePattern() { return Map.of("available", false, "score", 0d); }

    private static Signal label(double score, JsonNode thresholds) {
        if (score >= number(thresholds, "strongBuy", 50)) return new Signal("long");
        if (score >= number(thresholds, "buy", 30)) return new Signal("long");
        if (score <= number(thresholds, "strongSell", -50)) return new Signal("short");
        if (score <= number(thresholds, "sell", -30)) return new Signal("short");
        return new Signal("none");
    }

    private static double gain(Position position, double price) {
        return ("long".equals(position.side()) ? price / position.entry() - 1 : position.entry() / price - 1) * 100;
    }

    private static double percent(double value, double base) { return base == 0 ? 0 : (value / base - 1) * 100; }

    private static Double winRateFor(List<Map<String, Object>> trades, String side) {
        List<Map<String, Object>> matching = trades.stream().filter(row -> side.equals(row.get("side"))).toList();
        if (matching.isEmpty()) return null;
        long wins = matching.stream().filter(row -> number(row.get("netPercent"), 0) > 0).count();
        return round(wins * 100d / matching.size(), 1);
    }

    private static double number(JsonNode node, String key, double fallback) {
        return node != null && node.path(key).isNumber() ? node.path(key).asDouble() : fallback;
    }

    private static double number(Object value, double fallback) {
        return value instanceof Number number ? number.doubleValue() : fallback;
    }

    private static double round(double value, int digits) {
        if (!Double.isFinite(value)) return 0;
        double scale = Math.pow(10, digits);
        return Math.round(value * scale) / scale;
    }

    private static double clamp(double value, double low, double high) { return Math.max(low, Math.min(high, value)); }

    private static final class Position {
        private final String side;
        private final double entry;
        private final int entryIndex;
        private double stopLoss;
        private final double tp1;
        private final double tp2;
        private double remaining;
        private double realizedPercent;
        private boolean partialDone;
        private boolean movedStop;
        private final double partialFraction;
        private final double score;
        private final Double mlProbability;
        private final Diagnostics diagnostics;

        private Position(String side, double entry, int entryIndex, double stopLoss, double tp1, double tp2,
                         double remaining, double realizedPercent, boolean partialDone, boolean movedStop,
                         double partialFraction, double score, Double mlProbability, Diagnostics diagnostics) {
            this.side = side;
            this.entry = entry;
            this.entryIndex = entryIndex;
            this.stopLoss = stopLoss;
            this.tp1 = tp1;
            this.tp2 = tp2;
            this.remaining = remaining;
            this.realizedPercent = realizedPercent;
            this.partialDone = partialDone;
            this.movedStop = movedStop;
            this.partialFraction = partialFraction;
            this.score = score;
            this.mlProbability = mlProbability;
            this.diagnostics = diagnostics;
        }

        String side() { return side; }
        double entry() { return entry; }
        int entryIndex() { return entryIndex; }
        double stopLoss() { return stopLoss; }
        double tp1() { return tp1; }
        double tp2() { return tp2; }
        double remaining() { return remaining; }
        boolean partialDone() { return partialDone; }
        boolean movedStop() { return movedStop; }
        double partialFraction() { return partialFraction; }
        double score() { return score; }
        Double mlProbability() { return mlProbability; }
        Diagnostics diagnostics() { return diagnostics; }
    }

    private record Close(double price, String reason) {}
    private record Signal(String side) {}
    private record Levels(Double stopLoss, List<Double> targets, double riskPercent) {}
    private record Score(double value, double consensusPercent, int activeGroups, int agreeing, Map<String, Object> breakdown,
                         double rangePosition, double priceChange20Pct, double volumeRatio, double cvdSlope) {}
    private record Diagnostics(double ruleScore, double combinedScore, double consensusPercent, int activeGroups,
                               int agreeingGroups, double volumeRatio, double cvdSlope, double priceChange20Pct,
                               double rangePosition50, double structureScore, Map<String, Double> groupScores,
                               Map<String, Object> historicalPattern) {
        Map<String, Object> asMap() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ruleScore", ruleScore);
            out.put("combinedScore", combinedScore);
            out.put("consensusPercent", consensusPercent);
            out.put("activeGroups", activeGroups);
            out.put("agreeingGroups", agreeingGroups);
            out.put("volumeRatio", volumeRatio);
            out.put("cvdSlope", cvdSlope);
            out.put("priceChange20Pct", priceChange20Pct);
            out.put("rangePosition50", rangePosition50);
            out.put("groupScores", groupScores);
            out.put("historicalPattern", historicalPattern);
            return out;
        }
    }
}
