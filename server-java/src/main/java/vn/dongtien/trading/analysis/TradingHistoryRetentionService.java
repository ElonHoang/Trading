package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.auth.DocumentStore;
import vn.dongtien.trading.telegram.TelegramHistoryImportService;

import java.time.Instant;
import java.util.Set;

/** Deletes only completed trade records that are older than a configured cutoff. */
@Service
public class TradingHistoryRetentionService {
    private static final Set<String> STATE_KEYS = Set.of(AutoRetuneService.STATE_KEY, TelegramHistoryImportService.STATE_KEY);
    private static final Set<String> CLOSED_STATUSES = Set.of("stopped", "breakeven", "target", "expired", "cancelled");

    private final DocumentStore documents;
    private final ObjectMapper mapper;
    private final TradingStateLock stateLock;

    public TradingHistoryRetentionService(DocumentStore documents, ObjectMapper mapper, TradingStateLock stateLock) {
        this.documents = documents;
        this.mapper = mapper;
        this.stateLock = stateLock;
    }

    /**
     * Removes records strictly before {@code cutoff}.  An unknown/malformed
     * record is retained deliberately, so a bad timestamp can never erase a
     * trade by accident.  Open-call state, settings, models and learning logs
     * are stored under other keys and are not touched.
     */
    public PurgeResult purgeClosedTradesOlderThan(Instant cutoff) {
        if (cutoff == null) throw new IllegalArgumentException("Mốc dọn lịch sử không hợp lệ");
        return stateLock.withLock(() -> purgeLocked(cutoff));
    }

    private PurgeResult purgeLocked(Instant cutoff) {
        int deleted = 0;
        int retained = 0;
        for (String key : STATE_KEYS) {
            JsonNode raw = documents.find(key).orElse(null);
            if (raw == null || !raw.isObject() || !raw.path("trades").isArray()) continue;
            ObjectNode state = ((ObjectNode) raw).deepCopy();
            ArrayNode kept = mapper.createArrayNode();
            int removedFromDocument = 0;
            for (JsonNode trade : state.path("trades")) {
                Instant closedAt = ReviewSupport.instant(trade.get("closedAt"));
                String status = ReviewSupport.text(trade.path("result").get("status"), "");
                if (CLOSED_STATUSES.contains(status) && closedAt != null && closedAt.isBefore(cutoff)) {
                    removedFromDocument++;
                } else {
                    kept.add(trade.deepCopy());
                }
            }
            deleted += removedFromDocument;
            retained += kept.size();
            if (removedFromDocument > 0) {
                state.set("trades", kept);
                state.put("lastHistoryPurgeAt", Instant.now().toString());
                documents.put(key, state);
            }
        }
        return new PurgeResult(deleted, retained, cutoff);
    }

    public record PurgeResult(int deletedTrades, int retainedTrades, Instant cutoff) {}
}
