package vn.dongtien.trading.analysis;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.trading.config.StrategyService;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.ml.ModelTrainer;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Bot-worker-only cadence for learning from completed calls.
 *
 * <p>Each run stores the prior day's loss replay, W/L/PnL review and compact
 * learning record before it considers retraining market models.  The strategy
 * review uses realised bot outcomes; a market model is promoted only when its
 * new holdout metrics meet the configured quality bar.</p>
 */
@Service
@ConditionalOnProperty(prefix = "dongtien.learning.scheduler", name = "enabled", havingValue = "true")
public class TradingLearningScheduler {
    private final AutoRetuneService autoRetune;
    private final StrategyService strategies;
    private final DailyLossLogService dailyLossLogs;
    private final DailyReviewService dailyReviews;
    private final LearningLogService learningLogs;
    private final ModelTrainer trainer;
    private final TradingHistoryRetentionService retention;
    private final TradingStateLock stateLock;
    private final ObjectMapper mapper;
    private final boolean modelTrainingEnabled;
    private final int maxModelPairs;
    private final int retentionDays;

    public TradingLearningScheduler(AutoRetuneService autoRetune, StrategyService strategies,
                                    DailyLossLogService dailyLossLogs, DailyReviewService dailyReviews,
                                    LearningLogService learningLogs, ModelTrainer trainer,
                                    TradingHistoryRetentionService retention, TradingStateLock stateLock,
                                    ObjectMapper mapper,
                                    @Value("${dongtien.learning.scheduler.model-training-enabled:true}") boolean modelTrainingEnabled,
                                    @Value("${dongtien.learning.scheduler.max-model-pairs:3}") int maxModelPairs,
                                    @Value("${dongtien.learning.scheduler.history-retention-days:30}") int retentionDays) {
        this.autoRetune = autoRetune;
        this.strategies = strategies;
        this.dailyLossLogs = dailyLossLogs;
        this.dailyReviews = dailyReviews;
        this.learningLogs = learningLogs;
        this.trainer = trainer;
        this.retention = retention;
        this.stateLock = stateLock;
        this.mapper = mapper;
        this.modelTrainingEnabled = modelTrainingEnabled;
        this.maxModelPairs = Math.max(1, Math.min(10, maxModelPairs));
        this.retentionDays = Math.max(7, retentionDays);
    }

    @Scheduled(cron = "${dongtien.learning.scheduler.daily-cron:0 7 8 * * *}",
            zone = "${dongtien.learning.scheduler.zone:Asia/Ho_Chi_Minh}")
    public void runDailyScheduled() {
        try {
            JobResult result = runDailyLearning(Instant.now());
            System.out.println("[learning] daily job: " + result.status());
        } catch (RuntimeException error) {
            System.err.println("[learning] daily job failed: " + message(error));
        }
    }

    @Scheduled(cron = "${dongtien.learning.scheduler.weekly-purge-cron:0 37 8 * * MON}",
            zone = "${dongtien.learning.scheduler.zone:Asia/Ho_Chi_Minh}")
    public void runWeeklyPurgeScheduled() {
        try {
            TradingHistoryRetentionService.PurgeResult result = purgeExpiredHistory(Instant.now());
            System.out.println("[learning] weekly purge: deleted=" + result.deletedTrades());
        } catch (RuntimeException error) {
            System.err.println("[learning] weekly purge failed: " + message(error));
        }
    }

    /** Runs the stateful daily workflow. Model training is intentionally outside the state lock. */
    public JobResult runDailyLearning(Instant now) {
        Instant startedAt = now == null ? Instant.now() : now;
        StateWorkflow stateWorkflow = stateLock.withLock(() -> recordAndReview(startedAt));
        if ("too-early".equals(stateWorkflow.lossLogStatus())) {
            return new JobResult("too-early", stateWorkflow.lossLogStatus(), stateWorkflow.reviewStatus(),
                    stateWorkflow.learningLogKey(), List.of());
        }
        List<ModelTrainer.PromotionResult> models = new ArrayList<>();
        if (modelTrainingEnabled && stateWorkflow.reviewSucceeded()
                && stateWorkflow.strategy().path("learning").path("dailyModelTrainingEnabled").asBoolean(true)) {
            for (TradingPair pair : stateWorkflow.pairs()) {
                try {
                    models.add(trainer.trainIfReliable(pair.symbol(), pair.interval(), stateWorkflow.strategy()));
                } catch (RuntimeException error) {
                    models.add(ModelTrainer.PromotionResult.failed(pair.symbol(), pair.interval(), message(error)));
                }
            }
        }
        return new JobResult("completed", stateWorkflow.lossLogStatus(), stateWorkflow.reviewStatus(),
                stateWorkflow.learningLogKey(), models);
    }

    /** Weekly cleanup uses a 30-day default and never removes open calls or learning/model documents. */
    public TradingHistoryRetentionService.PurgeResult purgeExpiredHistory(Instant now) {
        Instant reference = now == null ? Instant.now() : now;
        return retention.purgeClosedTradesOlderThan(reference.minus(retentionDays, ChronoUnit.DAYS));
    }

    private StateWorkflow recordAndReview(Instant now) {
        ObjectNode state = autoRetune.readState();
        JsonNode strategy = autoRetune.applyActiveTuning(strategies.strategy(), state);
        DailyLossLogService.Result loss = dailyLossLogs.recordDailyLossLog(strategy, state, now.toEpochMilli(),
                new DailyLossLogService.Dependencies(null, autoRetune::saveState, -1, false, false, false));
        if ("too-early".equals(loss.status())) {
            return new StateWorkflow(loss.status(), "not-run", null, strategy, List.of(), false);
        }

        Map<String, Object> review = dailyReviews.runDailyReview(strategy, state, now, false, false);
        JsonNode report = mapper.valueToTree(review);
        String reviewStatus = report.path("status").asText("unknown");
        String summary = dailyReviews.formatDailyReview(review);
        LearningLogService.WriteResult learning = learningLogs.writeLearningLog(report, strategy,
                state.path("activeTuning"), summary);
        boolean succeeded = !Set.of("failed", "disabled", "too-soon").contains(reviewStatus);
        List<TradingPair> pairs = succeeded ? pairsClosedInReviewWindow(state, strategy, now) : List.of();
        return new StateWorkflow(loss.status(), reviewStatus, learning.jsonFile(), strategy, pairs, succeeded);
    }

    private List<TradingPair> pairsClosedInReviewWindow(ObjectNode state, JsonNode strategy, Instant now) {
        DailyLossLogService.ReviewWindow window = DailyLossLogService.calendarDayWindow(
                strategy.path("dailyReview"), now.toEpochMilli(), -1);
        Set<TradingPair> values = new LinkedHashSet<>();
        for (JsonNode trade : state.path("trades")) {
            Instant closedAt = ReviewSupport.instant(trade.get("closedAt"));
            if (closedAt == null || closedAt.toEpochMilli() < window.sinceMs() || closedAt.toEpochMilli() >= window.untilMs()) continue;
            String symbol = ReviewSupport.text(trade.get("symbol"), "");
            String interval = ReviewSupport.text(trade.get("interval"), "");
            if (!symbol.isBlank() && BinanceClient.INTERVAL_MS.containsKey(interval)) values.add(new TradingPair(symbol, interval));
            if (values.size() >= maxModelPairs) break;
        }
        return List.copyOf(values);
    }

    private static String message(RuntimeException error) {
        return error.getMessage() == null || error.getMessage().isBlank() ? "Lỗi không xác định" : error.getMessage();
    }

    private record StateWorkflow(String lossLogStatus, String reviewStatus, String learningLogKey,
                                 JsonNode strategy, List<TradingPair> pairs, boolean reviewSucceeded) {}
    private record TradingPair(String symbol, String interval) {}
    public record JobResult(String status, String lossLogStatus, String reviewStatus,
                            String learningLogKey, List<ModelTrainer.PromotionResult> modelTraining) {}
}
