package vn.dongtien.trading.analysis;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import vn.dongtien.auth.DocumentStore;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

class TradingHistoryRetentionServiceTest {
    @Test
    void deletesOnlyOldCompletedTradesAndPreservesAllOtherState() throws Exception {
        ObjectMapper mapper = JsonMapper.builder().build();
        MemoryDocumentStore documents = new MemoryDocumentStore();
        documents.put(AutoRetuneService.STATE_KEY, mapper.readTree("""
                {
                  "activeTuning":{"changes":{"risk.slPercent":4.5}},
                  "trades":[
                    {"id":"old","closedAt":"2026-07-01T00:00:00Z","result":{"status":"stopped"}},
                    {"id":"boundary","closedAt":"2026-07-26T00:00:00Z","result":{"status":"target"}},
                    {"id":"bad-date","closedAt":"not-a-date","result":{"status":"expired"}},
                    {"id":"not-closed","closedAt":"2026-06-01T00:00:00Z","result":{"status":"open"}}
                  ]
                }
                """));
        documents.put("data:open-calls", mapper.readTree("{" + "\"BTCUSDT\":{\"status\":\"open\"}" + "}"));
        documents.put("learning:loss:2026-07-01", mapper.readTree("{\"record\":{}}"));

        TradingHistoryRetentionService service = new TradingHistoryRetentionService(documents, mapper, new TradingStateLock());
        TradingHistoryRetentionService.PurgeResult result = service.purgeClosedTradesOlderThan(Instant.parse("2026-07-26T00:00:00Z"));

        assertEquals(1, result.deletedTrades());
        JsonNode state = documents.find(AutoRetuneService.STATE_KEY).orElseThrow();
        assertEquals(3, state.path("trades").size());
        assertEquals("boundary", state.path("trades").get(0).path("id").asText());
        assertEquals("bad-date", state.path("trades").get(1).path("id").asText());
        assertEquals("not-closed", state.path("trades").get(2).path("id").asText());
        assertNotNull(state.path("activeTuning").path("changes").get("risk.slPercent"));
        assertEquals("open", documents.find("data:open-calls").orElseThrow().path("BTCUSDT").path("status").asText());
        assertNotNull(documents.find("learning:loss:2026-07-01").orElse(null));
    }

    private static final class MemoryDocumentStore implements DocumentStore {
        private final Map<String, JsonNode> values = new LinkedHashMap<>();

        @Override public Optional<JsonNode> find(String key) { return Optional.ofNullable(values.get(key)); }

        @Override public List<StoredDocument> findByPrefix(String prefix) {
            List<StoredDocument> result = new ArrayList<>();
            values.forEach((key, value) -> { if (key.startsWith(prefix)) result.add(new StoredDocument(key, value)); });
            return result;
        }

        @Override public void put(String key, JsonNode value) { values.put(key, value); }
        @Override public boolean delete(String key) { return values.remove(key) != null; }
    }
}
