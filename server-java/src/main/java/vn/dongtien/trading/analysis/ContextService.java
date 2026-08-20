package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import vn.dongtien.trading.data.AnnouncementService;
import vn.dongtien.trading.data.FundamentalsService;
import vn.dongtien.trading.data.NewsService;
import vn.dongtien.trading.market.BinanceClient;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * Supplemental, non-backtestable context (tokenomics, news and delisting risk).
 * It never changes a technical score; it only supports or vetoes a setup.
 */
@Service
public class ContextService {
    private static final double DEFAULT_FDV_RATIO_WARN = 2;
    private static final double DEFAULT_FDV_RATIO_SEVERE = 4;
    private static final double DEFAULT_CIRCULATING_WARN_PERCENT = 50;
    private static final double DEFAULT_VOLUME_TO_MCAP_WARN = .02;
    private static final double DEFAULT_RANK_RISKY_ABOVE = 300;

    private final BinanceClient binance;
    private final FundamentalsService fundamentals;
    private final AnnouncementService announcements;
    private final NewsService news;

    public ContextService(BinanceClient binance, FundamentalsService fundamentals,
                          AnnouncementService announcements, NewsService news) {
        this.binance = binance;
        this.fundamentals = fundamentals;
        this.announcements = announcements;
        this.news = news;
    }

    public Map<String, Object> buildContext(String symbol) {
        return buildContext(symbol, Map.of());
    }

    /** Allows a sparse context configuration with the same field names as the former JS module. */
    public Map<String, Object> buildContext(String symbol, Map<String, ?> config) {
        Map<String, ?> cfg = config == null ? Map.of() : config;
        Thresholds thresholds = new Thresholds(
                number(cfg.get("fdvRatioWarn"), DEFAULT_FDV_RATIO_WARN),
                number(cfg.get("fdvRatioSevere"), DEFAULT_FDV_RATIO_SEVERE),
                number(cfg.get("circulatingWarnPercent"), DEFAULT_CIRCULATING_WARN_PERCENT),
                number(cfg.get("volumeToMcapWarn"), DEFAULT_VOLUME_TO_MCAP_WARN),
                number(cfg.get("rankRiskyAbove"), DEFAULT_RANK_RISKY_ABOVE));

        String baseAsset = safely(() -> baseAssetOf(symbol));
        CompletableFuture<Map<String, Object>> tokenomicsFuture = baseAsset == null
                ? CompletableFuture.completedFuture(null)
                : CompletableFuture.supplyAsync(() -> safely(() -> fundamentals.fetchTokenomics(baseAsset)));
        CompletableFuture<Map<String, Object>> delistFuture = CompletableFuture.supplyAsync(
                () -> safely(() -> announcements.fetchDelistRisk(symbol, baseAsset)));

        Map<String, Object> tokenomics = tokenomicsFuture.join();
        Map<String, Object> delistRisk = delistFuture.join();
        Map<String, Object> tokenNews = baseAsset == null ? null
                : safely(() -> news.fetchTokenNews(baseAsset, text(tokenomics, "name")));

        List<Map<String, Object>> warnings = new ArrayList<>();
        List<String> supports = new ArrayList<>();
        boolean blockLong = false;
        boolean blockShort = false;

        if (delistRisk != null) {
            String status = text(delistRisk, "symbolStatus");
            if (status != null && !status.isEmpty() && !bool(delistRisk, "statusIsTrading", false)) {
                warnings.add(warning("critical", "Cặp đang ở trạng thái " + status
                        + " (không giao dịch) — không vào lệnh"));
                blockLong = true;
                blockShort = true;
            }
            List<Map<String, Object>> matched = maps(delistRisk.get("matchedAnnouncements"));
            if (!matched.isEmpty()) {
                warnings.add(warning("critical", "Có thông báo delist nhắc tới " + baseAsset + ": \""
                        + textOrEmpty(matched.get(0), "title") + "\""));
                blockLong = true;
            }
            List<Map<String, Object>> unparsed = maps(delistRisk.get("unparsedNotices"));
            if (!unparsed.isEmpty()) {
                warnings.add(warning("info", unparsed.size()
                        + " thông báo removal không ghi token trong tiêu đề — nên tự mở kiểm tra"));
            }
            if (!bool(delistRisk, "sourceAvailable", false)) {
                warnings.add(warning("warn", "Không đọc được thông báo delist của Binance — chưa kiểm tra được rủi ro delist"));
            }
        }

        if (tokenomics != null) {
            Double ratio = numberOrNull(tokenomics.get("fdvToMarketCap"));
            if (ratio != null) {
                if (ratio >= thresholds.fdvRatioSevere()) {
                    warnings.add(warning("warn", "FDV gấp " + fixed(ratio, 1)
                            + "× vốn hoá — phần lớn cung chưa lưu hành, áp lực pha loãng rất lớn"));
                } else if (ratio >= thresholds.fdvRatioWarn()) {
                    warnings.add(warning("warn", "FDV gấp " + fixed(ratio, 1)
                            + "× vốn hoá — còn nhiều token sẽ được mở khoá"));
                } else if (ratio <= 1.15) {
                    supports.add("FDV chỉ gấp " + fixed(ratio, 2)
                            + "× vốn hoá — gần như đã lưu hành hết, ít áp lực pha loãng");
                }
            }
            Double circulatingPercent = numberOrNull(tokenomics.get("circulatingPercent"));
            if (circulatingPercent != null && circulatingPercent < thresholds.circulatingWarnPercent()) {
                warnings.add(warning("warn", "Chỉ " + fixed(circulatingPercent, 1) + "% tổng cung đang lưu hành"));
            }
            Double volumeToMcap = numberOrNull(tokenomics.get("volumeToMarketCap"));
            if (volumeToMcap != null && volumeToMcap < thresholds.volumeToMcapWarn()) {
                warnings.add(warning("warn", "Khối lượng 24h chỉ " + fixed(volumeToMcap * 100, 2)
                        + "% vốn hoá — thanh khoản mỏng, dễ trượt giá"));
            }
            Double rank = numberOrNull(tokenomics.get("marketCapRank"));
            if (rank != null && rank > thresholds.rankRiskyAbove()) {
                warnings.add(warning("warn", "Xếp hạng vốn hoá #" + integerText(rank)
                        + " — token nhỏ, biến động và rủi ro cao"));
            } else if (rank != null && rank <= 50) {
                supports.add("Vốn hoá #" + integerText(rank) + " — token lớn, thanh khoản tốt");
            }
        } else {
            warnings.add(warning("info", "Không lấy được tokenomics (CoinGecko không có token này hoặc lỗi mạng)"));
        }

        if (tokenNews != null && bool(tokenNews, "available", false) && !maps(tokenNews.get("items")).isEmpty()) {
            Map<String, Object> counts = map(tokenNews.get("counts"));
            int negative = (int) number(counts.get("negative"), 0);
            int positive = (int) number(counts.get("positive"), 0);
            Map<String, Object> worst = mapOrNull(tokenNews.get("firstNegative"));
            Map<String, Object> best = mapOrNull(tokenNews.get("firstPositive"));
            if (negative > 0 && worst != null) {
                warnings.add(warning(negative >= 2 ? "warn" : "info", negative + " tin tiêu cực ("
                        + String.join(", ", strings(worst.get("keywords"))) + "): \""
                        + shorten(textOrEmpty(worst, "title"), 90) + "\""));
            }
            if (positive > 0 && negative == 0 && best != null) {
                supports.add(positive + " tin tích cực (" + String.join(", ", strings(best.get("keywords"))) + "): \""
                        + shorten(textOrEmpty(best, "title"), 90) + "\"");
            }
        } else if (tokenNews != null && text(tokenNews, "note") != null) {
            warnings.add(warning("info", text(tokenNews, "note")));
        }

        boolean critical = warnings.stream().anyMatch(value -> "critical".equals(value.get("severity")));
        boolean hasWarn = warnings.stream().anyMatch(value -> "warn".equals(value.get("severity")));
        String bias = critical ? "blocked"
                : hasWarn && supports.isEmpty() ? "negative"
                : !supports.isEmpty() && !hasWarn ? "positive"
                : "neutral";

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("baseAsset", baseAsset);
        result.put("tokenomics", tokenomics);
        result.put("delistRisk", delistRisk);
        result.put("news", tokenNews);
        result.put("warnings", warnings);
        result.put("supports", supports);
        result.put("blockLong", blockLong);
        result.put("blockShort", blockShort);
        result.put("bias", bias);
        return result;
    }

    public Map<String, Object> buildContext(String symbol, JsonNode config) {
        return buildContext(symbol, object(config));
    }

    private String baseAssetOf(String symbol) {
        BinanceClient.SymbolInfo info = binance.fetchSymbolInfo().get(symbol);
        return info == null ? null : info.baseAsset();
    }

    private static Map<String, Object> warning(String severity, String text) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("severity", severity);
        result.put("text", text);
        return result;
    }

    private static <T> T safely(Supplier<T> supplier) {
        try {
            return supplier.get();
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static double number(Object value, double fallback) {
        Double parsed = numberOrNull(value);
        return parsed == null ? fallback : parsed;
    }

    private static Double numberOrNull(Object value) {
        if (value instanceof Number number) return number.doubleValue();
        if (value instanceof String string) {
            try {
                return Double.parseDouble(string);
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private static boolean bool(Map<String, Object> source, String field, boolean fallback) {
        Object value = source.get(field);
        if (value instanceof Boolean bool) return bool;
        if (value instanceof String text) return Boolean.parseBoolean(text);
        return fallback;
    }

    private static String text(Map<String, Object> source, String field) {
        return source == null || source.get(field) == null ? null : String.valueOf(source.get(field));
    }

    private static String textOrEmpty(Map<String, Object> source, String field) {
        String value = text(source, field);
        return value == null ? "" : value;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return value instanceof Map<?, ?> raw ? (Map<String, Object>) raw : Map.of();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> mapOrNull(Object value) {
        return value instanceof Map<?, ?> raw ? (Map<String, Object>) raw : null;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> maps(Object value) {
        if (!(value instanceof List<?> values)) return List.of();
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : values) if (item instanceof Map<?, ?> raw) result.add((Map<String, Object>) raw);
        return result;
    }

    private static List<String> strings(Object value) {
        if (!(value instanceof List<?> values)) return List.of();
        List<String> result = new ArrayList<>();
        for (Object item : values) if (item != null) result.add(String.valueOf(item));
        return result;
    }

    private static String fixed(double value, int places) {
        return String.format(Locale.ROOT, "%." + places + "f", value);
    }

    private static String integerText(double value) {
        return Math.rint(value) == value ? Long.toString((long) value) : Double.toString(value);
    }

    private static String shorten(String value, int length) {
        return value.substring(0, Math.min(length, value.length()));
    }

    private static Map<String, Object> object(JsonNode node) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (node == null || !node.isObject()) return result;
        node.properties().forEach(entry -> result.put(entry.getKey(), value(entry.getValue())));
        return result;
    }

    private static Object value(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) return null;
        if (node.isObject()) return object(node);
        if (node.isArray()) {
            List<Object> result = new ArrayList<>();
            for (JsonNode child : node) result.add(value(child));
            return result;
        }
        if (node.isBoolean()) return node.asBoolean();
        if (node.isIntegralNumber()) return node.asLong();
        if (node.isNumber()) return node.asDouble();
        return node.asText();
    }

    private record Thresholds(double fdvRatioWarn, double fdvRatioSevere, double circulatingWarnPercent,
                              double volumeToMcapWarn, double rankRiskyAbove) {}
}
