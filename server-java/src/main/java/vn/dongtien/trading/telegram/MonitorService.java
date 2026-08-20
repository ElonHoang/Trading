package vn.dongtien.trading.telegram;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import vn.dongtien.trading.analysis.PostMortemService;
import vn.dongtien.trading.config.TradingUniverse;
import vn.dongtien.trading.data.MonitorStateService;
import vn.dongtien.trading.data.OpenCallService;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.market.Candle;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * Lifecycle monitor for automatic calls.  The mechanics are independent from
 * Telegram transport and setup construction: those are supplied as callbacks,
 * making the monitor usable from a long-running bot or a one-shot job.
 */
@Service
public class MonitorService {
    private final OpenCallService openCalls;
    private final MonitorStateService monitorState;
    private final TradingUniverse universe;
    private final PostMortemService postMortem;

    public MonitorService(OpenCallService openCalls, MonitorStateService monitorState,
                          TradingUniverse universe, PostMortemService postMortem) {
        this.openCalls = openCalls;
        this.monitorState = monitorState;
        this.universe = universe;
        this.postMortem = postMortem;
    }

    public Monitor createMonitor(Dependencies dependencies) {
        if (dependencies == null || dependencies.listTargets() == null || dependencies.evaluate() == null
                || dependencies.notify() == null || dependencies.loadStrategy() == null) {
            throw new IllegalArgumentException("Monitor cần listTargets, evaluate, notify và loadStrategy");
        }
        return new Monitor(dependencies);
    }

    public final class Monitor implements AutoCloseable {
        private final Dependencies deps;
        private final Map<String, MonitorStateService.StateEntry> state = new LinkedHashMap<>();
        private final AtomicBoolean running = new AtomicBoolean();
        private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "trading-monitor"); thread.setDaemon(true); return thread;
        });
        private volatile boolean stateLoaded;
        private volatile ScheduledFuture<?> timer;

        private Monitor(Dependencies deps) { this.deps = deps; }

        /** Executes one pass. Calls that overlap with a slow pass are ignored. */
        public void tick() {
            if (!running.compareAndSet(false, true)) return;
            try {
                loadState();
                JsonNode strategy = deps.loadStrategy().loadStrategy();
                if (strategy == null) throw new IllegalStateException("Không nạp được strategy");
                JsonNode alerts = strategy.path("alerts");
                double minAbsScore = number(alerts.get("minAbsScore"), 35d);
                boolean onlyOnSignalChange = !alerts.path("onlyOnSignalChange").isBoolean()
                        || alerts.path("onlyOnSignalChange").asBoolean();
                Double maxEntryDrift = nullableNumber(alerts.get("maxEntryDriftPercent"));
                int maxHoldBars = integer(alerts.get("maxHoldBars"), 96);
                PostMortemService.ReviewPause pause = postMortem.inReviewPause(strategy.path("learning"), System.currentTimeMillis());
                if (pause.active()) log("[monitor] đang trong cửa soi lại sau báo cáo ngày — chưa mở kèo mới, còn "
                        + Math.ceil(pause.leftMs() / 60_000d) + " phút.");

                List<String> allowed = universe.symbols(strategy);
                Map<String, OpenCallService.OpenCall> open = new LinkedHashMap<>(openCalls.readOpenCalls());
                Map<String, Target> targets = targets(allowed, open);
                for (Target target : targets.values()) processTarget(target, open, strategy, pause, minAbsScore,
                        onlyOnSignalChange, maxEntryDrift, maxHoldBars);
            } catch (RuntimeException error) {
                log("[monitor] lượt quét lỗi: " + error.getMessage());
            } finally {
                try { saveState(); }
                catch (RuntimeException error) { log("[monitor] không lưu được trạng thái: " + error.getMessage()); }
                running.set(false);
            }
        }

        /** Starts a repeating scan, with the same 30-second floor as Node. */
        public synchronized long start(long pollSeconds) {
            long seconds = Math.max(30L, pollSeconds);
            stopTimer();
            timer = scheduler.scheduleAtFixedRate(this::tickSafely, seconds, seconds, TimeUnit.SECONDS);
            tickSafely();
            return seconds;
        }

        public synchronized void stop() { stopTimer(); }
        @Override public synchronized void close() { stopTimer(); scheduler.shutdownNow(); }
        public Long intervalMs(String interval) { return BinanceClient.INTERVAL_MS.get(interval); }
        public Map<String, MonitorStateService.StateEntry> state() { return Map.copyOf(state); }

        private void tickSafely() { try { tick(); } catch (RuntimeException ignored) {} }
        private void stopTimer() { if (timer != null) timer.cancel(false); timer = null; }

        private void loadState() {
            if (stateLoaded) return;
            try { state.putAll(monitorState.readMonitorState()); }
            catch (RuntimeException error) { log("[monitor] không nạp được trạng thái: " + error.getMessage()); }
            finally { stateLoaded = true; }
        }
        private void saveState() { monitorState.saveMonitorState(state); }

        private Map<String, Target> targets(List<String> allowed, Map<String, OpenCallService.OpenCall> open) {
            Map<String, Target> result = new LinkedHashMap<>();
            for (Target requested : deps.listTargets().listTargets()) {
                try {
                    String symbol = requireAllowed(requested.symbol(), allowed);
                    if (open.containsKey(symbol)) continue;
                    Target target = new Target(symbol, requested.interval(), false);
                    result.put(key(target.symbol(), target.interval()), target);
                } catch (RuntimeException error) { log("[monitor] bỏ target ngoài whitelist: " + error.getMessage()); }
            }
            for (OpenCallService.OpenCall call : open.values()) {
                if (call == null || call.symbol() == null) continue;
                Target target = new Target(call.symbol(), call.interval(), true);
                result.put(key(target.symbol(), target.interval()), target);
            }
            return result;
        }

        private void processTarget(Target target, Map<String, OpenCallService.OpenCall> open, JsonNode strategy,
                                   PostMortemService.ReviewPause pause, double minAbsScore, boolean onlyOnChange,
                                   Double maxEntryDrift, int maxHoldBars) {
            String key = key(target.symbol(), target.interval());
            MonitorStateService.StateEntry previous = state.getOrDefault(key, new MonitorStateService.StateEntry(null, null));
            try {
                Evaluation evaluation = deps.evaluate().evaluate(target);
                Map<String, ?> snapshot = map(evaluation.snapshot());
                Map<String, ?> setup = map(evaluation.setup());
                String snapshotSymbol = text(snapshot, "symbol", target.symbol());
                Long candleTime = parseInstant(text(snapshot, "lastClosedCandleTime", null));
                OpenCallService.OpenCall existing = open.get(snapshotSymbol);

                if (existing != null) {
                    OpenCallService.CheckResult result = openCalls.checkCall(existing, candlesOf(snapshot), maxHoldBars);
                    if (result.isOpen()) {
                        List<String> newlyHit = new ArrayList<>();
                        for (String label : result.hitTps()) if (!existing.tpHit().contains(label)) newlyHit.add(label);
                        if (!newlyHit.isEmpty()) deps.notify().notify(new Notification("progress", target, snapshot, setup,
                                existing, result, newlyHit, evaluation.projections(), evaluation.limitPlan(), previous.lastSignal()));
                        return;
                    }
                    openCalls.closeCall(snapshotSymbol);
                    open.remove(snapshotSymbol);
                    Object recorded = null;
                    if (deps.recordClosedTrade() != null) {
                        try { recorded = deps.recordClosedTrade().record(existing, result, snapshot, integer(strategy.path("autoRetune").get("historyLimit"), 200)); }
                        catch (RuntimeException error) { log("[monitor] không lưu được kết quả kèo " + snapshotSymbol + ": " + error.getMessage()); }
                    }
                    if (result.status() == OpenCallService.Status.TARGET || !result.hitTps().isEmpty()) {
                        deps.notify().notify(new Notification("closed", target, snapshot, setup, existing, result, List.of(),
                                evaluation.projections(), evaluation.limitPlan(), previous.lastSignal()));
                    } else log("[monitor] " + snapshotSymbol + " " + text(snapshot, "interval", "") + " chốt "
                            + result.status().value() + " khi chưa chạm TP nào — không báo, để dành cho bản tổng hợp ngày.");
                    if (result.status() == OpenCallService.Status.STOPPED && recorded != null
                            && strategy.path("autoRetune").path("enabled").asBoolean(false) && deps.runAutoRetune() != null) {
                        try {
                            String report = deps.runAutoRetune().run(strategy, recorded);
                            if (report != null && !report.isBlank()) log("[monitor] tự kiểm chứng sau chuỗi SL:\n" + report);
                        } catch (RuntimeException error) { log("[monitor] tự kiểm chứng sau SL lỗi: " + error.getMessage()); }
                    }
                    state.put(key, new MonitorStateService.StateEntry(candleTime, null));
                    return;
                }

                if (Objects.equals(previous.lastCandleTime(), candleTime)) return;
                double score = number(map(snapshot.get("combined")).get("score"), 0d);
                String signal = text(setup, "signal", null);
                boolean changed = !Objects.equals(signal, previous.lastSignal());
                String side = text(setup, "side", "none");
                if (pause.active() && !"none".equals(side) && Math.abs(score) >= minAbsScore) {
                    log("[monitor] hoãn " + snapshotSymbol + " " + text(snapshot, "interval", "")
                            + ": đang soi lại kèo thua của ngày vừa rồi.");
                    return;
                }
                state.put(key, new MonitorStateService.StateEntry(candleTime, signal));
                if ("none".equals(side) || Math.abs(score) < minAbsScore || (onlyOnChange && !changed) || target.trackingOnly()) return;

                Double entry = nullableNumber(setup.get("entry"));
                Double live = nullableNumber(map(snapshot.get("price")).get("live"));
                if (maxEntryDrift != null && live != null && entry != null && entry != 0d) {
                    double drift = (live - entry) / entry * 100d;
                    if (Math.abs(drift) > maxEntryDrift) {
                        log("[monitor] bỏ " + snapshotSymbol + " " + text(snapshot, "interval", "") + ": giá đã lệch "
                                + (drift > 0 ? "+" : "") + String.format(java.util.Locale.ROOT, "%.2f", drift)
                                + "% khỏi entry (tối đa " + maxEntryDrift + "%)");
                        return;
                    }
                }
                if (entry == null || nullableNumber(setup.get("stopLoss")) == null || candleTime == null) {
                    log("[monitor] bỏ " + snapshotSymbol + ": setup thiếu entry/SL hoặc thời điểm nến đóng.");
                    return;
                }
                List<OpenCallService.Target> callTargets = maps(setup.get("targets")).stream()
                        .map(row -> new OpenCallService.Target(text(row, "label", ""), number(row.get("price"), Double.NaN))).toList();
                Object evidence = deps.buildEvidence() == null ? null : deps.buildEvidence().build(snapshot, setup);
                OpenCallService.OpenCall call = openCalls.openCall(snapshotSymbol, new OpenCallService.CallDraft(
                        text(snapshot, "interval", target.interval()), side, entry, number(setup.get("stopLoss"), Double.NaN),
                        callTargets, candleTime, evidence), allowedFor(strategy));
                open.put(snapshotSymbol, call);
                deps.notify().notify(new Notification("call", target, snapshot, setup, call, null, List.of(),
                        evaluation.projections(), evaluation.limitPlan(), previous.lastSignal()));
            } catch (RuntimeException error) { log("[monitor] " + key + ": " + error.getMessage()); }
        }

        private List<String> allowedFor(JsonNode strategy) { return universe.symbols(strategy); }
        private String requireAllowed(String symbol, Collection<String> allowed) {
            String normalized = BinanceClient.normalizeSymbol(symbol);
            if (!allowed.contains(normalized)) throw new IllegalArgumentException(normalized + " không nằm trong danh sách token được phép giao dịch.");
            return normalized;
        }
        private void log(String text) { if (deps.log() != null) deps.log().accept(text); }
    }

    /** Callback bundle: app-specific chart/setup/Telegram code remains outside the lifecycle core. */
    public record Dependencies(TargetProvider listTargets, Evaluator evaluate, Notifier notify, StrategyLoader loadStrategy,
                               Consumer<String> log, EvidenceBuilder buildEvidence, ClosedTradeRecorder recordClosedTrade,
                               RetuneRunner runAutoRetune) {
        public Dependencies(TargetProvider listTargets, Evaluator evaluate, Notifier notify, StrategyLoader loadStrategy) {
            this(listTargets, evaluate, notify, loadStrategy, null, null, null, null);
        }
    }
    @FunctionalInterface public interface TargetProvider { List<Target> listTargets(); }
    @FunctionalInterface public interface Evaluator { Evaluation evaluate(Target target); }
    @FunctionalInterface public interface Notifier { void notify(Notification notification); }
    @FunctionalInterface public interface StrategyLoader { JsonNode loadStrategy(); }
    @FunctionalInterface public interface EvidenceBuilder { Object build(Map<String, ?> snapshot, Map<String, ?> setup); }
    @FunctionalInterface public interface ClosedTradeRecorder {
        Object record(OpenCallService.OpenCall call, OpenCallService.CheckResult result, Map<String, ?> snapshot, int historyLimit);
    }
    @FunctionalInterface public interface RetuneRunner { String run(JsonNode strategy, Object recorded); }
    public record Target(String symbol, String interval, boolean trackingOnly) {
        public Target(String symbol, String interval) { this(symbol, interval, false); }
    }
    public record Evaluation(Map<String, ?> snapshot, Map<String, ?> setup, Object projections, Object limitPlan) {
        public Evaluation(Map<String, ?> snapshot, Map<String, ?> setup) { this(snapshot, setup, null, null); }
    }
    public record Notification(String kind, Target target, Map<String, ?> snapshot, Map<String, ?> setup,
                               OpenCallService.OpenCall call, OpenCallService.CheckResult result, List<String> hitTps,
                               Object projections, Object limitPlan, String changedFrom) {}

    private static String key(String symbol, String interval) { return symbol + "|" + (interval == null ? "auto" : interval); }
    private static List<Candle> candlesOf(Map<String, ?> snapshot) {
        Map<String, ?> series = map(snapshot.get("series"));
        List<?> close = list(series.get("close")), time = list(series.get("time")), high = list(series.get("high")), low = list(series.get("low"));
        if (close.isEmpty()) return List.of();
        List<Candle> result = new ArrayList<>();
        for (int index = 0; index < close.size(); index++) {
            result.add(new Candle(longNumber(at(time, index), 0L), 0d, number(at(high, index), Double.NaN),
                    number(at(low, index), Double.NaN), number(close.get(index), Double.NaN), 0d, 0L, 0d, 0L, null, true, ""));
        }
        return result;
    }
    @SuppressWarnings("unchecked") private static Map<String, ?> map(Object value) {
        return value instanceof Map<?, ?> map ? (Map<String, ?>) map : Map.of();
    }
    private static List<?> list(Object value) { return value instanceof List<?> list ? list : List.of(); }
    private static Object at(List<?> values, int index) { return index < values.size() ? values.get(index) : null; }
    @SuppressWarnings("unchecked") private static List<Map<String, ?>> maps(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        List<Map<String, ?>> result = new ArrayList<>();
        for (Object item : list) if (item instanceof Map<?, ?> map) result.add((Map<String, ?>) map);
        return result;
    }
    private static String text(Map<String, ?> value, String field, String fallback) {
        Object found = value == null ? null : value.get(field); return found == null ? fallback : String.valueOf(found);
    }
    private static double number(Object value, double fallback) {
        if (value == null) return fallback;
        try { double result = value instanceof Number number ? number.doubleValue() : Double.parseDouble(String.valueOf(value)); return Double.isFinite(result) ? result : fallback; }
        catch (RuntimeException ignored) { return fallback; }
    }
    private static double number(JsonNode value, double fallback) { return value == null ? fallback : number(value.asText(), fallback); }
    private static Double nullableNumber(Object value) { double result = number(value, Double.NaN); return Double.isFinite(result) ? result : null; }
    private static int integer(JsonNode value, int fallback) { return (int) Math.round(number(value, fallback)); }
    private static long longNumber(Object value, long fallback) { double result = number(value, Double.NaN); return Double.isFinite(result) ? Math.round(result) : fallback; }
    private static Long parseInstant(String value) {
        if (value == null || value.isBlank()) return null;
        try { return Instant.parse(value).toEpochMilli(); } catch (RuntimeException ignored) { return null; }
    }
}
