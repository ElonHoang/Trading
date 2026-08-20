package vn.dongtien.trading.data;

import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Public RSS news used as a supplemental context signal.  This is deliberately
 * keyword based: it classifies repeatably and does not claim to infer sentiment.
 */
@Service
public class NewsService {
    private static final List<Feed> FEEDS = List.of(
            new Feed("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
            new Feed("Cointelegraph", "https://cointelegraph.com/rss"));
    private static final long TTL_MS = Duration.ofMinutes(15).toMillis();
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(15);

    // Keep the original order (including the repeated "exploit") because it
    // determines which three explanatory keywords are returned.
    private static final List<String> NEGATIVE = List.of(
            "hack", "hacked", "exploit", "exploited", "breach", "stolen", "drain",
            "delist", "delisting", "removal", "halt", "suspend", "suspended",
            "lawsuit", "sue", "sued", "sec charges", "fraud", "scam", "rug",
            "bankrupt", "insolvency", "liquidated", "outage", "exploit",
            "investigation", "probe", "ban", "banned", "crackdown", "dump");
    private static final List<String> POSITIVE = List.of(
            "listing", "lists", "listed", "partnership", "partners", "integration",
            "upgrade", "mainnet", "launch", "launches", "etf approval", "approved",
            "adoption", "buyback", "burn", "staking rewards", "funding round", "raises",
            "record high", "all-time high", "rally", "surge");

    private static final Pattern ITEM = Pattern.compile("<item[\\s>][\\s\\S]*?</item>");
    private static final Pattern TAGS = Pattern.compile("<[^>]+>");
    private static final Map<String, Pattern> ITEM_FIELDS = Map.of(
            "title", Pattern.compile("<title>([\\s\\S]*?)</title>"),
            "link", Pattern.compile("<link>([\\s\\S]*?)</link>"),
            "date", Pattern.compile("<pubDate>([\\s\\S]*?)</pubDate>"),
            "desc", Pattern.compile("<description>([\\s\\S]*?)</description>"));

    private final HttpClient http;
    private final Object cacheLock = new Object();
    private final Map<String, Pattern> keywordPatterns = new java.util.concurrent.ConcurrentHashMap<>();
    private volatile CacheEntry<List<Map<String, Object>>> cachedItems;

    public NewsService() {
        this(HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build());
    }

    NewsService(HttpClient http) {
        this.http = http;
    }

    public Map<String, Object> fetchTokenNews(String ticker) {
        return fetchTokenNews(ticker, null, 6);
    }

    public Map<String, Object> fetchTokenNews(String ticker, String fullName) {
        return fetchTokenNews(ticker, fullName, 6);
    }

    /**
     * Returns news whose title or short description references the ticker or
     * full token name.  An unavailable feed is distinct from a successful scan
     * with no match, just as it was in the Node runtime.
     */
    public Map<String, Object> fetchTokenNews(String ticker, String fullName, int limit) {
        List<Map<String, Object>> items = fetchAllItems();
        if (items.isEmpty()) {
            Map<String, Object> unavailable = new LinkedHashMap<>();
            unavailable.put("available", false);
            unavailable.put("items", List.of());
            unavailable.put("counts", null);
            return unavailable;
        }

        String normalizedTicker = ticker == null ? "" : ticker.toUpperCase(Locale.ROOT);
        Pattern tickerPattern = normalizedTicker.length() >= 2
                ? Pattern.compile("\\b" + Pattern.quote(normalizedTicker) + "\\b") : null;
        Pattern namePattern = fullName != null && fullName.length() >= 3
                ? Pattern.compile("\\b" + Pattern.quote(fullName) + "\\b", Pattern.CASE_INSENSITIVE) : null;

        List<Map<String, Object>> matched = new ArrayList<>();
        for (Map<String, Object> item : items) {
            String haystack = string(item.get("title")) + " " + string(item.get("desc"));
            boolean tickerMatches = tickerPattern != null && tickerPattern.matcher(haystack).find();
            boolean nameMatches = namePattern != null && namePattern.matcher(haystack).find();
            if (!tickerMatches && !nameMatches) continue;
            Map<String, Object> match = new LinkedHashMap<>(item);
            match.putAll(classify(haystack));
            matched.add(match);
        }

        Map<String, Object> counts = new LinkedHashMap<>();
        counts.put("negative", 0);
        counts.put("positive", 0);
        counts.put("mixed", 0);
        counts.put("neutral", 0);
        for (Map<String, Object> item : matched) {
            String tone = string(item.get("tone"));
            counts.put(tone, ((Number) counts.get(tone)).intValue() + 1);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("available", true);
        result.put("scanned", items.size());
        result.put("sources", FEEDS.stream().map(Feed::name).toList());
        // Array#slice(0, negativeLimit) in the old runtime omitted that many
        // items from the end; preserve it even though normal callers use 6.
        int end = limit < 0 ? Math.max(0, matched.size() + limit) : Math.min(limit, matched.size());
        result.put("items", new ArrayList<>(matched.subList(0, end)));
        result.put("counts", counts);
        result.put("firstNegative", firstWithTone(matched, "negative"));
        result.put("firstPositive", firstWithTone(matched, "positive"));
        result.put("note", matched.isEmpty()
                ? "Không tìm thấy tin nào khớp token này trong RSS tin chung — không có nghĩa là không có tin"
                : null);
        return result;
    }

    private List<Map<String, Object>> fetchAllItems() {
        long now = System.currentTimeMillis();
        CacheEntry<List<Map<String, Object>>> hit = cachedItems;
        if (hit != null && now - hit.at() < TTL_MS) return hit.value();

        synchronized (cacheLock) {
            hit = cachedItems;
            now = System.currentTimeMillis();
            if (hit != null && now - hit.at() < TTL_MS) return hit.value();

            List<CompletableFuture<List<Map<String, Object>>>> futures = FEEDS.stream()
                    .map(feed -> fetchFeed(feed).exceptionally(error -> List.<Map<String, Object>>of()))
                    .toList();
            List<Map<String, Object>> result = new ArrayList<>();
            for (CompletableFuture<List<Map<String, Object>>> future : futures) result.addAll(future.join());
            List<Map<String, Object>> immutable = List.copyOf(result);
            cachedItems = new CacheEntry<>(now, immutable);
            return immutable;
        }
    }

    private CompletableFuture<List<Map<String, Object>>> fetchFeed(Feed feed) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(feed.url()))
                .timeout(REQUEST_TIMEOUT)
                .GET()
                .build();
        return http.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenApply(response -> response.statusCode() >= 200 && response.statusCode() < 300
                        ? parseItems(response.body(), feed.name()) : List.of());
    }

    static List<Map<String, Object>> parseItems(String xml, String source) {
        List<Map<String, Object>> result = new ArrayList<>();
        Matcher matcher = ITEM.matcher(xml == null ? "" : xml);
        while (matcher.find()) {
            String block = matcher.group();
            String title = field(block, "title");
            if (title.isEmpty()) continue;
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("title", title);
            item.put("link", field(block, "link"));
            item.put("date", field(block, "date"));
            String description = field(block, "desc");
            item.put("desc", description.substring(0, Math.min(300, description.length())));
            item.put("source", source);
            result.add(item);
        }
        return result;
    }

    private static String field(String block, String name) {
        Matcher matcher = ITEM_FIELDS.get(name).matcher(block);
        return matcher.find() ? stripTags(matcher.group(1)) : "";
    }

    private static String stripTags(String value) {
        return TAGS.matcher(value.replace("<![CDATA[", "").replace("]]>", "")).replaceAll("").trim();
    }

    private Map<String, Object> classify(String text) {
        String lower = text.toLowerCase(Locale.ROOT);
        List<String> negative = matchingKeywords(lower, NEGATIVE);
        List<String> positive = matchingKeywords(lower, POSITIVE);
        Map<String, Object> result = new LinkedHashMap<>();
        if (!negative.isEmpty() && positive.isEmpty()) {
            result.put("tone", "negative");
            result.put("keywords", firstThree(negative));
        } else if (!positive.isEmpty() && negative.isEmpty()) {
            result.put("tone", "positive");
            result.put("keywords", firstThree(positive));
        } else if (!negative.isEmpty()) {
            List<String> all = new ArrayList<>(negative);
            all.addAll(positive);
            result.put("tone", "mixed");
            result.put("keywords", firstThree(all));
        } else {
            result.put("tone", "neutral");
            result.put("keywords", List.of());
        }
        return result;
    }

    private List<String> matchingKeywords(String lower, List<String> candidates) {
        List<String> result = new ArrayList<>();
        for (String keyword : candidates) if (hasKeyword(lower, keyword)) result.add(keyword);
        return result;
    }

    private boolean hasKeyword(String lower, String keyword) {
        Pattern pattern = keywordPatterns.computeIfAbsent(keyword,
                value -> Pattern.compile("\\b" + Pattern.quote(value) + "\\b"));
        return pattern.matcher(lower).find();
    }

    private static List<String> firstThree(List<String> values) {
        return List.copyOf(values.subList(0, Math.min(3, values.size())));
    }

    private static Map<String, Object> firstWithTone(List<Map<String, Object>> values, String tone) {
        for (Map<String, Object> value : values) if (tone.equals(value.get("tone"))) return value;
        return null;
    }

    private static String string(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private record Feed(String name, String url) {}
    private record CacheEntry<T>(long at, T value) {}
}
