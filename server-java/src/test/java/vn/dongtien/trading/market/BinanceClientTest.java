package vn.dongtien.trading.market;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class BinanceClientTest {
    @Test
    void normalizesTokenAndPairInputsWithoutBreakingWrappedTokens() {
        assertEquals("BTCUSDT", BinanceClient.normalizeSymbol("btc"));
        assertEquals("ETHUSDT", BinanceClient.normalizeSymbol("eth/usdt"));
        assertEquals("ETHBTC", BinanceClient.normalizeSymbol("eth-btc"));
        assertEquals("WBTCUSDT", BinanceClient.normalizeSymbol("wbtc"));
        assertThrows(IllegalArgumentException.class, () -> BinanceClient.normalizeSymbol("  "));
    }
}
