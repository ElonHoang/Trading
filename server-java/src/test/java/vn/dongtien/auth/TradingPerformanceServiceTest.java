package vn.dongtien.auth;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class TradingPerformanceServiceTest {
    @Test
    void aggregatesClosedTradesByDayAndUsesTheSamePnlRulesAsNode() throws Exception {
        JsonMapper mapper = JsonMapper.builder().build();
        MemoryDocumentStore documents = new MemoryDocumentStore();
        documents.put("config:strategy", mapper.readTree("""
                {"risk":{"partialFraction":0.5},"dailyReview":{"feePercent":0.06,"assumedCapitalPerTradeUsd":200}}
                """));
        documents.put("data:auto-retune", mapper.readTree("""
                {"trades":[
                  {"closedAt":"2026-08-18T03:00:00Z","side":"long","entry":100,
                   "targets":[{"label":"TP1","price":104}],
                   "result":{"status":"target","hitTps":["TP1"],"lastPrice":110}},
                  {"closedAt":"2026-08-17T03:00:00Z","side":"long","entry":100,
                   "targets":[{"label":"TP1","price":104}],
                   "result":{"status":"stopped","hitTps":[],"lastPrice":95}},
                  {"closedAt":"2026-08-16T03:00:00Z","side":"long","entry":100,
                   "targets":[{"label":"TP1","price":104}],
                   "result":{"status":"breakeven","hitTps":["TP1"],"lastPrice":100}},
                  {"closedAt":"2026-08-15T03:00:00Z","side":"short","entry":100,
                   "targets":[],"result":{"status":"expired","hitTps":[]}}
                ]}
                """));

        TradingPerformanceService service = new TradingPerformanceService(
                documents,
                Clock.fixed(Instant.parse("2026-08-18T06:00:00Z"), ZoneOffset.UTC),
                ZoneId.of("Asia/Bangkok")
        );

        TradingPerformanceService.PerformanceResponse response = service.performance("week");

        assertThat(response.sourceAvailable()).isTrue();
        assertThat(response.points()).hasSize(7);
        assertThat(response.summary().totalTrades()).isEqualTo(4);
        assertThat(response.summary().wins()).isEqualTo(2);
        assertThat(response.summary().losses()).isEqualTo(1);
        assertThat(response.summary().breakeven()).isEqualTo(1);
        assertThat(response.summary().expired()).isEqualTo(1);
        assertThat(response.summary().measuredTrades()).isEqualTo(3);
        assertThat(response.summary().winRatePercent()).isEqualTo(66.7);
        assertThat(response.summary().pnlPercent()).isEqualTo(6.82);
        assertThat(response.summary().pnlUsd()).isEqualTo(13.64);
        assertThat(response.summary().averagePnlUsd()).isEqualTo(4.55);
        assertThat(response.points().get(6).label()).isEqualTo("18/08");
        assertThat(response.points().get(6).pnlPercent()).isEqualTo(9.94);
    }

    @Test
    void returnsTwelveZeroFilledMonthsWhenHistoryDocumentDoesNotExist() {
        TradingPerformanceService service = new TradingPerformanceService(
                new MemoryDocumentStore(),
                Clock.fixed(Instant.parse("2026-08-18T06:00:00Z"), ZoneOffset.UTC),
                ZoneId.of("Asia/Bangkok")
        );

        TradingPerformanceService.PerformanceResponse response = service.performance("year");

        assertThat(response.sourceAvailable()).isFalse();
        assertThat(response.granularity()).isEqualTo("month");
        assertThat(response.points()).hasSize(12);
        assertThat(response.points().get(0).key()).isEqualTo("2025-09");
        assertThat(response.points().get(11).key()).isEqualTo("2026-08");
        assertThat(response.summary().totalTrades()).isZero();
        assertThat(response.message()).contains("Database");
    }

    private static final class MemoryDocumentStore implements DocumentStore {
        private final Map<String, JsonNode> values = new HashMap<>();

        @Override
        public Optional<JsonNode> find(String key) {
            return Optional.ofNullable(values.get(key));
        }

        @Override
        public List<StoredDocument> findByPrefix(String prefix) {
            return values.entrySet().stream()
                    .filter(row -> row.getKey().startsWith(prefix))
                    .map(row -> new StoredDocument(row.getKey(), row.getValue()))
                    .toList();
        }

        @Override
        public void put(String key, JsonNode value) {
            values.put(key, value);
        }

        @Override
        public boolean delete(String key) {
            return values.remove(key) != null;
        }
    }
}
