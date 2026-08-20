package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.trading.market.Candle;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Replays a stopped call on real candles after enough candles exist to explain
 * whether the stop was swept, the direction was wrong, or price later reversed.
 * It only produces evidence; it never changes the strategy.
 */
@Service
public class PostMortemService {
    public static final String SWEPT = "bi-quet";
    public static final String WRONG_WAY = "sai-huong";
    public static final String REVERSED = "dao-chieu";
    public static final String UNKNOWN = "chua-du-nen";

    private final ObjectMapper mapper;

    public PostMortemService(ObjectMapper mapper) { this.mapper = mapper; }

    /**
     * Returns a deterministic review pause based solely on the daily-review
     * clock.  No mutable state is needed, so a no-write review cannot race a
     * live monitor.
     */
    public ReviewPause inReviewPause(JsonNode cfg, long nowMillis) {
        if (cfg != null && cfg.path("enabled").isBoolean() && !cfg.path("enabled").asBoolean()) return ReviewPause.inactive();
        double minutes = number(cfg == null ? null : cfg.get("pauseAfterReviewMinutes"), 0d);
        String reviewAt = cfg == null ? "" : cfg.path("reviewAtUtc").asText("").trim();
        java.util.regex.Matcher match = java.util.regex.Pattern.compile("^(\\d{1,2}):(\\d{2})$").matcher(reviewAt);
        if (!(minutes > 0) || !match.matches()) return ReviewPause.inactive();
        long start = Math.floorDiv(nowMillis, 86_400_000L) * 86_400_000L
                + Long.parseLong(match.group(1)) * 3_600_000L + Long.parseLong(match.group(2)) * 60_000L;
        long end = start + Math.round(minutes * 60_000d);
        if (nowMillis < start || nowMillis >= end) return ReviewPause.inactive();
        return new ReviewPause(true, end - nowMillis, iso(end));
    }

    public ReviewPause inReviewPause(JsonNode cfg) { return inReviewPause(cfg, System.currentTimeMillis()); }

    public Replay replayStoppedCall(Trade trade, List<Candle> candles, Options options) {
        Options opts = options == null ? Options.defaults() : options.normalized();
        Base base = Base.of(trade);
        Target firstTarget = trade == null || trade.targets().isEmpty() ? null : trade.targets().get(0);
        if (trade == null || !finite(trade.entry()) || !finite(trade.stopLoss()) || firstTarget == null
                || !finite(firstTarget.price()) || !finite(openedAt(trade))) {
            return Replay.unknown(base, "bản ghi cũ không có entry/SL/TP");
        }
        double entry = trade.entry();
        double stop = trade.stopLoss();
        double tp1 = firstTarget.price();
        long openedAt = Math.round(openedAt(trade));
        double risk = Math.abs(entry - stop);
        if (!(risk > 0)) return Replay.unknown(base, "khoảng SL bằng 0");

        boolean isLong = "long".equals(trade.side());
        List<Candle> after = (candles == null ? List.<Candle>of() : candles).stream()
                .filter(candle -> candle.openTime() > openedAt).limit(opts.maxHoldBars()).toList();
        if (after.isEmpty()) return Replay.unknown(base, "không còn nến của kèo này");

        int stopIndex = -1;
        double mfeBeforeStop = 0d;
        double maxAdverse = 0d;
        for (int index = 0; index < after.size(); index++) {
            Candle candle = after.get(index);
            double adverse = isLong ? entry - candle.low() : candle.high() - entry;
            maxAdverse = Math.max(maxAdverse, adverse);
            if (stopIndex >= 0) continue;
            boolean hitStop = isLong ? candle.low() <= stop : candle.high() >= stop;
            if (hitStop) { stopIndex = index; continue; }
            double favor = isLong ? candle.high() - entry : entry - candle.low();
            mfeBeforeStop = Math.max(mfeBeforeStop, favor);
        }
        if (stopIndex < 0) return Replay.unknown(base, "không khớp được nến chạm SL");

        List<Candle> rest = after.subList(stopIndex + 1, after.size());
        int tpAfterIndex = indexOf(rest, candle -> isLong ? candle.high() >= tp1 : candle.low() <= tp1);
        boolean reachedTp1After = tpAfterIndex >= 0;
        Integer barsToTp1After = reachedTp1After ? tpAfterIndex + 1 : null;
        boolean reachedTp1Soon = reachedTp1After && barsToTp1After <= opts.sweepRecoveryBars();

        double widerStop = isLong ? entry - risk * opts.widerSlMultiple() : entry + risk * opts.widerSlMultiple();
        boolean widerStopSaves = false;
        for (Candle candle : after) {
            boolean hitWiderStop = isLong ? candle.low() <= widerStop : candle.high() >= widerStop;
            if (hitWiderStop) break;
            boolean hitTp = isLong ? candle.high() >= tp1 : candle.low() <= tp1;
            if (hitTp) { widerStopSaves = true; break; }
        }

        Replay measured = new Replay(base.tradeId(), base.symbol(), base.interval(), base.side(), base.evidence(), null, null,
                round(mfeBeforeStop / risk, 2), round(maxAdverse / risk, 2), round(maxAdverse / entry * 100d, 2),
                round(risk / entry * 100d, 2), stopIndex + 1, rest.size(), reachedTp1After, barsToTp1After,
                reachedTp1Soon, widerStopSaves);
        if (rest.size() < opts.minBarsAfterStop() && !reachedTp1Soon && !widerStopSaves) {
            return measured.withKind(Kind.UNKNOWN, "mới " + rest.size() + " nến sau SL");
        }
        if (widerStopSaves || reachedTp1Soon) return measured.withKind(Kind.SWEPT, null);
        if (mfeBeforeStop / risk < opts.noFavorMoveR()) return measured.withKind(Kind.WRONG_WAY, null);
        return measured.withKind(Kind.REVERSED, null);
    }

    public Replay replayStoppedCall(Trade trade, List<Candle> candles) {
        return replayStoppedCall(trade, candles, Options.defaults());
    }

    public Replay replayStoppedCall(JsonNode trade, List<Candle> candles, Options options) {
        return replayStoppedCall(fromJson(trade), candles, options);
    }

    /** Loads candles through an injected source so the replay remains testable. */
    public PostMortemReport postMortemLosses(List<Trade> lostTrades, CandleFetcher fetchCandles,
                                             int maxTrades, int candleLimit, Options options,
                                             Consumer<String> onError) {
        List<Trade> values = lostTrades == null ? List.of() : lostTrades;
        int limit = Math.max(1, maxTrades);
        List<Replay> rows = new ArrayList<>();
        for (int index = values.size() - 1, count = 0; index >= 0 && count < limit; index--, count++) {
            Trade trade = values.get(index);
            try {
                List<Candle> candles = fetchCandles.fetchCandles(trade.symbol(), trade.interval(), candleLimit);
                rows.add(replayStoppedCall(trade, candles, options));
            } catch (RuntimeException error) {
                if (onError != null) onError.accept(trade.symbol() + " " + trade.interval() + ": " + error.getMessage());
                rows.add(Replay.unknown(Base.of(trade), "không tải được nến: " + error.getMessage()));
            }
        }
        return summarizePostMortem(rows);
    }

    public PostMortemReport postMortemLosses(List<Trade> lostTrades, CandleFetcher fetchCandles) {
        return postMortemLosses(lostTrades, fetchCandles, 12, 400, Options.defaults(), null);
    }

    public PostMortemReport summarizePostMortem(List<Replay> rows) {
        List<Replay> safe = rows == null ? List.of() : List.copyOf(rows);
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Kind kind : Kind.values()) counts.put(kind.value(), 0);
        for (Replay row : safe) counts.compute(row.kind().value(), (key, value) -> value == null ? 1 : value + 1);
        List<Replay> decided = safe.stream().filter(row -> row.kind() != Kind.UNKNOWN).toList();
        List<Replay> swept = safe.stream().filter(row -> row.kind() == Kind.SWEPT).toList();
        List<Replay> wrong = safe.stream().filter(row -> row.kind() == Kind.WRONG_WAY).toList();
        List<Replay> reversed = safe.stream().filter(row -> row.kind() == Kind.REVERSED).toList();
        PostMortemReport report = new PostMortemReport(safe.size(), decided.size(), counts,
                share(swept.size(), decided.size()), share(wrong.size(), decided.size()), share(reversed.size(), decided.size()),
                round(median(swept.stream().map(Replay::slPercent).toList()), 2),
                round(median(swept.stream().map(Replay::neededSlPercent).toList()), 2),
                round(median(decided.stream().map(row -> row.barsToSl() == null ? null : row.barsToSl().doubleValue()).toList()), 1),
                safe, null);
        return report.withVerdict(verdictOf(report));
    }

    /** JSON adapter keeps the persisted contract's Vietnamese kind ids rather than enum names. */
    public JsonNode toJson(PostMortemReport report) {
        ObjectNode out = mapper.createObjectNode();
        if (report == null) return out;
        out.put("total", report.total());
        out.put("decided", report.decided());
        out.set("counts", mapper.valueToTree(report.counts()));
        putNumber(out, "sweptSharePercent", report.sweptSharePercent());
        putNumber(out, "wrongWaySharePercent", report.wrongWaySharePercent());
        putNumber(out, "reversedSharePercent", report.reversedSharePercent());
        putNumber(out, "medianSlPercent", report.medianSlPercent());
        putNumber(out, "medianNeededSlPercent", report.medianNeededSlPercent());
        putNumber(out, "medianBarsToSl", report.medianBarsToSl());
        var rows = out.putArray("rows");
        for (Replay row : report.rows()) rows.add(toJson(row));
        if (report.verdict() == null) out.putNull("verdict");
        else {
            ObjectNode verdict = out.putObject("verdict");
            verdict.put("id", report.verdict().id()); verdict.put("text", report.verdict().text());
        }
        return out;
    }
    public JsonNode toJson(Replay replay) {
        ObjectNode out = mapper.createObjectNode();
        if (replay == null) return out;
        putText(out, "tradeId", replay.tradeId()); putText(out, "symbol", replay.symbol());
        putText(out, "interval", replay.interval()); putText(out, "side", replay.side());
        if (replay.evidence() == null) out.putNull("evidence"); else out.set("evidence", replay.evidence());
        putText(out, "kind", replay.kind() == null ? null : replay.kind().value());
        putText(out, "reason", replay.reason());
        putNumber(out, "mfeBeforeSlR", replay.mfeBeforeSlR()); putNumber(out, "maxAdverseR", replay.maxAdverseR());
        putNumber(out, "neededSlPercent", replay.neededSlPercent()); putNumber(out, "slPercent", replay.slPercent());
        putInteger(out, "barsToSl", replay.barsToSl()); putInteger(out, "barsAfterSl", replay.barsAfterSl());
        putBoolean(out, "reachedTp1After", replay.reachedTp1After()); putInteger(out, "barsToTp1AfterSl", replay.barsToTp1AfterSl());
        putBoolean(out, "reachedTp1Soon", replay.reachedTp1Soon()); putBoolean(out, "widerStopSaves", replay.widerStopSaves());
        return out;
    }

    public Trade fromJson(JsonNode node) {
        if (node == null || !node.isObject()) return new Trade(null, null, null, null, null, null, List.of(), null, null, null);
        List<Target> targets = new ArrayList<>();
        if (node.path("targets").isArray()) for (JsonNode target : node.path("targets")) {
            targets.add(new Target(target.path("label").asText(), number(target.get("price"), Double.NaN)));
        }
        Long opened = node.path("openedAtCandle").isNumber() ? node.path("openedAtCandle").asLong() : null;
        return new Trade(node.path("id").asText(null), node.path("symbol").asText(null), node.path("interval").asText(null),
                node.path("side").asText(null), nullableNumber(node.get("entry")), nullableNumber(node.get("stopLoss")),
                targets, opened, node.path("openedAt").asText(null), node.get("evidence"));
    }

    private static Verdict verdictOf(PostMortemReport summary) {
        if (summary.decided() < 3) return new Verdict("khong-du-mau", "Chưa đủ kèo kết luận được để rút ra hướng nào.");
        double swept = zero(summary.sweptSharePercent());
        double wrong = zero(summary.wrongWaySharePercent());
        double reversed = zero(summary.reversedSharePercent());
        if (swept > 50d) return new Verdict("noi-sl", fmt(swept) + "% số kèo thua là bị quét rồi giá đi đúng hướng — SL đang nằm trong vùng nhiễu. "
                + "Trung vị: đặt " + summary.medianSlPercent() + "%, cần " + summary.medianNeededSlPercent()
                + "%. Hướng sửa là NỚI SL, và nó phải qua backtest bên dưới mới được áp.");
        if (wrong > 50d) return new Verdict("sai-huong", fmt(wrong) + "% số kèo thua đi ngược ngay từ nến đầu — vấn đề nằm ở chỗ CHỌN LỆNH, không phải ở khoảng SL.");
        if (reversed > 50d) return new Verdict("dao-chieu", fmt(reversed) + "% số kèo thua đã đi đúng hướng rồi đảo chiều thật — entry có lợi thế nhưng bảo vệ lợi nhuận quá chậm.");
        return new Verdict("hon-hop", "Nguyên nhân trộn lẫn, không nhóm nào quá nửa — chưa có hướng sửa nào được số liệu chống đỡ rõ.");
    }

    private static Double openedAt(Trade trade) {
        if (trade == null) return null;
        if (trade.openedAtCandle() != null) return trade.openedAtCandle().doubleValue();
        if (trade.openedAt() == null || trade.openedAt().isBlank()) return null;
        try { return (double) Instant.parse(trade.openedAt()).toEpochMilli(); }
        catch (RuntimeException ignored) { return null; }
    }

    private static int indexOf(List<Candle> rows, java.util.function.Predicate<Candle> predicate) {
        for (int index = 0; index < rows.size(); index++) if (predicate.test(rows.get(index))) return index;
        return -1;
    }

    private static boolean finite(Double value) { return value != null && Double.isFinite(value); }
    private static double number(JsonNode node, double fallback) {
        if (node == null || node.isNull()) return fallback;
        try { double value = Double.parseDouble(node.asText()); return Double.isFinite(value) ? value : fallback; }
        catch (RuntimeException ignored) { return fallback; }
    }
    private static Double nullableNumber(JsonNode node) {
        double value = number(node, Double.NaN); return Double.isFinite(value) ? value : null;
    }
    private static Double round(Double value, int digits) { return value == null ? null : round(value.doubleValue(), digits); }
    private static Double round(double value, int digits) { return TradePnlService.round(value, digits); }
    private static Double share(int amount, int total) { return total == 0 ? null : round(amount * 100d / total, 1); }
    private static Double median(List<Double> values) {
        List<Double> sorted = values.stream().filter(value -> value != null && Double.isFinite(value)).sorted().toList();
        if (sorted.isEmpty()) return null;
        int middle = sorted.size() / 2;
        return sorted.size() % 2 == 1 ? sorted.get(middle) : (sorted.get(middle - 1) + sorted.get(middle)) / 2d;
    }
    private static String iso(long millis) { return DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSX")
            .withZone(ZoneOffset.UTC).format(Instant.ofEpochMilli(millis)); }
    private static double zero(Double value) { return value == null ? 0d : value; }
    private static String fmt(double value) { return value == Math.rint(value) ? Long.toString(Math.round(value)) : Double.toString(value); }
    private static void putText(ObjectNode node, String field, String value) { if (value == null) node.putNull(field); else node.put(field, value); }
    private static void putNumber(ObjectNode node, String field, Double value) { if (value == null) node.putNull(field); else node.put(field, value); }
    private static void putInteger(ObjectNode node, String field, Integer value) { if (value == null) node.putNull(field); else node.put(field, value); }
    private static void putBoolean(ObjectNode node, String field, Boolean value) { if (value == null) node.putNull(field); else node.put(field, value); }

    @FunctionalInterface
    public interface CandleFetcher { List<Candle> fetchCandles(String symbol, String interval, int limit); }

    public enum Kind {
        SWEPT(PostMortemService.SWEPT), WRONG_WAY(PostMortemService.WRONG_WAY),
        REVERSED(PostMortemService.REVERSED), UNKNOWN(PostMortemService.UNKNOWN);
        private final String value;
        Kind(String value) { this.value = value; }
        public String value() { return value; }
        public static Kind fromValue(String value) {
            for (Kind kind : values()) if (kind.value.equals(value)) return kind;
            return UNKNOWN;
        }
    }

    public record Target(String label, Double price) {}
    public record Trade(String id, String symbol, String interval, String side, Double entry, Double stopLoss,
                        List<Target> targets, Long openedAtCandle, String openedAt, JsonNode evidence) {
        public Trade { targets = targets == null ? List.of() : List.copyOf(targets); }
    }
    public record Options(int maxHoldBars, double widerSlMultiple, int minBarsAfterStop,
                          int sweepRecoveryBars, double noFavorMoveR) {
        public static Options defaults() { return new Options(96, 1.5d, 6, 6, .15d); }
        Options normalized() { return new Options(Math.max(1, maxHoldBars), Math.max(0d, widerSlMultiple),
                Math.max(0, minBarsAfterStop), Math.max(0, sweepRecoveryBars), noFavorMoveR); }
    }
    public record ReviewPause(boolean active, long leftMs, String until) {
        static ReviewPause inactive() { return new ReviewPause(false, 0L, null); }
    }
    public record Verdict(String id, String text) {}
    public record Replay(String tradeId, String symbol, String interval, String side, JsonNode evidence, Kind kind,
                         String reason, Double mfeBeforeSlR, Double maxAdverseR, Double neededSlPercent,
                         Double slPercent, Integer barsToSl, Integer barsAfterSl, Boolean reachedTp1After,
                         Integer barsToTp1AfterSl, Boolean reachedTp1Soon, Boolean widerStopSaves) {
        static Replay unknown(Base base, String reason) {
            return new Replay(base.tradeId(), base.symbol(), base.interval(), base.side(), base.evidence(), Kind.UNKNOWN,
                    reason, null, null, null, null, null, null, null, null, null, null);
        }
        Replay withKind(Kind value, String detail) {
            return new Replay(tradeId, symbol, interval, side, evidence, value, detail, mfeBeforeSlR, maxAdverseR,
                    neededSlPercent, slPercent, barsToSl, barsAfterSl, reachedTp1After, barsToTp1AfterSl,
                    reachedTp1Soon, widerStopSaves);
        }
    }
    public record PostMortemReport(int total, int decided, Map<String, Integer> counts, Double sweptSharePercent,
                                   Double wrongWaySharePercent, Double reversedSharePercent, Double medianSlPercent,
                                   Double medianNeededSlPercent, Double medianBarsToSl, List<Replay> rows,
                                   Verdict verdict) {
        public PostMortemReport { counts = Map.copyOf(counts); rows = List.copyOf(rows); }
        PostMortemReport withVerdict(Verdict value) {
            return new PostMortemReport(total, decided, counts, sweptSharePercent, wrongWaySharePercent,
                    reversedSharePercent, medianSlPercent, medianNeededSlPercent, medianBarsToSl, rows, value);
        }
    }
    private record Base(String tradeId, String symbol, String interval, String side, JsonNode evidence) {
        static Base of(Trade trade) {
            return trade == null ? new Base(null, null, null, null, null)
                    : new Base(trade.id(), trade.symbol(), trade.interval(), trade.side(), trade.evidence());
        }
    }
}
