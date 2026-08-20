package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.trading.backtest.BacktestService;
import vn.dongtien.trading.config.StrategyService;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.market.Candle;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Calendar/rolling review of completed calls and conservative, evidence-led
 * tuning proposals.  This ports the decision model of the former Node
 * {@code analysis/daily-review.js}; open calls are never included because the
 * state document only receives a trade after it closes.
 */
@Service
public class DailyReviewService {
    private final ObjectMapper mapper;
    private final AutoRetuneService autoRetune;
    private final PostMortemService postMortems;
    private final BinanceClient binance;
    private final BacktestService backtest;
    private final StrategyService strategies;

    public DailyReviewService(ObjectMapper mapper, AutoRetuneService autoRetune, PostMortemService postMortems,
                              BinanceClient binance, BacktestService backtest, StrategyService strategies) {
        this.mapper = mapper;
        this.autoRetune = autoRetune;
        this.postMortems = postMortems;
        this.binance = binance;
        this.backtest = backtest;
        this.strategies = strategies;
    }

    public ReviewWindow reviewWindow(JsonNode config) {
        return reviewWindow(config, Instant.now());
    }

    /** Computes a review range with exactly the calendar-day semantics of the Node implementation. */
    public ReviewWindow reviewWindow(JsonNode config, Instant now) {
        String mode = ReviewSupport.text(config == null ? null : config.get("windowMode"), "calendar-day");
        long nowMillis = now == null ? System.currentTimeMillis() : now.toEpochMilli();
        if ("calendar-day".equals(mode)) {
            long offset = Math.round(ReviewSupport.number(config == null ? null : config.get("dayOffsetHours"), 0) * 3_600_000d);
            int days = Math.min(0, (int) ReviewSupport.number(config == null ? null : config.get("dayOffsetDays"), 0));
            long since = (Math.floorDiv(nowMillis + offset, ReviewSupport.DAY_MILLIS) + days) * ReviewSupport.DAY_MILLIS - offset;
            LocalDate date = Instant.ofEpochMilli(since + offset).atOffset(ZoneOffset.UTC).toLocalDate();
            String label = String.format(Locale.ROOT, "NGÀY %02d/%02d/%04d", date.getDayOfMonth(), date.getMonthValue(), date.getYear());
            return new ReviewWindow(mode, since, since + ReviewSupport.DAY_MILLIS, Instant.ofEpochMilli(since).toString(), label);
        }
        double hours = ReviewSupport.number(config == null ? null : config.get("windowHours"), 0);
        if ("rolling".equals(mode) && hours > 0) {
            long since = nowMillis - Math.round(hours * 3_600_000d);
            String hoursLabel = hours == Math.rint(hours) ? Long.toString(Math.round(hours)) : Double.toString(hours);
            return new ReviewWindow(mode, since, null, Instant.ofEpochMilli(since).toString(), hoursLabel + "H GẦN NHẤT");
        }
        return new ReviewWindow("all", null, null, null, "TOÀN BỘ LỊCH SỬ ĐANG LƯU");
    }

    /**
     * W means a call touched TP1 (even if it later expired/breakeven); L means
     * it stopped before TP1.  Unrated expired calls stay visible but are not in
     * the W/L denominator.
     */
    public Map<String, Object> summarizeCalls(JsonNode trades, Long sinceMs, Long untilMs,
                                              double partialFraction, double feePercent, double capitalPerTradeUsd) {
        ArrayNode inWindow = mapper.createArrayNode();
        if (trades != null && trades.isArray()) {
            for (JsonNode trade : trades) {
                Instant closedAt = ReviewSupport.instant(trade.get("closedAt"));
                if ((sinceMs != null || untilMs != null) && closedAt == null) continue;
                long at = closedAt == null ? 0 : closedAt.toEpochMilli();
                if (sinceMs != null && at < sinceMs) continue;
                if (untilMs != null && at >= untilMs) continue;
                inWindow.add(trade.deepCopy());
            }
        }
        ArrayNode won = mapper.createArrayNode();
        ArrayNode lost = mapper.createArrayNode();
        int breakeven = 0;
        int expired = 0;
        int measured = 0;
        double pnl = 0;
        for (JsonNode trade : inWindow) {
            String status = ReviewSupport.text(trade.path("result").get("status"), "");
            boolean reachedTp1 = ReviewSupport.reachedTp1(trade);
            if (reachedTp1) won.add(trade.deepCopy());
            if ("stopped".equals(status) && !reachedTp1) lost.add(trade.deepCopy());
            if ("breakeven".equals(status)) breakeven++;
            if ("expired".equals(status)) expired++;
            Double returnPercent = ReviewSupport.tradeReturnPercent(trade, partialFraction, feePercent);
            if (returnPercent != null) {
                measured++;
                pnl += returnPercent;
            }
        }
        int closed = inWindow.size();
        int rated = won.size() + lost.size();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("closed", closed); result.put("lost", lost.size()); result.put("breakeven", breakeven);
        result.put("won", won.size()); result.put("expired", expired); result.put("rated", rated); result.put("unrated", closed - rated);
        result.put("win", won.size()); result.put("loss", lost.size());
        Double pnlPercent = measured == 0 ? null : ReviewSupport.round(pnl, 2);
        result.put("pnlPercent", pnlPercent); result.put("capitalPerTradeUsd", capitalPerTradeUsd);
        result.put("pnlUsd", pnlPercent == null ? null : ReviewSupport.round(capitalPerTradeUsd * pnlPercent / 100, 2));
        result.put("pnlFromTrades", measured);
        result.put("lossRatePercent", rated == 0 ? null : ReviewSupport.round(lost.size() * 100d / rated, 1));
        result.put("winRatePercent", rated == 0 ? null : ReviewSupport.round(won.size() * 100d / rated, 1));
        result.put("trades", inWindow); result.put("ratedTrades", combine(won, lost));
        result.put("wonTrades", won); result.put("lostTrades", lost);
        return result;
    }

    public Map<String, Object> summarizeCalls(JsonNode trades) {
        return summarizeCalls(trades, null, null, .5, .06, 200);
    }

    /** Shared per-call PnL convention also used by closing-call notifications. */
    public Double tradeReturnPercent(JsonNode trade, double partialFraction, double feePercent) {
        return TradePnlService.tradeReturnPercent(trade, partialFraction, feePercent);
    }

    public Double tradeReturnPercent(JsonNode trade) { return tradeReturnPercent(trade, .5, .06); }

    public boolean reachedTp1(JsonNode trade) { return ReviewSupport.reachedTp1(trade); }

    /** Compares closed calendar days and flags only repeated, sufficiently sampled loss problems. */
    public Map<String, Object> compareDailyPerformance(JsonNode trades, JsonNode config, Instant now,
                                                        double partialFraction, double feePercent, double capitalPerTradeUsd) {
        int lookbackDays = Math.max(2, Math.min(30, ReviewSupport.integer(config == null ? null : config.get("comparisonDays"), 7)));
        double target = ReviewSupport.number(config == null ? null : config.get("targetLossRatePercent"), 30);
        int minTradesPerDay = Math.max(1, ReviewSupport.integer(config == null ? null : config.get("minClosedTradesPerDay"), 3));
        int minBadDays = Math.max(2, ReviewSupport.integer(config == null ? null : config.get("minBadDays"), 2));
        ObjectNode calendarConfig = ReviewSupport.objectCopy(mapper, config);
        calendarConfig.put("windowMode", "calendar-day");
        ReviewWindow review = reviewWindow(calendarConfig, now);
        long end = review.untilMs();
        long offset = Math.round(ReviewSupport.number(config == null ? null : config.get("dayOffsetHours"), 0) * 3_600_000d);
        List<Map<String, Object>> days = new ArrayList<>();
        for (int index = lookbackDays - 1; index >= 0; index--) {
            long since = end - (index + 1L) * ReviewSupport.DAY_MILLIS;
            long until = since + ReviewSupport.DAY_MILLIS;
            Map<String, Object> summary = summarizeCalls(trades, since, until, partialFraction, feePercent, capitalPerTradeUsd);
            Map<String, Object> day = new LinkedHashMap<>();
            day.put("date", Instant.ofEpochMilli(since + offset).atOffset(ZoneOffset.UTC).toLocalDate().toString());
            day.put("sinceMs", since); day.put("untilMs", until); day.putAll(summary);
            Double lossRate = ReviewSupport.finite(day.get("lossRatePercent"));
            day.put("bad", ReviewSupport.integer(day.get("rated"), 0) >= minTradesPerDay && lossRate != null && lossRate > target);
            days.add(day);
        }
        Map<String, Object> previous = null;
        for (Map<String, Object> day : days) {
            Double lossRate = ReviewSupport.finite(day.get("lossRatePercent"));
            Double pnl = ReviewSupport.finite(day.get("pnlPercent"));
            Double previousLoss = previous == null ? null : ReviewSupport.finite(previous.get("lossRatePercent"));
            Double previousPnl = previous == null ? null : ReviewSupport.finite(previous.get("pnlPercent"));
            day.put("lossRateDelta", previousLoss != null && lossRate != null ? ReviewSupport.round(lossRate - previousLoss, 1) : null);
            day.put("pnlDelta", previousPnl != null && pnl != null ? ReviewSupport.round(pnl - previousPnl, 2) : null);
            if (ReviewSupport.integer(day.get("rated"), 0) > 0) previous = day;
        }
        Map<String, Object> aggregate = summarizeCalls(trades, end - lookbackDays * ReviewSupport.DAY_MILLIS, end,
                partialFraction, feePercent, capitalPerTradeUsd);
        int eligibleDays = (int) days.stream().filter(day -> ReviewSupport.integer(day.get("rated"), 0) >= minTradesPerDay).count();
        int badDays = (int) days.stream().filter(day -> Boolean.TRUE.equals(day.get("bad"))).count();
        Map<String, Object> persistent = new LinkedHashMap<>();
        persistent.put("byInterval", repeatedBy(days, "interval", target, minBadDays));
        persistent.put("bySide", repeatedBy(days, "side", target, minBadDays));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("lookbackDays", lookbackDays); result.put("target", target); result.put("minTradesPerDay", minTradesPerDay);
        result.put("minBadDays", minBadDays); result.put("eligibleDays", eligibleDays); result.put("badDays", badDays);
        result.put("repeatedIssue", badDays >= minBadDays); result.put("days", days); result.put("aggregate", aggregate);
        result.put("persistent", persistent);
        return result;
    }

    public Map<String, Object> compareDailyPerformance(JsonNode trades, JsonNode config) {
        return compareDailyPerformance(trades, config, Instant.now(), .5, .06, 200);
    }

    /** Correlation-only loss diagnosis: it ranks areas to backtest, not causal claims. */
    public Map<String, Object> diagnoseLosses(Map<String, Object> summary) {
        ArrayNode lost = array(summary == null ? null : summary.get("lostTrades"));
        ArrayNode won = array(summary == null ? null : summary.get("wonTrades"));
        ArrayNode rated = array(summary == null ? null : summary.get("ratedTrades"));
        List<Map<String, Object>> numeric = new ArrayList<>();
        for (NumericField field : List.of(
                new NumericField("score", "điểm tín hiệu", true),
                new NumericField("consensusPercent", "đồng thuận %", false),
                new NumericField("riskPercent", "khoảng SL %", false),
                new NumericField("cvdSlope", "độ dốc CVD", true),
                new NumericField("volumeRatio", "volume/TB", false))) {
            List<Double> failures = evidenceValues(lost, field);
            List<Double> successes = evidenceValues(won, field);
            if (failures.size() < 3 || successes.size() < 3) continue;
            double failedMean = failures.stream().mapToDouble(Double::doubleValue).average().orElse(0);
            double successMean = successes.stream().mapToDouble(Double::doubleValue).average().orElse(0);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("key", field.key()); row.put("label", field.label()); row.put("lost", ReviewSupport.round(failedMean, 3));
            row.put("rest", ReviewSupport.round(successMean, 3));
            row.put("deltaPercent", successMean == 0 ? null : ReviewSupport.round((failedMean - successMean) / Math.abs(successMean) * 100, 1));
            row.put("samples", Map.of("lost", failures.size(), "rest", successes.size()));
            numeric.add(row);
        }
        numeric.sort((left, right) -> Double.compare(Math.abs(ReviewSupport.number(right.get("deltaPercent"), 0)),
                Math.abs(ReviewSupport.number(left.get("deltaPercent"), 0))));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("numeric", numeric); result.put("byInterval", rateBy(rated, lost, "interval"));
        result.put("bySide", rateBy(rated, lost, "side"));
        List<Map<String, Object>> symbols = rateBy(rated, lost, "symbol");
        result.put("bySymbol", symbols.subList(0, Math.min(8, symbols.size())));
        result.put("supportingGroups", autoRetune.diagnoseSupportingGroups(lost));
        return result;
    }

    /** Generates entry gates only when post-mortem says the loss was wrong direction. */
    public List<AutoRetuneService.Candidate> buildEntryCandidates(JsonNode strategy, JsonNode config, JsonNode postMortem) {
        if (postMortem == null || !"sai-huong".equals(ReviewSupport.text(ReviewSupport.at(postMortem, "verdict.id"), ""))) return List.of();
        ArrayNode rows = array(postMortem.get("rows"));
        List<JsonNode> wrong = new ArrayList<>();
        for (JsonNode row : rows) if ("sai-huong".equals(ReviewSupport.text(row.get("kind"), ""))) wrong.add(row);
        int minSamples = Math.max(3, ReviewSupport.integer(config == null ? null : config.get("minEntryCauseSamples"), 3));
        double share = ReviewSupport.number(config == null ? null : config.get("entryCauseSharePercent"), 60);
        if (wrong.size() < minSamples) return List.of();
        JsonNode quality = strategy == null ? null : strategy.path("entryQuality");
        List<AutoRetuneService.Candidate> result = new ArrayList<>();
        if (!ReviewSupport.bool(quality == null ? null : quality.get("requireStructureAgreement"), false)
                && supported(wrong, minSamples, share, row -> {
            double score = ReviewSupport.number(ReviewSupport.at(row, "evidence.groups.structure.score"), Double.NaN);
            if (!Double.isFinite(score)) return null;
            return score * direction(row) < 0;
        })) {
            result.add(entryCandidate(strategy, "entry-structure-agreement", "Chỉ vào khi cấu trúc cùng hướng",
                    changes("entryQuality.requireStructureAgreement", true),
                    "Phần lớn kèo sai hướng được vào khi cấu trúc đang chống lại hướng lệnh."));
        }
        double currentMove = ReviewSupport.number(quality == null ? null : quality.get("maxDirectionalMove20Pct"), Double.NaN);
        double proposedMove = Double.isFinite(currentMove) && currentMove > 0 ? Math.max(2, ReviewSupport.round(currentMove - .5, 2))
                : ReviewSupport.number(config == null ? null : config.get("entryMaxMove20Pct"), 4);
        if (proposedMove > 0 && supported(wrong, minSamples, share, row -> {
            double move = ReviewSupport.number(ReviewSupport.at(row, "evidence.priceChange20Pct"), Double.NaN);
            return Double.isFinite(move) ? move * direction(row) > proposedMove : null;
        })) {
            result.add(entryCandidate(strategy, "entry-no-chasing", "Không đuổi nhịp đã đi quá " + proposedMove + "%/20 nến",
                    changes("entryQuality.maxDirectionalMove20Pct", proposedMove),
                    "Phần lớn kèo sai hướng xuất hiện sau khi giá đã đi quá xa theo hướng vào lệnh."));
        }
        boolean avoiding = ReviewSupport.bool(quality == null ? null : quality.get("avoidRangeExtremes"), false);
        double maxLong = avoiding ? Math.max(.6, ReviewSupport.round(ReviewSupport.number(quality == null ? null : quality.get("maxLongRangePosition"), .8) - .05, 2)) : .8;
        double minShort = avoiding ? Math.min(.4, ReviewSupport.round(ReviewSupport.number(quality == null ? null : quality.get("minShortRangePosition"), .2) + .05, 2)) : .2;
        if (supported(wrong, minSamples, share, row -> {
            double position = ReviewSupport.number(ReviewSupport.at(row, "evidence.rangePosition50"), Double.NaN);
            if (!Double.isFinite(position)) return null;
            return direction(row) > 0 ? position > maxLong : position < minShort;
        })) {
            ObjectNode values = mapper.createObjectNode();
            values.put("entryQuality.avoidRangeExtremes", true); values.put("entryQuality.maxLongRangePosition", maxLong);
            values.put("entryQuality.minShortRangePosition", minShort);
            result.add(entryCandidate(strategy, "entry-avoid-range-extremes", "Tránh entry sát cực trị vùng giá 50 nến", values,
                    "Phần lớn kèo sai hướng mua gần đỉnh vùng hoặc bán gần đáy vùng 50 nến."));
        }
        double nextCvd = ReviewSupport.round(ReviewSupport.number(quality == null ? null : quality.get("minAbsCvdSlope"), .03)
                + ReviewSupport.number(config == null ? null : config.get("entryCvdStep"), .01), 3);
        if (supported(wrong, minSamples, share, row -> {
            double cvd = ReviewSupport.number(ReviewSupport.at(row, "evidence.cvdSlope"), Double.NaN);
            return Double.isFinite(cvd) ? cvd * direction(row) < nextCvd : null;
        })) {
            result.add(entryCandidate(strategy, "entry-stronger-cvd", "Tăng xác nhận CVD lên " + ReviewSupport.round(nextCvd * 100, 1) + "%",
                    changes("entryQuality.minAbsCvdSlope", nextCvd), "Phần lớn kèo sai hướng chỉ vừa đủ qua ngưỡng CVD hiện tại."));
        }
        double nextVolume = ReviewSupport.round(ReviewSupport.number(quality == null ? null : quality.get("minVolumeRatio"), 1)
                + ReviewSupport.number(config == null ? null : config.get("entryVolumeStep"), .1), 2);
        if (supported(wrong, minSamples, share, row -> {
            double volume = ReviewSupport.number(ReviewSupport.at(row, "evidence.volumeRatio"), Double.NaN);
            return Double.isFinite(volume) ? volume < nextVolume : null;
        })) {
            result.add(entryCandidate(strategy, "entry-stronger-volume", "Tăng xác nhận volume lên " + nextVolume + "x",
                    changes("entryQuality.minVolumeRatio", nextVolume), "Phần lớn kèo sai hướng chỉ vừa đủ qua ngưỡng volume hiện tại."));
        }
        return result;
    }

    public ReviewCandidates buildReviewCandidates(JsonNode strategy, JsonNode config, Map<String, Object> diagnosis,
                                                   JsonNode postMortem) {
        String causeId = ReviewSupport.text(ReviewSupport.at(postMortem, "verdict.id"), "");
        List<AutoRetuneService.Candidate> risks = autoRetune.buildRiskCandidates(strategy, config);
        List<AutoRetuneService.Candidate> candidates;
        switch (causeId) {
            case "sai-huong" -> candidates = buildEntryCandidates(strategy, config, postMortem);
            case "noi-sl" -> candidates = risks.stream().filter(item -> item.id().equals("fixed-stop") || item.id().startsWith("wider-stop")).toList();
            case "dao-chieu" -> candidates = risks.stream().filter(item -> item.id().equals("nearer-tp1")).toList();
            default -> candidates = List.of();
        }
        Map<String, Object> worst = null;
        Object intervals = diagnosis == null ? null : diagnosis.get("byInterval");
        if (intervals instanceof List<?> list) {
            int min = Math.max(4, ReviewSupport.integer(config == null ? null : config.get("minTradesPerInterval"), 5));
            for (Object row : list) {
                Map<String, Object> map = asMap(row);
                if (ReviewSupport.integer(map.get("total"), 0) >= min) { worst = map; break; }
            }
        }
        return new ReviewCandidates(candidates, worst, postMortem == null ? null : ReviewSupport.at(postMortem, "verdict"));
    }

    /** Reads BTC's realised change during the reviewed window; failure is non-fatal. */
    public Map<String, Object> readMarketTrend(JsonNode config, ReviewWindow window, Instant now) {
        String symbol = ReviewSupport.text(config == null ? null : config.get("marketSymbol"), "BTCUSDT");
        String interval = ReviewSupport.text(config == null ? null : config.get("marketInterval"), "4h");
        double threshold = Math.abs(ReviewSupport.number(config == null ? null : config.get("marketTrendPercent"), 2));
        try {
            List<Candle> candles = binance.fetchKlines(symbol, interval, 200).stream().filter(Candle::closed).toList();
            long until = window.untilMs() == null ? now.toEpochMilli() : window.untilMs();
            long since = window.sinceMs() == null ? until - ReviewSupport.DAY_MILLIS : window.sinceMs();
            List<Candle> inWindow = candles.stream().filter(candle -> candle.openTime() >= since && candle.openTime() < until).toList();
            List<Candle> used = inWindow.size() >= 2 ? inWindow : candles.subList(Math.max(0, candles.size() - 6), candles.size());
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("symbol", symbol); result.put("interval", interval);
            if (used.size() < 2) { result.put("error", "không đủ nến"); return result; }
            double change = (used.get(used.size() - 1).close() - used.get(0).open()) / used.get(0).open() * 100;
            result.put("bars", used.size()); result.put("changePercent", ReviewSupport.round(change, 2)); result.put("inWindow", inWindow.size() >= 2);
            result.put("label", change >= threshold ? "Uptrend" : change <= -threshold ? "Downtrend" : "Sideway");
            return result;
        } catch (RuntimeException error) {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("symbol", symbol); result.put("interval", interval); result.put("error", error.getMessage());
            return result;
        }
    }

    public Map<String, Object> runDailyReview(JsonNode strategy) {
        return runDailyReview(strategy, autoRetune.readState(), Instant.now(), false, false, null);
    }

    public Map<String, Object> runDailyReview(JsonNode strategy, boolean force, boolean skipTraining) {
        return runDailyReview(strategy, autoRetune.readState(), Instant.now(), force, skipTraining, null);
    }

    public Map<String, Object> runDailyReview(JsonNode strategy, ObjectNode state, Instant now, boolean force, boolean skipTraining) {
        return runDailyReview(strategy, state, now, force, skipTraining, null);
    }

    /**
     * Executes a daily review. A supplied post-mortem JSON is useful for a
     * command/UI that already replayed losses; otherwise this method computes
     * one with {@link PostMortemService} from the stored closed trades.
     */
    public Map<String, Object> runDailyReview(JsonNode strategy, ObjectNode state, Instant now, boolean force,
                                               boolean skipTraining, JsonNode suppliedPostMortem) {
        if (state == null) state = autoRetune.readState();
        JsonNode config = strategy == null ? null : strategy.path("dailyReview");
        boolean enabled = config == null || !config.path("enabled").isBoolean() || config.path("enabled").asBoolean();
        int everyHours = Math.max(1, ReviewSupport.integer(config == null ? null : config.get("everyHours"), 24));
        ReviewWindow analysisWindow = reviewWindow(config, now);
        ObjectNode overviewConfig = ReviewSupport.objectCopy(mapper, config);
        overviewConfig.put("windowMode", "calendar-day");
        ReviewWindow overviewWindow = reviewWindow(overviewConfig, now);
        Map<String, Object> base = new LinkedHashMap<>();
        base.put("enabled", enabled); base.put("everyHours", everyHours); base.put("window", windowMap(overviewWindow)); base.put("at", now.toString());
        JsonNode active = state.path("activeTuning").path("changes").isObject() ? state.path("activeTuning") : null;
        base.put("activeTuning", active == null ? null : active.deepCopy());
        if (!enabled) return report("disabled", base);
        Instant lastAt = ReviewSupport.instant(state.get("lastReviewAt"));
        if (!force && lastAt != null && now.toEpochMilli() - lastAt.toEpochMilli() < everyHours * 3_600_000d) {
            Map<String, Object> result = report("too-soon", base);
            result.put("nextAt", lastAt.plusMillis(everyHours * 3_600_000L).toString());
            return result;
        }
        double partial = ReviewSupport.number(ReviewSupport.at(strategy, "risk.partialFraction"), .5);
        double fee = ReviewSupport.number(config == null ? null : config.get("feePercent"), .06);
        double capital = ReviewSupport.number(config == null ? null : config.get("assumedCapitalPerTradeUsd"), 200);
        Map<String, Object> summary = summarizeCalls(state.path("trades"), overviewWindow.sinceMs(), overviewWindow.untilMs(), partial, fee, capital);
        Map<String, Object> analysisSummary = sameWindow(analysisWindow, overviewWindow) ? summary
                : summarizeCalls(state.path("trades"), analysisWindow.sinceMs(), analysisWindow.untilMs(), partial, fee, capital);
        Map<String, Object> comparison = compareDailyPerformance(state.path("trades"), config, now, partial, fee, capital);
        base.put("comparison", compactComparison(comparison));
        double target = ReviewSupport.number(config == null ? null : config.get("targetLossRatePercent"), 30);
        int minTrades = Math.max(3, ReviewSupport.integer(config == null ? null : config.get("minClosedTrades"), 10));
        state.put("lastReviewAt", now.toString());
        base.put("market", readMarketTrend(config, analysisWindow, now));
        base.put("retune", freshRetune(state.path("attempts"), analysisWindow, now));

        Map<String, Object> aggregate = asMap(comparison.get("aggregate"));
        JsonNode postMortem = suppliedPostMortem;
        if (postMortem == null && ReviewSupport.bool(ReviewSupport.at(strategy, "learning.enabled"), true)
                && ReviewSupport.integer(aggregate.get("lost"), 0) > 0) {
            postMortem = createPostMortem(array(aggregate.get("lostTrades")), strategy);
        }
        base.put("postMortem", postMortem);
        if (skipTraining) {
            Map<String, Object> diagnosis = ReviewSupport.integer(aggregate.get("rated"), 0) > 0 ? diagnoseLosses(aggregate) : null;
            Map<String, Object> result = report("review-only", base); result.put("target", target); result.put("summary", compactSummary(summary)); result.put("diagnosis", diagnosis);
            appendReview(state, now, result, summary, null); autoRetune.saveState(state); return result;
        }
        if (ReviewSupport.integer(aggregate.get("rated"), 0) < minTrades) {
            Map<String, Object> result = report("not-enough-data", base); result.put("target", target); result.put("summary", compactSummary(summary)); result.put("minClosedTrades", minTrades);
            appendReview(state, now, result, summary, null); autoRetune.saveState(state); return result;
        }
        if (ReviewSupport.integer(analysisSummary.get("rated"), 0) == 0) {
            Map<String, Object> result = report("no-new-data", base); result.put("target", target); result.put("summary", compactSummary(summary)); result.put("minClosedTrades", minTrades);
            appendReview(state, now, result, summary, null); autoRetune.saveState(state); return result;
        }
        Map<String, Object> diagnosis = diagnoseLosses(aggregate);
        ReviewCandidates reviewCandidates = buildReviewCandidates(strategy, config, diagnosis, postMortem);
        if (ReviewSupport.finite(aggregate.get("lossRatePercent")) != null && ReviewSupport.finite(aggregate.get("lossRatePercent")) <= target) {
            Map<String, Object> result = reviewResult("on-target", base, target, summary, diagnosis, reviewCandidates.worstInterval());
            appendReview(state, now, result, summary, null); autoRetune.saveState(state); return result;
        }
        if (!Boolean.TRUE.equals(comparison.get("repeatedIssue"))) {
            Map<String, Object> result = reviewResult("monitoring-pattern", base, target, summary, diagnosis, reviewCandidates.worstInterval());
            appendReview(state, now, result, summary, null); autoRetune.saveState(state); return result;
        }
        double cooldownHours = Math.max(0, ReviewSupport.number(config == null ? null : config.get("cooldownHours"), 168));
        Instant appliedAt = ReviewSupport.instant(state.get("lastAppliedAt"));
        if (appliedAt != null && now.toEpochMilli() - appliedAt.toEpochMilli() < cooldownHours * 3_600_000d) {
            Map<String, Object> result = reviewResult("cooldown", base, target, summary, diagnosis, reviewCandidates.worstInterval());
            result.put("nextTuneAt", appliedAt.plusMillis(Math.round(cooldownHours * 3_600_000d)).toString());
            appendReview(state, now, result, summary, null); autoRetune.saveState(state); return result;
        }
        if (reviewCandidates.candidates().isEmpty()) {
            Map<String, Object> result = reviewResult("no-supported-change", base, target, summary, diagnosis, reviewCandidates.worstInterval());
            result.put("cause", reviewCandidates.cause());
            appendReview(state, now, result, summary, null); autoRetune.saveState(state); return result;
        }
        return evaluateCandidates(strategy, state, now, config, target, summary, diagnosis, reviewCandidates, base, comparison);
    }

    /** Formats the intentionally compact daily Telegram overview. */
    public String formatDailyReview(Map<String, Object> report) {
        if (report == null || "disabled".equals(report.get("status")) || "too-soon".equals(report.get("status"))) return null;
        Map<String, Object> summary = asMap(report.get("summary"));
        Map<String, Object> window = asMap(report.get("window"));
        int closed = ReviewSupport.integer(summary.get("closed"), 0);
        int wins = ReviewSupport.integer(summary.get("win"), ReviewSupport.integer(summary.get("won"), 0));
        int losses = ReviewSupport.integer(summary.get("loss"), ReviewSupport.integer(summary.get("lost"), 0));
        double capital = ReviewSupport.number(summary.get("capitalPerTradeUsd"), 200);
        Double pnl = ReviewSupport.finite(summary.get("pnlPercent"));
        Double pnlUsd = ReviewSupport.finite(summary.get("pnlUsd"));
        String pnlText = pnl == null || pnlUsd == null ? "—" : (pnlUsd >= 0 ? "🟢 +" : "🔴 ")
                + vi(String.format(Locale.ROOT, "%.2f", pnlUsd)) + "$ (" + (pnl >= 0 ? "+" : "") + vi(String.format(Locale.ROOT, "%.2f", pnl)) + "%)";
        List<String> lines = new ArrayList<>();
        lines.add("📅 <b>" + value(window.get("label"), "NGÀY HIỆN TẠI") + "</b>");
        lines.add("🌟 <b>Tổng Quan Hiệu Suất</b>"); lines.add("Tổng số lệnh: <b>" + closed + "</b>");
        lines.add("<i>Không bao gồm các kèo đang mở.</i>"); lines.add("");
        lines.add("Tỉ lệ W/L: <b>" + wins + " W - " + losses + " L</b>");
        lines.add("Win (W): Kèo đã chạm ít nhất TP1."); lines.add("Loss (L): Kèo chạm SL khi chưa chạm TP1."); lines.add("");
        lines.add("Tổng Lợi nhuận (PnL): <b>" + (closed == 0 ? "0,00$ (+0,00%)" : pnlText) + "</b>");
        String capitalText = capital == Math.rint(capital) ? Long.toString(Math.round(capital)) : Double.toString(capital);
        lines.add("Điều kiện tính toán: Giả định vốn vào mọi lệnh bằng nhau (" + vi(capitalText)
                + "$) và chưa nhân đòn bẩy. Đã trừ phí sàn cho mỗi lần thoát lệnh.");
        return String.join("\n", lines);
    }

    private Map<String, Object> evaluateCandidates(JsonNode strategy, ObjectNode state, Instant now, JsonNode config, double target,
                                                    Map<String, Object> summary, Map<String, Object> diagnosis, ReviewCandidates candidates,
                                                    Map<String, Object> base, Map<String, Object> comparison) {
        try {
            Map<String, Object> aggregate = asMap(comparison.get("aggregate"));
            int maxSymbols = Math.max(1, ReviewSupport.integer(config == null ? null : config.get("maxSymbols"), 3));
            List<Pair> lossPairs = pairsFromLosses(array(aggregate.get("lostTrades")), maxSymbols);
            String guardInterval = ReviewSupport.text(config == null ? null : config.get("guardInterval"), "4h");
            List<Pair> guardPairs = guardPairs(config, guardInterval);
            int requestedCandles = Math.max(600, ReviewSupport.integer(config == null ? null : config.get("backtestCandles"), 3000));
            double trainingRatio = ReviewSupport.number(config == null ? null : config.get("trainingRatio"), .75);
            if (!(trainingRatio > 0 && trainingRatio < 1)) trainingRatio = .75;
            List<Pair> allPairs = new ArrayList<>(lossPairs); allPairs.addAll(guardPairs);
            Map<String, ReviewSupport.BacktestSegments> baselines = new LinkedHashMap<>();
            for (Pair pair : allPairs) baselines.put(pair.key(), ReviewSupport.backtestSegments(binance, backtest, pair.symbol(), pair.interval(), strategy,
                    requestedCandles, trainingRatio));
            List<Map<String, Object>> baselineRows = new ArrayList<>();
            for (Pair pair : allPairs) {
                ReviewSupport.BacktestSegments segment = baselines.get(pair.key());
                Map<String, Object> row = new LinkedHashMap<>(); row.put("key", pair.key()); row.put("train", segment.train()); row.put("holdout", segment.holdout());
                baselineRows.add(row);
            }
            List<Map<String, Object>> evaluated = new ArrayList<>();
            for (AutoRetuneService.Candidate candidate : candidates.candidates()) {
                List<Map<String, Object>> byPair = new ArrayList<>();
                for (Pair pair : allPairs) {
                    ReviewSupport.BacktestSegments baseSegments = baselines.get(pair.key());
                    ReviewSupport.BacktestSegments tested = ReviewSupport.backtestSegments(binance, backtest, pair.symbol(), pair.interval(), candidate.strategy(),
                            requestedCandles, trainingRatio);
                    boolean passes = pair.guard()
                            ? passesGuard(baseSegments.train(), tested.train(), config) && passesGuard(baseSegments.holdout(), tested.holdout(), config)
                            : passesImprovement(baseSegments.train(), tested.train(), config) && passesImprovement(baseSegments.holdout(), tested.holdout(), config);
                    Map<String, Object> row = new LinkedHashMap<>(); row.put("key", pair.key()); row.put("guard", pair.guard());
                    row.put("train", tested.train()); row.put("holdout", tested.holdout()); row.put("passes", passes); byPair.add(row);
                }
                List<Map<String, Object>> lossRows = byPair.stream().filter(row -> !Boolean.TRUE.equals(row.get("guard"))).toList();
                List<Map<String, Object>> guardRows = byPair.stream().filter(row -> Boolean.TRUE.equals(row.get("guard"))).toList();
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("id", candidate.id()); item.put("label", candidate.label()); item.put("changes", candidate.changes()); item.put("because", candidate.because());
                item.put("kind", candidate.kind()); item.put("byPair", byPair); item.put("improves", lossRows.stream().allMatch(row -> Boolean.TRUE.equals(row.get("passes"))));
                item.put("guardOk", guardRows.stream().allMatch(row -> Boolean.TRUE.equals(row.get("passes")))); item.put("passes", byPair.stream().allMatch(row -> Boolean.TRUE.equals(row.get("passes"))));
                item.put("holdout", average(lossRows, "holdout")); item.put("guardHoldout", average(guardRows, "holdout")); evaluated.add(item);
            }
            evaluated.sort(Comparator.comparing((Map<String, Object> item) -> ReviewSupport.number(asMap(item.get("holdout")).get("slRatePercent"), 0))
                    .thenComparing((left, right) -> Double.compare(ReviewSupport.number(asMap(right.get("holdout")).get("expectancyPercent"), 0),
                            ReviewSupport.number(asMap(left.get("holdout")).get("expectancyPercent"), 0))));
            Map<String, Object> selected = evaluated.stream().filter(row -> Boolean.TRUE.equals(row.get("passes"))).findFirst().orElse(null);
            boolean autoApply = ReviewSupport.bool(config == null ? null : config.get("autoApply"), false);
            boolean runtimeApply = ReviewSupport.bool(config == null ? null : config.get("runtimeApply"), false);
            boolean applied = selected != null && (autoApply || runtimeApply);
            Map<String, Object> result = reviewResult(selected == null ? "no-safe-change" : applied ? "applied" : "proposed", base, target, summary, diagnosis, candidates.worstInterval());
            result.put("guardInterval", guardInterval); result.put("baselines", baselineRows); result.put("candidates", evaluated);
            result.put("selected", selected == null ? null : selectedForReport(selected)); result.put("autoApply", autoApply); result.put("runtimeApply", runtimeApply);
            if (applied) {
                ObjectNode changes = (ObjectNode) selected.get("changes");
                activateTuning(state, now, changes, String.valueOf(selected.get("id")), ReviewSupport.integer(comparison.get("lookbackDays"), 0));
                if (autoApply) {
                    AutoRetuneService.Candidate candidate = candidates.candidates().stream().filter(value -> value.id().equals(selected.get("id"))).findFirst().orElse(null);
                    if (candidate != null) strategies.saveStrategy(candidate.strategy());
                }
            }
            appendReview(state, now, result, summary, selected == null ? null : String.valueOf(selected.get("id")));
            autoRetune.saveState(state); return result;
        } catch (RuntimeException error) {
            Map<String, Object> result = reviewResult("failed", base, target, summary, diagnosis, candidates.worstInterval());
            result.put("error", error.getMessage()); appendReview(state, now, result, summary, null); autoRetune.saveState(state); return result;
        }
    }

    private JsonNode createPostMortem(ArrayNode lost, JsonNode strategy) {
        try {
            List<PostMortemService.Trade> trades = new ArrayList<>();
            for (JsonNode trade : lost) trades.add(postMortems.fromJson(trade));
            JsonNode learning = strategy == null ? null : strategy.path("learning");
            PostMortemService.Options options = new PostMortemService.Options(
                    Math.max(1, ReviewSupport.integer(ReviewSupport.at(strategy, "alerts.maxHoldBars"), 96)),
                    ReviewSupport.number(learning == null ? null : learning.get("widerSlMultiple"), 1.5),
                    Math.max(0, ReviewSupport.integer(learning == null ? null : learning.get("minBarsAfterStop"), 6)),
                    Math.max(0, ReviewSupport.integer(learning == null ? null : learning.get("sweepRecoveryBars"), 6)),
                    ReviewSupport.number(learning == null ? null : learning.get("noFavorMoveR"), .15));
            PostMortemService.PostMortemReport report = postMortems.postMortemLosses(trades, binance::fetchKlines,
                    Math.max(1, ReviewSupport.integer(learning == null ? null : learning.get("maxTradesPerReview"), 12)),
                    Math.max(50, ReviewSupport.integer(learning == null ? null : learning.get("replayCandles"), 400)), options, null);
            return postMortems.toJson(report);
        } catch (RuntimeException error) {
            ObjectNode failed = mapper.createObjectNode(); failed.put("error", error.getMessage()); return failed;
        }
    }

    private boolean passesImprovement(Map<String, Object> baseline, Map<String, Object> proposed, JsonNode config) {
        int minimum = Math.max(5, ReviewSupport.integer(config == null ? null : config.get("minTradesPerSegment"), 8));
        if (ReviewSupport.integer(proposed.get("trades"), 0) < minimum) return false;
        Double pPf = ReviewSupport.finite(proposed.get("profitFactor")); Double pExpectancy = ReviewSupport.finite(proposed.get("expectancyPercent"));
        Double pSl = ReviewSupport.finite(proposed.get("slRatePercent")); Double bPf = ReviewSupport.finite(baseline.get("profitFactor"));
        Double bExpectancy = ReviewSupport.finite(baseline.get("expectancyPercent")); Double bSl = ReviewSupport.finite(baseline.get("slRatePercent"));
        if (pPf == null || pExpectancy == null || pSl == null || bPf == null || bExpectancy == null || bSl == null) return false;
        return pSl <= bSl - ReviewSupport.number(config == null ? null : config.get("minSlRateDropPercent"), 2)
                && pExpectancy >= bExpectancy && pPf >= bPf;
    }

    private boolean passesGuard(Map<String, Object> baseline, Map<String, Object> proposed, JsonNode config) {
        int minimum = Math.max(5, ReviewSupport.integer(config == null ? null : config.get("minTradesPerSegment"), 8));
        if (ReviewSupport.integer(proposed.get("trades"), 0) < minimum) return false;
        Double pf = ReviewSupport.finite(proposed.get("profitFactor")); Double expectancy = ReviewSupport.finite(proposed.get("expectancyPercent"));
        if (pf == null || expectancy == null) return false;
        return expectancy > 0 && pf >= ReviewSupport.number(config == null ? null : config.get("minProfitFactor"), 1.05)
                && expectancy >= ReviewSupport.number(baseline.get("expectancyPercent"), 0)
                - ReviewSupport.number(config == null ? null : config.get("guardExpectancyTolerance"), .02);
    }

    private List<Map<String, Object>> repeatedBy(List<Map<String, Object>> days, String field, double target, int minBadDays) {
        Map<String, GroupRow> totals = new LinkedHashMap<>();
        for (Map<String, Object> day : days) {
            ArrayNode all = array(day.get("ratedTrades")); ArrayNode lost = array(day.get("lostTrades"));
            Map<String, Integer> dayTotals = tally(all, field); Map<String, Integer> dayLost = tally(lost, field);
            for (Map.Entry<String, Integer> entry : dayTotals.entrySet()) {
                GroupRow row = totals.computeIfAbsent(entry.getKey(), GroupRow::new);
                int total = entry.getValue(); int failures = dayLost.getOrDefault(entry.getKey(), 0);
                row.total += total; row.lost += failures; row.observedDays++;
                if (total >= 2 && failures * 100d / total > target) row.badDays++;
            }
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (GroupRow row : totals.values()) {
            Map<String, Object> item = new LinkedHashMap<>(); item.put("key", row.key); item.put("total", row.total); item.put("lost", row.lost);
            item.put("observedDays", row.observedDays); item.put("badDays", row.badDays); item.put("lossRatePercent", ReviewSupport.round(row.lost * 100d / row.total, 1));
            if (row.badDays >= minBadDays) result.add(item);
        }
        result.sort(Comparator.<Map<String, Object>>comparingInt(row -> ReviewSupport.integer(row.get("badDays"), 0)).reversed()
                .thenComparing((left, right) -> Double.compare(ReviewSupport.number(right.get("lossRatePercent"), 0), ReviewSupport.number(left.get("lossRatePercent"), 0))));
        return result;
    }

    private List<Map<String, Object>> rateBy(ArrayNode all, ArrayNode lost, String field) {
        Map<String, Integer> totals = tally(all, field); Map<String, Integer> failures = tally(lost, field);
        List<Map<String, Object>> result = new ArrayList<>();
        for (Map.Entry<String, Integer> entry : totals.entrySet()) {
            int failed = failures.getOrDefault(entry.getKey(), 0);
            Map<String, Object> row = new LinkedHashMap<>(); row.put("key", entry.getKey()); row.put("total", entry.getValue()); row.put("lost", failed);
            row.put("lossRatePercent", ReviewSupport.round(failed * 100d / entry.getValue(), 1)); result.add(row);
        }
        result.sort(Comparator.comparing((Map<String, Object> row) -> ReviewSupport.number(row.get("lossRatePercent"), 0)).reversed()
                .thenComparing((left, right) -> Integer.compare(ReviewSupport.integer(right.get("total"), 0), ReviewSupport.integer(left.get("total"), 0))));
        return result;
    }

    private Map<String, Integer> tally(ArrayNode rows, String field) {
        Map<String, Integer> result = new LinkedHashMap<>();
        for (JsonNode row : rows) {
            JsonNode value = row.get(field);
            if (value == null || value.isNull()) continue;
            String key = value.asText();
            if (!key.isBlank()) result.merge(key, 1, Integer::sum);
        }
        return result;
    }

    private List<Double> evidenceValues(ArrayNode rows, NumericField field) {
        List<Double> values = new ArrayList<>();
        for (JsonNode row : rows) {
            double value = ReviewSupport.number(row.path("evidence").get(field.key()), Double.NaN);
            if (Double.isFinite(value)) values.add(field.absolute() ? Math.abs(value) : value);
        }
        return values;
    }

    private boolean supported(List<JsonNode> rows, int minSamples, double requiredShare, Predicate predicate) {
        int known = 0; int hits = 0;
        for (JsonNode row : rows) {
            Boolean value = predicate.test(row);
            if (value == null) continue;
            known++; if (value) hits++;
        }
        return known >= minSamples && hits * 100d / known >= requiredShare;
    }

    private AutoRetuneService.Candidate entryCandidate(JsonNode strategy, String id, String label, ObjectNode changes, String because) {
        return new AutoRetuneService.Candidate(id, label, changes, because, "entry", autoRetune.applyStrategyChanges(strategy, changes));
    }

    private ObjectNode changes(String path, Object value) {
        ObjectNode changes = mapper.createObjectNode(); changes.set(path, mapper.valueToTree(value)); return changes;
    }

    private static int direction(JsonNode row) { return "long".equals(ReviewSupport.text(row.get("side"), "")) ? 1 : -1; }

    private ArrayNode combine(ArrayNode first, ArrayNode second) {
        ArrayNode result = mapper.createArrayNode(); for (JsonNode value : first) result.add(value.deepCopy()); for (JsonNode value : second) result.add(value.deepCopy()); return result;
    }

    private ArrayNode array(Object value) {
        if (value instanceof ArrayNode array) return array;
        if (value instanceof JsonNode node && node.isArray()) return (ArrayNode) node;
        JsonNode converted = mapper.valueToTree(value);
        return converted != null && converted.isArray() ? (ArrayNode) converted : mapper.createArrayNode();
    }

    private Map<String, Object> compactSummary(Map<String, Object> summary) {
        Map<String, Object> result = new LinkedHashMap<>(summary);
        for (String key : List.of("trades", "ratedTrades", "wonTrades", "lostTrades")) result.remove(key);
        return result;
    }

    private Map<String, Object> compactComparison(Map<String, Object> comparison) {
        Map<String, Object> result = new LinkedHashMap<>(comparison);
        Object rawDays = result.get("days");
        if (rawDays instanceof List<?> days) {
            List<Map<String, Object>> compact = new ArrayList<>(); for (Object day : days) compact.add(compactSummary(asMap(day))); result.put("days", compact);
        }
        result.put("aggregate", compactSummary(asMap(result.get("aggregate")))); return result;
    }

    private JsonNode freshRetune(JsonNode attempts, ReviewWindow window, Instant now) {
        if (attempts == null || !attempts.isArray()) return null;
        long freshFrom = window.sinceMs() == null ? now.toEpochMilli() - 7 * ReviewSupport.DAY_MILLIS : window.sinceMs();
        for (int index = attempts.size() - 1; index >= 0; index--) {
            JsonNode attempt = attempts.get(index); String status = ReviewSupport.text(attempt.get("status"), ""); Instant at = ReviewSupport.instant(attempt.get("at"));
            if (("applied".equals(status) || "proposed".equals(status) || "no-safe-change".equals(status)) && at != null && at.toEpochMilli() >= freshFrom) {
                ObjectNode result = mapper.createObjectNode(); result.put("at", at.toString()); result.put("status", status); result.set("streak", attempt.get("streak"));
                result.set("selected", attempt.get("selected")); result.set("guardInterval", attempt.get("guardInterval")); return result;
            }
        }
        return null;
    }

    private void appendReview(ObjectNode state, Instant now, Map<String, Object> report, Map<String, Object> summary, String selected) {
        if (!state.path("reviews").isArray()) state.set("reviews", mapper.createArrayNode());
        ArrayNode reviews = (ArrayNode) state.path("reviews"); ObjectNode row = mapper.createObjectNode();
        row.put("at", now.toString()); row.put("status", String.valueOf(report.get("status"))); row.put("closed", ReviewSupport.integer(summary.get("closed"), 0));
        putOrNull(row, "rated", ReviewSupport.finite(summary.get("rated"))); putOrNull(row, "lossRatePercent", ReviewSupport.finite(summary.get("lossRatePercent"))); putOrNull(row, "pnlPercent", ReviewSupport.finite(summary.get("pnlPercent")));
        if (selected != null) row.put("selected", selected); reviews.add(row); while (reviews.size() > 30) reviews.remove(0);
    }

    private void activateTuning(ObjectNode state, Instant now, ObjectNode changes, String selectedId, int comparisonDays) {
        ObjectNode tuning = state.path("activeTuning").isObject() ? ((ObjectNode) state.path("activeTuning")).deepCopy() : mapper.createObjectNode();
        ObjectNode merged = tuning.path("changes").isObject() ? ((ObjectNode) tuning.path("changes")).deepCopy() : mapper.createObjectNode();
        changes.properties().forEach(entry -> merged.set(entry.getKey(), entry.getValue().deepCopy()));
        tuning.put("source", "daily-comparison"); tuning.put("appliedAt", now.toString()); tuning.set("changes", merged); tuning.put("selectedId", selectedId);
        tuning.put("comparisonDays", comparisonDays); state.set("activeTuning", tuning); state.put("lastAppliedAt", now.toString());
    }

    private List<Pair> pairsFromLosses(ArrayNode losses, int maximum) {
        List<Pair> result = new ArrayList<>(); Set<String> seen = new LinkedHashSet<>();
        for (int index = losses.size() - 1; index >= 0 && result.size() < maximum; index--) {
            JsonNode trade = losses.get(index); String symbol = ReviewSupport.text(trade.get("symbol"), ""); String interval = ReviewSupport.text(trade.get("interval"), "");
            String key = symbol + "|" + interval; if (!symbol.isBlank() && !interval.isBlank() && seen.add(key)) result.add(new Pair(key, symbol, interval, false));
        }
        return result;
    }

    private List<Pair> guardPairs(JsonNode config, String interval) {
        List<Pair> result = new ArrayList<>(); JsonNode symbols = config == null ? null : config.get("guardSymbols");
        if (symbols != null && symbols.isArray()) for (JsonNode symbol : symbols) addGuard(result, ReviewSupport.text(symbol, ""), interval);
        else for (String symbol : List.of("BTCUSDT", "ETHUSDT", "SOLUSDT")) addGuard(result, symbol, interval);
        return result;
    }

    private static void addGuard(List<Pair> pairs, String symbol, String interval) { if (!symbol.isBlank()) pairs.add(new Pair("guard:" + symbol + "|" + interval, symbol, interval, true)); }

    private Map<String, Object> average(List<Map<String, Object>> rows, String segment) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (String field : List.of("slRatePercent", "profitFactor", "expectancyPercent", "maxDrawdownPercent", "totalReturnPercent")) {
            result.put(field, rows.isEmpty() ? null : ReviewSupport.round(rows.stream().mapToDouble(row -> ReviewSupport.number(asMap(row.get(segment)).get(field), 0)).average().orElse(0), 3));
        }
        return result;
    }

    private Map<String, Object> selectedForReport(Map<String, Object> selected) {
        Map<String, Object> result = new LinkedHashMap<>(); for (String key : List.of("id", "label", "changes", "because")) result.put(key, selected.get(key));
        result.put("holdout", selected.get("holdout")); result.put("guardHoldout", selected.get("guardHoldout")); return result;
    }

    private static boolean sameWindow(ReviewWindow first, ReviewWindow second) {
        return java.util.Objects.equals(first.sinceMs(), second.sinceMs()) && java.util.Objects.equals(first.untilMs(), second.untilMs());
    }

    private static Map<String, Object> report(String status, Map<String, Object> base) { Map<String, Object> result = new LinkedHashMap<>(); result.put("status", status); result.putAll(base); return result; }

    private Map<String, Object> reviewResult(String status, Map<String, Object> base, double target, Map<String, Object> summary,
                                             Map<String, Object> diagnosis, Map<String, Object> worstInterval) {
        Map<String, Object> result = report(status, base); result.put("target", target); result.put("summary", compactSummary(summary)); result.put("diagnosis", diagnosis); result.put("worstInterval", worstInterval); return result;
    }

    private static Map<String, Object> windowMap(ReviewWindow window) {
        Map<String, Object> result = new LinkedHashMap<>(); result.put("mode", window.mode()); result.put("sinceMs", window.sinceMs()); result.put("untilMs", window.untilMs()); result.put("since", window.since()); result.put("label", window.label()); return result;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) { return value instanceof Map<?, ?> ? (Map<String, Object>) value : Map.of(); }
    private static String value(Object value, String fallback) { return value == null ? fallback : value.toString(); }
    private static String vi(String value) { return value.replace('.', ','); }
    private static void putOrNull(ObjectNode node, String field, Double value) { if (value == null) node.putNull(field); else node.put(field, value); }

    public record ReviewWindow(String mode, Long sinceMs, Long untilMs, String since, String label) {}
    public record ReviewCandidates(List<AutoRetuneService.Candidate> candidates, Map<String, Object> worstInterval, JsonNode cause) {}
    private record NumericField(String key, String label, boolean absolute) {}
    private record Pair(String key, String symbol, String interval, boolean guard) {}
    private static final class GroupRow {
        private final String key;
        private int total;
        private int lost;
        private int observedDays;
        private int badDays;
        private GroupRow(String key) { this.key = key; }
    }
    @FunctionalInterface private interface Predicate { Boolean test(JsonNode value); }
}
