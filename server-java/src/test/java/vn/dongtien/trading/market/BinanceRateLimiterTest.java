package vn.dongtien.trading.market;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

class BinanceRateLimiterTest {
    /** Controllable clock and sleep log, so the tests never actually wait. */
    private static final class Fake implements BinanceRateLimiter.Clock, BinanceRateLimiter.Sleeper {
        private long now = 1_700_000_000_000L;
        private final List<Long> slept = new ArrayList<>();

        @Override public long nowMs() { return now; }

        @Override public void sleepMs(long millis) {
            slept.add(millis);
            now += millis;
        }
    }

    private static BinanceRateLimiter limiter(Fake fake) {
        return new BinanceRateLimiter("spot", BinanceRateLimiter.SPOT_WEIGHT_CAP, fake, fake);
    }

    @Test
    void refusesToSendWhileBinanceSaysTheAddressIsBanned() {
        Fake fake = new Fake();
        BinanceRateLimiter limiter = limiter(fake);
        String body = "{\"code\":-1003,\"msg\":\"Way too much request weight used; IP banned until "
                + (fake.now + 120_000) + ". Please use WebSocket Streams\"}";

        limiter.recordThrottled(418, body, Optional.empty());

        assertThat(limiter.bannedUntilMs()).isEqualTo(fake.now + 120_000);
        assertThatThrownBy(limiter::beforeRequest)
                .isInstanceOf(BinanceClient.RemoteException.class)
                .hasMessageContaining("120 giay");
        // Nothing was sent and nothing was slept off: the caller fails fast instead.
        assertThat(fake.slept).isEmpty();
    }

    @Test
    void allowsRequestsAgainOnceTheBanHasElapsed() {
        Fake fake = new Fake();
        BinanceRateLimiter limiter = limiter(fake);
        limiter.recordThrottled(418, "IP banned until " + (fake.now + 60_000) + ".", Optional.empty());

        fake.now += 60_001;

        assertThat(limiter.bannedUntilMs()).isZero();
        assertDoesNotThrow(limiter::beforeRequest);
    }

    @Test
    void honoursRetryAfterWhenThrottledWithoutABanTimestamp() {
        Fake fake = new Fake();
        BinanceRateLimiter limiter = limiter(fake);

        limiter.recordThrottled(429, "{\"code\":-1003,\"msg\":\"Too many requests\"}", Optional.of("30"));

        assertThat(limiter.bannedUntilMs()).isEqualTo(fake.now + 30_000);
    }

    @Test
    void waitsForTheNextWindowOnceTheSoftLimitIsReached() {
        Fake fake = new Fake();
        BinanceRateLimiter limiter = limiter(fake);
        limiter.recordUsedWeight(Optional.of("5200")); // above 80% of 6000

        limiter.beforeRequest();

        assertThat(fake.slept).hasSize(1);
        // Slept into the next wall-clock minute rather than for a fixed guess.
        assertThat(fake.now % 60_000).isLessThan(1_000);
        assertDoesNotThrow(limiter::beforeRequest);
    }

    @Test
    void staysOutOfTheWayWhileTheBudgetIsHealthy() {
        Fake fake = new Fake();
        BinanceRateLimiter limiter = limiter(fake);

        limiter.recordUsedWeight(Optional.of("120"));
        limiter.beforeRequest();
        limiter.recordUsedWeight(Optional.of("240"));
        limiter.beforeRequest();

        assertThat(fake.slept).isEmpty();
    }

    @Test
    void ignoresAMalformedWeightHeaderInsteadOfFailingTheRequest() {
        Fake fake = new Fake();
        BinanceRateLimiter limiter = limiter(fake);

        limiter.recordUsedWeight(Optional.of("not-a-number"));
        limiter.recordUsedWeight(Optional.empty());

        assertDoesNotThrow(limiter::beforeRequest);
        assertThat(fake.slept).isEmpty();
    }

    @Test
    void treatsTheBudgetAsSpentWhenThrottledWithNoHintAtAll() {
        Fake fake = new Fake();
        BinanceRateLimiter limiter = limiter(fake);

        limiter.recordThrottled(429, "", Optional.empty());

        // Falls back to the end of the current minute rather than retrying immediately.
        assertThat(limiter.bannedUntilMs()).isGreaterThan(fake.now);
        assertThat(limiter.bannedUntilMs()).isLessThanOrEqualTo(fake.now + 61_000);
    }

    @Test
    void keepsTheLongerDeadlineWhenTwoThrottleAnswersOverlap() {
        Fake fake = new Fake();
        BinanceRateLimiter limiter = limiter(fake);

        limiter.recordThrottled(418, "IP banned until " + (fake.now + 300_000) + ".", Optional.empty());
        limiter.recordThrottled(429, "Too many requests", Optional.of("5"));

        assertThat(limiter.bannedUntilMs()).isEqualTo(fake.now + 300_000);
    }
}
