package vn.dongtien.trading.analysis;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SetupServiceTest {
    private final SetupService service = new SetupService();

    @Test
    void limitOrderUsesTheAnchoredPriceRatherThanTheZoneMidpoint() {
        Map<String, Object> snapshot = Map.of(
                "price", Map.of("lastClose", 100d),
                "combined", Map.of("score", 20d),
                "structure", Map.of(
                        "support", List.of(Map.of("price", 99.5d, "touches", 3)),
                        "resistance", List.of(Map.of("price", 103d, "touches", 2))));
        Map<String, Object> risk = Map.of(
                "slPercent", 4d,
                "takeProfitR", List.of(.75d, 1.5d),
                "limitOrder", Map.of(
                        "minDistancePercent", .5d,
                        "maxDistancePercent", 4d,
                        "zoneWidthR", .3d,
                        "maxZoneFractionOfDistance", .5d,
                        "fallbackPullbackPercent", 1.5d,
                        "minLeanScore", 10d,
                        "expiryBars", 6));

        Map<String, Object> plan = service.buildLimitPlan(snapshot, risk);
        Map<String, Object> order = first(plan, "orders");
        Map<String, Object> zone = map(order.get("zone"));

        assertEquals("long", order.get("direction"));
        assertEquals(99.5d, number(order.get("entry")));
        assertTrue(number(order.get("entry")) < 100d);
        assertTrue(number(order.get("entry")) != (number(zone.get("low")) + number(zone.get("high"))) / 2);
        assertEquals(4d, number(order.get("riskPercent")), 1e-10);
    }

    @Test
    void criticalContextVetoTurnsALongIntoLimit() {
        Map<String, Object> snapshot = Map.of(
                "combined", Map.of("side", "long", "signal", "MUA", "score", 42d, "strength", "normal"),
                "levels", Map.of("entry", 100d, "stopLoss", 96d, "riskPercent", 4d,
                        "targets", List.of(), "srTargets", List.of()),
                "rules", Map.of("breakdown", Map.of()),
                "conflicts", List.of());
        Map<String, Object> context = Map.of(
                "blockLong", true,
                "blockShort", false,
                "bias", "blocked",
                "warnings", List.of(Map.of("severity", "critical", "text", "Đã có thông báo delist")),
                "supports", List.of());

        Map<String, Object> setup = service.buildSetup(snapshot, context);

        assertEquals("none", setup.get("side"));
        assertEquals("LIMIT", setup.get("signal"));
        assertTrue((Boolean) setup.get("blocked"));
        assertTrue((Boolean) setup.get("vetoed"));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> first(Map<String, Object> source, String key) {
        return (Map<String, Object>) ((List<?>) source.get(key)).get(0);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    private static double number(Object value) {
        return ((Number) value).doubleValue();
    }
}
