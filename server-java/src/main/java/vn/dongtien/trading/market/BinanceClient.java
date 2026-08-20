package vn.dongtien.trading.market;

import org.springframework.stereotype.Component;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.trading.analysis.AnalysisService;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@Component
public class BinanceClient {
    public static final List<String> INTERVALS = List.of(
            "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M");
    public static final Map<String, Long> INTERVAL_MS = Map.ofEntries(
            Map.entry("1m", 60_000L), Map.entry("3m", 180_000L), Map.entry("5m", 300_000L),
            Map.entry("15m", 900_000L), Map.entry("30m", 1_800_000L), Map.entry("1h", 3_600_000L),
            Map.entry("2h", 7_200_000L), Map.entry("4h", 14_400_000L), Map.entry("6h", 21_600_000L),
            Map.entry("8h", 28_800_000L), Map.entry("12h", 43_200_000L), Map.entry("1d", 86_400_000L),
            Map.entry("3d", 259_200_000L), Map.entry("1w", 604_800_000L), Map.entry("1M", 2_592_000_000L));

    private static final List<String> SPOT_HOSTS = List.of(
            "https://api.binance.com", "https://api1.binance.com",
            "https://api2.binance.com", "https://data-api.binance.vision");
    private static final List<String> FUTURES_HOSTS = List.of("https://fapi.binance.com");
    private static final List<String> STABLE_QUOTES = List.of("USDT", "USDC", "FDUSD", "BUSD", "TUSD");
    private static final List<String> COIN_QUOTES = List.of("BTC", "ETH", "BNB");

    private final HttpClient http;
    private final ObjectMapper mapper;
    private volatile Map<String, SymbolInfo> spotSymbols;
    private volatile long spotSymbolsAt;
    private volatile Set<String> futuresSymbols;
    private volatile long futuresSymbolsAt;
    private volatile List<JsonNode> tickerCache;
    private volatile long tickerCacheAt;

    @Autowired
    public BinanceClient(ObjectMapper mapper) {
        this(mapper, HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build());
    }

    BinanceClient(ObjectMapper mapper, HttpClient http) {
        this.mapper = mapper;
        this.http = http;
    }

    public static String normalizeSymbol(String input) {
        String symbol = input == null ? "" : input.trim().toUpperCase(Locale.ROOT).replaceAll("[/_\\-\\s]", "");
        if (symbol.isEmpty()) throw new IllegalArgumentException("Thiếu mã token");
        for (String quote : STABLE_QUOTES) if (symbol.length() > quote.length() && symbol.endsWith(quote)) return symbol;
        for (String quote : COIN_QUOTES) if (symbol.length() - quote.length() >= 3 && symbol.endsWith(quote)) return symbol;
        return symbol + "USDT";
    }

    public String resolveSymbol(String input) {
        String raw = input == null ? "" : input.trim().toUpperCase(Locale.ROOT).replaceAll("[/_\\-\\s]", "");
        if (raw.isEmpty()) throw new IllegalArgumentException("Thiếu mã token");
        try {
            Set<String> symbols = new LinkedHashSet<>(fetchTradingSymbols());
            symbols.addAll(fetchFuturesSymbols());
            for (String candidate : List.of(raw, raw + "USDT", normalizeSymbol(input))) {
                if (symbols.contains(candidate)) return candidate;
            }
            throw new IllegalArgumentException("Không tìm thấy cặp giao dịch nào cho \"" + raw + "\" trên Binance spot hoặc futures");
        } catch (RemoteException error) {
            return normalizeSymbol(input);
        }
    }

    public Map<String, SymbolInfo> fetchSymbolInfo() {
        long now = System.currentTimeMillis();
        if (spotSymbols != null && now - spotSymbolsAt < Duration.ofHours(6).toMillis()) return spotSymbols;
        JsonNode root = getJson(SPOT_HOSTS, "/api/v3/exchangeInfo");
        Map<String, SymbolInfo> result = new LinkedHashMap<>();
        for (JsonNode row : root.path("symbols")) {
            result.put(row.path("symbol").asText(), new SymbolInfo(
                    row.path("baseAsset").asText(), row.path("quoteAsset").asText(), row.path("status").asText()));
        }
        spotSymbols = Map.copyOf(result);
        spotSymbolsAt = now;
        return spotSymbols;
    }

    public Set<String> fetchTradingSymbols() {
        Set<String> result = new LinkedHashSet<>();
        fetchSymbolInfo().forEach((symbol, info) -> { if ("TRADING".equals(info.status())) result.add(symbol); });
        return result;
    }

    /** Uses Binance metadata instead of guessing where a base symbol ends. */
    public String baseAssetOf(String symbol) {
        SymbolInfo info = fetchSymbolInfo().get(symbol == null ? "" : symbol.toUpperCase(Locale.ROOT));
        return info == null ? null : info.baseAsset();
    }

    public String symbolStatusOf(String symbol) {
        SymbolInfo info = fetchSymbolInfo().get(symbol == null ? "" : symbol.toUpperCase(Locale.ROOT));
        return info == null ? null : info.status();
    }

    /** Whole-market ticker cache used by the low-cost screener. */
    public List<JsonNode> fetchAllTickers() {
        long now = System.currentTimeMillis();
        if (tickerCache != null && now - tickerCacheAt < 30_000) return tickerCache;
        List<JsonNode> result = new ArrayList<>();
        for (JsonNode row : getJson(SPOT_HOSTS, "/api/v3/ticker/24hr")) result.add(row);
        tickerCache = List.copyOf(result);
        tickerCacheAt = now;
        return tickerCache;
    }

    /**
     * Cheap pre-filter equivalent to the former Node screener.  It deliberately
     * only selects symbols; deeper analysis still goes through {@link AnalysisService}.
     */
    public ScreenResult screenSymbols(int topVolume, int topMovers, double minQuoteVolumeUsd,
                                      String quote, boolean requireFutures) {
        String requestedQuote = quote == null || quote.isBlank() ? "USDT" : quote.toUpperCase(Locale.ROOT);
        Set<String> futures = null;
        if (requireFutures) {
            try { futures = fetchFuturesSymbols(); } catch (RuntimeException ignored) { /* disclose below */ }
        }
        Map<String, SymbolInfo> metadata = fetchSymbolInfo();
        List<ScreenRow> rows = new ArrayList<>();
        Set<String> stableBases = Set.of("USDC", "FDUSD", "BUSD", "TUSD", "USDP", "DAI", "EUR", "USD1", "USDS",
                "AEUR", "EURI", "XUSD", "PYUSD", "RLUSD");
        for (JsonNode ticker : fetchAllTickers()) {
            String symbol = ticker.path("symbol").asText();
            SymbolInfo info = metadata.get(symbol);
            if (info == null || !"TRADING".equals(info.status()) || !requestedQuote.equals(info.quoteAsset())
                    || stableBases.contains(info.baseAsset()) || (futures != null && !futures.contains(symbol))) continue;
            double volume = numberOrNaN(ticker.path("quoteVolume"));
            if (!Double.isFinite(volume) || volume < minQuoteVolumeUsd) continue;
            double move = numberOrNaN(ticker.path("priceChangePercent"));
            rows.add(new ScreenRow(symbol, volume, Double.isFinite(move) ? Math.abs(move) : 0));
        }
        List<String> byVolume = rows.stream().sorted((a, b) -> Double.compare(b.quoteVolume(), a.quoteVolume()))
                .limit(Math.max(0, topVolume)).map(ScreenRow::symbol).toList();
        List<String> byMovers = rows.stream().sorted((a, b) -> Double.compare(b.changeAbs(), a.changeAbs()))
                .limit(Math.max(0, topMovers)).map(ScreenRow::symbol).toList();
        Set<String> selected = new LinkedHashSet<>(); selected.addAll(byVolume); selected.addAll(byMovers);
        return new ScreenResult(List.copyOf(selected), rows.size(), fetchAllTickers().size(), futures != null);
    }

    public Set<String> fetchFuturesSymbols() {
        long now = System.currentTimeMillis();
        if (futuresSymbols != null && now - futuresSymbolsAt < Duration.ofHours(6).toMillis()) return futuresSymbols;
        Set<String> result = new LinkedHashSet<>();
        for (JsonNode row : getJson(FUTURES_HOSTS, "/fapi/v1/exchangeInfo").path("symbols")) {
            if ("TRADING".equals(row.path("status").asText()) && "PERPETUAL".equals(row.path("contractType").asText())) {
                result.add(row.path("symbol").asText());
            }
        }
        futuresSymbols = Set.copyOf(result);
        futuresSymbolsAt = now;
        return futuresSymbols;
    }

    public List<Candle> fetchKlines(String symbol, String interval, int limit) {
        try {
            return fetchKlinesFrom(SPOT_HOSTS, "/api/v3/klines", symbol, interval, limit, "spot", null);
        } catch (RemoteException error) {
            if (!error.invalidSymbol()) throw error;
            return fetchKlinesFrom(FUTURES_HOSTS, "/fapi/v1/klines", symbol, interval, limit, "futures", null);
        }
    }

    public List<Candle> fetchKlinesHistory(String symbol, String interval, int total) {
        try {
            return fetchHistoryFrom(SPOT_HOSTS, "/api/v3/klines", symbol, interval, total, "spot");
        } catch (RemoteException error) {
            if (!error.invalidSymbol()) throw error;
            return fetchHistoryFrom(FUTURES_HOSTS, "/fapi/v1/klines", symbol, interval, total, "futures");
        }
    }

    private List<Candle> fetchHistoryFrom(List<String> hosts, String endpoint, String symbol, String interval, int total, String market) {
        requireInterval(interval);
        int wanted = Math.min(Math.max(total, 200), 20_000);
        List<Candle> result = new ArrayList<>();
        long endTime = System.currentTimeMillis();
        while (result.size() < wanted) {
            int limit = Math.min(1000, wanted - result.size());
            List<Candle> page = fetchKlinesFrom(hosts, endpoint, symbol, interval, limit, market, endTime);
            if (page.isEmpty()) break;
            result.addAll(0, page);
            endTime = page.get(0).openTime() - 1;
            if (page.size() < limit) break;
        }
        return result;
    }

    private List<Candle> fetchKlinesFrom(List<String> hosts, String endpoint, String symbol, String interval,
                                         int limit, String market, Long endTime) {
        requireInterval(interval);
        int capped = Math.min(Math.max(limit, 50), 1000);
        String path = endpoint + "?symbol=" + encode(symbol) + "&interval=" + encode(interval) + "&limit=" + capped
                + (endTime == null ? "" : "&endTime=" + endTime);
        JsonNode root = getJson(hosts, path);
        long now = System.currentTimeMillis();
        List<Candle> result = new ArrayList<>();
        for (JsonNode row : root) {
            result.add(new Candle(row.get(0).asLong(), number(row.get(1)), number(row.get(2)), number(row.get(3)),
                    number(row.get(4)), number(row.get(5)), row.get(6).asLong(), number(row.get(7)), row.get(8).asLong(),
                    row.size() > 9 ? number(row.get(9)) : null, row.get(6).asLong() < now, market));
        }
        return result;
    }

    public JsonNode fetchTicker24h(String symbol) {
        try {
            return getJson(SPOT_HOSTS, "/api/v3/ticker/24hr?symbol=" + encode(symbol));
        } catch (RemoteException error) {
            if (!error.invalidSymbol()) throw error;
            return getJson(FUTURES_HOSTS, "/fapi/v1/ticker/24hr?symbol=" + encode(symbol));
        }
    }

    public JsonNode fetchDerivatives(String symbol) {
        try {
            JsonNode premium = getJson(FUTURES_HOSTS, "/fapi/v1/premiumIndex?symbol=" + encode(symbol));
            JsonNode history;
            try { history = getJson(FUTURES_HOSTS, "/futures/data/openInterestHist?symbol=" + encode(symbol) + "&period=4h&limit=14"); }
            catch (RemoteException ignored) { history = null; }
            ObjectNode result = mapper.createObjectNode();
            if (!premium.path("lastFundingRate").isMissingNode()) result.put("fundingRate", number(premium.path("lastFundingRate")));
            if (!premium.path("markPrice").isMissingNode()) result.put("markPrice", number(premium.path("markPrice")));
            if (history != null && history.isArray() && !history.isEmpty()) {
                double first = number(history.get(0).path("sumOpenInterest"));
                double last = number(history.get(history.size() - 1).path("sumOpenInterest"));
                result.put("openInterest", last);
                if (first > 0) result.put("openInterestChangePct", (last - first) / first * 100);
            }
            return result;
        } catch (RemoteException ignored) {
            return null;
        }
    }

    public JsonNode fetchOrderBook(String symbol, int limit) {
        return fetchOrderBook(symbol, limit, 4d);
    }

    public JsonNode fetchOrderBook(String symbol, int limit, double wallMultiple) {
        try {
            JsonNode book;
            try { book = getJson(SPOT_HOSTS, "/api/v3/depth?symbol=" + encode(symbol) + "&limit=" + limit); }
            catch (RemoteException error) {
                if (!error.invalidSymbol()) throw error;
                book = getJson(FUTURES_HOSTS, "/fapi/v1/depth?symbol=" + encode(symbol) + "&limit=" + limit);
            }
            if (!book.path("bids").isArray() || book.path("bids").isEmpty()
                    || !book.path("asks").isArray() || book.path("asks").isEmpty()) return null;
            double bidValue = depthValue(book.path("bids"));
            double askValue = depthValue(book.path("asks"));
            if (bidValue + askValue == 0) return null;
            double bestBid = number(book.path("bids").get(0).get(0));
            double bestAsk = number(book.path("asks").get(0).get(0));
            double mid = (bestBid + bestAsk) / 2;
            double lastBid = number(book.path("bids").get(book.path("bids").size() - 1).get(0));
            double lastAsk = number(book.path("asks").get(book.path("asks").size() - 1).get(0));
            ObjectNode result = mapper.createObjectNode();
            result.put("bidValue", bidValue); result.put("askValue", askValue);
            result.put("imbalance", (bidValue - askValue) / (bidValue + askValue));
            result.put("midPrice", mid); result.put("spreadPct", (bestAsk - bestBid) / mid * 100);
            result.put("depthSpanPct", ((mid - lastBid) + (lastAsk - mid)) / mid * 50);
            result.put("levels", book.path("bids").size() + book.path("asks").size());
            ArrayNode walls = result.putArray("walls");
            appendWalls(walls, book.path("bids"), "bid", bidValue, mid, wallMultiple);
            appendWalls(walls, book.path("asks"), "ask", askValue, mid, wallMultiple);
            return result;
        } catch (RemoteException ignored) { return null; }
    }

    public JsonNode fetchPositioning(String symbol, String interval) {
        String period = positioningPeriod(interval);
        String query = "symbol=" + encode(symbol) + "&period=" + period + "&limit=30";
        try {
            JsonNode accounts = getJson(FUTURES_HOSTS, "/futures/data/globalLongShortAccountRatio?" + query);
            JsonNode top = getJson(FUTURES_HOSTS, "/futures/data/topLongShortPositionRatio?" + query);
            JsonNode taker = getJson(FUTURES_HOSTS, "/futures/data/takerlongshortRatio?" + query);
            if (accounts.isEmpty() && top.isEmpty() && taker.isEmpty()) return null;
            ObjectNode result = mapper.createObjectNode(); result.put("period", period); result.put("samples", accounts.size());
            if (!accounts.isEmpty()) {
                JsonNode first = accounts.get(0), last = accounts.get(accounts.size() - 1);
                result.put("longAccountRatio", number(last.path("longAccount")));
                result.put("longShortRatio", number(last.path("longShortRatio")));
                result.put("longAccountChange", number(last.path("longAccount")) - number(first.path("longAccount")));
            }
            if (!top.isEmpty()) {
                JsonNode last = top.get(top.size() - 1);
                result.put("topLongRatio", number(last.path("longAccount")));
                result.put("topLongShortRatio", number(last.path("longShortRatio")));
            }
            if (!taker.isEmpty()) result.put("takerBuySellRatio", number(taker.get(taker.size() - 1).path("buySellRatio")));
            return result;
        } catch (RemoteException ignored) { return null; }
    }

    public static String positioningPeriod(String interval) {
        if (Set.of("5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d").contains(interval)) return interval;
        return Set.of("1m", "3m").contains(interval) ? "5m" : "1d";
    }

    private static double depthValue(JsonNode levels) {
        double result = 0;
        for (JsonNode level : levels) result += number(level.get(0)) * number(level.get(1));
        return result;
    }

    private static void appendWalls(ArrayNode target, JsonNode levels, String side, double total, double mid, double multiple) {
        if (levels == null || levels.isEmpty() || total <= 0 || mid <= 0) return;
        double average = total / levels.size();
        List<Wall> candidates = new ArrayList<>();
        for (JsonNode level : levels) {
            double price = numberOrNaN(level.get(0));
            double value = price * numberOrNaN(level.get(1));
            if (Double.isFinite(value) && value >= average * Math.max(1, multiple)) candidates.add(new Wall(price, value));
        }
        candidates.sort((a, b) -> Double.compare(b.value(), a.value()));
        List<Wall> kept = new ArrayList<>();
        for (Wall wall : candidates) {
            if (kept.stream().anyMatch(existing -> Math.abs(wall.price() - existing.price()) / mid * 100 < .1)) continue;
            kept.add(wall);
            ObjectNode row = target.addObject();
            row.put("side", side); row.put("price", wall.price()); row.put("value", wall.value());
            row.put("ratioToAvg", wall.value() / average); row.put("distancePct", (wall.price() - mid) / mid * 100);
            if (kept.size() == 3) break;
        }
    }

    JsonNode getJson(List<String> hosts, String path) {
        RuntimeException last = null;
        for (String host : hosts) {
            try {
                HttpRequest request = HttpRequest.newBuilder(URI.create(host + path)).timeout(Duration.ofSeconds(15))
                        .header("User-Agent", "dong-tien-ai-java/1.0").GET().build();
                HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() < 200 || response.statusCode() >= 300) {
                    String message = "HTTP " + response.statusCode();
                    try {
                        JsonNode body = mapper.readTree(response.body());
                        if (!body.path("msg").asText("").isEmpty()) {
                            message = body.path("msg").asText() + " (code " + body.path("code").asInt() + ")";
                        }
                    } catch (RuntimeException ignored) {}
                    boolean invalid = message.contains("-1121") || message.toLowerCase(Locale.ROOT).contains("invalid symbol");
                    RemoteException error = new RemoteException(message, invalid);
                    if (response.statusCode() == 400 || invalid) throw error;
                    last = error;
                    continue;
                }
                return mapper.readTree(response.body());
            } catch (RemoteException error) {
                if (error.invalidSymbol()) throw error;
                last = error;
            } catch (IOException error) {
                last = new RemoteException(host + ": " + error.getMessage(), false);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new RemoteException("Yêu cầu Binance bị gián đoạn", false);
            }
        }
        throw new RemoteException("Không lấy được dữ liệu từ Binance: " + (last == null ? "unknown" : last.getMessage()), false);
    }

    private static void requireInterval(String interval) {
        if (!INTERVAL_MS.containsKey(interval)) throw new IllegalArgumentException("Khung thời gian không hợp lệ: " + interval);
    }
    private static String encode(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }
    private static double number(JsonNode node) { return Double.parseDouble(node.asText()); }
    private static double numberOrNaN(JsonNode node) {
        try { return node == null ? Double.NaN : Double.parseDouble(node.asText()); }
        catch (RuntimeException ignored) { return Double.NaN; }
    }

    public record SymbolInfo(String baseAsset, String quoteAsset, String status) {}
    public record ScreenResult(List<String> symbols, int scanned, int totalPairs, boolean futuresFiltered) {}
    private record ScreenRow(String symbol, double quoteVolume, double changeAbs) {}
    private record Wall(double price, double value) {}
    public static final class RemoteException extends RuntimeException {
        private final boolean invalidSymbol;
        RemoteException(String message, boolean invalidSymbol) { super(message); this.invalidSymbol = invalidSymbol; }
        public boolean invalidSymbol() { return invalidSymbol; }
    }
}
