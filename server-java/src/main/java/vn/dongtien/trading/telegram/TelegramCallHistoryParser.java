package vn.dongtien.trading.telegram;

import java.text.Normalizer;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Converts this bot's published call/update captions back into closed-trade
 * records.  It intentionally accepts only the known caption format and skips
 * ambiguous messages rather than inventing a result.
 */
public final class TelegramCallHistoryParser {
    private static final Pattern OPEN_HEADER = Pattern.compile("(?s)([A-Z0-9]{2,24})\\s*\\|\\s*KHUNG\\s+([0-9]+[MHDW])");
    private static final Pattern ENTRY = Pattern.compile("(?i)\\bENTRY(?:\\s*\\([^)]*\\))?\\s*:\\s*([0-9.,]+)");
    private static final Pattern STOP_LOSS = Pattern.compile("(?i)\\bSTOPLOSS(?:\\s*\\([^)]*\\))?\\s*:\\s*([0-9.,]+)");
    private static final Pattern TARGET = Pattern.compile("(?im)\\bTP\\s*([0-9]+)\\s*:\\s*([0-9.,]+)");
    private static final Pattern CLOSED = Pattern.compile(
            "(?s)([A-Z0-9]{2,24})\\s+([0-9]+[MHDW])\\s*(?:—|-)\\s*(CHAM STOPLOSS|VE HOA VON|HET HAN GIU)");
    private static final Pattern FINAL_TARGET = Pattern.compile(
            "(?s)CAP NHAT\\s*:\\s*([A-Z0-9]{2,24})\\s+HIT\\s+TP\\s*FULL");
    private static final Pattern PARTIAL_TARGET = Pattern.compile(
            "(?s)CAP NHAT\\s*:\\s*([A-Z0-9]{2,24})\\s+HIT\\s+TP\\s*([0-9]+)");

    public ParseResult parse(long chatId, LocalDate targetDate, ZoneId zone, List<HistoryMessage> source) {
        if (targetDate == null || zone == null) throw new IllegalArgumentException("Ngay import hoac mui gio khong hop le");
        List<HistoryMessage> messages = source == null ? List.of() : source.stream()
                .filter(message -> message != null && message.sentAt() != null && message.text() != null)
                .sorted(Comparator.comparing(HistoryMessage::sentAt).thenComparingLong(HistoryMessage::messageId))
                .toList();
        List<OpenCall> openCalls = new ArrayList<>();
        List<ImportedTrade> trades = new ArrayList<>();
        int recognisedOpenCalls = 0;
        int skippedClosures = 0;

        for (HistoryMessage message : messages) {
            String normalized = normalized(message.text());
            Optional<OpenCall> opening = parseOpening(message, normalized);
            if (opening.isPresent()) {
                openCalls.add(opening.get());
                recognisedOpenCalls++;
                continue;
            }

            Matcher partial = PARTIAL_TARGET.matcher(normalized);
            if (partial.find()) {
                findLatest(openCalls, partial.group(1), null).ifPresent(call -> call.hitTargets.add("TP" + partial.group(2)));
            }

            Matcher complete = FINAL_TARGET.matcher(normalized);
            if (complete.find()) {
                Optional<OpenCall> call = findLatest(openCalls, complete.group(1), null);
                if (call.isPresent()) {
                    OpenCall matched = call.get();
                    for (Target target : matched.targets) matched.hitTargets.add(target.label());
                    if (isTargetDay(message, targetDate, zone)) {
                        trades.add(matched.close(chatId, message, "target", matched.targets.isEmpty()
                                ? null : matched.targets.get(matched.targets.size() - 1).price()));
                    }
                    openCalls.remove(matched);
                } else if (isTargetDay(message, targetDate, zone)) {
                    skippedClosures++;
                }
                continue;
            }

            Matcher closed = CLOSED.matcher(normalized);
            if (!closed.find()) continue;
            String status = switch (closed.group(3)) {
                case "CHAM STOPLOSS" -> "stopped";
                case "VE HOA VON" -> "breakeven";
                default -> "expired";
            };
            Optional<OpenCall> call = findLatest(openCalls, closed.group(1), closed.group(2));
            if (call.isEmpty()) {
                if (isTargetDay(message, targetDate, zone)) skippedClosures++;
                continue;
            }
            OpenCall matched = call.get();
            if (isTargetDay(message, targetDate, zone)) {
                Double exit = "stopped".equals(status) ? matched.stopLoss : "breakeven".equals(status) ? matched.entry : null;
                trades.add(matched.close(chatId, message, status, exit));
            }
            openCalls.remove(matched);
        }
        return new ParseResult(List.copyOf(trades), recognisedOpenCalls, skippedClosures, messages.size());
    }

    private static Optional<OpenCall> parseOpening(HistoryMessage message, String normalized) {
        Matcher header = OPEN_HEADER.matcher(normalized);
        if (!header.find() || !normalized.contains("KHUYEN NGHI")) return Optional.empty();
        String side = normalized.contains("LONG / MUA") ? "long" : normalized.contains("SHORT / BAN") ? "short" : null;
        Double entry = number(ENTRY, normalized);
        Double stopLoss = number(STOP_LOSS, normalized);
        if (side == null || entry == null || stopLoss == null) return Optional.empty();
        List<Target> targets = new ArrayList<>();
        Matcher target = TARGET.matcher(normalized);
        while (target.find()) {
            Double price = parseNumber(target.group(2));
            if (price != null) targets.add(new Target("TP" + target.group(1), price));
        }
        return Optional.of(new OpenCall(header.group(1), header.group(2).toLowerCase(Locale.ROOT), side, entry, stopLoss,
                List.copyOf(targets), message));
    }

    private static Optional<OpenCall> findLatest(List<OpenCall> calls, String symbol, String interval) {
        for (int index = calls.size() - 1; index >= 0; index--) {
            OpenCall call = calls.get(index);
            if (call.symbol.equalsIgnoreCase(symbol) && (interval == null || call.interval.equalsIgnoreCase(interval))) return Optional.of(call);
        }
        return Optional.empty();
    }

    private static boolean isTargetDay(HistoryMessage message, LocalDate targetDate, ZoneId zone) {
        return message.sentAt().atZone(zone).toLocalDate().equals(targetDate);
    }

    private static Double number(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? parseNumber(matcher.group(1)) : null;
    }

    /** Supports both Vietnamese 1.234,56 and dot-decimal 1,234.56 formatting. */
    private static Double parseNumber(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String value = raw.replace(" ", "").replace("\u00A0", "");
        int comma = value.lastIndexOf(',');
        int dot = value.lastIndexOf('.');
        if (comma >= 0 && dot >= 0) {
            value = comma > dot ? value.replace(".", "").replace(',', '.') : value.replace(",", "");
        } else if (comma >= 0) {
            value = value.replace(',', '.');
        }
        try {
            double parsed = Double.parseDouble(value);
            return Double.isFinite(parsed) && parsed > 0 ? parsed : null;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static String normalized(String text) {
        String withoutTags = text.replaceAll("(?s)<[^>]*>", " ");
        String decomposed = Normalizer.normalize(withoutTags, Normalizer.Form.NFD).replaceAll("\\p{M}+", "");
        return decomposed.toUpperCase(Locale.ROOT).replace('\u00A0', ' ').replaceAll("\\s+", " ").trim();
    }

    public record HistoryMessage(long messageId, Instant sentAt, String text) {}
    public record Target(String label, double price) {}
    public record ImportedTrade(String id, String source, long chatId, long messageId, String symbol, String interval,
                                String side, Instant openedAt, Instant closedAt, double entry, double stopLoss,
                                List<Target> targets, String status, List<String> hitTps, Double lastPrice) {}
    public record ParseResult(List<ImportedTrade> trades, int recognisedOpenCalls, int skippedClosures, int scannedMessages) {}

    private static final class OpenCall {
        private final String symbol;
        private final String interval;
        private final String side;
        private final double entry;
        private final double stopLoss;
        private final List<Target> targets;
        private final HistoryMessage opened;
        private final Set<String> hitTargets = new LinkedHashSet<>();

        private OpenCall(String symbol, String interval, String side, double entry, double stopLoss,
                         List<Target> targets, HistoryMessage opened) {
            this.symbol = symbol;
            this.interval = interval;
            this.side = side;
            this.entry = entry;
            this.stopLoss = stopLoss;
            this.targets = targets;
            this.opened = opened;
        }

        private ImportedTrade close(long chatId, HistoryMessage closing, String status, Double lastPrice) {
            return new ImportedTrade("telegram-import:" + chatId + ":" + closing.messageId(), "telegram-import",
                    chatId, closing.messageId(), symbol, interval, side, opened.sentAt(), closing.sentAt(), entry, stopLoss,
                    targets, status, List.copyOf(hitTargets), lastPrice);
        }
    }
}
