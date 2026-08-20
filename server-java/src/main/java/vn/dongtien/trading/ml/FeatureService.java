package vn.dongtien.trading.ml;

import org.springframework.stereotype.Service;
import vn.dongtien.trading.analysis.IndicatorService.Indicators;
import vn.dongtien.trading.market.Candle;

import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

@Service
public class FeatureService {
    public static final int WARMUP = 60;
    public static final List<String> NAMES = List.of(
            "ret1", "ret3", "ret5", "ret10", "ret20", "volZ", "volRatio", "cvdDeltaNorm", "cvdSlope",
            "cvdSlopeChange", "rangePos", "bodyRatio", "upperWick", "lowerWick", "hourOfDay", "dayOfWeek");

    public double[] vector(List<Candle> candles, Indicators indicators, int i) {
        if (i < WARMUP) return null;
        Candle candle = candles.get(i);
        if (candle.close() == 0 || indicators.volumeAverage().get(i) == null || indicators.cvd().get(i) == null
                || indicators.cvdDelta().get(i) == null || indicators.cvdSlope().get(i) == null) return null;
        double mean = 0;
        for (int j = Math.max(0, i - 49); j <= i; j++) mean += candles.get(j).volume();
        int count = Math.min(50, i + 1);
        mean /= count;
        double variance = 0;
        for (int j = Math.max(0, i - 49); j <= i; j++) variance += Math.pow(candles.get(j).volume() - mean, 2);
        double sd = Math.sqrt(variance / count);
        double high = Double.NEGATIVE_INFINITY;
        double low = Double.POSITIVE_INFINITY;
        for (int j = Math.max(0, i - 49); j <= i; j++) {
            high = Math.max(high, candles.get(j).high());
            low = Math.min(low, candles.get(j).low());
        }
        double range = candle.high() - candle.low();
        Double previousSlope = indicators.cvdSlope().get(i - 5);
        var date = Instant.ofEpochMilli(candle.openTime()).atZone(ZoneOffset.UTC);
        return finite(new double[]{
                ret(candles, i, 1), ret(candles, i, 3), ret(candles, i, 5), ret(candles, i, 10), ret(candles, i, 20),
                div(candle.volume() - mean, sd), div(candle.volume(), indicators.volumeAverage().get(i)),
                clamp(div(indicators.cvdDelta().get(i), candle.volume()), -1, 1),
                clamp(indicators.cvdSlope().get(i), -1, 1),
                clamp(previousSlope == null ? 0 : indicators.cvdSlope().get(i) - previousSlope, -2, 2),
                high > low ? (candle.close() - low) / (high - low) : .5,
                div(candle.close() - candle.open(), range), div(candle.high() - Math.max(candle.open(), candle.close()), range),
                div(Math.min(candle.open(), candle.close()) - candle.low(), range), date.getHour() / 24d,
                date.getDayOfWeek().getValue() % 7 / 7d
        });
    }

    private static double ret(List<Candle> candles, int i, int n) {
        double prior = candles.get(i - n).close();
        return div(candles.get(i).close() - prior, prior) * 100;
    }
    private static double div(double a, Double b) { return b == null || b == 0 || !Double.isFinite(b) ? 0 : a / b; }
    private static double clamp(double value, double low, double high) { return Math.max(low, Math.min(high, value)); }
    private static double[] finite(double[] values) {
        for (int i = 0; i < values.length; i++) if (!Double.isFinite(values[i])) values[i] = 0;
        return values;
    }
}
