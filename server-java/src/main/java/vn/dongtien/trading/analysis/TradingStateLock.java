package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;

import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * Serializes read-modify-write operations on the shared auto-retune document.
 *
 * <p>The Telegram monitor and the daily learning job run in the same bot
 * worker.  They must not overwrite one another's update to
 * {@code data:auto-retune}.  This lock deliberately protects only that shared
 * state; model training continues outside it so monitoring is not delayed.</p>
 */
@Service
public class TradingStateLock {
    private final ReentrantLock lock = new ReentrantLock();

    public <T> T withLock(Supplier<T> action) {
        lock.lock();
        try {
            return action.get();
        } finally {
            lock.unlock();
        }
    }

    public void runLocked(Runnable action) {
        lock.lock();
        try {
            action.run();
        } finally {
            lock.unlock();
        }
    }
}
