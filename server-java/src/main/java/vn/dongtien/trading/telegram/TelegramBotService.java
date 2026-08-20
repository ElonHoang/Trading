package vn.dongtien.trading.telegram;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import vn.dongtien.trading.analysis.AnalysisService;
import vn.dongtien.trading.config.StrategyService;
import vn.dongtien.trading.config.TradingUniverse;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.watchlist.WatchlistService;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@Service
public class TelegramBotService {
    private final String token;
    private final Set<Long> allowed;
    private final ObjectMapper mapper;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
    private final BinanceClient binance;
    private final StrategyService strategies;
    private final TradingUniverse universe;
    private final AnalysisService analysis;
    private final WatchlistService watchlist;

    public TelegramBotService(@Value("${dongtien.telegram.token:}") String token,
                              @Value("${dongtien.telegram.allowed-ids:}") String allowedIds,
                              @Value("${dongtien.telegram.alert-chat-ids:}") String alertChatIds,
                              ObjectMapper mapper, BinanceClient binance, StrategyService strategies,
                              TradingUniverse universe, AnalysisService analysis, WatchlistService watchlist) {
        this.token = token.trim(); this.mapper = mapper; this.binance = binance; this.strategies = strategies;
        this.universe = universe; this.analysis = analysis; this.watchlist = watchlist;
        this.allowed = new HashSet<>();
        Arrays.stream((allowedIds + "," + alertChatIds).split(",")).map(String::trim).filter(value -> !value.isEmpty())
                .forEach(value -> allowed.add(Long.parseLong(value)));
    }

    public void runForever() {
        requireToken();
        long offset = 0;
        while (!Thread.currentThread().isInterrupted()) {
            try {
                JsonNode updates = get("getUpdates?timeout=45&offset=" + offset);
                for (JsonNode update : updates.path("result")) {
                    offset = Math.max(offset, update.path("update_id").asLong() + 1);
                    JsonNode message = update.path("message");
                    long chatId = message.path("chat").path("id").asLong();
                    if (!allowed.isEmpty() && !allowed.contains(chatId)) continue;
                    String text = message.path("text").asText("").trim();
                    if (!text.isEmpty()) handle(chatId, text);
                }
            } catch (RuntimeException error) {
                try { Thread.sleep(2_000); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            }
        }
    }

    public void sendAlertsOnce() {
        requireToken();
        Set<Long> recipients = allowed;
        for (String symbol : watchlist.read()) {
            try {
                Map<String, Object> snapshot = analysis.analyze(symbol, "4h", strategies.strategy(), 0);
                String message = format(snapshot);
                for (Long chatId : recipients) send(chatId, message);
            } catch (RuntimeException ignored) {}
        }
    }

    private void handle(long chatId, String text) {
        try {
            String[] parts = text.split("\\s+");
            String command = parts[0].toLowerCase(Locale.ROOT).split("@")[0];
            if (command.equals("/start") || command.equals("/help")) {
                send(chatId, "/analyze BTC 4h\n/watchlist\n/add BTC\n/remove BTC"); return;
            }
            if (command.equals("/watchlist")) { send(chatId, String.join("\n", watchlist.read())); return; }
            if (command.equals("/add") && parts.length > 1) { send(chatId, String.join("\n", watchlist.add(parts[1]))); return; }
            if (command.equals("/remove") && parts.length > 1) { send(chatId, String.join("\n", watchlist.remove(BinanceClient.normalizeSymbol(parts[1])))); return; }
            String symbolInput = command.equals("/analyze") && parts.length > 1 ? parts[1] : command.startsWith("/") ? command.substring(1) : parts[0];
            String interval = parts.length > 2 ? parts[2] : "4h";
            String symbol = binance.resolveSymbol(symbolInput);
            universe.requireAllowed(symbol, strategies.strategy());
            send(chatId, format(analysis.analyze(symbol, interval, strategies.strategy(), 0)));
        } catch (RuntimeException error) { send(chatId, "Lỗi: " + error.getMessage()); }
    }

    @SuppressWarnings("unchecked")
    private static String format(Map<String, Object> snapshot) {
        Map<String, Object> combined = (Map<String, Object>) snapshot.get("combined");
        Map<String, Object> price = (Map<String, Object>) snapshot.get("price");
        Map<String, Object> levels = (Map<String, Object>) snapshot.get("levels");
        return snapshot.get("symbol") + " " + snapshot.get("interval") + "\n"
                + combined.get("signal") + " | điểm " + combined.get("score") + "\n"
                + "Giá: " + price.get("lastClose") + "\n"
                + (levels.get("stopLoss") == null ? "" : "SL: " + levels.get("stopLoss"));
    }

    private void send(long chatId, String text) {
        try {
            String body = mapper.writeValueAsString(Map.of("chat_id", chatId, "text", text));
            HttpRequest request = HttpRequest.newBuilder(URI.create(api("sendMessage"))).timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build();
            http.send(request, HttpResponse.BodyHandlers.discarding());
        } catch (IOException error) { throw new IllegalStateException("Không gửi được Telegram", error); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); }
    }
    private JsonNode get(String method) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(api(method))).timeout(Duration.ofSeconds(55)).GET().build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() / 100 != 2) throw new IllegalStateException("Telegram HTTP " + response.statusCode());
            return mapper.readTree(response.body());
        } catch (IOException error) { throw new IllegalStateException("Không đọc được Telegram", error); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException("Telegram bị gián đoạn", error); }
    }
    private String api(String method) { return "https://api.telegram.org/bot" + token + "/" + method; }
    private void requireToken() { if (token.isBlank()) throw new IllegalStateException("Thiếu TELEGRAM_BOT_TOKEN"); }
}
