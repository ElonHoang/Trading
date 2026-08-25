package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.auth.DocumentStore;
import vn.dongtien.trading.backtest.BacktestService;
import vn.dongtien.trading.config.StrategyService;
import vn.dongtien.trading.market.BinanceClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Persistent, conservative auto-retuning after a streak of closed stop-losses.
 *
 * <p>This is a Java port of the removed {@code analysis/auto-retune.js}.  It
 * deliberately stores proposals in the same document shape used by the former
 * runtime ({@value #STATE_KEY}), so persisted database state remains usable.
 * A configuration is only proposed/applied after each affected pair and every
 * guard pair passes both train and holdout checks.</p>
 */
@Service
public class AutoRetuneService {
    public static final String STATE_KEY = "data:auto-retune";

    private static final Map<String, String> GROUP_LABELS = Map.ofEntries(
            Map.entry("cvd", "CVD"), Map.entry("volume", "Khối lượng"),
            Map.entry("derivatives", "Phái sinh"), Map.entry("positioning", "Định vị đám đông"),
            Map.entry("structure", "Hỗ trợ/kháng cự"), Map.entry("orderBook", "Sổ lệnh"),
            Map.entry("historicalPattern", "Mẫu hình lịch sử"));

    private final DocumentStore documents;
    private final ObjectMapper mapper;
    private final AnalysisService analysis;
    private final BinanceClient binance;
    private final BacktestService backtest;
    private final StrategyService strategies;
    private final TradingStateLock stateLock;

    public AutoRetuneService(DocumentStore documents, ObjectMapper mapper, AnalysisService analysis, BinanceClient binance,
                             BacktestService backtest, StrategyService strategies, TradingStateLock stateLock) {
        this.documents = documents;
        this.mapper = mapper;
        this.analysis = analysis;
        this.binance = binance;
        this.backtest = backtest;
        this.strategies = strategies;
        this.stateLock = stateLock;
    }

    /** Loads and normalizes the shared JSON state without dropping unknown fields. */
    public ObjectNode readState() {
        ObjectNode state = ReviewSupport.objectCopy(mapper, documents.find(STATE_KEY).orElse(null));
        normalizeState(state);
        return state;
    }

    /** Alias retaining the name used by the old runtime and operational notes. */
    public ObjectNode readAutoRetuneState() { return readState(); }

    public void saveState(JsonNode state) {
        stateLock.runLocked(() -> documents.put(STATE_KEY, state == null ? emptyState() : state));
    }

    public void saveAutoRetuneState(JsonNode state) { saveState(state); }

    /** A fresh state is public for command handlers and tests that do not yet have a document. */
    public ObjectNode emptyState() {
        ObjectNode state = mapper.createObjectNode();
        state.putArray("trades");
        state.putArray("attempts");
        state.putArray("reviews");
        state.putArray("lossLogs");
        state.putNull("lossLogWeek");
        state.putNull("activeTuning");
        state.putNull("lastHandledTriggerId");
        state.putNull("lastAppliedAt");
        state.putNull("lastReviewAt");
        return state;
    }

    private void normalizeState(ObjectNode state) {
        for (String field : List.of("trades", "attempts", "reviews", "lossLogs")) {
            if (!state.path(field).isArray()) state.set(field, mapper.createArrayNode());
        }
    }

    /**
     * Captures evidence at call time.  It intentionally only copies values
     * available in the analysis snapshot, never a later market observation.
     */
    public ObjectNode buildCallEvidence(JsonNode snapshot, JsonNode setup) {
        ObjectNode evidence = mapper.createObjectNode();
        evidence.put("side", ReviewSupport.text(setup == null ? null : setup.get("side"), null));
        putFiniteOrNull(evidence, "score", ReviewSupport.finite(snapshot == null ? null : ReviewSupport.at(snapshot, "combined.score")));
        putFiniteOrNull(evidence, "consensusPercent", ReviewSupport.finite(snapshot == null ? null : ReviewSupport.at(snapshot, "rules.consensus.percent")));
        Double risk = ReviewSupport.finite(setup == null ? null : setup.get("riskPercent"));
        if (risk == null) risk = ReviewSupport.finite(snapshot == null ? null : ReviewSupport.at(snapshot, "levels.riskPercent"));
        putFiniteOrNull(evidence, "riskPercent", risk);
        putFiniteOrNull(evidence, "cvdSlope", ReviewSupport.finite(snapshot == null ? null : ReviewSupport.at(snapshot, "indicators.cvdSlope")));
        putFiniteOrNull(evidence, "volumeRatio", ReviewSupport.finite(snapshot == null ? null : ReviewSupport.at(snapshot, "indicators.volumeRatio")));

        ObjectNode groups = evidence.putObject("groups");
        JsonNode breakdown = snapshot == null ? null : ReviewSupport.at(snapshot, "rules.breakdown");
        if (breakdown != null && breakdown.isObject()) {
            breakdown.properties().forEach(entry -> {
                ObjectNode group = groups.putObject(entry.getKey());
                JsonNode value = entry.getValue();
                copyOrNull(group, "score", value.get("score"));
                copyOrNull(group, "contributionPct", value.get("contributionPct"));
                group.put("skipped", ReviewSupport.bool(value.get("skipped"), false));
            });
        }

        JsonNode close = snapshot == null ? null : ReviewSupport.at(snapshot, "series.close");
        JsonNode high = snapshot == null ? null : ReviewSupport.at(snapshot, "series.high");
        JsonNode low = snapshot == null ? null : ReviewSupport.at(snapshot, "series.low");
        if (close != null && close.isArray() && !close.isEmpty()) {
            int last = close.size() - 1;
            int from = Math.max(0, last - 19);
            double current = ReviewSupport.number(close.get(last), Double.NaN);
            double first = ReviewSupport.number(close.get(from), Double.NaN);
            putFiniteOrNull(evidence, "priceChange20Pct", Double.isFinite(current) && Double.isFinite(first) && first != 0
                    ? ReviewSupport.round((current - first) / first * 100, 2) : null);
            double rangeHigh = Double.NEGATIVE_INFINITY;
            double rangeLow = Double.POSITIVE_INFINITY;
            for (int index = Math.max(0, last - 49); index <= last; index++) {
                double candleHigh = ReviewSupport.number(high != null && high.isArray() && index < high.size() ? high.get(index) : close.get(index), Double.NaN);
                double candleLow = ReviewSupport.number(low != null && low.isArray() && index < low.size() ? low.get(index) : close.get(index), Double.NaN);
                rangeHigh = Math.max(rangeHigh, candleHigh);
                rangeLow = Math.min(rangeLow, candleLow);
            }
            putFiniteOrNull(evidence, "rangePosition50", Double.isFinite(current) && rangeHigh > rangeLow
                    ? ReviewSupport.round((current - rangeLow) / (rangeHigh - rangeLow), 3) : 0.5d);
        } else {
            evidence.putNull("priceChange20Pct");
            evidence.putNull("rangePosition50");
        }
        return evidence;
    }

    /** Convenience bridge for a caller that has not already retained an analysis snapshot. */
    public ObjectNode buildCallEvidence(String symbol, String interval, JsonNode strategy, JsonNode setup) {
        return buildCallEvidence(mapper.valueToTree(analysis.analyze(symbol, interval, strategy, 50)), setup);
    }

    /** Saves one completed trade and returns its persisted state plus its SL streak. */
    public Map<String, Object> recordClosedTrade(JsonNode call, JsonNode result, JsonNode snapshot, int historyLimit) {
        return stateLock.withLock(() -> recordClosedTradeLocked(call, result, snapshot, historyLimit));
    }

    private Map<String, Object> recordClosedTradeLocked(JsonNode call, JsonNode result, JsonNode snapshot, int historyLimit) {
        ObjectNode state = readState();
        String interval = ReviewSupport.text(call == null ? null : call.get("interval"),
                ReviewSupport.text(snapshot == null ? null : snapshot.get("interval"), ""));
        Instant candleStart = ReviewSupport.instant(snapshot == null ? null : snapshot.get("lastClosedCandleTime"));
        Long intervalMillis = BinanceClient.INTERVAL_MS.get(interval);
        Instant fallback = candleStart != null && intervalMillis != null
                ? candleStart.plusMillis(intervalMillis - 1)
                : ReviewSupport.instant(snapshot == null ? null : snapshot.get("generatedAt"));
        if (fallback == null) fallback = candleStart == null ? Instant.now() : candleStart;
        Instant closed = ReviewSupport.instant(result == null ? null : result.get("closedAt"));
        if (closed == null) closed = fallback;
        String status = ReviewSupport.text(result == null ? null : result.get("status"), "unknown");

        ObjectNode trade = mapper.createObjectNode();
        String symbol = ReviewSupport.text(call == null ? null : call.get("symbol"), "");
        String openedAtCandle = ReviewSupport.text(call == null ? null : call.get("openedAtCandle"), "");
        trade.put("id", symbol + "|" + interval + "|" + openedAtCandle + "|" + closed + "|" + status);
        trade.put("symbol", symbol);
        trade.put("interval", interval);
        copyOrNull(trade, "side", call == null ? null : call.get("side"));
        copyOrNull(trade, "openedAt", call == null ? null : call.get("openedAt"));
        trade.put("closedAt", closed.toString());
        copyOrNull(trade, "entry", call == null ? null : call.get("entry"));
        copyOrNull(trade, "stopLoss", call == null ? null : call.get("stopLoss"));
        copyOrNull(trade, "openedAtCandle", call == null ? null : call.get("openedAtCandle"));
        ArrayNode targets = trade.putArray("targets");
        JsonNode sourceTargets = call == null ? null : call.get("targets");
        if (sourceTargets != null && sourceTargets.isArray()) {
            for (JsonNode target : sourceTargets) {
                ObjectNode item = targets.addObject();
                copyOrNull(item, "label", target.get("label"));
                copyOrNull(item, "price", target.get("price"));
            }
        }
        ObjectNode storedResult = trade.putObject("result");
        storedResult.put("status", status);
        if (result != null && result.path("hitTps").isArray()) storedResult.set("hitTps", result.path("hitTps").deepCopy());
        else storedResult.putArray("hitTps");
        copyOrNull(storedResult, "bars", result == null ? null : result.get("bars"));
        copyOrNull(storedResult, "lastPrice", result == null ? null : result.get("lastPrice"));
        boolean reachedTp1 = "target".equals(status) || (storedResult.path("hitTps").isArray() && !storedResult.path("hitTps").isEmpty());
        storedResult.put("outcome", reachedTp1 ? "win" : "stopped".equals(status) ? "loss" : "neutral");
        copyOrNull(trade, "evidence", call == null ? null : call.get("evidence"));

        ArrayNode trades = (ArrayNode) state.path("trades");
        ObjectNode persisted = findById(trades, trade.path("id").asText());
        boolean recorded = persisted == null;
        if (recorded) trades.add(trade);
        else trade = persisted;
        int limit = Math.max(20, historyLimit > 0 ? historyLimit : 200);
        trimToLast(trades, limit);
        saveState(state);
        Map<String, Object> output = new LinkedHashMap<>();
        output.put("state", state);
        output.put("trade", trade);
        output.put("recorded", recorded);
        output.put("streak", stopLossStreak(trades));
        return output;
    }

    private static ObjectNode findById(ArrayNode trades, String id) {
        if (id == null || id.isBlank()) return null;
        for (JsonNode item : trades) {
            if (item.isObject() && id.equals(item.path("id").asText())) return (ObjectNode) item;
        }
        return null;
    }

    public Map<String, Object> recordClosedTrade(JsonNode call, JsonNode result, JsonNode snapshot) {
        return recordClosedTrade(call, result, snapshot, 200);
    }

    public int stopLossStreak(JsonNode trades) {
        if (trades == null || !trades.isArray()) return 0;
        int streak = 0;
        for (int index = trades.size() - 1; index >= 0; index--) {
            if (!"stopped".equals(ReviewSupport.text(trades.get(index).path("result").get("status"), ""))) break;
            streak++;
        }
        return streak;
    }

    /** Lists evidence groups that supported the losing direction in repeated stops. */
    public List<Map<String, Object>> diagnoseSupportingGroups(JsonNode trades) {
        Map<String, GroupTotal> totals = new LinkedHashMap<>();
        if (trades != null && trades.isArray()) {
            for (JsonNode trade : trades) {
                int direction = "long".equals(ReviewSupport.text(trade.get("side"), "")) ? 1 : -1;
                JsonNode groups = trade.path("evidence").path("groups");
                if (!groups.isObject()) continue;
                groups.properties().forEach(entry -> {
                    JsonNode evidence = entry.getValue();
                    double contribution = ReviewSupport.number(evidence.get("contributionPct"), Double.NaN);
                    if (!Double.isFinite(contribution) || ReviewSupport.bool(evidence.get("skipped"), false)
                            || contribution * direction <= 0) return;
                    GroupTotal current = totals.computeIfAbsent(entry.getKey(), GroupTotal::new);
                    current.count++;
                    current.totalContribution += Math.abs(contribution);
                });
            }
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (GroupTotal total : totals.values()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("group", total.group);
            row.put("label", GROUP_LABELS.getOrDefault(total.group, total.group));
            row.put("count", total.count);
            row.put("totalContribution", total.totalContribution);
            row.put("averageContribution", ReviewSupport.round(total.totalContribution / total.count, 2));
            result.add(row);
        }
        result.sort(Comparator.<Map<String, Object>>comparingInt(row -> ReviewSupport.integer(row.get("count"), 0)).reversed()
                .thenComparing((left, right) -> Double.compare(ReviewSupport.number(right.get("averageContribution"), 0),
                        ReviewSupport.number(left.get("averageContribution"), 0))));
        return result;
    }

    /** Applies dotted JSON changes to a deep copy; the source strategy is never mutated. */
    public ObjectNode applyStrategyChanges(JsonNode strategy, Map<String, ?> changes) {
        ObjectNode next = ReviewSupport.objectCopy(mapper, strategy);
        if (changes != null) {
            for (Map.Entry<String, ?> change : changes.entrySet()) {
                ReviewSupport.setPath(next, change.getKey(), mapper.valueToTree(change.getValue()), mapper);
            }
        }
        return next;
    }

    public ObjectNode applyStrategyChanges(JsonNode strategy, JsonNode changes) {
        ObjectNode next = ReviewSupport.objectCopy(mapper, strategy);
        if (changes != null && changes.isObject()) {
            changes.properties().forEach(entry -> ReviewSupport.setPath(next, entry.getKey(), entry.getValue(), mapper));
        }
        return next;
    }

    public ObjectNode applyActiveTuning(JsonNode strategy, JsonNode state) {
        JsonNode changes = state == null ? null : state.path("activeTuning").path("changes");
        return changes != null && changes.isObject() ? applyStrategyChanges(strategy, changes) : ReviewSupport.objectCopy(mapper, strategy);
    }

    /** Candidate set shared by streak retuning and the daily review. */
    public List<Candidate> buildRiskCandidates(JsonNode strategy, JsonNode config) {
        JsonNode risk = strategy == null ? null : strategy.path("risk");
        double currentStop = ReviewSupport.number(risk == null ? null : risk.get("slPercent"), 4);
        JsonNode configuredTp = risk == null ? null : risk.get("takeProfitR");
        List<Double> takeProfit = new ArrayList<>();
        if (configuredTp != null && configuredTp.isArray()) {
            for (JsonNode value : configuredTp) {
                double number = ReviewSupport.number(value, Double.NaN);
                if (Double.isFinite(number)) takeProfit.add(number);
            }
        }
        if (takeProfit.isEmpty()) takeProfit.addAll(List.of(.75, 1.5, 2.25));
        List<Candidate> result = new ArrayList<>();
        double step = Math.max(.1, ReviewSupport.number(config == null ? null : config.get("slPercentStep"), .5));
        double maxStop = Math.max(currentStop, ReviewSupport.number(config == null ? null : config.get("maxSlPercent"), 6));
        for (double next = currentStop + step, index = 0; next <= maxStop + 1e-9; next += step, index++) {
            double wider = ReviewSupport.round(Math.min(next, maxStop), 2);
            String id = index == 0 ? "wider-stop" : "wider-stop-" + String.valueOf(wider).replace('.', '-');
            ObjectNode changes = mapper.createObjectNode();
            changes.put("risk.slPercent", wider);
            result.add(candidate(strategy, id, "Nới khoảng SL " + currentStop + "% → " + wider + "%", changes,
                    "Lệnh thua thường có khoảng SL hẹp hơn phần còn lại, tức SL nằm trong biên độ nhiễu.", "risk"));
        }
        if (ReviewSupport.bool(risk == null ? null : risk.get("preferSrLevels"), false)) {
            ObjectNode changes = mapper.createObjectNode();
            changes.put("risk.preferSrLevels", false);
            result.add(candidate(strategy, "fixed-stop", "Bỏ bám SL vào hỗ trợ/kháng cự", changes,
                    "Bám cấu trúc có thể làm khoảng SL thật hẹp hơn cấu hình.", "risk"));
        }
        double tp1 = takeProfit.get(0);
        double nearer = Math.max(ReviewSupport.number(config == null ? null : config.get("minTp1R"), .5),
                ReviewSupport.round(tp1 - ReviewSupport.number(config == null ? null : config.get("tp1Step"), .25), 2));
        if (nearer < tp1) {
            double ratio = nearer / tp1;
            ArrayNode values = mapper.createArrayNode();
            for (double target : takeProfit) values.add(ReviewSupport.round(target * ratio, 3));
            ObjectNode changes = mapper.createObjectNode();
            changes.set("risk.takeProfitR", values);
            result.add(candidate(strategy, "nearer-tp1", "Kéo TP gần lại (TP1 " + tp1 + "R → " + nearer + "R)", changes,
                    "TP1 gần hơn giúp nhiều lệnh được bảo vệ sớm hơn.", "risk"));
        }
        return result;
    }

    public List<Candidate> buildRetuneCandidates(JsonNode strategy, JsonNode config) {
        double current = ReviewSupport.number(strategy == null ? null : ReviewSupport.at(strategy, "risk.slPercent"), Double.NaN);
        double floor = ReviewSupport.number(config == null ? null : config.get("minSlPercent"), 3);
        double limit = Double.isFinite(current) ? Math.min(floor, current) : floor;
        return buildRiskCandidates(strategy, config).stream().filter(item -> {
            double stop = ReviewSupport.number(ReviewSupport.at(item.strategy(), "risk.slPercent"), Double.NaN);
            return !Double.isFinite(stop) || stop >= limit;
        }).toList();
    }

    public Map<String, Object> runAutoRetune(JsonNode strategy, ObjectNode state) {
        return runAutoRetune(strategy, state, Instant.now());
    }

    /** Loads the shared state, runs a review, and persists any resulting attempt. */
    public Map<String, Object> runAutoRetune(JsonNode strategy) {
        return runAutoRetune(strategy, readState(), Instant.now());
    }

    /** Runs a streak review using a supplied clock for deterministic jobs/tests. */
    public Map<String, Object> runAutoRetune(JsonNode strategy, ObjectNode state, Instant now) {
        if (state == null) state = readState();
        normalizeState(state);
        JsonNode config = strategy == null ? null : strategy.path("autoRetune");
        boolean enabled = ReviewSupport.bool(config == null ? null : config.get("enabled"), false);
        int streak = stopLossStreak(state.path("trades"));
        int required = Math.max(3, ReviewSupport.integer(config == null ? null : config.get("stopLossStreak"), 3));
        JsonNode latest = state.path("trades").isEmpty() ? null : state.path("trades").get(state.path("trades").size() - 1);
        Map<String, Object> base = new LinkedHashMap<>();
        base.put("enabled", enabled);
        base.put("streak", streak);
        base.put("requiredStreak", required);
        base.put("triggerTradeId", latest == null ? null : ReviewSupport.text(latest.get("id"), null));
        if (!enabled || streak < required || latest == null) return report("not-triggered", base);
        if (ReviewSupport.text(state.get("lastHandledTriggerId"), "").equals(ReviewSupport.text(latest.get("id"), ""))) {
            return report("already-handled", base);
        }

        state.put("lastHandledTriggerId", ReviewSupport.text(latest.get("id"), ""));
        double cooldownHours = Math.max(0, ReviewSupport.number(config == null ? null : config.get("cooldownHours"), 168));
        Instant lastApplied = ReviewSupport.instant(state.get("lastAppliedAt"));
        List<Map<String, Object>> suspects = diagnoseSupportingGroups(lastTrades(state.path("trades"), streak));
        if (lastApplied != null && now.toEpochMilli() - lastApplied.toEpochMilli() < cooldownHours * 3_600_000d) {
            Map<String, Object> result = report("cooldown", base);
            result.put("suspectedGroups", suspects);
            appendAttempt(state, now, result);
            saveState(state);
            return result;
        }

        try {
            int maxSymbols = Math.max(1, ReviewSupport.integer(config == null ? null : config.get("maxSymbols"), 3));
            List<Pair> losses = pairsFromTrades(lastTrades(state.path("trades"), streak), maxSymbols);
            String guardInterval = ReviewSupport.text(config == null ? null : config.get("guardInterval"), "4h");
            List<Pair> guards = guardPairs(config, guardInterval);
            int requestedCandles = Math.max(600, ReviewSupport.integer(config == null ? null : config.get("backtestCandles"), 3000));
            double trainingRatio = ReviewSupport.number(config == null ? null : config.get("trainingRatio"), .75);
            if (!(trainingRatio > 0 && trainingRatio < 1)) trainingRatio = .75;

            Map<String, ReviewSupport.BacktestSegments> baseline = new LinkedHashMap<>();
            for (Pair pair : join(losses, guards)) {
                baseline.put(pair.key(), ReviewSupport.backtestSegments(binance, backtest, pair.symbol(), pair.interval(), strategy,
                        requestedCandles, trainingRatio));
            }
            List<Map<String, Object>> baselineRows = baselineRows(baseline, join(losses, guards));
            List<Map<String, Object>> evaluated = new ArrayList<>();
            for (Candidate candidate : buildRetuneCandidates(strategy, config)) {
                List<Map<String, Object>> byPair = new ArrayList<>();
                for (Pair pair : join(losses, guards)) {
                    ReviewSupport.BacktestSegments baseSegments = baseline.get(pair.key());
                    ReviewSupport.BacktestSegments tested = ReviewSupport.backtestSegments(binance, backtest, pair.symbol(), pair.interval(),
                            candidate.strategy(), requestedCandles, trainingRatio);
                    boolean passed = pair.guard()
                            ? passesGuardCheck(baseSegments.train(), tested.train(), config) && passesGuardCheck(baseSegments.holdout(), tested.holdout(), config)
                            : passesRiskCheck(baseSegments.train(), tested.train(), config) && passesRiskCheck(baseSegments.holdout(), tested.holdout(), config);
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("key", pair.key()); row.put("guard", pair.guard()); row.put("train", tested.train());
                    row.put("validation", tested.holdout()); row.put("passes", passed);
                    byPair.add(row);
                }
                List<Map<String, Object>> lossRows = byPair.stream().filter(row -> !Boolean.TRUE.equals(row.get("guard"))).toList();
                List<Map<String, Object>> guardRows = byPair.stream().filter(row -> Boolean.TRUE.equals(row.get("guard"))).toList();
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("id", candidate.id()); item.put("label", candidate.label()); item.put("changes", candidate.changes());
                item.put("because", candidate.because()); item.put("kind", candidate.kind()); item.put("byPair", byPair);
                item.put("improves", lossRows.stream().allMatch(row -> Boolean.TRUE.equals(row.get("passes"))));
                item.put("guardOk", guardRows.stream().allMatch(row -> Boolean.TRUE.equals(row.get("passes"))));
                item.put("passes", byPair.stream().allMatch(row -> Boolean.TRUE.equals(row.get("passes"))));
                item.put("validation", averageMetrics(lossRows, "validation"));
                item.put("guardValidation", averageMetrics(guardRows, "validation"));
                evaluated.add(item);
            }
            evaluated.sort(Comparator.comparing((Map<String, Object> item) -> ReviewSupport.number(asMap(item.get("validation")).get("maxDrawdownPercent"), 0))
                    .thenComparing((left, right) -> Double.compare(ReviewSupport.number(asMap(right.get("validation")).get("profitFactor"), 0),
                            ReviewSupport.number(asMap(left.get("validation")).get("profitFactor"), 0)))
                    .thenComparing((left, right) -> Double.compare(ReviewSupport.number(asMap(right.get("validation")).get("expectancyPercent"), 0),
                            ReviewSupport.number(asMap(left.get("validation")).get("expectancyPercent"), 0))));
            Map<String, Object> selected = evaluated.stream().filter(item -> Boolean.TRUE.equals(item.get("passes"))).findFirst().orElse(null);
            boolean autoApply = ReviewSupport.bool(config == null ? null : config.get("autoApply"), false);
            boolean runtimeApply = ReviewSupport.bool(config == null ? null : config.get("runtimeApply"), false);
            boolean applied = selected != null && (autoApply || runtimeApply);

            Map<String, Object> result = report(selected == null ? "no-safe-change" : applied ? "applied" : "proposed", base);
            result.put("autoApply", autoApply); result.put("runtimeApply", runtimeApply); result.put("guardInterval", guardInterval);
            result.put("suspectedGroups", suspects); result.put("pairs", baselineRows); result.put("candidates", evaluated);
            result.put("selected", selected == null ? null : selectedSummary(selected, "validation", "guardValidation"));
            if (applied) {
                ObjectNode selectedChanges = (ObjectNode) selected.get("changes");
                putActiveTuning(state, "stop-loss-streak", now, selectedChanges, String.valueOf(selected.get("id")), null);
                if (autoApply) {
                    result.put("backupFile", backupStrategy(strategy, result, now));
                    Candidate candidate = buildRetuneCandidates(strategy, config).stream()
                            .filter(item -> item.id().equals(selected.get("id"))).findFirst().orElse(null);
                    if (candidate != null) strategies.saveStrategy(candidate.strategy());
                }
            }
            appendAttempt(state, now, result);
            saveState(state);
            return result;
        } catch (RuntimeException error) {
            Map<String, Object> result = report("failed", base);
            result.put("suspectedGroups", suspects);
            result.put("error", error.getMessage());
            appendAttempt(state, now, result);
            saveState(state);
            return result;
        }
    }

    /** Human-readable summary suitable for a Telegram/console notification. */
    public String formatAutoRetuneReport(Map<String, Object> report) {
        if (report == null) return null;
        String title = "🧪 TỰ KIỂM CHỨNG SAU " + ReviewSupport.integer(report.get("streak"), 0) + " SL LIÊN TIẾP";
        List<String> groups = new ArrayList<>();
        Object rawGroups = report.get("suspectedGroups");
        if (rawGroups instanceof List<?> values) {
            for (Object value : values.subList(0, Math.min(3, values.size()))) {
                Map<String, Object> group = asMap(value);
                groups.add(group.getOrDefault("label", "?") + " (" + ReviewSupport.integer(group.get("count"), 0)
                        + " kèo, đóng góp TB " + group.getOrDefault("averageContribution", "?") + " điểm)");
            }
        }
        String groupText = groups.isEmpty() ? "chưa đủ dữ liệu nhóm" : String.join(" · ", groups);
        String status = String.valueOf(report.get("status"));
        if ("applied".equals(status) || "proposed".equals(status)) {
            Map<String, Object> selected = asMap(report.get("selected"));
            Map<String, Object> validation = asMap(selected.get("validation"));
            Map<String, Object> guard = asMap(selected.get("guardValidation"));
            String verb = "applied".equals(status) ? "Đã áp dụng" : "ĐỀ XUẤT (chưa tự ghi)";
            String because = selected.get("because") == null ? "" : "\nLý do: " + selected.get("because");
            String changes = stringifyChanges(selected.get("changes"));
            String ending = "applied".equals(status)
                    ? (report.get("backupFile") == null
                    ? "Thay đổi đã được lưu vào state và sẽ có hiệu lực từ lượt quét sau."
                    : "Cấu hình cũ đã được sao lưu trong database trước khi thay đổi.")
                    : "Dùng lệnh quản trị cấu hình để áp dụng đề xuất vào database.";
            return title + "\nNhóm cần xem xét: " + groupText + ".\n" + verb + ": " + selected.get("label") + "." + because
                    + "\nTrên các cặp vừa thua: PF " + validation.get("profitFactor") + ", drawdown " + validation.get("maxDrawdownPercent")
                    + "%, " + validation.get("trades") + " lệnh.\nTrên bộ canh gác khung " + report.getOrDefault("guardInterval", "4h")
                    + ": PF " + guard.get("profitFactor") + ", kỳ vọng " + guard.get("expectancyPercent") + "%/lệnh.\nThay đổi: " + changes + "\n" + ending;
        }
        if ("no-safe-change".equals(status)) return title + "\nNhóm cần xem xét: " + groupText + ".\n"
                + "Đã kiểm chứng các phương án nới SL / bỏ bám cấu trúc / kéo TP1 gần lại nhưng chưa phương án nào vừa cải thiện các cặp vừa thua vừa giữ được bộ canh gác. Giữ nguyên để tránh tối ưu theo nhiễu.";
        if ("cooldown".equals(status)) return title + "\nĐang trong thời gian chờ sau lần tinh chỉnh trước; bot chỉ ghi nhận thêm dữ liệu, chưa sửa tiếp.";
        if ("failed".equals(status)) return title + "\nKhông thể hoàn tất kiểm chứng: " + report.get("error") + ". Giữ nguyên cấu hình.";
        return null;
    }

    private Map<String, Object> selectedSummary(Map<String, Object> selected, String validation, String guardValidation) {
        Map<String, Object> summary = new LinkedHashMap<>();
        for (String key : List.of("id", "label", "changes", "because")) summary.put(key, selected.get(key));
        summary.put("validation", selected.get(validation));
        summary.put("guardValidation", selected.get(guardValidation));
        return summary;
    }

    private String backupStrategy(JsonNode strategy, Map<String, Object> report, Instant now) {
        String key = "backup:strategy:" + now;
        ObjectNode backup = mapper.createObjectNode();
        backup.set("strategy", ReviewSupport.copy(strategy, mapper));
        backup.set("report", mapper.valueToTree(report));
        documents.put(key, backup);
        return "database:" + key;
    }

    private void putActiveTuning(ObjectNode state, String source, Instant now, ObjectNode changes, String selectedId,
                                 Integer comparisonDays) {
        ObjectNode tuning = state.path("activeTuning").isObject()
                ? ((ObjectNode) state.path("activeTuning")).deepCopy() : mapper.createObjectNode();
        ObjectNode merged = tuning.path("changes").isObject() ? ((ObjectNode) tuning.path("changes")).deepCopy() : mapper.createObjectNode();
        changes.properties().forEach(entry -> merged.set(entry.getKey(), entry.getValue().deepCopy()));
        tuning.put("source", source); tuning.put("appliedAt", now.toString()); tuning.set("changes", merged);
        tuning.put("selectedId", selectedId);
        if (comparisonDays != null) tuning.put("comparisonDays", comparisonDays);
        state.set("activeTuning", tuning);
        state.put("lastAppliedAt", now.toString());
    }

    private boolean passesGuardCheck(Map<String, Object> baseline, Map<String, Object> proposed, JsonNode config) {
        int minTrades = Math.max(5, ReviewSupport.integer(config == null ? null : config.get("minTradesPerSegment"), 8));
        if (ReviewSupport.integer(proposed.get("trades"), 0) < minTrades) return false;
        Double pf = ReviewSupport.finite(proposed.get("profitFactor"));
        Double expectancy = ReviewSupport.finite(proposed.get("expectancyPercent"));
        if (pf == null || expectancy == null) return false;
        double tolerance = ReviewSupport.number(config == null ? null : config.get("guardExpectancyTolerance"), .02);
        return expectancy > 0 && pf >= ReviewSupport.number(config == null ? null : config.get("minProfitFactor"), 1.05)
                && expectancy >= ReviewSupport.number(baseline.get("expectancyPercent"), 0) - tolerance;
    }

    private boolean passesRiskCheck(Map<String, Object> baseline, Map<String, Object> proposed, JsonNode config) {
        int minTrades = Math.max(5, ReviewSupport.integer(config == null ? null : config.get("minTradesPerSegment"), 8));
        if (ReviewSupport.integer(proposed.get("trades"), 0) < minTrades) return false;
        Double pf = ReviewSupport.finite(proposed.get("profitFactor"));
        Double expectancy = ReviewSupport.finite(proposed.get("expectancyPercent"));
        Double drawdown = ReviewSupport.finite(proposed.get("maxDrawdownPercent"));
        Double baseDrawdown = ReviewSupport.finite(baseline.get("maxDrawdownPercent"));
        if (pf == null || expectancy == null || drawdown == null || baseDrawdown == null) return false;
        double reduction = ReviewSupport.number(config == null ? null : config.get("minDrawdownReductionPercent"), 10) / 100;
        return pf >= ReviewSupport.number(config == null ? null : config.get("minProfitFactor"), 1.05)
                && expectancy > 0 && drawdown <= baseDrawdown * (1 - reduction);
    }

    private List<Map<String, Object>> baselineRows(Map<String, ReviewSupport.BacktestSegments> baseline, List<Pair> pairs) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Pair pair : pairs) {
            ReviewSupport.BacktestSegments segments = baseline.get(pair.key());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("key", pair.key()); row.put("guard", pair.guard()); row.put("train", segments.train()); row.put("validation", segments.holdout());
            rows.add(row);
        }
        return rows;
    }

    private Map<String, Object> averageMetrics(List<Map<String, Object>> rows, String segment) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("trades", rows.stream().mapToInt(row -> ReviewSupport.integer(asMap(row.get(segment)).get("trades"), 0)).sum());
        for (String field : List.of("profitFactor", "expectancyPercent", "maxDrawdownPercent", "totalReturnPercent", "slRatePercent")) {
            double value = rows.isEmpty() ? Double.NaN : rows.stream().mapToDouble(row -> ReviewSupport.number(asMap(row.get(segment)).get(field), 0)).average().orElse(0);
            result.put(field, Double.isFinite(value) ? ReviewSupport.round(value, 2) : null);
        }
        return result;
    }

    private List<Pair> pairsFromTrades(JsonNode trades, int maximum) {
        List<Pair> result = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        if (trades != null && trades.isArray()) {
            for (int index = trades.size() - 1; index >= 0 && result.size() < maximum; index--) {
                JsonNode trade = trades.get(index);
                String symbol = ReviewSupport.text(trade.get("symbol"), "");
                String interval = ReviewSupport.text(trade.get("interval"), "");
                String key = symbol + "|" + interval;
                if (!symbol.isBlank() && !interval.isBlank() && seen.add(key)) result.add(new Pair(key, symbol, interval, false));
            }
        }
        return result;
    }

    private List<Pair> guardPairs(JsonNode config, String interval) {
        List<Pair> result = new ArrayList<>();
        JsonNode values = config == null ? null : config.get("guardSymbols");
        if (values != null && values.isArray()) {
            for (JsonNode symbol : values) addGuardPair(result, ReviewSupport.text(symbol, ""), interval);
        } else {
            for (String symbol : List.of("BTCUSDT", "ETHUSDT", "SOLUSDT")) addGuardPair(result, symbol, interval);
        }
        return result;
    }

    private static void addGuardPair(List<Pair> result, String symbol, String interval) {
        if (!symbol.isBlank()) result.add(new Pair("guard:" + symbol + "|" + interval, symbol, interval, true));
    }

    private static List<Pair> join(List<Pair> first, List<Pair> second) {
        List<Pair> result = new ArrayList<>(first);
        result.addAll(second);
        return result;
    }

    private ArrayNode lastTrades(JsonNode trades, int count) {
        ArrayNode result = mapper.createArrayNode();
        if (trades == null || !trades.isArray() || count <= 0) return result;
        for (int index = Math.max(0, trades.size() - count); index < trades.size(); index++) {
            result.add(trades.get(index).deepCopy());
        }
        return result;
    }

    private void appendAttempt(ObjectNode state, Instant at, Map<String, Object> report) {
        ArrayNode attempts = (ArrayNode) state.path("attempts");
        ObjectNode row = mapper.createObjectNode();
        row.put("at", at.toString());
        mapper.valueToTree(report).properties().forEach(entry -> row.set(entry.getKey(), entry.getValue()));
        attempts.add(row);
        trimToLast(attempts, 30);
    }

    private static void trimToLast(ArrayNode values, int maximum) {
        while (values.size() > maximum) values.remove(0);
    }

    private static Map<String, Object> report(String status, Map<String, Object> base) {
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("status", status);
        report.putAll(base);
        return report;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        return value instanceof Map<?, ?> ? (Map<String, Object>) value : Map.of();
    }

    private String stringifyChanges(Object value) {
        JsonNode changes = value instanceof JsonNode node ? node : mapper.valueToTree(value);
        if (changes == null || !changes.isObject()) return "";
        List<String> output = new ArrayList<>();
        changes.properties().forEach(entry -> output.add(entry.getKey() + " = " + entry.getValue()));
        return String.join(" · ", output);
    }

    private void copyOrNull(ObjectNode target, String field, JsonNode value) {
        if (value == null || value.isNull() || value.isMissingNode()) target.putNull(field);
        else target.set(field, value.deepCopy());
    }

    private static void putFiniteOrNull(ObjectNode target, String field, Double value) {
        if (value == null) target.putNull(field); else target.put(field, value);
    }

    private Candidate candidate(JsonNode strategy, String id, String label, ObjectNode changes, String because, String kind) {
        return new Candidate(id, label, changes, because, kind, applyStrategyChanges(strategy, changes));
    }

    public record Candidate(String id, String label, ObjectNode changes, String because, String kind, ObjectNode strategy) {}

    private record Pair(String key, String symbol, String interval, boolean guard) {}

    private static final class GroupTotal {
        private final String group;
        private int count;
        private double totalContribution;
        private GroupTotal(String group) { this.group = group; }
    }
}
