package vn.dongtien.trading.analysis;

import org.junit.jupiter.api.Test;
import vn.dongtien.trading.market.Candle;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class IndicatorServiceTest {
    private final IndicatorService service = new IndicatorService();

    @Test
    void computesSmaAndCvdFromTakerBuyVolume() {
        List<Candle> candles = List.of(candle(0, 10, 7d), candle(1, 20, 8d), candle(2, 30, 20d));
        var result = service.compute(candles, 2, 1);
        assertNull(result.volumeAverage().get(0));
        assertEquals(15, result.volumeAverage().get(1));
        assertEquals(4, result.cvdDelta().get(0));
        assertEquals(-4, result.cvdDelta().get(1));
        assertEquals(10d / 30d, result.cvdSlope().get(2), 1e-12);
    }

    private static Candle candle(long time, double volume, Double takerBuy) {
        return new Candle(time, 1, 2, .5, 1.5, volume, time + 1, volume, 1, takerBuy, true, "spot");
    }
}
