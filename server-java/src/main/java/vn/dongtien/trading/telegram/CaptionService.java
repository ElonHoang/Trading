package vn.dongtien.trading.telegram;

import vn.dongtien.trading.analysis.TradePnlService;
import vn.dongtien.trading.data.OpenCallService;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.NumberFormat;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Pure HTML caption/message builders used by the Telegram alert lifecycle. */
public final class CaptionService {
    public static final int CAPTION_LIMIT = 1024;
    private static final String HR = "━━━━━━━━━━━━━━━━━━";
    private static final Locale VIETNAMESE = Locale.forLanguageTag("vi-VN");

    private CaptionService() {}

    /** Escapes the three characters Telegram HTML requires escaped. */
    public static String esc(Object value) {
        return String.valueOf(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    public static String buildCaption(Map<String, ?> snapshot) {
        return buildCaption(snapshot, null, null);
    }

    public static String buildCaption(Map<String, ?> snapshot, Map<String, ?> setup, Map<String, ?> limitPlan) {
        Map<String, ?> snap = map(snapshot);
        Map<String, ?> price = map(snap.get("price"));
        double lastClose = number(price.get("lastClose"), Double.NaN);
        int decimals = decimalsFor(lastClose);
        String side = text(setup, "side", "none");
        List<String> lines = new ArrayList<>();

        lines.add("🔥 <b>" + esc(snap.get("symbol")) + "</b> | Khung " + esc(snap.get("interval")));
        String current = "💰 Giá hiện tại: <b>" + fmt(lastClose, decimals) + "</b>";
        Double change = nullableNumber(price.get("change24hPercent"));
        if (change != null) current += " (" + pct(change, 2) + ")";
        lines.add(current);
        lines.add("long".equals(side) ? "🚨 KHUYẾN NGHỊ: 🟢 <b>LONG / MUA</b>"
                : "short".equals(side) ? "🚨 KHUYẾN NGHỊ: 🔴 <b>SHORT / BÁN</b>"
                : "🚨 KHUYẾN NGHỊ: 🟡 <b>LIMIT</b>");

        if (!"none".equals(side) && nullableNumber(value(setup, "entry")) != null) {
            lines.add(HR);
            lines.add("🎯 <b>CHI TIẾT LỆNH</b>");
            double entry = number(value(setup, "entry"), Double.NaN);
            lines.add("• Entry (Vào lệnh): " + fmt(entry, decimals));
            lines.add("• Stoploss (Cắt lỗ): " + fmt(number(value(setup, "stopLoss"), Double.NaN), decimals)
                    + " (Rủi ro " + fmt(number(value(setup, "riskPercent"), Double.NaN), 2) + "%)");
            List<Map<String, ?>> targets = maps(value(setup, "targets"));
            if (!targets.isEmpty()) {
                lines.add("• Take Profit (Chốt lời):");
                for (int index = 0; index < targets.size(); index++) {
                    double target = number(targets.get(index).get("price"), Double.NaN);
                    double move = (target - entry) / entry * 100d;
                    lines.add("   👉 TP " + (index + 1) + ": " + fmt(target, decimals) + " (" + pct(move, 2) + ")");
                }
            }
            Double rr = nullableNumber(value(setup, "rrToTp1"));
            if (rr != null && rr != 0d) lines.add("⚖️ Tỷ lệ R:R: " + fmt(rr, 2));
        }

        List<Map<String, ?>> orders = maps(value(limitPlan, "orders"));
        boolean vetoed = bool(value(setup, "vetoed"), false);
        if (!orders.isEmpty() && "none".equals(side) && !vetoed) {
            lines.add(HR);
            lines.add("🎯 <b>LỆNH CHỜ (LIMIT)</b> — đặt tại Entry LIMIT bên dưới, KHÔNG vào giá hiện tại");
            for (Map<String, ?> order : orders) {
                boolean longSide = "long".equals(text(order, "direction", ""));
                lines.add((longSide ? "🟢" : "🔴") + " <b>" + esc(order.get("label")) + "</b>");
                lines.add("   • Entry LIMIT (giá đặt lệnh): <b>" + fmt(number(order.get("entry"), Double.NaN), decimals)
                        + "</b> (" + pct(number(order.get("distancePercent"), Double.NaN), 2) + " so với giá hiện tại)");
                Map<String, ?> zone = map(order.get("zone"));
                lines.add("   • Vùng khớp tham khảo: " + fmt(number(zone.get("low"), Double.NaN), decimals)
                        + " – " + fmt(number(zone.get("high"), Double.NaN), decimals));
                String targets = maps(order.get("targets")).stream().map(target -> fmt(number(target.get("price"), Double.NaN), decimals))
                        .reduce((left, right) -> left + " / " + right).orElse("");
                lines.add("   • SL " + fmt(number(order.get("stopLoss"), Double.NaN), decimals) + " (rủi ro "
                        + fmt(number(order.get("riskPercent"), Double.NaN), 2) + "%) · TP " + targets);
                if (bool(order.get("fromStructure"), false)) {
                    lines.add("   • Neo vào " + (longSide ? "hỗ trợ" : "kháng cự") + " "
                            + fmt(number(order.get("anchor"), Double.NaN), decimals) + " ("
                            + stringNumber(order.get("anchorTouches")) + " lần chạm)");
                } else lines.add("   • Neo: " + esc(order.get("basis")));
                lines.add("   • Huỷ nếu nến đóng " + (longSide ? "dưới" : "trên") + " "
                        + fmt(number(order.get("stopLoss"), Double.NaN), decimals) + ", hoặc chưa khớp sau "
                        + stringNumber(order.get("expiryBars")) + " nến");
            }
        }
        return String.join("\n", lines);
    }

    /** Splits at a line boundary so HTML tags and price lines are not cut in half. */
    public static SplitCaption splitCaption(String text) { return splitCaption(text, CAPTION_LIMIT); }
    public static SplitCaption splitCaption(String text, int limit) {
        String value = text == null ? "" : text;
        if (value.length() <= limit) return new SplitCaption(value, null);
        String[] lines = value.split("\\n", -1);
        List<String> head = new ArrayList<>();
        int used = 0;
        for (String line : lines) {
            if (used + line.length() + 1 > limit - 20) break;
            head.add(line);
            used += line.length() + 1;
        }
        String rest = String.join("\n", java.util.Arrays.copyOfRange(lines, head.size(), lines.length)).trim();
        return new SplitCaption(String.join("\n", head) + "\n<i>(xem tiếp bên dưới)</i>", rest.isEmpty() ? null : rest);
    }

    public static String buildTpUpdate(Map<String, ?> call, List<String> hitTps, Map<String, ?> risk) {
        Map<String, ?> safeCall = map(call);
        List<String> hits = hitTps == null ? List.of() : hitTps;
        double entry = number(safeCall.get("entry"), Double.NaN);
        int decimals = decimalsFor(entry);
        boolean isLong = "long".equals(text(safeCall, "side", ""));
        List<Map<String, ?>> targets = maps(safeCall.get("targets"));
        String lastLabel = hits.isEmpty() ? null : hits.get(hits.size() - 1);
        int index = -1;
        Map<String, ?> target = Map.of();
        for (int i = 0; i < targets.size(); i++) if (java.util.Objects.equals(text(targets.get(i), "label", null), lastLabel)) {
            index = i; target = targets.get(i); break;
        }
        boolean isFinal = index >= 0 && index == targets.size() - 1;
        Map<String, ?> next = index >= 0 && index + 1 < targets.size() ? targets.get(index + 1) : null;
        Double targetPrice = nullableNumber(target.get("price"));
        Double spot = targetPrice == null ? null : (targetPrice - entry) / entry * 100d * (isLong ? 1d : -1d);
        double leverage = number(value(risk, "displayLeverage"), 10d);
        long partial = Math.round(number(value(risk, "partialFraction"), .5d) * 100d);
        List<String> lines = new ArrayList<>();
        lines.add("🚀 <b>CẬP NHẬT: " + esc(safeCall.get("symbol")) + " HIT " + (isFinal ? "TP FULL" : esc(lastLabel)) + "!</b>");
        if (spot != null) lines.add("💰 Lợi nhuận: " + pct(spot, 2) + " (Spot) | " + pct(spot * leverage, 2)
                + " (Đòn bẩy " + stringNumber(leverage) + "x)");
        lines.add(HR);
        lines.add("🎯 <b>CHI TIẾT CHỐT LỜI</b>");
        lines.add("• Entry đã gọi : " + fmt(entry, decimals));
        lines.add("• Mốc TP vừa hit : " + (targetPrice == null ? "—" : fmt(targetPrice, decimals)));
        lines.add("• Trạng thái lệnh : " + (isFinal ? "Chốt hết" : "Đã chốt 1 phần, gồng tiếp"));
        lines.add(HR);
        lines.add("🛠 <b>HÀNH ĐỘNG TIẾP THEO</b>");
        if (isFinal) {
            lines.add("✅ Chốt lời: Đóng 100% khối lượng còn lại tại đây.");
            lines.add("🛡 Quản lý rủi ro: Lệnh đã đóng hết, không còn rủi ro.");
        } else {
            lines.add("✅ Chốt lời: Đóng " + (index == 0 ? partial : 50) + "% khối lượng lệnh tại đây.");
            lines.add(index == 0 ? "🛡 Quản lý rủi ro: Dời Stoploss về Entry (hoà vốn)."
                    : "🛡 Quản lý rủi ro: Giữ Stoploss ở " + fmt(entry, decimals) + " (entry).");
            if (next != null) lines.add("👀 Mục tiêu tiếp: " + esc(next.get("label")) + " tại "
                    + fmt(number(next.get("price"), Double.NaN), decimals) + ".");
        }
        return String.join("\n", lines);
    }

    public static String buildTpUpdate(OpenCallService.OpenCall call, List<String> hitTps, Map<String, ?> risk) {
        return buildTpUpdate(callMap(call), hitTps, risk);
    }

    public static String buildClosedNote(Map<String, ?> call, Map<String, ?> result, Map<String, ?> risk, double feePercent) {
        Map<String, ?> safeCall = map(call), safeResult = map(result);
        double entry = number(safeCall.get("entry"), Double.NaN);
        int decimals = decimalsFor(entry);
        double partialFraction = number(value(risk, "partialFraction"), .5d);
        TradePnlService.Trade trade = toTrade(safeCall, safeResult);
        Double pnl = TradePnlService.tradeReturnPercent(trade, partialFraction, feePercent);
        boolean tookPartial = TradePnlService.tookPartialAtTp1(trade);
        List<Map<String, ?>> targets = maps(safeCall.get("targets"));
        Map<String, ?> tp1 = targets.isEmpty() ? null : targets.get(0);
        List<String> hits = strings(safeResult.get("hitTps"));
        String status = text(safeResult, "status", "expired");
        String icon = switch (status) { case "stopped" -> "🛑"; case "breakeven" -> "🛡"; default -> "⏱"; };
        String label = switch (status) { case "stopped" -> "CHẠM STOPLOSS"; case "breakeven" -> "VỀ HOÀ VỐN (SL đã kéo về entry sau TP1)"; default -> "HẾT HẠN GIỮ"; };
        List<String> lines = new ArrayList<>();
        lines.add(icon + " <b>" + esc(safeCall.get("symbol")) + " " + esc(safeCall.get("interval")) + "</b> — " + label);
        String line = ("long".equals(text(safeCall, "side", "")) ? "LONG" : "SHORT") + " từ " + fmt(entry, decimals);
        if (pnl != null) line += " · kết quả " + pct(pnl, 2);
        if (!hits.isEmpty()) line += " · đã chạm " + esc(String.join(", ", hits));
        lines.add(line);
        if (tookPartial && pnl != null && tp1 != null) {
            lines.add("<i>Gồm " + Math.round(partialFraction * 100d) + "% đã chốt ở " + esc(tp1.get("label"))
                    + " (" + fmt(number(tp1.get("price"), Double.NaN), decimals) + "), phần còn lại thoát ở "
                    + fmt(number(safeResult.get("lastPrice"), Double.NaN), decimals) + ".</i>");
        }
        return String.join("\n", lines);
    }

    public static String buildClosedNote(Map<String, ?> call, Map<String, ?> result, Map<String, ?> risk) {
        return buildClosedNote(call, result, risk, .06d);
    }

    public static String buildClosedNote(OpenCallService.OpenCall call, OpenCallService.CheckResult result,
                                         Map<String, ?> risk, double feePercent) {
        return buildClosedNote(callMap(call), resultMap(result), risk, feePercent);
    }

    public static String buildClosedNote(OpenCallService.OpenCall call, OpenCallService.CheckResult result,
                                         Map<String, ?> risk) {
        return buildClosedNote(call, result, risk, .06d);
    }

    public static String buildQuoteMessage(Map<String, ?> snapshot) {
        Map<String, ?> snap = map(snapshot), price = map(snap.get("price")), indicators = map(snap.get("indicators")), combined = map(snap.get("combined"));
        double lastClose = number(price.get("lastClose"), Double.NaN);
        String change = nullableNumber(price.get("change24hPercent")) == null ? ""
                : "  " + pct(number(price.get("change24hPercent"), Double.NaN), 2) + " (24h)";
        String cvd = nullableNumber(indicators.get("cvdSlope")) == null ? "—" : pct(number(indicators.get("cvdSlope"), Double.NaN) * 100d, 1);
        String volume = nullableNumber(indicators.get("volumeRatio")) == null ? "—" : fmt(number(indicators.get("volumeRatio"), Double.NaN), 2) + "×";
        return "<b>" + esc(snap.get("symbol")) + "</b> · " + esc(snap.get("interval")) + "  " + fmt(lastClose, decimalsFor(lastClose)) + change + "\n"
                + esc(combined.get("signal")) + " (" + stringNumber(combined.get("score")) + "/100) · CVD " + cvd + " · Vol " + volume;
    }

    public static int decimalsFor(double value) {
        double absolute = Math.abs(value);
        if (!Double.isFinite(value) || absolute == 0d) return 2;
        if (absolute < .001d) return 8;
        if (absolute < 1d) return 6;
        if (absolute < 100d) return 4;
        return 2;
    }
    public static String fmt(double value, int digits) {
        if (!Double.isFinite(value)) return "—";
        NumberFormat formatter = NumberFormat.getNumberInstance(VIETNAMESE);
        formatter.setMinimumFractionDigits(digits); formatter.setMaximumFractionDigits(digits);
        return formatter.format(value);
    }
    public static String pct(double value, int digits) {
        if (!Double.isFinite(value)) return "—";
        double rounded = BigDecimal.valueOf(value).setScale(digits, RoundingMode.HALF_UP).doubleValue();
        return (rounded > 0 ? "+" : "") + fmt(rounded, digits) + "%";
    }

    private static TradePnlService.Trade toTrade(Map<String, ?> call, Map<String, ?> result) {
        List<TradePnlService.Target> targets = maps(call.get("targets")).stream()
                .map(target -> new TradePnlService.Target(text(target, "label", ""), number(target.get("price"), Double.NaN))).toList();
        return new TradePnlService.Trade(text(call, "side", null), nullableNumber(call.get("entry")), targets,
                new TradePnlService.Result(text(result, "status", null), strings(result.get("hitTps")), nullableNumber(result.get("lastPrice"))));
    }
    private static Map<String, Object> callMap(OpenCallService.OpenCall call) {
        Map<String, Object> value = new LinkedHashMap<>();
        if (call == null) return value;
        value.put("symbol", call.symbol()); value.put("interval", call.interval()); value.put("side", call.side());
        value.put("entry", call.entry()); value.put("stopLoss", call.stopLoss());
        List<Map<String, Object>> targets = new ArrayList<>();
        for (OpenCallService.Target target : call.targets()) {
            Map<String, Object> row = new LinkedHashMap<>(); row.put("label", target.label()); row.put("price", target.price()); targets.add(row);
        }
        value.put("targets", targets); return value;
    }
    private static Map<String, Object> resultMap(OpenCallService.CheckResult result) {
        Map<String, Object> value = new LinkedHashMap<>();
        if (result == null) return value;
        value.put("status", result.status().value()); value.put("hitTps", result.hitTps()); value.put("lastPrice", result.lastPrice());
        return value;
    }
    @SuppressWarnings("unchecked") private static Map<String, ?> map(Object value) {
        return value instanceof Map<?, ?> values ? (Map<String, ?>) values : Map.of();
    }
    private static Object value(Map<String, ?> map, String field) { return map == null ? null : map.get(field); }
    private static String text(Map<String, ?> map, String field, String fallback) {
        Object value = value(map, field); return value == null ? fallback : String.valueOf(value);
    }
    private static boolean bool(Object value, boolean fallback) { return value instanceof Boolean bool ? bool : fallback; }
    private static double number(Object value, double fallback) {
        if (value == null) return fallback;
        try { double number = value instanceof Number n ? n.doubleValue() : Double.parseDouble(String.valueOf(value)); return Double.isFinite(number) ? number : fallback; }
        catch (RuntimeException ignored) { return fallback; }
    }
    private static Double nullableNumber(Object value) { double number = number(value, Double.NaN); return Double.isFinite(number) ? number : null; }
    private static String stringNumber(Object value) {
        if (value instanceof Number number && number.doubleValue() == Math.rint(number.doubleValue())) return Long.toString(Math.round(number.doubleValue()));
        return String.valueOf(value);
    }
    @SuppressWarnings("unchecked") private static List<Map<String, ?>> maps(Object value) {
        if (!(value instanceof List<?> values)) return List.of();
        List<Map<String, ?>> result = new ArrayList<>();
        for (Object item : values) if (item instanceof Map<?, ?>) result.add((Map<String, ?>) item);
        return result;
    }
    private static List<String> strings(Object value) {
        if (!(value instanceof List<?> values)) return List.of();
        return values.stream().map(String::valueOf).toList();
    }

    public record SplitCaption(String caption, String rest) {}
}
