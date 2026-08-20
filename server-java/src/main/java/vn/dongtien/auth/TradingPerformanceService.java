package vn.dongtien.auth;

import org.springframework.core.env.Environment;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@Service
public class TradingPerformanceService {
    private static final String STATE_KEY = "data:auto-retune";
    private static final String STRATEGY_KEY = "config:strategy";
    private static final DateTimeFormatter DAY_LABEL = DateTimeFormatter.ofPattern("dd/MM");
    private static final DateTimeFormatter MONTH_LABEL = DateTimeFormatter.ofPattern("MM/yyyy");

    private final DocumentStore documents;
    private final Clock clock;
    private final ZoneId zone;

    @Autowired
    public TradingPerformanceService(DocumentStore documents, Environment environment) {
        this(
                documents,
                Clock.systemUTC(),
                ZoneId.of(environment.getProperty("TRADING_TIMEZONE", "Asia/Bangkok"))
        );
    }

    TradingPerformanceService(DocumentStore documents, Clock clock, ZoneId zone) {
        this.documents = documents;
        this.clock = clock;
        this.zone = zone;
    }

    public PerformanceResponse performance(String requestedRange) {
        Range range = Range.from(requestedRange);
        ZonedDateTime now = ZonedDateTime.now(clock).withZoneSameInstant(zone);
        Window window = Window.forRange(range, now);
        Options options = readOptions();
        JsonNode state = documents.find(STATE_KEY).orElse(null);
        boolean sourceAvailable = state != null;
        List<Trade> trades = sourceAvailable ? readTrades(state) : List.of();
        List<MutablePoint> buckets = window.buckets();

        for (Trade trade : trades) {
            ZonedDateTime closedAt = trade.closedAt().atZone(zone);
            if (closedAt.isBefore(window.from()) || !closedAt.isBefore(window.to())) continue;
            int index = window.bucketIndex(closedAt);
            if (index < 0 || index >= buckets.size()) continue;
            buckets.get(index).add(trade, options);
        }

        double cumulative = 0;
        List<PerformancePoint> points = new ArrayList<>();
        for (MutablePoint bucket : buckets) {
            cumulative = round(cumulative + bucket.pnlPercent, 2);
            points.add(bucket.freeze(options.capitalPerTradeUsd, cumulative));
        }

        int total = points.stream().mapToInt(PerformancePoint::trades).sum();
        int wins = points.stream().mapToInt(PerformancePoint::wins).sum();
        int losses = points.stream().mapToInt(PerformancePoint::losses).sum();
        int breakeven = points.stream().mapToInt(PerformancePoint::breakeven).sum();
        int expired = points.stream().mapToInt(PerformancePoint::expired).sum();
        int measured = points.stream().mapToInt(PerformancePoint::measuredTrades).sum();
        int rated = wins + losses;
        double pnlPercent = round(points.stream().mapToDouble(PerformancePoint::pnlPercent).sum(), 2);
        double pnlUsd = round(options.capitalPerTradeUsd * pnlPercent / 100, 2);
        Double winRate = rated == 0 ? null : round(wins * 100.0 / rated, 1);
        Double averagePnlUsd = measured == 0 ? null : round(pnlUsd / measured, 2);

        PerformanceSummary summary = new PerformanceSummary(
                total, wins, losses, breakeven, expired, rated, measured,
                winRate, pnlPercent, pnlUsd, averagePnlUsd, options.capitalPerTradeUsd
        );
        String message = sourceAvailable
                ? (total == 0 ? "Chưa có lệnh đóng trong khoảng thời gian này." : null)
                : "Database chưa có lịch sử giao dịch. Biểu đồ sẽ tự cập nhật khi bot ghi lệnh đóng.";
        return new PerformanceResponse(
                range.value, window.granularity(), sourceAvailable,
                window.from().toInstant().toString(), window.to().toInstant().toString(),
                message, summary, points
        );
    }

    private List<Trade> readTrades(JsonNode root) {
        try {
            JsonNode rows = root.path("trades");
            if (!rows.isArray()) return List.of();
            List<Trade> trades = new ArrayList<>();
            for (JsonNode row : rows) {
                Trade parsed = Trade.parse(row);
                if (parsed != null) trades.add(parsed);
            }
            return trades;
        } catch (RuntimeException ignored) {
            return List.of();
        }
    }

    private Options readOptions() {
        double partial = 0.5;
        double fee = 0.06;
        double capital = 200;
        try {
            JsonNode root = documents.find(STRATEGY_KEY).orElse(null);
            if (root != null) {
                partial = finiteOr(root.path("risk").path("partialFraction"), partial);
                fee = finiteOr(root.path("dailyReview").path("feePercent"), fee);
                capital = finiteOr(root.path("dailyReview").path("assumedCapitalPerTradeUsd"), capital);
            }
        } catch (RuntimeException ignored) {
            // Giữ mặc định tương thích với trade-pnl.js nếu document cấu hình lỗi.
        }
        return new Options(partial, fee, capital);
    }

    private static double finiteOr(JsonNode node, double fallback) {
        double value = node.asDouble(Double.NaN);
        return Double.isFinite(value) ? value : fallback;
    }

    private static double round(double value, int digits) {
        double factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    private enum Range {
        WEEK("week"), MONTH("month"), YEAR("year");

        private final String value;
        Range(String value) { this.value = value; }

        static Range from(String value) {
            String normalized = value == null ? "week" : value.trim().toLowerCase(Locale.ROOT);
            for (Range range : values()) if (range.value.equals(normalized)) return range;
            throw new IllegalArgumentException("range chỉ nhận week, month hoặc year");
        }
    }

    private record Options(double partialFraction, double feePercent, double capitalPerTradeUsd) {}

    private record Trade(Instant closedAt, String side, Double entry, Double exit,
                         String status, boolean reachedTp1, boolean tookPartial, Double tp1Price) {
        static Trade parse(JsonNode row) {
            try {
                String closed = row.path("closedAt").asText("");
                double entry = row.path("entry").asDouble(Double.NaN);
                double exit = row.path("result").path("lastPrice").asDouble(Double.NaN);
                if (closed.isBlank()) return null;
                JsonNode hitTps = row.path("result").path("hitTps");
                boolean hitAny = hitTps.isArray() && !hitTps.isEmpty();
                String status = row.path("result").path("status").asText("");
                JsonNode targets = row.path("targets");
                String tp1Label = targets.isArray() && !targets.isEmpty()
                        ? targets.get(0).path("label").asText("") : "";
                Double tp1Price = targets.isArray() && !targets.isEmpty()
                        ? targets.get(0).path("price").asDouble(Double.NaN) : null;
                if (tp1Price != null && !Double.isFinite(tp1Price)) tp1Price = null;
                boolean hitTp1 = false;
                if (hitTps.isArray() && !tp1Label.isBlank()) {
                    for (JsonNode hit : hitTps) if (tp1Label.equals(hit.asText())) hitTp1 = true;
                }
                return new Trade(Instant.parse(closed), row.path("side").asText("short"),
                        Double.isFinite(entry) && entry != 0 ? entry : null,
                        Double.isFinite(exit) ? exit : null,
                        status, hitAny || "target".equals(status),
                        hitTp1 && !"target".equals(status), tp1Price);
            } catch (RuntimeException ignored) {
                return null;
            }
        }

        Double pnl(Options options) {
            if (entry == null || exit == null) return null;
            double direction = "long".equals(side) ? 1 : -1;
            double exitGain = ((exit - entry) / entry) * 100 * direction;
            boolean partialTaken = tookPartial && tp1Price != null;
            double partial = partialTaken ? options.partialFraction : 0;
            double realized = partialTaken
                    ? ((((tp1Price - entry) / entry) * 100 * direction) - options.feePercent) * partial
                    : 0;
            return round(realized + (exitGain - options.feePercent) * (1 - partial), 2);
        }
    }

    private static final class MutablePoint {
        private final String key;
        private final String label;
        private int trades;
        private int wins;
        private int losses;
        private int breakeven;
        private int expired;
        private int measured;
        private double pnlPercent;

        private MutablePoint(String key, String label) {
            this.key = key;
            this.label = label;
        }

        void add(Trade trade, Options options) {
            trades++;
            Double pnl = trade.pnl(options);
            if (pnl != null) {
                measured++;
                pnlPercent = round(pnlPercent + pnl, 2);
            }
            if (trade.reachedTp1) wins++;
            if ("stopped".equals(trade.status) && !trade.reachedTp1) losses++;
            if ("breakeven".equals(trade.status)) breakeven++;
            if ("expired".equals(trade.status)) expired++;
        }

        PerformancePoint freeze(double capital, double cumulativePercent) {
            return new PerformancePoint(key, label, trades, wins, losses, breakeven, expired,
                    measured, pnlPercent, round(capital * pnlPercent / 100, 2),
                    cumulativePercent, round(capital * cumulativePercent / 100, 2));
        }
    }

    private record Window(ZonedDateTime from, ZonedDateTime to, String granularity,
                          List<MutablePoint> buckets, Range range) {
        static Window forRange(Range range, ZonedDateTime now) {
            ZonedDateTime today = now.toLocalDate().atStartOfDay(now.getZone());
            ZonedDateTime to = today.plusDays(1);
            List<MutablePoint> buckets = new ArrayList<>();
            if (range == Range.YEAR) {
                YearMonth last = YearMonth.from(today);
                YearMonth first = last.minusMonths(11);
                for (int i = 0; i < 12; i++) {
                    YearMonth month = first.plusMonths(i);
                    buckets.add(new MutablePoint(month.toString(), month.format(MONTH_LABEL)));
                }
                return new Window(first.atDay(1).atStartOfDay(now.getZone()), to,
                        "month", buckets, range);
            }
            int days = range == Range.WEEK ? 7 : 30;
            LocalDate first = today.toLocalDate().minusDays(days - 1L);
            for (int i = 0; i < days; i++) {
                LocalDate day = first.plusDays(i);
                buckets.add(new MutablePoint(day.toString(), day.format(DAY_LABEL)));
            }
            return new Window(first.atStartOfDay(now.getZone()), to, "day", buckets, range);
        }

        int bucketIndex(ZonedDateTime time) {
            if (range == Range.YEAR) {
                YearMonth first = YearMonth.from(from);
                YearMonth value = YearMonth.from(time);
                return (value.getYear() - first.getYear()) * 12 + value.getMonthValue() - first.getMonthValue();
            }
            return (int) java.time.temporal.ChronoUnit.DAYS.between(from.toLocalDate(), time.toLocalDate());
        }
    }

    public record PerformancePoint(String key, String label, int trades, int wins, int losses,
                                   int breakeven, int expired, int measuredTrades,
                                   double pnlPercent, double pnlUsd,
                                   double cumulativePnlPercent, double cumulativePnlUsd) {}

    public record PerformanceSummary(int totalTrades, int wins, int losses, int breakeven,
                                     int expired, int ratedTrades, int measuredTrades,
                                     Double winRatePercent, double pnlPercent, double pnlUsd,
                                     Double averagePnlUsd, double capitalPerTradeUsd) {}

    public record PerformanceResponse(String range, String granularity, boolean sourceAvailable,
                                      String from, String to, String message,
                                      PerformanceSummary summary, List<PerformancePoint> points) {}
}
