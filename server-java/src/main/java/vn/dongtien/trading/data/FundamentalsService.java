package vn.dongtien.trading.data;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** CoinGecko tokenomics lookup, with the same conservative 15-minute cache as the former Node service. */
@Service
public class FundamentalsService {
    private static final String COINGECKO = "https://api.coingecko.com/api/v3";
    private static final long TTL_MS = Duration.ofMinutes(15).toMillis();
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(15);

    private final ObjectMapper mapper;
    private final HttpClient http;
    private final Map<String, CacheEntry<Object>> cache = new ConcurrentHashMap<>();
    private final Object cacheLock = new Object();

    @Autowired
    public FundamentalsService(ObjectMapper mapper) {
        this(mapper, HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build());
    }

    FundamentalsService(ObjectMapper mapper, HttpClient http) {
        this.mapper = mapper;
        this.http = http;
    }

    /**
     * Resolves a ticker to CoinGecko's best ranked exact-symbol match.  A null
     * result means CoinGecko did not have an exact match; it is deliberately
     * cached so unknown small tokens do not repeatedly consume the free quota.
     */
    public String resolveCoinId(String baseAsset) {
        String ticker = baseAsset == null ? "" : baseAsset.trim().toUpperCase(Locale.ROOT);
        if (ticker.isEmpty()) return null;
        return cached("id:" + ticker, () -> {
            JsonNode root = getJson("/search?query=" + encode(ticker));
            List<JsonNode> exact = new ArrayList<>();
            for (JsonNode coin : root.path("coins")) {
                String symbol = coin.path("symbol").asText("");
                if (ticker.equals(symbol.toUpperCase(Locale.ROOT))) exact.add(coin);
            }
            if (exact.isEmpty()) return null;
            exact.sort(Comparator.comparingInt(FundamentalsService::marketCapRank));
            String id = exact.get(0).path("id").asText(null);
            return id == null || id.isBlank() ? null : id;
        });
    }

    /**
     * Returns null when a ticker cannot be resolved or the resolution request
     * fails.  Once an id is known, a failed detail request is allowed to surface
     * so callers can distinguish a lookup failure from unknown-token data.
     */
    public Map<String, Object> fetchTokenomics(String baseAsset) {
        String id;
        try {
            id = resolveCoinId(baseAsset);
        } catch (RuntimeException ignored) {
            return null;
        }
        if (id == null) return null;
        return cached("coin:" + id, () -> tokenomics(id));
    }

    private Map<String, Object> tokenomics(String id) {
        JsonNode root = getJson("/coins/" + encode(id)
                + "?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false");
        JsonNode market = root.path("market_data");
        Double circulating = number(market.path("circulating_supply"));
        Double total = number(market.path("total_supply"));
        Double max = number(market.path("max_supply"));
        Double marketCap = number(market.path("market_cap").path("usd"));
        Double fdv = number(market.path("fully_diluted_valuation").path("usd"));
        Double volume24h = number(market.path("total_volume").path("usd"));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("coinId", id);
        result.put("name", textOrNull(root.get("name")));
        String symbol = textOrNull(root.get("symbol"));
        result.put("symbol", symbol == null ? null : symbol.toUpperCase(Locale.ROOT));
        result.put("marketCapRank", integer(root.get("market_cap_rank")));
        result.put("marketCapUsd", marketCap);
        result.put("fdvUsd", fdv);
        result.put("fdvToMarketCap", quotient(fdv, marketCap));
        result.put("circulatingSupply", circulating);
        result.put("totalSupply", total);
        result.put("maxSupply", max);
        result.put("circulatingPercent", quotientTimes(circulating, total, 100));
        result.put("volume24hUsd", volume24h);
        result.put("volumeToMarketCap", quotient(volume24h, marketCap));
        result.put("athChangePercent", number(market.path("ath_change_percentage").path("usd")));
        result.put("atlChangePercent", number(market.path("atl_change_percentage").path("usd")));
        result.put("priceChange7dPercent", number(market.path("price_change_percentage_7d")));
        result.put("priceChange30dPercent", number(market.path("price_change_percentage_30d")));
        result.put("categories", categories(root.path("categories")));
        result.put("genesisDate", textOrNull(root.get("genesis_date")));
        return result;
    }

    private JsonNode getJson(String path) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(COINGECKO + path))
                .timeout(REQUEST_TIMEOUT)
                .header("accept", "application/json")
                .GET()
                .build();
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new RemoteDataException("CoinGecko HTTP " + response.statusCode());
            }
            return mapper.readTree(response.body());
        } catch (IOException error) {
            throw new RemoteDataException("Không lấy được dữ liệu CoinGecko: " + error.getMessage(), error);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new RemoteDataException("Yêu cầu CoinGecko bị gián đoạn", error);
        }
    }

    @SuppressWarnings("unchecked")
    private <T> T cached(String key, Loader<T> loader) {
        long now = System.currentTimeMillis();
        CacheEntry<Object> hit = cache.get(key);
        if (hit != null && now - hit.at() < TTL_MS) return (T) hit.value();

        synchronized (cacheLock) {
            now = System.currentTimeMillis();
            hit = cache.get(key);
            if (hit != null && now - hit.at() < TTL_MS) return (T) hit.value();
            T value = loader.load();
            cache.put(key, new CacheEntry<>(now, value));
            return value;
        }
    }

    private static int marketCapRank(JsonNode coin) {
        Integer rank = integer(coin.get("market_cap_rank"));
        return rank == null ? 1_000_000_000 : rank;
    }

    private static List<String> categories(JsonNode categories) {
        List<String> result = new ArrayList<>();
        if (categories == null || !categories.isArray()) return result;
        for (JsonNode value : categories) {
            String category = textOrNull(value);
            if (category != null && !category.isEmpty()) result.add(category);
            if (result.size() == 5) break;
        }
        return result;
    }

    private static Double number(JsonNode value) {
        if (value == null || value.isMissingNode() || value.isNull() || !value.isNumber()) return null;
        return value.asDouble();
    }

    private static Integer integer(JsonNode value) {
        if (value == null || value.isMissingNode() || value.isNull() || !value.isNumber()) return null;
        return value.asInt();
    }

    private static String textOrNull(JsonNode value) {
        return value == null || value.isMissingNode() || value.isNull() ? null : value.asText();
    }

    // The JS conditions intentionally treat zero as absent, rather than invent
    // a ratio from a zero market cap or supply value.
    private static Double quotient(Double numerator, Double denominator) {
        return numerator == null || denominator == null || numerator == 0 || denominator == 0
                ? null : numerator / denominator;
    }

    private static Double quotientTimes(Double numerator, Double denominator, double factor) {
        Double value = quotient(numerator, denominator);
        return value == null ? null : value * factor;
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    @FunctionalInterface
    private interface Loader<T> { T load(); }

    private record CacheEntry<T>(long at, T value) {}

    static final class RemoteDataException extends RuntimeException {
        RemoteDataException(String message) { super(message); }
        RemoteDataException(String message, Throwable cause) { super(message, cause); }
    }
}
