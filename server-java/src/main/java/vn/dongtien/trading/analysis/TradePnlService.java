package vn.dongtien.trading.analysis;

import tools.jackson.databind.JsonNode;
import vn.dongtien.trading.data.OpenCallService;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;

/** Pure, shared calculation of the realized return of one finished call. */
public final class TradePnlService {
    private TradePnlService() {}

    /**
     * Return percentage before leverage.  When TP1 was reached but the final
     * target was not, {@code partialFraction} is realized at TP1 and the rest
     * closes at the actual exit price.  Fees apply to each exit.
     */
    public static Double tradeReturnPercent(Trade trade, double partialFraction, double feePercent) {
        if (trade == null || trade.result() == null || trade.entry() == null || trade.result().lastPrice() == null) return null;
        double entry = trade.entry();
        double exit = trade.result().lastPrice();
        if (!Double.isFinite(entry) || entry == 0 || !Double.isFinite(exit)) return null;
        double direction = "long".equals(trade.side()) ? 1d : -1d;
        java.util.function.DoubleFunction<Double> gain = price -> (price - entry) / entry * 100d * direction;
        Target tp1 = trade.targets().isEmpty() ? null : trade.targets().get(0);
        boolean tookPartial = tp1 != null && trade.result().hitTps().contains(tp1.label())
                && !"target".equals(trade.result().status());
        double partial = tookPartial ? partialFraction : 0d;
        double realized = tookPartial ? (gain.apply(tp1.price()) - feePercent) * partial : 0d;
        return round(realized + (gain.apply(exit) - feePercent) * (1d - partial), 2);
    }

    public static Double tradeReturnPercent(Trade trade) {
        return tradeReturnPercent(trade, .5d, .06d);
    }

    public static Double tradeReturnPercent(OpenCallService.OpenCall call, OpenCallService.CheckResult result,
                                            double partialFraction, double feePercent) {
        if (call == null || result == null) return null;
        List<Target> targets = call.targets().stream().map(target -> new Target(target.label(), target.price())).toList();
        return tradeReturnPercent(new Trade(call.side(), call.entry(), targets,
                new Result(result.status().value(), result.hitTps(), result.lastPrice())), partialFraction, feePercent);
    }

    public static boolean tookPartialAtTp1(Trade trade) {
        if (trade == null || trade.result() == null || trade.targets().isEmpty()) return false;
        Target tp1 = trade.targets().get(0);
        return trade.result().hitTps().contains(tp1.label()) && !"target".equals(trade.result().status());
    }

    public static boolean tookPartialAtTp1(OpenCallService.OpenCall call, OpenCallService.CheckResult result) {
        if (call == null || result == null) return false;
        return tookPartialAtTp1(new Trade(call.side(), call.entry(), call.targets().stream()
                .map(target -> new Target(target.label(), target.price())).toList(),
                new Result(result.status().value(), result.hitTps(), result.lastPrice())));
    }

    /** Adapter for persisted trade JSON, useful to reporting services. */
    public static Double tradeReturnPercent(JsonNode trade, double partialFraction, double feePercent) {
        return tradeReturnPercent(fromJson(trade), partialFraction, feePercent);
    }

    public static boolean tookPartialAtTp1(JsonNode trade) {
        return tookPartialAtTp1(fromJson(trade));
    }

    public static Trade fromJson(JsonNode trade) {
        if (trade == null || !trade.isObject()) return new Trade(null, null, List.of(), null);
        List<Target> targets = new ArrayList<>();
        if (trade.path("targets").isArray()) for (JsonNode node : trade.path("targets")) {
            Double price = number(node.get("price"));
            if (price != null) targets.add(new Target(node.path("label").asText(), price));
        }
        JsonNode result = trade.get("result");
        List<String> hits = new ArrayList<>();
        if (result != null && result.path("hitTps").isArray()) for (JsonNode node : result.path("hitTps")) hits.add(node.asText());
        Result parsedResult = result == null || !result.isObject() ? null : new Result(result.path("status").asText(), hits,
                number(result.get("lastPrice")));
        return new Trade(trade.path("side").asText(null), number(trade.get("entry")), targets, parsedResult);
    }

    private static Double number(JsonNode value) {
        if (value == null || value.isNull()) return null;
        double result;
        try { result = Double.parseDouble(value.asText()); }
        catch (RuntimeException ignored) { return null; }
        return Double.isFinite(result) ? result : null;
    }

    static Double round(double value, int digits) {
        if (!Double.isFinite(value)) return null;
        return BigDecimal.valueOf(value).setScale(digits, RoundingMode.HALF_UP).doubleValue();
    }

    public record Target(String label, double price) {}

    public record Result(String status, List<String> hitTps, Double lastPrice) {
        public Result { hitTps = hitTps == null ? List.of() : List.copyOf(hitTps); }
    }

    public record Trade(String side, Double entry, List<Target> targets, Result result) {
        public Trade { targets = targets == null ? List.of() : List.copyOf(targets); }
    }
}
