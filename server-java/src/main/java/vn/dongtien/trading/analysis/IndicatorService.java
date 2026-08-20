package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;
import vn.dongtien.trading.market.Candle;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

@Service
public class IndicatorService {
    public Indicators compute(List<Candle> candles, int volumePeriod, int cvdPeriod) {
        List<Double> volumes = candles.stream().map(Candle::volume).toList();
        List<Double> volumeAverage = sma(volumes, volumePeriod);
        List<Double> delta = new ArrayList<>();
        List<Double> cumulative = new ArrayList<>();
        double running = 0;
        boolean seen = false;
        for (Candle candle : candles) {
            if (candle.takerBuyVolume() == null || !Double.isFinite(candle.takerBuyVolume())) {
                delta.add(null);
                cumulative.add(seen ? running : null);
            } else {
                double value = 2 * candle.takerBuyVolume() - candle.volume();
                running += value;
                seen = true;
                delta.add(value);
                cumulative.add(running);
            }
        }
        List<Double> slope = new ArrayList<>();
        for (int i = 0; i < candles.size(); i++) {
            if (i < cvdPeriod || cumulative.get(i) == null || cumulative.get(i - cvdPeriod) == null) {
                slope.add(null);
                continue;
            }
            double volume = 0;
            for (int j = i - cvdPeriod + 1; j <= i; j++) volume += candles.get(j).volume();
            slope.add(volume <= 0 ? null : (cumulative.get(i) - cumulative.get(i - cvdPeriod)) / volume);
        }
        return new Indicators(volumePeriod, cvdPeriod, volumeAverage, delta, cumulative, slope);
    }

    public List<Double> sma(List<Double> values, int period) {
        List<Double> result = new ArrayList<>();
        double sum = 0;
        for (int i = 0; i < values.size(); i++) {
            sum += values.get(i);
            if (i >= period) sum -= values.get(i - period);
            result.add(i >= period - 1 ? sum / period : null);
        }
        return result;
    }

    public SupportResistance supportResistance(List<Candle> candles, int left, int right, double tolerancePct, int maxLevels) {
        List<Level> highs = new ArrayList<>();
        List<Level> lows = new ArrayList<>();
        for (int i = left; i < candles.size() - right; i++) {
            boolean high = true;
            boolean low = true;
            for (int j = i - left; j <= i + right; j++) {
                if (j == i) continue;
                if (candles.get(j).high() >= candles.get(i).high()) high = false;
                if (candles.get(j).low() <= candles.get(i).low()) low = false;
            }
            if (high) highs.add(new Level(candles.get(i).high(), 1, i));
            if (low) lows.add(new Level(candles.get(i).low(), 1, i));
        }
        List<Level> all = new ArrayList<>(cluster(highs, tolerancePct));
        all.addAll(cluster(lows, tolerancePct));
        double price = candles.get(candles.size() - 1).close();
        List<Level> support = all.stream().filter(level -> level.price() < price)
                .sorted(Comparator.comparingDouble(Level::price).reversed()).limit(maxLevels).toList();
        List<Level> resistance = all.stream().filter(level -> level.price() > price)
                .sorted(Comparator.comparingDouble(Level::price)).limit(maxLevels).toList();
        return new SupportResistance(support, resistance);
    }

    private List<Level> cluster(List<Level> points, double tolerancePct) {
        List<Level> sorted = points.stream().sorted(Comparator.comparingDouble(Level::price)).toList();
        List<Level> groups = new ArrayList<>();
        for (Level point : sorted) {
            if (!groups.isEmpty()) {
                Level previous = groups.get(groups.size() - 1);
                if (Math.abs(point.price() - previous.price()) / previous.price() * 100 <= tolerancePct) {
                    int touches = previous.touches() + 1;
                    groups.set(groups.size() - 1, new Level(
                            (previous.price() * previous.touches() + point.price()) / touches,
                            touches, Math.max(previous.lastIndex(), point.lastIndex())));
                    continue;
                }
            }
            groups.add(point);
        }
        return groups;
    }

    public record Indicators(int volumePeriod, int cvdPeriod, List<Double> volumeAverage,
                             List<Double> cvdDelta, List<Double> cvd, List<Double> cvdSlope) {}
    public record Level(double price, int touches, int lastIndex) {}
    public record SupportResistance(List<Level> support, List<Level> resistance) {}
}
