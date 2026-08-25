package vn.dongtien.trading.telegram;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class TelegramCallHistoryParserTest {
    private final TelegramCallHistoryParser parser = new TelegramCallHistoryParser();
    private final ZoneId zone = ZoneId.of("Asia/Ho_Chi_Minh");

    @Test
    void importsRecognisedStopLossUsingTheOriginalCallValues() {
        TelegramCallHistoryParser.ParseResult result = parser.parse(123L, LocalDate.of(2026, 8, 24), zone, List.of(
                message(10, "2026-08-23T12:00:00Z", """
                        🔥 <b>BTC</b> | Khung 4h
                        🚨 KHUYẾN NGHỊ: 🔴 <b>SHORT / BÁN</b>
                        • Entry (Vào lệnh): 100,00
                        • Stoploss (Cắt lỗ): 105,00
                        👉 TP 1: 95,00
                        👉 TP 2: 90,00
                        """),
                message(11, "2026-08-24T04:00:00Z", """
                        🛑 <b>BTC 4h</b> — CHẠM STOPLOSS
                        SHORT từ 100,00 · kết quả -5,00%
                        """)
        ));

        assertThat(result.trades()).hasSize(1);
        TelegramCallHistoryParser.ImportedTrade trade = result.trades().get(0);
        assertThat(trade.id()).isEqualTo("telegram-import:123:11");
        assertThat(trade.symbol()).isEqualTo("BTC");
        assertThat(trade.side()).isEqualTo("short");
        assertThat(trade.status()).isEqualTo("stopped");
        assertThat(trade.entry()).isEqualTo(100);
        assertThat(trade.lastPrice()).isEqualTo(105);
        assertThat(trade.targets()).extracting(TelegramCallHistoryParser.Target::label).containsExactly("TP1", "TP2");
    }

    @Test
    void importsFullTargetOnTheDayButSkipsAnUnmatchedClosure() {
        TelegramCallHistoryParser.ParseResult result = parser.parse(456L, LocalDate.of(2026, 8, 24), zone, List.of(
                message(20, "2026-08-24T01:00:00Z", """
                        🔥 ETH | Khung 1h
                        🚨 KHUYẾN NGHỊ: 🟢 LONG / MUA
                        • Entry (Vào lệnh): 2.000,00
                        • Stoploss (Cắt lỗ): 1.900,00
                        👉 TP 1: 2.100,00
                        """),
                message(21, "2026-08-24T03:00:00Z", "🚀 CẬP NHẬT: ETH HIT TP FULL!"),
                message(22, "2026-08-24T04:00:00Z", "🛑 <b>XRP 1h</b> — CHẠM STOPLOSS")
        ));

        assertThat(result.trades()).hasSize(1);
        assertThat(result.trades().get(0).status()).isEqualTo("target");
        assertThat(result.trades().get(0).lastPrice()).isEqualTo(2100);
        assertThat(result.trades().get(0).hitTps()).containsExactly("TP1");
        assertThat(result.skippedClosures()).isEqualTo(1);
    }

    private static TelegramCallHistoryParser.HistoryMessage message(long id, String at, String text) {
        return new TelegramCallHistoryParser.HistoryMessage(id, Instant.parse(at), text);
    }
}
