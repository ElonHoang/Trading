package vn.dongtien.trading.config;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class TradingUniverseTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final TradingUniverse universe = new TradingUniverse();

    @Test
    void keepsOrderDeduplicatesAndFailsClosed() {
        var strategy = mapper.readTree("{\"alerts\":{\"tradeSymbols\":[\"btc\",\"ETHUSDT\",\"BTC\"]}}");
        assertEquals(List.of("BTCUSDT", "ETHUSDT"), universe.symbols(strategy));
        assertEquals("BTCUSDT", universe.requireAllowed("btc", strategy));
        assertThrows(IllegalArgumentException.class, () -> universe.requireAllowed("SOL", strategy));
        assertThrows(IllegalArgumentException.class, () -> universe.symbols(mapper.readTree("{}")));
    }
}
