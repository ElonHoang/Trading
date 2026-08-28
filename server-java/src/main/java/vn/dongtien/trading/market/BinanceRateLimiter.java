package vn.dongtien.trading.market;

import java.util.Locale;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Per-IP request budget for one Binance REST pool (spot or futures).
 *
 * <p>Binance counts request weight per IP over a one-minute window that resets
 * on the wall-clock minute, and answers {@code 429} once the budget is gone and
 * {@code 418} with error {@code -1003} once it decides to ban the address.
 * Every response carries the weight spent so far in {@code X-MBX-USED-WEIGHT-1M},
 * so the budget is read from Binance rather than guessed from a local table.</p>
 *
 * <p>Requests are held back before the soft limit so a scan slows down instead
 * of being banned, and once a ban is known the client fails without sending
 * anything: further calls while banned extend the ban.</p>
 */
final class BinanceRateLimiter {
    /** Documented weight ceilings per minute for each pool. */
    static final int SPOT_WEIGHT_CAP = 6000;
    static final int FUTURES_WEIGHT_CAP = 2400;

    private static final long WINDOW_MS = 60_000L;
    /** Leaves room for in-flight requests whose weight has not been reported yet. */
    private static final double SOFT_LIMIT = 0.8;
    /** Clears the minute boundary before assuming the window has rolled over. */
    private static final long WINDOW_EDGE_BUFFER_MS = 250L;
    private static final long MAX_THROTTLE_WAIT_MS = 65_000L;
    private static final Pattern BANNED_UNTIL = Pattern.compile("banned until (\\d{10,})");

    private final String pool;
    private final int weightCap;
    private final Clock clock;
    private final Sleeper sleeper;

    private long bannedUntilMs;
    private int usedWeight;
    private long usedWeightAtMs;

    BinanceRateLimiter(String pool, int weightCap) {
        this(pool, weightCap, System::currentTimeMillis, Thread::sleep);
    }

    BinanceRateLimiter(String pool, int weightCap, Clock clock, Sleeper sleeper) {
        this.pool = pool;
        this.weightCap = weightCap;
        this.clock = clock;
        this.sleeper = sleeper;
    }

    /**
     * Blocks until the next request fits the budget.
     *
     * @throws BinanceClient.RemoteException if the address is currently banned, so
     *         the caller never spends a request confirming a ban it already knows about.
     */
    synchronized void beforeRequest() {
        long now = clock.nowMs();
        if (now < bannedUntilMs) {
            throw new BinanceClient.RemoteException(bannedMessage(bannedUntilMs - now), false);
        }
        if (!sameWindow(now)) return;
        if (usedWeight < weightCap * SOFT_LIMIT) return;
        waitUntil(nextWindowStart(now), now);
    }

    /** Records the weight Binance reports so the next call can budget against it. */
    synchronized void recordUsedWeight(Optional<String> header) {
        if (header.isEmpty()) return;
        try {
            usedWeight = Integer.parseInt(header.get().trim());
            usedWeightAtMs = clock.nowMs();
        } catch (NumberFormatException ignored) {
            // A malformed header only costs us the budget hint for this response.
        }
    }

    /**
     * Records a {@code 429} or {@code 418} answer.
     *
     * <p>A {@code 418} body states the exact instant the ban lifts; a {@code 429}
     * carries {@code Retry-After} in seconds. Without either, the budget is
     * treated as spent for the rest of the current window.</p>
     */
    synchronized void recordThrottled(int status, String body, Optional<String> retryAfter) {
        long now = clock.nowMs();
        long until = bannedUntilFromBody(body);
        if (until <= 0) {
            long seconds = retryAfterSeconds(retryAfter);
            until = seconds > 0 ? now + seconds * 1000 : nextWindowStart(now);
        }
        if (until > bannedUntilMs) bannedUntilMs = until;
        usedWeight = weightCap;
        usedWeightAtMs = now;
    }

    /** Instant the current ban lifts, or 0 when not banned. */
    synchronized long bannedUntilMs() {
        return clock.nowMs() < bannedUntilMs ? bannedUntilMs : 0;
    }

    private boolean sameWindow(long now) {
        return usedWeightAtMs > 0 && now - usedWeightAtMs < WINDOW_MS
                && now / WINDOW_MS == usedWeightAtMs / WINDOW_MS;
    }

    private static long nextWindowStart(long now) {
        return (now / WINDOW_MS + 1) * WINDOW_MS + WINDOW_EDGE_BUFFER_MS;
    }

    private void waitUntil(long target, long now) {
        long wait = Math.min(target - now, MAX_THROTTLE_WAIT_MS);
        if (wait <= 0) return;
        try {
            sleeper.sleepMs(wait);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new BinanceClient.RemoteException("Yêu cầu Binance bị gián đoạn", false);
        }
        usedWeight = 0;
        usedWeightAtMs = 0;
    }

    private static long bannedUntilFromBody(String body) {
        if (body == null) return 0;
        Matcher matcher = BANNED_UNTIL.matcher(body.toLowerCase(Locale.ROOT));
        if (!matcher.find()) return 0;
        try {
            return Long.parseLong(matcher.group(1));
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    private static long retryAfterSeconds(Optional<String> retryAfter) {
        if (retryAfter.isEmpty()) return 0;
        try {
            return Math.max(0, Long.parseLong(retryAfter.get().trim()));
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    private String bannedMessage(long leftMs) {
        return "Binance dang chan IP cho " + pool + ", con " + Math.max(1, (leftMs + 999) / 1000)
                + " giay. Khong goi tiep de tranh keo dai lenh cam.";
    }

    @FunctionalInterface
    interface Clock {
        long nowMs();
    }

    @FunctionalInterface
    interface Sleeper {
        void sleepMs(long millis) throws InterruptedException;
    }
}
