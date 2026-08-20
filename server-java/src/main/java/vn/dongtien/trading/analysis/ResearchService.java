package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.trading.backtest.BacktestService;
import vn.dongtien.trading.config.TradingUniverse;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.market.Candle;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * Read-only research jobs formerly implemented by the Node CLI scripts.
 *
 * <p>Every method receives a strategy snapshot and never persists it.  This is
 * important for research commands: a candidate is measured against the same
 * market data as the baseline, but it cannot silently change production
 * settings.</p>
 */
@Service
public class ResearchService {
    private static final int MIN_BACKTEST_CANDLES = 400;
    // floor(534 * .75) = 400, the simulator's minimum train window.
    private static final int MIN_VALIDATION_CANDLES = 534;
    private static final int BACKTEST_WARMUP = 220;
    private static final int MAX_HISTORY_CANDLES = 20_000;

    private final ObjectMapper mapper;
    private final BinanceClient binance;
    private final BacktestService backtest;
    private final HistoricalPatternService historicalPatterns;
    private final TradingUniverse universe;

    public ResearchService(ObjectMapper mapper, BinanceClient binance, BacktestService backtest,
                           HistoricalPatternService historicalPatterns, TradingUniverse universe) {
        this.mapper = mapper;
        this.binance = binance;
        this.backtest = backtest;
        this.historicalPatterns = historicalPatterns;
        this.universe = universe;
    }

    /**
     * Summarises the entry diagnostics of simulated stop losses and profitable
     * trades.  {@link BacktestService} intentionally limits its trade payload
     * for dashboard responses, so the returned source section explicitly says
     * when only the most recent trade rows were available for diagnosis.
     */
    public Map<String, Object> diagnoseStopLoss(String symbolInput, String interval, int requestedCandles,
                                                 JsonNode strategy) {
        String symbol = allowedSymbol(symbolInput, strategy);
        requireInterval(interval);
        Map<String, Object> result = backtest.run(symbol, interval, backtestCandles(requestedCandles), strategy);
        List<Map<String, Object>> trades = tradeRows(result.get("trades"));
        List<Map<String, Object>> stopped = trades.stream()
                .filter(row -> "stoploss".equals(String.valueOf(row.get("reason")))).toList();
        List<Map<String, Object>> profitable = trades.stream()
                .filter(row -> number(row.get("netPercent"), 0) > 0).toList();

        Map<String, Object> output = new LinkedHashMap<>();
        output.put("symbol", symbol);
        output.put("interval", interval);
        output.put("period", result.get("period"));
        output.put("settings", result.get("settings"));
        output.put("allTrades", summarizeDiagnostics(trades));
        output.put("stopLosses", summarizeDiagnostics(stopped));
        output.put("profitableTrades", summarizeDiagnostics(profitable));
        output.put("stopLossEntries", stopped.stream().map(this::stopLossEntry).toList());

        int allTradeCount = integer(result.get("allTradeCount"), trades.size());
        Map<String, Object> source = new LinkedHashMap<>();
        source.put("allTradeCount", allTradeCount);
        source.put("tradesAnalysed", trades.size());
        source.put("tradesTruncated", allTradeCount > trades.size());
        source.put("note", allTradeCount > trades.size()
                ? "Backtest payload contains the latest trade rows only; aggregate statistics still cover the full run."
                : "All simulated trade rows were available for diagnosis.");
        output.put("source", source);
        return output;
    }

    /**
     * Chooses an entry filter on the first 75% of a fixed candle sample and
     * reports it against the untouched final 25%.  Candles are loaded once and
     * reused for every candidate, so all candidates get identical data and no
     * extra Binance burst is produced.
     */
    public Map<String, Object> validateFilters(String symbolInput, String interval, int requestedCandles,
                                                JsonNode strategy) {
        String symbol = allowedSymbol(symbolInput, strategy);
        requireInterval(interval);
        ObjectNode researchBase = researchBase(strategy);
        List<Candle> candles = binance.fetchKlinesHistory(symbol, interval, validationCandles(requestedCandles)).stream()
                .filter(Candle::closed).toList();
        if (candles.size() < MIN_VALIDATION_CANDLES) {
            throw new IllegalArgumentException(symbol + " " + interval + " does not have enough closed candles for a 75/25 validation.");
        }
        int split = (int) Math.floor(candles.size() * .75);
        if (split < MIN_BACKTEST_CANDLES || split <= BACKTEST_WARMUP || candles.size() - split < 120) {
            throw new IllegalArgumentException(symbol + " " + interval + " does not leave enough training and holdout candles.");
        }

        List<FilterCandidate> candidates = filterCandidates(researchBase);
        List<CandidateRun> runs = new ArrayList<>();
        for (FilterCandidate candidate : candidates) {
            Segments segments = runSegments(symbol, interval, candles, split, candidate.strategy());
            runs.add(new CandidateRun(candidate, compact(segments.training()), compact(segments.holdout())));
        }

        CandidateRun baseline = runs.get(0);
        List<CandidateRun> eligible = new ArrayList<>();
        for (CandidateRun run : runs.subList(1, runs.size())) {
            if (isTrainingEligible(run.training(), baseline.training())) eligible.add(run);
        }
        eligible.sort(Comparator.comparingDouble((CandidateRun run) -> descendingMetric(run.training(), "profitFactor"))
                .thenComparingDouble(run -> descendingMetric(run.training(), "expectancyPercent")));
        CandidateRun selected = eligible.isEmpty() ? null : eligible.get(0);

        List<Map<String, Object>> training = new ArrayList<>();
        List<Map<String, Object>> validationCandidates = new ArrayList<>();
        for (CandidateRun run : runs) {
            training.add(candidateRow(run.candidate(), run.training()));
            if (run != baseline) validationCandidates.add(candidateRow(run.candidate(), run.holdout()));
        }

        Map<String, Object> period = new LinkedHashMap<>();
        period.put("from", Instant.ofEpochMilli(candles.get(0).openTime()).toString());
        period.put("to", Instant.ofEpochMilli(candles.get(candles.size() - 1).openTime()).toString());
        period.put("candles", candles.size());
        period.put("trainingCandles", split);
        period.put("validationCandles", candles.size() - split);

        Map<String, Object> validation = new LinkedHashMap<>();
        validation.put("baseline", baseline.holdout());
        validation.put("selected", selected == null ? null : selected.holdout());
        validation.put("passes", selected != null && validationPasses(selected.holdout(), baseline.holdout()));
        validation.put("candidates", validationCandidates);

        Map<String, Object> output = new LinkedHashMap<>();
        output.put("symbol", symbol);
        output.put("interval", interval);
        output.put("period", period);
        output.put("training", training);
        output.put("selectedFromTraining", selected == null ? null : selectedDescription(selected.candidate()));
        output.put("validation", validation);
        output.put("engineNotes", List.of(
                "ML is disabled while comparing entry filters so a stored model cannot favour one candidate.",
                "The Java entry-quality gate applies CVD in the signal direction; this is stricter than an unsigned CVD magnitude check."));
        return output;
    }

    /**
     * Scans either one allowed symbol or the complete alert whitelist for a
     * matched OHLC path in its own history.  Failures are recorded per symbol
     * so a temporary Binance error cannot erase the rest of the report.
     */
    public Map<String, Object> researchPatterns(String symbolInput, String interval, JsonNode strategy) {
        requireInterval(interval);
        if (strategy == null || !strategy.isObject()) throw new IllegalArgumentException("A strategy object is required for research.");
        JsonNode config = strategy.path("historicalPattern");
        int requested = historicalCandleCount(interval, config);
        List<String> symbols = symbolInput == null || symbolInput.isBlank()
                ? universe.symbols(strategy)
                : List.of(allowedSymbol(symbolInput, strategy));
        List<Map<String, Object>> reports = new ArrayList<>();
        for (String symbol : symbols) {
            try {
                List<Candle> candles = binance.fetchKlinesHistory(symbol, interval, requested).stream()
                        .filter(Candle::closed).toList();
                Map<String, Object> report = new LinkedHashMap<>();
                report.put("symbol", symbol);
                report.put("interval", interval);
                report.put("candles", candles.size());
                report.put("market", candles.isEmpty() ? null : candles.get(0).market());
                report.putAll(historicalPatterns.analyze(candles, config));
                completePatternSummary(report, config);
                reports.add(report);
            } catch (RuntimeException error) {
                Map<String, Object> report = new LinkedHashMap<>();
                report.put("symbol", symbol);
                report.put("interval", interval);
                report.put("candles", 0);
                report.put("market", null);
                report.put("available", false);
                report.put("score", 0d);
                report.put("side", "none");
                report.put("reasons", List.of("Could not load/read history: " + error.getMessage()));
                reports.add(report);
            }
        }
        Map<String, Object> output = new LinkedHashMap<>();
        output.put("generatedAt", Instant.now().toString());
        output.put("scope", "alerts.tradeSymbols");
        output.put("interval", interval);
        output.put("historyMonths", Math.max(1, Math.min(6, config.path("maxMonths").asInt(6))));
        output.put("candlesRequestedPerToken", requested);
        output.put("reports", reports);
        return output;
    }

    public Map<String, Object> researchPatterns(String interval, JsonNode strategy) {
        return researchPatterns(null, interval, strategy);
    }

    private Segments runSegments(String symbol, String interval, List<Candle> candles, int split, JsonNode strategy) {
        Map<String, Object> training = backtest.runWithCandles(symbol, interval, candles.subList(0, split), split,
                BACKTEST_WARMUP, false, strategy);
        Map<String, Object> holdout = backtest.runWithCandles(symbol, interval, candles, candles.size(), split,
                false, strategy);
        return new Segments(training, holdout);
    }

    private List<FilterCandidate> filterCandidates(ObjectNode base) {
        List<FilterCandidate> result = new ArrayList<>();
        result.add(candidate("baseline", null, base));
        for (int score : List.of(35, 40, 45)) {
            result.add(candidate("|score| >= " + score, Map.of("buy", score, "sell", -score), base,
                    Map.of("thresholds.buy", score, "thresholds.sell", -score)));
        }
        for (int score : List.of(35, 40)) {
            Map<String, Object> proposed = new LinkedHashMap<>();
            proposed.put("buy", score);
            proposed.put("sell", -score);
            proposed.put("requireStructureAgreement", true);
            result.add(candidate("|score| >= " + score + " + structure agrees", proposed, base, Map.of(
                    "thresholds.buy", score, "thresholds.sell", -score,
                    "entryQuality.enabled", true, "entryQuality.requireStructureAgreement", true)));
        }
        result.add(candidate("strong directional CVD |slope| >= 3%", Map.of("minAbsCvdSlope", .03), base,
                Map.of("entryQuality.enabled", true, "entryQuality.minAbsCvdSlope", .03)));
        result.add(candidate("volume >= 1x average", Map.of("minVolumeRatio", 1), base,
                Map.of("entryQuality.enabled", true, "entryQuality.minVolumeRatio", 1d)));
        result.add(candidate("avoid a directional move beyond 4% in 20 bars", Map.of("maxDirectionalMove20Pct", 4), base,
                Map.of("entryQuality.enabled", true, "entryQuality.maxDirectionalMove20Pct", 4d)));
        result.add(candidate("structure agrees", Map.of("requireStructureAgreement", true), base,
                Map.of("entryQuality.enabled", true, "entryQuality.requireStructureAgreement", true)));
        result.add(candidate("strong directional CVD + volume >= 1x", Map.of("minAbsCvdSlope", .03, "minVolumeRatio", 1), base,
                Map.of("entryQuality.enabled", true, "entryQuality.minAbsCvdSlope", .03,
                        "entryQuality.minVolumeRatio", 1d)));
        return result;
    }

    private FilterCandidate candidate(String name, Map<String, Object> proposed, ObjectNode base) {
        return new FilterCandidate(name, proposed, base.deepCopy());
    }

    private FilterCandidate candidate(String name, Map<String, Object> proposed, ObjectNode base,
                                      Map<String, ?> changes) {
        ObjectNode strategy = base.deepCopy();
        changes.forEach((path, value) -> setPath(strategy, path, value));
        return new FilterCandidate(name, proposed, strategy);
    }

    private ObjectNode researchBase(JsonNode strategy) {
        if (strategy == null || !strategy.isObject()) throw new IllegalArgumentException("A strategy object is required for research.");
        ObjectNode base = ((ObjectNode) strategy).deepCopy();
        // Mirror the old CLI: compare filters separately from the current production gate and stored ML model.
        setPath(base, "entryQuality.enabled", false);
        setPath(base, "entryQuality.minAbsCvdSlope", -1_000_000d);
        setPath(base, "entryQuality.minVolumeRatio", 0d);
        setPath(base, "entryQuality.requireStructureAgreement", false);
        setPath(base, "entryQuality.maxDirectionalMove20Pct", null);
        setPath(base, "entryQuality.avoidRangeExtremes", false);
        setPath(base, "entryQuality.blockedIntervals", List.of());
        setPath(base, "ml.enabled", false);
        return base;
    }

    private Map<String, Object> compact(Map<String, Object> result) {
        Map<String, Object> stats = objectMap(result.get("stats"));
        Map<String, Object> settings = objectMap(result.get("settings"));
        Map<String, Object> compact = new LinkedHashMap<>();
        compact.put("trades", integer(stats.get("trades"), 0));
        compact.put("winRatePercent", finite(stats.get("winRatePercent")));
        compact.put("profitFactor", finite(stats.get("profitFactor")));
        compact.put("expectancyPercent", finite(stats.get("expectancyPercent")));
        compact.put("totalReturnPercent", finite(stats.get("totalReturnPercent")));
        compact.put("maxDrawdownPercent", finite(stats.get("maxDrawdownPercent")));
        compact.put("skippedByEntryFilter", integer(settings.get("skippedByEntryQuality"), 0));
        return compact;
    }

    private boolean isTrainingEligible(Map<String, Object> candidate, Map<String, Object> baseline) {
        int baselineTrades = integer(baseline.get("trades"), 0);
        if (integer(candidate.get("trades"), 0) < Math.max(12, (int) Math.ceil(baselineTrades * .5))) return false;
        Double candidatePf = finite(candidate.get("profitFactor"));
        Double baselinePf = finite(baseline.get("profitFactor"));
        Double candidateWin = finite(candidate.get("winRatePercent"));
        Double baselineWin = finite(baseline.get("winRatePercent"));
        return candidatePf != null && baselinePf != null && candidateWin != null && baselineWin != null
                && candidatePf >= baselinePf + .1 && candidateWin >= baselineWin + 5;
    }

    private boolean validationPasses(Map<String, Object> selected, Map<String, Object> baseline) {
        Double selectedPf = finite(selected.get("profitFactor"));
        Double baselinePf = finite(baseline.get("profitFactor"));
        Double selectedWin = finite(selected.get("winRatePercent"));
        Double baselineWin = finite(baseline.get("winRatePercent"));
        return integer(selected.get("trades"), 0) >= 8 && selectedPf != null && baselinePf != null
                && selectedWin != null && baselineWin != null
                && selectedPf >= baselinePf + .1 && selectedWin >= baselineWin + 3;
    }

    private Map<String, Object> candidateRow(FilterCandidate candidate, Map<String, Object> metrics) {
        Map<String, Object> row = selectedDescription(candidate);
        row.putAll(metrics);
        return row;
    }

    private Map<String, Object> selectedDescription(FilterCandidate candidate) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", candidate.name());
        row.put("proposedThresholds", candidate.proposedThresholds());
        return row;
    }

    private Map<String, Object> stopLossEntry(Map<String, Object> trade) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("entryTime", trade.get("entryTime"));
        row.put("side", trade.get("side"));
        row.put("netPercent", trade.get("netPercent"));
        row.put("score", trade.get("score"));
        row.put("diagnostics", trade.get("entryDiagnostics"));
        return row;
    }

    private Map<String, Object> summarizeDiagnostics(List<Map<String, Object>> rows) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("count", rows.size());
        result.put("long", rows.stream().filter(row -> "long".equals(row.get("side"))).count());
        result.put("short", rows.stream().filter(row -> "short".equals(row.get("side"))).count());
        result.put("averageScore", mean(rows, row -> diagnostic(row, "combinedScore")));
        result.put("averageConsensusPercent", mean(rows, row -> diagnostic(row, "consensusPercent")));
        result.put("averageVolumeRatio", mean(rows, row -> diagnostic(row, "volumeRatio")));
        result.put("averageCvdSlope", mean(rows, row -> diagnostic(row, "cvdSlope")));
        result.put("averagePriceChange20Pct", mean(rows, row -> diagnostic(row, "priceChange20Pct")));
        result.put("averageRangePosition50", mean(rows, row -> diagnostic(row, "rangePosition50")));
        Map<String, Object> groups = new LinkedHashMap<>();
        for (String group : List.of("cvd", "volume", "structure", "historicalPattern")) {
            groups.put(group, mean(rows, row -> groupScore(row, group)));
        }
        result.put("groupScores", groups);
        Map<String, Object> flags = new LinkedHashMap<>();
        flags.put("lowVolumeBelow0_8", rows.stream().filter(row -> number(diagnostic(row, "volumeRatio"), 0) < .8).count());
        flags.put("cvdAgainstEntry", rows.stream().filter(this::cvdAgainstEntry).count());
        flags.put("entryAtOppositeRangeExtreme", rows.stream().filter(this::oppositeRangeExtreme).count());
        result.put("flags", flags);
        return result;
    }

    private Object diagnostic(Map<String, Object> row, String key) {
        return objectMap(row.get("entryDiagnostics")).get(key);
    }

    private Object groupScore(Map<String, Object> row, String group) {
        return objectMap(objectMap(row.get("entryDiagnostics")).get("groupScores")).get(group);
    }

    private boolean cvdAgainstEntry(Map<String, Object> row) {
        double slope = number(diagnostic(row, "cvdSlope"), 0);
        return ("long".equals(row.get("side")) && slope < 0) || ("short".equals(row.get("side")) && slope > 0);
    }

    private boolean oppositeRangeExtreme(Map<String, Object> row) {
        double position = number(diagnostic(row, "rangePosition50"), .5);
        return ("long".equals(row.get("side")) && position > .8)
                || ("short".equals(row.get("side")) && position < .2);
    }

    private static Double mean(List<Map<String, Object>> rows, Function<Map<String, Object>, Object> pick) {
        if (rows.isEmpty()) return null;
        double total = 0;
        for (Map<String, Object> row : rows) total += number(pick.apply(row), 0);
        return round(total / rows.size(), 3);
    }

    private static List<Map<String, Object>> tradeRows(Object raw) {
        if (!(raw instanceof Iterable<?> rows)) return List.of();
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object row : rows) if (row instanceof Map<?, ?> map) result.add(objectMap(map));
        return result;
    }

    private String allowedSymbol(String input, JsonNode strategy) {
        if (strategy == null || !strategy.isObject()) throw new IllegalArgumentException("A strategy object is required for research.");
        return universe.requireAllowed(input, strategy);
    }

    private static void requireInterval(String interval) {
        if (interval == null || !BinanceClient.INTERVAL_MS.containsKey(interval)) {
            throw new IllegalArgumentException("Unsupported interval: " + interval);
        }
    }

    private static int backtestCandles(int requested) {
        return Math.max(MIN_BACKTEST_CANDLES, Math.min(MAX_HISTORY_CANDLES, requested <= 0 ? 3000 : requested));
    }

    private static int validationCandles(int requested) {
        return Math.max(MIN_VALIDATION_CANDLES, Math.min(MAX_HISTORY_CANDLES, requested <= 0 ? 3000 : requested));
    }

    private static int historicalCandleCount(String interval, JsonNode config) {
        long intervalMs = BinanceClient.INTERVAL_MS.get(interval);
        int months = Math.max(1, Math.min(6, config.path("maxMonths").asInt(6)));
        int lookback = Math.max(8, config.path("lookbackBars").asInt(24));
        int future = Math.max(1, config.path("futureBars").asInt(12));
        ZonedDateTime now = Instant.now().atZone(ZoneOffset.UTC);
        long coveredMillis = now.toInstant().toEpochMilli() - now.minusMonths(months).toInstant().toEpochMilli();
        long requested = (long) Math.ceil(coveredMillis / (double) intervalMs) + lookback + future + 2L;
        return (int) Math.min(MAX_HISTORY_CANDLES, requested);
    }

    /**
     * HistoricalPatternService returns the match rows used by the former CLI.
     * Recreate the display-only aggregate fields here so the whitelist report
     * remains compatible even when an unavailable result has fewer fields.
     */
    private static void completePatternSummary(Map<String, Object> report, JsonNode config) {
        List<Map<String, Object>> matches = tradeRows(report.get("matches"));
        if (matches.isEmpty()) return;
        List<Double> forward = new ArrayList<>();
        List<Double> similarities = new ArrayList<>();
        List<Double> pathErrors = new ArrayList<>();
        List<Double> p95Errors = new ArrayList<>();
        List<Double> toleranceCoverage = new ArrayList<>();
        for (Map<String, Object> match : matches) {
            forward.add(number(match.get("forwardReturnPct"), 0));
            similarities.add(number(match.get("similarity"), 0));
            pathErrors.add(number(match.get("relativePathError"), 0));
            p95Errors.add(number(match.get("p95RelativePathError"), 0));
            toleranceCoverage.add(number(match.get("barsWithinRelativeTolerancePercent"), 0));
        }
        double weight = similarities.stream().mapToDouble(Double::doubleValue).sum();
        double weightedForward = weight <= 0 ? average(forward) : 0;
        if (weight > 0) {
            for (int index = 0; index < forward.size(); index++) weightedForward += forward.get(index) * similarities.get(index);
            weightedForward /= weight;
        }
        String side = String.valueOf(report.getOrDefault("side", "none"));
        List<Double> sorted = new ArrayList<>(forward);
        sorted.sort(Double::compareTo);
        double variance = 0;
        for (double value : forward) variance += Math.pow(value - weightedForward, 2);
        variance /= forward.size();
        report.putIfAbsent("futureBars", Math.max(1, config.path("futureBars").asInt(12)));
        report.putIfAbsent("avgSimilarity", round(average(similarities), 1));
        report.putIfAbsent("avgRelativePathError", round(average(pathErrors), 1));
        report.putIfAbsent("avgP95RelativePathError", round(average(p95Errors), 1));
        report.putIfAbsent("avgBarsWithinRelativeTolerancePercent", round(average(toleranceCoverage), 1));
        report.putIfAbsent("avgForwardReturnPct", round(weightedForward, 2));
        report.putIfAbsent("medianForwardReturnPct", round(percentile(sorted, .5), 2));
        report.putIfAbsent("worstForwardReturnPct", round("short".equals(side) ? sorted.get(sorted.size() - 1) : sorted.get(0), 2));
        report.putIfAbsent("bestForwardReturnPct", round("short".equals(side) ? sorted.get(0) : sorted.get(sorted.size() - 1), 2));
        report.putIfAbsent("forwardReturnStdDev", round(Math.sqrt(variance), 2));
    }

    private static double average(List<Double> values) {
        return values.stream().mapToDouble(Double::doubleValue).average().orElse(0);
    }

    private static double percentile(List<Double> sorted, double p) {
        if (sorted.isEmpty()) return 0;
        double at = Math.max(0, Math.min(1, p)) * (sorted.size() - 1);
        int low = (int) Math.floor(at);
        int high = (int) Math.ceil(at);
        return sorted.get(low) + (sorted.get(high) - sorted.get(low)) * (at - low);
    }

    private void setPath(ObjectNode root, String dottedPath, Object value) {
        String[] parts = dottedPath.split("\\.");
        ObjectNode current = root;
        for (int i = 0; i < parts.length - 1; i++) {
            JsonNode child = current.get(parts[i]);
            if (child == null || !child.isObject()) {
                ObjectNode next = mapper.createObjectNode();
                current.set(parts[i], next);
                current = next;
            } else {
                current = (ObjectNode) child;
            }
        }
        JsonNode node = value instanceof JsonNode json ? json.deepCopy() : mapper.valueToTree(value);
        current.set(parts[parts.length - 1], node);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> objectMap(Object value) {
        if (!(value instanceof Map<?, ?> map)) return Map.of();
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) result.put(String.valueOf(entry.getKey()), entry.getValue());
        return result;
    }

    private static double number(Object value, double fallback) {
        if (value instanceof Number number) return Double.isFinite(number.doubleValue()) ? number.doubleValue() : fallback;
        if (value == null) return fallback;
        try {
            double parsed = Double.parseDouble(value.toString());
            return Double.isFinite(parsed) ? parsed : fallback;
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }

    private static int integer(Object value, int fallback) {
        double number = number(value, Double.NaN);
        return Double.isFinite(number) ? (int) number : fallback;
    }

    private static Double finite(Object value) {
        double number = number(value, Double.NaN);
        return Double.isFinite(number) ? number : null;
    }

    private static double descendingMetric(Map<String, Object> metrics, String field) {
        Double value = finite(metrics.get(field));
        return value == null ? Double.POSITIVE_INFINITY : -value;
    }

    private static double round(double value, int digits) {
        double scale = Math.pow(10, digits);
        return Math.round(value * scale) / scale;
    }

    private record Segments(Map<String, Object> training, Map<String, Object> holdout) {}
    private record FilterCandidate(String name, Map<String, Object> proposedThresholds, ObjectNode strategy) {}
    private record CandidateRun(FilterCandidate candidate, Map<String, Object> training, Map<String, Object> holdout) {}
}
