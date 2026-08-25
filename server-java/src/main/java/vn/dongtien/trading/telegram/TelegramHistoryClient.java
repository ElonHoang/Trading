package vn.dongtien.trading.telegram;

import it.tdlight.Init;
import it.tdlight.client.APIToken;
import it.tdlight.client.AuthenticationSupplier;
import it.tdlight.client.SimpleTelegramClient;
import it.tdlight.client.SimpleTelegramClientBuilder;
import it.tdlight.client.SimpleTelegramClientFactory;
import it.tdlight.client.TDLibSettings;
import it.tdlight.jni.TdApi;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * A short-lived, terminal-only User API client.  It never runs in the web or
 * bot services, and Telegram login/2FA is requested by TDLight on the local
 * terminal rather than received through the dashboard.
 */
@Service
public class TelegramHistoryClient {
    private static final AtomicBoolean NATIVE_INITIALIZED = new AtomicBoolean();

    private final Environment environment;

    public TelegramHistoryClient(Environment environment) {
        this.environment = environment;
    }

    public List<ChatSummary> listChats() throws Exception {
        return withClient(client -> {
            try {
                client.send(new TdApi.LoadChats(null, 100)).get(30, TimeUnit.SECONDS);
            } catch (Exception ignored) {
                // Telegram returns an error once all chats are already loaded.
            }
            TdApi.Chats chats = client.send(new TdApi.GetChats(null, 100)).get(1, TimeUnit.MINUTES);
            List<ChatSummary> result = new ArrayList<>();
            if (chats.chatIds == null) return result;
            for (long chatId : chats.chatIds) {
                TdApi.Chat chat = client.send(new TdApi.GetChat(chatId)).get(30, TimeUnit.SECONDS);
                result.add(new ChatSummary(chat.id, chat.title, chat.type == null ? "unknown" : chat.type.getClass().getSimpleName()));
            }
            result.sort(Comparator.comparing(ChatSummary::title, String.CASE_INSENSITIVE_ORDER));
            return result;
        });
    }

    public List<TelegramCallHistoryParser.HistoryMessage> history(long chatId, LocalDate targetDate, ZoneId zone,
                                                                    int lookbackDays, int maxMessages) throws Exception {
        if (chatId == 0) throw new IllegalArgumentException("chat-id khong hop le");
        if (targetDate == null) throw new IllegalArgumentException("date khong hop le");
        int safeLookback = Math.max(1, Math.min(90, lookbackDays));
        int safeMax = Math.max(100, Math.min(10_000, maxMessages));
        Instant from = targetDate.minusDays(safeLookback).atStartOfDay(zone).toInstant();
        return withClient(client -> {
            List<TelegramCallHistoryParser.HistoryMessage> result = new ArrayList<>();
            long cursor = 0;
            int remaining = safeMax;
            while (remaining > 0) {
                int limit = Math.min(100, remaining);
                TdApi.Messages page = client.send(new TdApi.GetChatHistory(chatId, cursor, 0, limit, false))
                        .get(1, TimeUnit.MINUTES);
                if (page.messages == null || page.messages.length == 0) break;
                long oldest = Long.MAX_VALUE;
                Instant oldestTime = null;
                for (TdApi.Message message : page.messages) {
                    oldest = Math.min(oldest, message.id);
                    Instant sentAt = Instant.ofEpochSecond(message.date);
                    if (oldestTime == null || sentAt.isBefore(oldestTime)) oldestTime = sentAt;
                    String text = textOf(message.content);
                    if (text != null && !text.isBlank()) result.add(new TelegramCallHistoryParser.HistoryMessage(message.id, sentAt, text));
                }
                remaining -= page.messages.length;
                if (oldest == Long.MAX_VALUE || oldest == cursor || (oldestTime != null && oldestTime.isBefore(from))) break;
                cursor = oldest;
            }
            return result;
        });
    }

    private <T> T withClient(ClientAction<T> action) throws Exception {
        String apiIdValue = required("TELEGRAM_API_ID");
        String apiHash = required("TELEGRAM_API_HASH");
        int apiId;
        try {
            apiId = Integer.parseInt(apiIdValue);
        } catch (NumberFormatException exception) {
            throw new IllegalStateException("TELEGRAM_API_ID phai la so nguyen", exception);
        }
        if (apiId <= 0) throw new IllegalStateException("TELEGRAM_API_ID phai lon hon 0");
        initializeNative();
        Path session = Path.of(environment.getProperty("TELEGRAM_HISTORY_SESSION_DIR", "/var/lib/dong-tien/telegram-history"));
        Files.createDirectories(session);
        try (SimpleTelegramClientFactory factory = new SimpleTelegramClientFactory()) {
            TDLibSettings settings = TDLibSettings.create(new APIToken(apiId, apiHash));
            settings.setDatabaseDirectoryPath(session.resolve("data"));
            settings.setDownloadedFilesDirectoryPath(session.resolve("downloads"));
            SimpleTelegramClientBuilder builder = factory.builder(settings);
            try (SimpleTelegramClient client = builder.build(AuthenticationSupplier.consoleLogin())) {
                client.getMeAsync().get(2, TimeUnit.MINUTES);
                return action.run(client);
            }
        }
    }

    private String required(String name) {
        String value = environment.getProperty(name);
        if (value == null || value.isBlank()) throw new IllegalStateException(name + " chua duoc cau hinh trong .env");
        return value.trim();
    }

    private static void initializeNative() throws Exception {
        if (NATIVE_INITIALIZED.compareAndSet(false, true)) Init.init();
    }

    private static String textOf(TdApi.MessageContent content) {
        if (content instanceof TdApi.MessageText text) return text.text == null ? null : text.text.text;
        if (content == null) return null;
        // Captions on photo/video documents use a FormattedText field named caption.
        // Reflection keeps this importer compatible across supported TDLib media classes.
        for (String fieldName : List.of("caption", "text")) {
            try {
                Field field = content.getClass().getField(fieldName);
                Object formatted = field.get(content);
                if (formatted instanceof TdApi.FormattedText text) return text.text;
            } catch (ReflectiveOperationException ignored) {
                // Try the next supported text field.
            }
        }
        return null;
    }

    private interface ClientAction<T> {
        T run(SimpleTelegramClient client) throws Exception;
    }

    public record ChatSummary(long id, String title, String type) {
        public Map<String, Object> asMap() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("id", id);
            value.put("title", title);
            value.put("type", type);
            return value;
        }
    }
}
