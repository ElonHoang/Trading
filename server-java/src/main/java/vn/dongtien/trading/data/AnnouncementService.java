package vn.dongtien.trading.data;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import vn.dongtien.trading.market.BinanceClient;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Binance listing/delisting notices, augmented by the official exchangeInfo symbol status. */
@Service
public class AnnouncementService {
    private static final String CMS = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query";
    private static final int DELISTING_CATALOG = 161;
    private static final int LISTING_CATALOG = 48;
    private static final int MAX_PAGE_SIZE = 20;
    private static final long TTL_MS = Duration.ofMinutes(30).toMillis();
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(15);
    private static final Pattern TITLE_TICKER = Pattern.compile("\\b[A-Z0-9]{2,10}\\b");
    private static final Set<String> TITLE_NOISE = Set.of(
            "BINANCE", "WILL", "AND", "THE", "FOR", "USDT", "USDC", "BUSD", "FDUSD", "USD",
            "SPOT", "MARGIN", "FUTURES", "PERPETUAL", "CONTRACT", "CONTRACTS", "TRADING",
            "PAIRS", "PAIR", "REMOVAL", "REMOVE", "DELIST", "DELISTING", "NOTICE", "UPDATE",
            "ADD", "ADDS", "NEW", "ON", "OF", "TO", "AT", "IN", "ISOLATED", "CROSS",
            "CONVERSION", "REGARDING", "SERVICES", "BOTS", "EARN", "API", "VIP", "M", "U");

    private final BinanceClient binance;
    private final ObjectMapper mapper;
    private final HttpClient http;
    private final Map<String, CacheEntry<List<Map<String, Object>>>> cache = new ConcurrentHashMap<>();
    private final Object cacheLock = new Object();

    @Autowired
    public AnnouncementService(BinanceClient binance, ObjectMapper mapper) {
        this(binance, mapper, HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build());
    }

    AnnouncementService(BinanceClient binance, ObjectMapper mapper, HttpClient http) {
        this.binance = binance;
        this.mapper = mapper;
        this.http = http;
    }

    /** Latest delisting notices. CMS failures intentionally degrade to an empty list. */
    public List<Map<String, Object>> fetchDelistAnnouncements() {
        return fetchDelistAnnouncements(MAX_PAGE_SIZE);
    }

    public List<Map<String, Object>> fetchDelistAnnouncements(int pageSize) {
        try {
            return fetchCatalog(DELISTING_CATALOG, pageSize);
        } catch (RuntimeException ignored) {
            return List.of();
        }
    }

    public List<Map<String, Object>> fetchListingAnnouncements() {
        return fetchListingAnnouncements(MAX_PAGE_SIZE);
    }

    public List<Map<String, Object>> fetchListingAnnouncements(int pageSize) {
        try {
            return fetchCatalog(LISTING_CATALOG, pageSize);
        } catch (RuntimeException ignored) {
            return List.of();
        }
    }

    /**
     * Combines the official symbol state with title-only matches from Binance's
     * undocumented CMS endpoint.  The latter cannot establish that a token is
     * safe: an empty result only means its notice feed was unavailable or had no
     * title match.
     */
    public Map<String, Object> fetchDelistRisk(String symbol, String baseAsset) {
        String status = null;
        try {
            BinanceClient.SymbolInfo info = binance.fetchSymbolInfo().get(symbol);
            status = info == null ? null : info.status();
        } catch (RuntimeException ignored) {
            // Context remains optional; the result below records that the CMS
            // source was unavailable when appropriate.
        }

        List<Map<String, Object>> notices = fetchDelistAnnouncements(30);
        String ticker = baseAsset == null ? "" : baseAsset.toUpperCase(Locale.ROOT);
        List<Map<String, Object>> matched = new ArrayList<>();
        List<Map<String, Object>> unparsed = new ArrayList<>();
        for (Map<String, Object> notice : notices) {
            List<String> tickers = tickersInTitle(string(notice.get("title")));
            if (!ticker.isEmpty() && tickers.contains(ticker)) matched.add(notice);
            else if (tickers.isEmpty()) unparsed.add(notice);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("symbolStatus", status);
        result.put("statusIsTrading", "TRADING".equals(status));
        result.put("announcementsChecked", notices.size());
        result.put("matchedAnnouncements", copyFirst(matched, 5));
        result.put("unparsedNotices", copyFirst(unparsed, 3));
        result.put("sourceAvailable", !notices.isEmpty());
        return result;
    }

    /** Returns all requested symbols that are not currently marked TRADING. */
    public List<Map<String, Object>> findNonTradingPairs(List<String> symbols) {
        Map<String, BinanceClient.SymbolInfo> info = binance.fetchSymbolInfo();
        List<Map<String, Object>> result = new ArrayList<>();
        for (String symbol : symbols) {
            BinanceClient.SymbolInfo value = info.get(symbol);
            String status = value == null ? "KHÔNG TỒN TẠI" : value.status();
            if ("TRADING".equals(status)) continue;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("symbol", symbol);
            row.put("status", status);
            result.add(row);
        }
        return result;
    }

    /** Extracts possible token tickers while excluding title boilerplate and pure numbers. */
    public static List<String> tickersInTitle(String title) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        Matcher matcher = TITLE_TICKER.matcher(title == null ? "" : title);
        while (matcher.find()) {
            String value = matcher.group();
            if (!TITLE_NOISE.contains(value) && !value.matches("^\\d+$")) result.add(value);
        }
        return List.copyOf(result);
    }

    private List<Map<String, Object>> fetchCatalog(int catalogId, int requested) {
        int pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);
        String key = "cat:" + catalogId + ":" + pageSize;
        long now = System.currentTimeMillis();
        CacheEntry<List<Map<String, Object>>> hit = cache.get(key);
        if (hit != null && now - hit.at() < TTL_MS) return hit.value();

        synchronized (cacheLock) {
            now = System.currentTimeMillis();
            hit = cache.get(key);
            if (hit != null && now - hit.at() < TTL_MS) return hit.value();

            JsonNode root = getJson("?type=1&catalogId=" + catalogId + "&pageNo=1&pageSize=" + pageSize);
            JsonNode data = root.path("data");
            JsonNode articles = null;
            JsonNode catalogs = data.path("catalogs");
            if (catalogs.isArray() && !catalogs.isEmpty()) {
                JsonNode candidate = catalogs.get(0).get("articles");
                if (candidate != null && !candidate.isNull()) articles = candidate;
            }
            if (articles == null) {
                JsonNode candidate = data.get("articles");
                if (candidate != null && !candidate.isNull()) articles = candidate;
            }

            List<Map<String, Object>> result = new ArrayList<>();
            if (articles != null && articles.isArray()) {
                for (JsonNode article : articles) result.add(article(article));
            }
            List<Map<String, Object>> immutable = List.copyOf(result);
            cache.put(key, new CacheEntry<>(now, immutable));
            return immutable;
        }
    }

    private static Map<String, Object> article(JsonNode article) {
        Object code = scalar(article.get("code"));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("title", article.path("title").asText(""));
        result.put("code", code);
        result.put("releaseAt", scalar(article.get("releaseDate")));
        result.put("url", code == null ? null : "https://www.binance.com/en/support/announcement/" + code);
        return result;
    }

    private JsonNode getJson(String query) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(CMS + query))
                .timeout(REQUEST_TIMEOUT)
                .header("accept", "application/json")
                .header("user-agent", "Mozilla/5.0")
                .GET()
                .build();
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new RemoteDataException("Binance CMS HTTP " + response.statusCode());
            }
            return mapper.readTree(response.body());
        } catch (IOException error) {
            throw new RemoteDataException("Không đọc được thông báo Binance: " + error.getMessage(), error);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new RemoteDataException("Yêu cầu thông báo Binance bị gián đoạn", error);
        }
    }

    private static Object scalar(JsonNode value) {
        if (value == null || value.isMissingNode() || value.isNull()) return null;
        if (value.isIntegralNumber()) return value.asLong();
        if (value.isNumber()) return value.asDouble();
        if (value.isBoolean()) return value.asBoolean();
        return value.asText();
    }

    private static List<Map<String, Object>> copyFirst(List<Map<String, Object>> values, int limit) {
        return new ArrayList<>(values.subList(0, Math.min(limit, values.size())));
    }

    private static String string(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private record CacheEntry<T>(long at, T value) {}

    private static final class RemoteDataException extends RuntimeException {
        private RemoteDataException(String message) { super(message); }
        private RemoteDataException(String message, Throwable cause) { super(message, cause); }
    }
}
