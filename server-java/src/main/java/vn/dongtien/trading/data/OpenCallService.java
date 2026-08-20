package vn.dongtien.trading.data;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.auth.DocumentStore;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.market.Candle;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Durable lifecycle store for calls which have been sent to Telegram.
 *
 * <p>A symbol may have only one open call.  This is deliberately separate from
 * the monitor: a monitor restart must not make it forget a live position and
 * publish the same call again.</p>
 */
@Service
public class OpenCallService {
    public static final String KEY = "data:open-calls";
    private static final DateTimeFormatter ISO_MILLIS = DateTimeFormatter
            .ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSX").withZone(ZoneOffset.UTC);

    private final DocumentStore documents;
    private final ObjectMapper mapper;

    public OpenCallService(DocumentStore documents, ObjectMapper mapper) {
        this.documents = documents;
        this.mapper = mapper;
    }

    /** Returns an empty map when the persisted value is absent or malformed. */
    public synchronized Map<String, OpenCall> readOpenCalls() {
        JsonNode value = documents.find(KEY).orElse(null);
        return read(value);
    }

    /**
     * Opens/replaces the call for {@code symbol}.  A non-null allow-list is
     * checked fail-closed, matching the old Node implementation.
     */
    public synchronized OpenCall openCall(String symbol, CallDraft draft, Collection<String> allowedSymbols) {
        String allowed = allowedSymbol(symbol, allowedSymbols);
        if (draft == null) throw new IllegalArgumentException("Thiếu thông tin kèo mở");
        long candleTime = draft.candleTime();
        OpenCall call = new OpenCall(
                allowed,
                draft.interval(),
                draft.side(),
                draft.entry(),
                draft.stopLoss(),
                safeTargets(draft.targets()),
                candleTime,
                ISO_MILLIS.format(Instant.ofEpochMilli(candleTime)),
                List.of(),
                asJson(draft.evidence()),
                null,
                false);
        Map<String, OpenCall> calls = readOpenCalls();
        calls.put(allowed, call);
        save(calls);
        return call;
    }

    /** Convenience overload for callers which do not use a whitelist. */
    public synchronized OpenCall openCall(String symbol, CallDraft draft) {
        return openCall(symbol, draft, null);
    }

    /** Stores Telegram message metadata so progress updates can reply to it. */
    public synchronized void setCallMessages(String symbol, JsonNode messages) {
        String normalized = BinanceClient.normalizeSymbol(symbol);
        Map<String, OpenCall> calls = readOpenCalls();
        OpenCall current = calls.get(normalized);
        if (current == null) return;
        calls.put(normalized, current.withMessages(messages));
        save(calls);
    }

    public synchronized void setCallMessages(String symbol, Object messages) {
        setCallMessages(symbol, messages == null ? null : mapper.valueToTree(messages));
    }

    /** Removes a call once its lifecycle has finished. */
    public synchronized boolean closeCall(String symbol) {
        String normalized = BinanceClient.normalizeSymbol(symbol);
        Map<String, OpenCall> calls = readOpenCalls();
        boolean removed = calls.remove(normalized) != null;
        if (removed) save(calls);
        return removed;
    }

    /**
     * Replays closed candles after a call was opened.  If a candle crosses both
     * stop loss and a target, stop loss wins; intrabar ordering is unknowable,
     * so this is the conservative convention used by the backtest too.
     */
    public synchronized CheckResult checkCall(OpenCall call, List<Candle> candles, int maxHoldBars) {
        if (call == null) throw new IllegalArgumentException("Thiếu kèo cần theo dõi");
        List<Candle> all = candles == null ? List.of() : candles;
        int hold = Math.max(1, maxHoldBars);
        long openedAt = call.openedAtCandle() == null ? Long.MAX_VALUE : call.openedAtCandle();
        List<Candle> after = all.stream().filter(candle -> candle.openTime() > openedAt).toList();
        List<Target> targets = safeTargets(call.targets());
        Target firstTarget = targets.isEmpty() ? null : targets.get(0);
        Target finalTarget = targets.isEmpty() ? null : targets.get(targets.size() - 1);
        List<String> known = distinct(call.tpHit());

        boolean replayable = !all.isEmpty() && all.get(0).openTime() <= openedAt;
        List<String> hit = replayable ? new ArrayList<>() : new ArrayList<>(known);
        boolean movedStop = firstTarget != null && !replayable && hit.contains(firstTarget.label());
        double stop = movedStop ? call.entry() : call.stopLoss();
        boolean isLong = "long".equals(call.side());

        for (Candle candle : after) {
            boolean hitStop = isLong ? candle.low() <= stop : candle.high() >= stop;
            if (hitStop) {
                return new CheckResult(movedStop ? Status.BREAKEVEN : Status.STOPPED,
                        merge(known, hit), stop, after.size(), movedStop, closedAt(candle, call.interval()));
            }
            for (Target target : targets) {
                if (hit.contains(target.label())) continue;
                boolean reached = isLong ? candle.high() >= target.price() : candle.low() <= target.price();
                if (reached) hit.add(target.label());
            }
            if (!movedStop && firstTarget != null && hit.contains(firstTarget.label())) {
                movedStop = true;
                stop = call.entry();
            }
            if (finalTarget != null && hit.contains(finalTarget.label())) {
                return new CheckResult(Status.TARGET, merge(known, hit), finalTarget.price(),
                        after.size(), movedStop, closedAt(candle, call.interval()));
            }
        }

        List<String> merged = merge(known, hit);
        if (after.size() >= hold) {
            Candle expiry = after.get(hold - 1);
            Double lastPrice = all.isEmpty() ? null : all.get(all.size() - 1).close();
            return new CheckResult(Status.EXPIRED, merged, lastPrice, after.size(), movedStop,
                    closedAt(expiry, call.interval()));
        }

        if (!merged.equals(known) || movedStop != call.slMovedToEntry()) {
            updateCall(call.symbol(), current -> current.withProgress(merged, movedStop));
        }
        Double lastPrice = all.isEmpty() ? null : all.get(all.size() - 1).close();
        return new CheckResult(Status.OPEN, merged, lastPrice, after.size(), movedStop, null);
    }

    public CheckResult checkCall(OpenCall call, List<Candle> candles) {
        return checkCall(call, candles, 96);
    }

    /** Adapter for services which persist completed calls as document JSON. */
    public ObjectNode toJson(OpenCall call) { return toNode(call); }

    public ObjectNode toJson(CheckResult result) {
        ObjectNode node = mapper.createObjectNode();
        if (result == null) return node;
        node.put("status", result.status().value());
        ArrayNode hits = node.putArray("hitTps");
        for (String hit : result.hitTps()) hits.add(hit);
        if (result.lastPrice() == null) node.putNull("lastPrice"); else node.put("lastPrice", result.lastPrice());
        node.put("bars", result.bars());
        node.put("slMovedToEntry", result.slMovedToEntry());
        if (result.closedAt() != null) node.put("closedAt", result.closedAt());
        return node;
    }

    private void updateCall(String symbol, java.util.function.UnaryOperator<OpenCall> updater) {
        String normalized = BinanceClient.normalizeSymbol(symbol);
        Map<String, OpenCall> calls = readOpenCalls();
        OpenCall current = calls.get(normalized);
        if (current == null) return;
        calls.put(normalized, updater.apply(current));
        save(calls);
    }

    private String allowedSymbol(String input, Collection<String> allowedSymbols) {
        String normalized = BinanceClient.normalizeSymbol(input);
        if (allowedSymbols == null) return normalized;
        Set<String> allowed = new LinkedHashSet<>();
        for (String value : allowedSymbols) allowed.add(BinanceClient.normalizeSymbol(value));
        if (!allowed.contains(normalized)) {
            throw new IllegalArgumentException(normalized + " không nằm trong danh sách token được phép giao dịch.");
        }
        return normalized;
    }

    private Map<String, OpenCall> read(JsonNode value) {
        Map<String, OpenCall> calls = new LinkedHashMap<>();
        if (value == null || !value.isObject()) return calls;
        value.properties().forEach(entry -> {
            OpenCall call = parseCall(entry.getValue(), entry.getKey());
            if (call != null) calls.put(entry.getKey(), call);
        });
        return calls;
    }

    private OpenCall parseCall(JsonNode value, String key) {
        if (value == null || !value.isObject()) return null;
        String symbol = value.path("symbol").asText(key);
        List<Target> targets = new ArrayList<>();
        if (value.path("targets").isArray()) for (JsonNode target : value.path("targets")) {
            targets.add(new Target(target.path("label").asText(), target.path("price").asDouble()));
        }
        List<String> hits = new ArrayList<>();
        if (value.path("tpHit").isArray()) for (JsonNode hit : value.path("tpHit")) hits.add(hit.asText());
        Long openedAt = value.path("openedAtCandle").isNumber() ? value.path("openedAtCandle").asLong() : null;
        return new OpenCall(symbol, value.path("interval").asText(null), value.path("side").asText(null),
                value.path("entry").asDouble(), value.path("stopLoss").asDouble(), targets, openedAt,
                value.path("openedAt").asText(null), hits, value.get("evidence"), value.get("messages"),
                value.path("slMovedToEntry").asBoolean(false));
    }

    private void save(Map<String, OpenCall> calls) {
        ObjectNode root = mapper.createObjectNode();
        calls.forEach((symbol, call) -> root.set(symbol, toNode(call)));
        documents.put(KEY, root);
    }

    private ObjectNode toNode(OpenCall call) {
        if (call == null) return mapper.createObjectNode();
        ObjectNode node = mapper.createObjectNode();
        node.put("symbol", call.symbol());
        putText(node, "interval", call.interval());
        putText(node, "side", call.side());
        node.put("entry", call.entry());
        node.put("stopLoss", call.stopLoss());
        ArrayNode targets = node.putArray("targets");
        for (Target target : safeTargets(call.targets())) {
            ObjectNode row = targets.addObject();
            putText(row, "label", target.label());
            row.put("price", target.price());
        }
        if (call.openedAtCandle() == null) node.putNull("openedAtCandle");
        else node.put("openedAtCandle", call.openedAtCandle());
        putText(node, "openedAt", call.openedAt());
        ArrayNode hit = node.putArray("tpHit");
        for (String label : distinct(call.tpHit())) hit.add(label);
        if (call.evidence() == null) node.putNull("evidence"); else node.set("evidence", call.evidence());
        if (call.messages() != null) node.set("messages", call.messages());
        if (call.slMovedToEntry()) node.put("slMovedToEntry", true);
        return node;
    }

    private static void putText(ObjectNode node, String field, String value) {
        if (value == null) node.putNull(field); else node.put(field, value);
    }

    private JsonNode asJson(Object value) {
        if (value == null) return null;
        return value instanceof JsonNode node ? node : mapper.valueToTree(value);
    }

    private static List<Target> safeTargets(List<Target> targets) {
        return targets == null ? List.of() : List.copyOf(targets);
    }

    private static List<String> distinct(List<String> values) {
        return values == null ? List.of() : new ArrayList<>(new LinkedHashSet<>(values));
    }

    private static List<String> merge(List<String> left, List<String> right) {
        List<String> result = new ArrayList<>(distinct(left));
        for (String value : distinct(right)) if (!result.contains(value)) result.add(value);
        return result;
    }

    private static String closedAt(Candle candle, String interval) {
        Long intervalMillis = BinanceClient.INTERVAL_MS.get(interval);
        if (candle == null || intervalMillis == null) return null;
        return ISO_MILLIS.format(Instant.ofEpochMilli(candle.openTime() + intervalMillis - 1));
    }

    public enum Status {
        OPEN("open"), STOPPED("stopped"), BREAKEVEN("breakeven"), TARGET("target"), EXPIRED("expired");
        private final String value;
        Status(String value) { this.value = value; }
        public String value() { return value; }
        @Override public String toString() { return value; }
        public static Status from(String value) {
            for (Status status : values()) if (status.value.equals(value)) return status;
            throw new IllegalArgumentException("Trạng thái kèo không hợp lệ: " + value);
        }
    }

    public record Target(String label, double price) {}

    public record CallDraft(String interval, String side, double entry, double stopLoss,
                            List<Target> targets, long candleTime, Object evidence) {
        public CallDraft(String interval, String side, double entry, double stopLoss,
                         List<Target> targets, long candleTime) {
            this(interval, side, entry, stopLoss, targets, candleTime, null);
        }
    }

    public record OpenCall(String symbol, String interval, String side, double entry, double stopLoss,
                           List<Target> targets, Long openedAtCandle, String openedAt, List<String> tpHit,
                           JsonNode evidence, JsonNode messages, boolean slMovedToEntry) {
        public OpenCall {
            targets = safeTargets(targets);
            tpHit = distinct(tpHit);
        }
        OpenCall withMessages(JsonNode value) {
            return new OpenCall(symbol, interval, side, entry, stopLoss, targets, openedAtCandle, openedAt,
                    tpHit, evidence, value, slMovedToEntry);
        }
        OpenCall withProgress(List<String> hits, boolean moved) {
            return new OpenCall(symbol, interval, side, entry, stopLoss, targets, openedAtCandle, openedAt,
                    hits, evidence, messages, moved);
        }
    }

    public record CheckResult(Status status, List<String> hitTps, Double lastPrice, int bars,
                              boolean slMovedToEntry, String closedAt) {
        public CheckResult { hitTps = distinct(hitTps); }
        public boolean isOpen() { return status == Status.OPEN; }
        public String statusValue() { return status.value(); }
    }
}
