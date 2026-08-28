package vn.dongtien.trading.analysis;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;

/**
 * Bot-worker-only cadence for {@link TradingLearningJobs}.
 *
 * <p>This bean exists only when the persistent worker enables it, so the web
 * process never runs the job twice.  When no persistent worker is deployed, an
 * external scheduler runs the same workflow through the {@code learn-once} and
 * {@code purge-history} CLI commands instead.</p>
 */
@Service
@ConditionalOnProperty(prefix = "dongtien.learning.scheduler", name = "enabled", havingValue = "true")
public class TradingLearningScheduler {
    private final TradingLearningJobs jobs;

    public TradingLearningScheduler(TradingLearningJobs jobs) {
        this.jobs = jobs;
    }

    @Scheduled(cron = "${dongtien.learning.scheduler.daily-cron:0 7 8 * * *}",
            zone = "${dongtien.learning.scheduler.zone:Asia/Ho_Chi_Minh}")
    public void runDailyScheduled() {
        try {
            TradingLearningJobs.JobResult result = jobs.runDailyLearning(Instant.now());
            System.out.println("[learning] daily job: " + result.status());
        } catch (RuntimeException error) {
            System.err.println("[learning] daily job failed: " + TradingLearningJobs.message(error));
        }
    }

    @Scheduled(cron = "${dongtien.learning.scheduler.weekly-purge-cron:0 37 8 * * MON}",
            zone = "${dongtien.learning.scheduler.zone:Asia/Ho_Chi_Minh}")
    public void runWeeklyPurgeScheduled() {
        try {
            TradingHistoryRetentionService.PurgeResult result = jobs.purgeExpiredHistory(Instant.now());
            System.out.println("[learning] weekly purge: deleted=" + result.deletedTrades());
        } catch (RuntimeException error) {
            System.err.println("[learning] weekly purge failed: " + TradingLearningJobs.message(error));
        }
    }
}
