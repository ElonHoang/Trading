package vn.dongtien.trading.analysis;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.trading.backtest.BacktestService;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.market.Candle;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Small JSON, time and backtest helpers shared by the periodic review services.
 *
 * <p>The persisted state intentionally remains JSON.  It is shared with the
 * old Node runtime through {@code data:auto-retune}, and keeping it document
 * shaped makes migrations and inspection in TiDB straightforward.</p>
 */
final class ReviewSupport {
    static final long DAY_MILLIS = 86_400_000L;

    private ReviewSupport() {}

    static ObjectNode object(ObjectMapper mapper) {
        return mapper.createObjectNode();
    }

    static ObjectNode objectCopy(ObjectMapper mapper, JsonNode node) {
        return node != null && node.isObject() ? ((ObjectNode) node).deepCopy() : mapper.createObjectNode();
    }

    static ArrayNode arrayCopy(ObjectMapper mapper, JsonNode node) {
        return node != null && node.isArray() ? ((ArrayNode) node).deepCopy() : mapper.createArrayNode();
    }

    static JsonNode copy(JsonNode node, ObjectMapper mapper) {
        return node == null ? mapper.valueToTree(null) : node.deepCopy();
    }

    static JsonNode at(JsonNode root, String dottedPath) {
        JsonNode current = root;
        for (String segment : dottedPath.split("\\.")) {
            if (current == null || !current.isObject()) return null;
            current = current.get(segment);
        }
        return current;
    }

    static void setPath(ObjectNode root, String dottedPath, JsonNode value, ObjectMapper mapper) {
        String[] parts = dottedPath.split("\\.");
        ObjectNode current = root;
        for (int index = 0; index < parts.length - 1; index++) {
            JsonNode child = current.get(parts[index]);
            if (child == null || !child.isObject()) {
                ObjectNode created = mapper.createObjectNode();
                current.set(parts[index], created);
                current = created;
            } else {
                current = (ObjectNode) child;
            }
        }
        current.set(parts[parts.length - 1], copy(value, mapper));
    }

    static boolean bool(JsonNode node, boolean fallback) {
        if (node == null || node.isNull() || node.isMissingNode()) return fallback;
        if (node.isBoolean()) return node.asBoolean();
        if (node.isTextual()) return Boolean.parseBoolean(node.asText());
        return fallback;
    }

    static String text(JsonNode node, String fallback) {
        if (node == null || node.isNull() || node.isMissingNode()) return fallback;
        String value = node.asText();
        return value == null || value.isBlank() ? fallback : value;
    }

    static String text(Object value, String fallback) {
        if (value == null) return fallback;
        String text = value.toString();
        return text.isBlank() ? fallback : text;
    }

    static double number(JsonNode node, double fallback) {
        if (node == null || node.isNull() || node.isMissingNode()) return fallback;
        double value;
        try {
            value = node.isNumber() ? node.asDouble() : Double.parseDouble(node.asText());
        } catch (RuntimeException ignored) {
            return fallback;
        }
        return Double.isFinite(value) ? value : fallback;
    }

    static int integer(JsonNode node, int fallback) {
        double value = number(node, Double.NaN);
        return Double.isFinite(value) ? (int) value : fallback;
    }

    static long longValue(JsonNode node, long fallback) {
        double value = number(node, Double.NaN);
        return Double.isFinite(value) ? (long) value : fallback;
    }

    static Double finite(JsonNode node) {
        double value = number(node, Double.NaN);
        return Double.isFinite(value) ? value : null;
    }

    static Double round(Double value, int digits) {
        if (value == null || !Double.isFinite(value)) return null;
        double scale = Math.pow(10, digits);
        return Math.round(value * scale) / scale;
    }

    static double round(double value, int digits) {
        double scale = Math.pow(10, digits);
        return Math.round(value * scale) / scale;
    }

    static Instant instant(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) return null;
        if (node.isNumber()) return Instant.ofEpochMilli(node.asLong());
        return instant(node.asText());
    }

    static Instant instant(String value) {
        if (value == null || value.isBlank()) return null;
        try {
            return Instant.parse(value);
        } catch (DateTimeParseException ignored) {
            try {
                return Instant.ofEpochMilli(Long.parseLong(value));
            } catch (RuntimeException ignoredAgain) {
                return null;
            }
        }
    }

    static String iso(Instant value) {
        return value == null ? null : value.toString();
    }

    static boolean reachedTp1(JsonNode trade) {
        JsonNode result = trade == null ? null : trade.path("result");
        if (result != null && result.path("hitTps").isArray() && !result.path("hitTps").isEmpty()) return true;
        return "target".equals(text(result == null ? null : result.get("status"), ""));
    }

    /** Exact shared PnL convention from the former Node {@code trade-pnl.js}. */
    static Double tradeReturnPercent(JsonNode trade, double partialFraction, double feePercent) {
        return TradePnlService.tradeReturnPercent(trade, partialFraction, feePercent);
    }

    static boolean containsText(JsonNode values, String wanted) {
        if (values == null || !values.isArray() || wanted == null) return false;
        for (JsonNode value : values) if (wanted.equals(value.asText())) return true;
        return false;
    }

    static Map<String, Object> map() {
        return new LinkedHashMap<>();
    }

    static Map<String, Object> copyWithout(Map<String, Object> source, String... keys) {
        Map<String, Object> result = new LinkedHashMap<>(source);
        for (String key : keys) result.remove(key);
        return result;
    }

    /**
     * Uses the simulator's supplied-candle API for the same 75/25 split as the
     * former Node {@code candlesData/startIndex} calls.  The holdout gets all
     * candles for indicator warmup but evaluates only from {@code split}.
     */
    static BacktestSegments backtestSegments(BinanceClient binance, BacktestService backtest,
                                              String symbol, String interval, JsonNode strategy,
                                              int requestedCandles, double trainingRatio) {
        List<Candle> candles = binance.fetchKlinesHistory(symbol, interval, requestedCandles).stream()
                .filter(Candle::closed).toList();
        int split = (int) Math.floor(candles.size() * trainingRatio);
        if (candles.size() < 500 || split <= 220 || candles.size() - split < 120) {
            throw new IllegalArgumentException(symbol + " " + interval + " không đủ nến để kiểm chứng");
        }
        Map<String, Object> train = backtest.runWithCandles(symbol, interval, candles.subList(0, split), split, 220, false, strategy);
        Map<String, Object> holdout = backtest.runWithCandles(symbol, interval, candles, candles.size(), split, false, strategy);
        return new BacktestSegments(metricsWhole(train), metricsWhole(holdout));
    }

    static Map<String, Object> metricsWhole(Map<String, Object> result) {
        Object rawStats = result == null ? null : result.get("stats");
        if (rawStats instanceof Map<?, ?> stats) return metricsFromStats(stats);
        return metrics(result, null, null);
    }

    /**
     * Accept both the original Java return map and the richer Node-compatible
     * return map being added to {@link BacktestService}.  When a time range is
     * requested and individual trades are available, metrics are recomputed so
     * train and holdout do not leak into each other.
     */
    static Map<String, Object> metrics(Map<String, Object> result, Long fromInclusive, Long untilExclusive) {
        List<Map<?, ?>> trades = tradeRows(result == null ? null : result.get("trades"));
        if (!trades.isEmpty()) {
            List<Map<?, ?>> selected = new ArrayList<>();
            for (Map<?, ?> trade : trades) {
                Long openedAt = timeFrom(trade, "openedAt", "entryTime");
                if (fromInclusive != null && openedAt != null && openedAt < fromInclusive) continue;
                if (untilExclusive != null && openedAt != null && openedAt >= untilExclusive) continue;
                // Unknown timestamps are deliberately retained: older persisted
                // backtests did not include them and silently deleting samples is worse.
                selected.add(trade);
            }
            return metricsFromTrades(selected);
        }
        Object rawStats = result == null ? null : result.get("stats");
        if (rawStats instanceof Map<?, ?> stats) return metricsFromStats(stats);
        return metricsFromSimpleResult(result == null ? Map.of() : result);
    }

    private static List<Map<?, ?>> tradeRows(Object raw) {
        if (!(raw instanceof Iterable<?> rows)) return List.of();
        List<Map<?, ?>> result = new ArrayList<>();
        for (Object row : rows) if (row instanceof Map<?, ?> map) result.add(map);
        return result;
    }

    private static Map<String, Object> metricsFromStats(Map<?, ?> stats) {
        Map<String, Object> result = map();
        int trades = integer(stats.get("trades"), 0);
        int stopped = 0;
        Object reasons = stats.get("exitReasons");
        if (reasons instanceof Map<?, ?> map) {
            stopped = integer(map.get("stoploss"), integer(map.get("stopped"), 0));
        }
        result.put("trades", trades);
        result.put("slRatePercent", trades == 0 ? null : round(stopped * 100d / trades, 1));
        result.put("winRatePercent", finite(stats.get("winRatePercent")));
        result.put("profitFactor", finite(stats.get("profitFactor")));
        result.put("expectancyPercent", finite(stats.get("expectancyPercent")));
        result.put("maxDrawdownPercent", finite(stats.get("maxDrawdownPercent")));
        result.put("totalReturnPercent", finite(stats.get("totalReturnPercent")));
        return result;
    }

    private static Map<String, Object> metricsFromSimpleResult(Map<String, Object> source) {
        Map<String, Object> result = map();
        int trades = integer(source.get("closedTrades"), integer(source.get("trades"), 0));
        int losses = integer(source.get("losses"), 0);
        result.put("trades", trades);
        result.put("slRatePercent", trades == 0 ? null : round(losses * 100d / trades, 1));
        result.put("winRatePercent", finite(source.get("winRatePercent")));
        result.put("profitFactor", null);
        result.put("expectancyPercent", trades == 0 ? null : round(number(source.get("netReturnPercent"), 0) / trades, 3));
        result.put("maxDrawdownPercent", null);
        result.put("totalReturnPercent", finite(source.get("netReturnPercent")));
        return result;
    }

    private static Map<String, Object> metricsFromTrades(List<Map<?, ?>> trades) {
        Map<String, Object> result = map();
        List<Double> returns = new ArrayList<>();
        int stopped = 0;
        int wins = 0;
        for (Map<?, ?> trade : trades) {
            double value = number(first(trade, "netPercent", "returnPercent"), 0);
            returns.add(value);
            String outcome = text(first(trade, "outcome", "reason"), "").toLowerCase(Locale.ROOT);
            if (outcome.contains("stop") || outcome.equals("stopped")) stopped++;
            if (value > 0 || outcome.contains("target") || outcome.contains("profit")) wins++;
        }
        int total = trades.size();
        double grossWin = returns.stream().filter(value -> value > 0).mapToDouble(Double::doubleValue).sum();
        double grossLoss = -returns.stream().filter(value -> value <= 0).mapToDouble(Double::doubleValue).sum();
        double equity = 100, peak = 100, maxDrawdown = 0;
        for (double value : returns) {
            equity *= 1 + value / 100;
            peak = Math.max(peak, equity);
            maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
        }
        double totalReturn = equity - 100;
        Double expectancy = total == 0 ? null : returns.stream().mapToDouble(Double::doubleValue).average().orElse(0);
        result.put("trades", total);
        result.put("slRatePercent", total == 0 ? null : round(stopped * 100d / total, 1));
        result.put("winRatePercent", total == 0 ? null : round(wins * 100d / total, 1));
        result.put("profitFactor", grossLoss > 0 ? round(grossWin / grossLoss, 2) : null);
        result.put("expectancyPercent", round(expectancy, 3));
        result.put("maxDrawdownPercent", total == 0 ? null : round(maxDrawdown, 2));
        result.put("totalReturnPercent", total == 0 ? null : round(totalReturn, 2));
        return result;
    }

    private static Object first(Map<?, ?> value, String first, String second) {
        Object found = value.get(first);
        return found == null ? value.get(second) : found;
    }

    private static Long timeFrom(Map<?, ?> value, String primary, String secondary) {
        Object raw = first(value, primary, secondary);
        if (raw instanceof Number number) return number.longValue();
        if (raw != null) {
            Instant instant = instant(raw.toString());
            if (instant != null) return instant.toEpochMilli();
        }
        return null;
    }

    static double number(Object value, double fallback) {
        if (value instanceof Number number) {
            double result = number.doubleValue();
            return Double.isFinite(result) ? result : fallback;
        }
        if (value == null) return fallback;
        try {
            double result = Double.parseDouble(value.toString());
            return Double.isFinite(result) ? result : fallback;
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }

    static int integer(Object value, int fallback) {
        double result = number(value, Double.NaN);
        return Double.isFinite(result) ? (int) result : fallback;
    }

    static Double finite(Object value) {
        double result = number(value, Double.NaN);
        return Double.isFinite(result) ? result : null;
    }

    record BacktestSegments(Map<String, Object> train, Map<String, Object> holdout) {}
}
