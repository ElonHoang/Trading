package vn.dongtien.auth;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;

class TradingPerformanceServiceTest {
    @TempDir
    Path tempDir;

    @Test
    void aggregatesClosedTradesByDayAndUsesTheSamePnlRulesAsNode() throws Exception {
        Path strategy = tempDir.resolve("strategy.json");
        Files.writeString(strategy, """
                {"risk":{"partialFraction":0.5},"dailyReview":{"feePercent":0.06,"assumedCapitalPerTradeUsd":200}}
                """);
        Path state = tempDir.resolve("auto-retune.json");
        Files.writeString(state, """
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
                """);

        TradingPerformanceService service = new TradingPerformanceService(
                JsonMapper.builder().build(), state, strategy,
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
    void returnsTwelveZeroFilledMonthsWhenHistoryFileDoesNotExist() {
        TradingPerformanceService service = new TradingPerformanceService(
                JsonMapper.builder().build(), tempDir.resolve("missing.json"), tempDir.resolve("missing-strategy.json"),
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
        assertThat(response.message()).contains("auto-retune.json");
    }
}
