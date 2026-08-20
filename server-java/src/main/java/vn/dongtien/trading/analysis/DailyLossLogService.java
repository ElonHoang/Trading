package vn.dongtien.trading.analysis;

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
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Records one post-mortem log per reviewed day.  This module deliberately does
 * not propose or apply strategy changes; it only preserves loss evidence for a
 * later review/optimizer.
 */
@Service
public class DailyLossLogService {
    public static final String AUTO_RETUNE_KEY = "data:auto-retune";
    private static final long DAY_MS = 86_400_000L;
    private static final Pattern DAY_LABEL = Pattern.compile("^NGÀY\\s+(\\d{2})/(\\d{2})/(\\d{4})$");
    private static final Pattern TIME = Pattern.compile("^(\\d{1,2}):(\\d{2})$");
    private static final DateTimeFormatter ISO_MILLIS = DateTimeFormatter
            .ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSX").withZone(ZoneOffset.UTC);

    private final ObjectMapper mapper;
    private final DocumentStore documents;
    private final BinanceClient binance;
    private final PostMortemService postMortem;
    private final LearningLogService learningLogs;

    public DailyLossLogService(ObjectMapper mapper, DocumentStore documents, BinanceClient binance,
                               PostMortemService postMortem, LearningLogService learningLogs) {
        this.mapper = mapper;
        this.documents = documents;
        this.binance = binance;
        this.postMortem = postMortem;
        this.learningLogs = learningLogs;
    }

    public Result recordDailyLossLog(JsonNode strategy, ObjectNode state, long nowMillis, Dependencies dependencies) {
        if (state == null) throw new IllegalArgumentException("Thiếu trạng thái auto-retune");
        Dependencies deps = dependencies == null ? Dependencies.defaults() : dependencies;
        JsonNode cfg = strategy == null ? mapper.createObjectNode() : strategy.path("dailyReview");
        JsonNode learn = strategy == null ? mapper.createObjectNode() : strategy.path("learning");
        int requestedOffset = Math.min(-1, deps.dayOffsetDays());
        ReviewWindow window = calendarDayWindow(cfg, nowMillis, requestedOffset);

        Matcher reviewTime = TIME.matcher(learn.path("reviewAtUtc").asText("").trim());
        if (reviewTime.matches() && !deps.force()) {
            long reviewAt = Math.floorDiv(window.untilMs(), DAY_MS) * DAY_MS
                    + Long.parseLong(reviewTime.group(1)) * 3_600_000L
                    + Long.parseLong(reviewTime.group(2)) * 60_000L;
            if (reviewAt < window.untilMs()) reviewAt += DAY_MS;
            if (nowMillis < reviewAt) return new Result("too-early", null);
        }

        String date = dateFromLabel(window.label(), Instant.ofEpochMilli(window.sinceMs()).toString().substring(0, 10));
        String currentWeek = weekKey(nowMillis, number(cfg.get("dayOffsetHours"), 7d));
        if (!currentWeek.equals(state.path("lossLogWeek").asText(null))) {
            state.putArray("lossLogs");
            state.put("lossLogWeek", currentWeek);
        }

        ArrayNode currentLogs = state.path("lossLogs").isArray() ? (ArrayNode) state.path("lossLogs") : state.putArray("lossLogs");
        JsonNode existing = findByDate(currentLogs, date);
        if (existing == null && deps.refreshExistingOnly()) return new Result("not-recorded", null);
        boolean hasUnknown = existing != null && existing.path("losses").isArray()
                && stream(existing.path("losses")).anyMatch(loss -> PostMortemService.UNKNOWN.equals(loss.path("cause").asText()));
        if (existing != null && !deps.force() && !(deps.refreshUnknown() && hasUnknown)) {
            return new Result("already-logged", existing);
        }

        List<PostMortemService.Trade> losses = new ArrayList<>();
        if (state.path("trades").isArray()) for (JsonNode trade : state.path("trades")) {
            Long closedAt = parseInstant(trade.path("closedAt").asText(null));
            boolean hitTp = trade.path("result").path("hitTps").isArray() && !trade.path("result").path("hitTps").isEmpty();
            if (closedAt != null && closedAt >= window.sinceMs() && closedAt < window.untilMs()
                    && "stopped".equals(trade.path("result").path("status").asText()) && !hitTp) {
                losses.add(postMortem.fromJson(trade));
            }
        }

        PostMortemService.CandleFetcher fetcher = deps.fetchCandles() != null
                ? deps.fetchCandles() : (symbol, interval, limit) -> binance.fetchKlines(symbol, interval, limit);
        PostMortemService.Options replayOptions = new PostMortemService.Options(
                integer(strategy == null ? null : strategy.path("alerts").get("maxHoldBars"), 96),
                number(learn.get("widerSlMultiple"), 1.5d), integer(learn.get("minBarsAfterStop"), 6),
                integer(learn.get("sweepRecoveryBars"), 6), number(learn.get("noFavorMoveR"), .15d));
        PostMortemService.PostMortemReport analysis = postMortem.postMortemLosses(losses, fetcher,
                Math.max(1, losses.size()), integer(learn.get("replayCandles"), 400), replayOptions, null);

        ObjectNode log = mapper.createObjectNode();
        log.put("date", date);
        log.put("generatedAt", ISO_MILLIS.format(Instant.ofEpochMilli(nowMillis)));
        ObjectNode logWindow = log.putObject("window");
        logWindow.put("since", window.since());
        logWindow.put("until", ISO_MILLIS.format(Instant.ofEpochMilli(window.untilMs())));
        log.put("totalLosses", losses.size());
        log.put("decided", analysis.decided());
        log.set("counts", mapper.valueToTree(analysis.counts()));
        log.set("verdict", mapper.valueToTree(analysis.verdict()));
        ArrayNode lossRows = log.putArray("losses");
        for (PostMortemService.Replay row : analysis.rows()) lossRows.add(learningLogs.compactLoss(row));

        List<JsonNode> next = new ArrayList<>();
        for (JsonNode item : currentLogs) if (!date.equals(item.path("date").asText())) next.add(item);
        next.add(log);
        next.sort(Comparator.comparing(item -> item.path("date").asText()));
        int keep = Math.max(1, Math.min(7, integer(learn.get("dailyLossLogHistoryDays"), 7)));
        ArrayNode savedLogs = state.putArray("lossLogs");
        for (int index = Math.max(0, next.size() - keep); index < next.size(); index++) savedLogs.add(next.get(index));

        if (deps.saveState() != null) deps.saveState().save(state);
        else documents.put(AUTO_RETUNE_KEY, state);
        return new Result(existing == null ? "logged" : "refreshed", log);
    }

    public Result recordDailyLossLog(JsonNode strategy, ObjectNode state) {
        return recordDailyLossLog(strategy, state, System.currentTimeMillis(), Dependencies.defaults());
    }

    /** Convenience bridge for the shared auto-retune state document. */
    public Result recordDailyLossLog(JsonNode strategy, AutoRetuneService autoRetune, long nowMillis, Dependencies dependencies) {
        if (autoRetune == null) throw new IllegalArgumentException("Thiếu AutoRetuneService");
        Dependencies base = dependencies == null ? Dependencies.defaults() : dependencies;
        Dependencies withStateSaver = new Dependencies(base.fetchCandles(), autoRetune::saveState, base.dayOffsetDays(),
                base.force(), base.refreshExistingOnly(), base.refreshUnknown());
        return recordDailyLossLog(strategy, autoRetune.readState(), nowMillis, withStateSaver);
    }

    /** Same calendar-day calculation used by the daily review, exposed for jobs/tests. */
    public static ReviewWindow calendarDayWindow(JsonNode cfg, long nowMillis, int dayOffsetDays) {
        double offsetHours = number(cfg == null ? null : cfg.get("dayOffsetHours"), 0d);
        long offset = Math.round(offsetHours * 3_600_000d);
        int days = Math.min(0, dayOffsetDays);
        long since = (Math.floorDiv(nowMillis + offset, DAY_MS) + days) * DAY_MS - offset;
        String date = Instant.ofEpochMilli(since + offset).toString().substring(0, 10);
        String[] parts = date.split("-");
        return new ReviewWindow("calendar-day", since, since + DAY_MS, ISO_MILLIS.format(Instant.ofEpochMilli(since)),
                "NGÀY " + parts[2] + "/" + parts[1] + "/" + parts[0]);
    }

    private static JsonNode findByDate(ArrayNode logs, String date) {
        for (JsonNode item : logs) if (date.equals(item.path("date").asText())) return item;
        return null;
    }
    private static String dateFromLabel(String label, String fallback) {
        Matcher match = DAY_LABEL.matcher(label == null ? "" : label);
        return match.matches() ? match.group(3) + "-" + match.group(2) + "-" + match.group(1) : fallback;
    }
    private static String weekKey(long now, double offsetHours) {
        long shifted = now + Math.round(offsetHours * 3_600_000d);
        long dayStart = Math.floorDiv(shifted, DAY_MS) * DAY_MS;
        int dayOfWeek = Instant.ofEpochMilli(dayStart).atZone(ZoneOffset.UTC).getDayOfWeek().getValue(); // Monday = 1
        return Instant.ofEpochMilli(dayStart - (dayOfWeek - 1L) * DAY_MS).toString().substring(0, 10);
    }
    private static Long parseInstant(String value) {
        if (value == null || value.isBlank()) return null;
        try { return Instant.parse(value).toEpochMilli(); } catch (RuntimeException ignored) { return null; }
    }
    private static int integer(JsonNode node, int fallback) { return (int) Math.round(number(node, fallback)); }
    private static double number(JsonNode node, double fallback) {
        if (node == null || node.isNull()) return fallback;
        try { double result = Double.parseDouble(node.asText()); return Double.isFinite(result) ? result : fallback; }
        catch (RuntimeException ignored) { return fallback; }
    }
    private static java.util.stream.Stream<JsonNode> stream(JsonNode array) {
        List<JsonNode> result = new ArrayList<>(); for (JsonNode row : array) result.add(row); return result.stream();
    }

    @FunctionalInterface public interface StateSaver { void save(ObjectNode state); }
    public record Dependencies(PostMortemService.CandleFetcher fetchCandles, StateSaver saveState, int dayOffsetDays,
                               boolean force, boolean refreshExistingOnly, boolean refreshUnknown) {
        public static Dependencies defaults() { return new Dependencies(null, null, -1, false, false, false); }
    }
    public record ReviewWindow(String mode, long sinceMs, long untilMs, String since, String label) {}
    public record Result(String status, JsonNode log) {}
}
