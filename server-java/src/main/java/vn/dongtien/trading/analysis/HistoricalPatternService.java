package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import vn.dongtien.trading.market.Candle;

import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class HistoricalPatternService {
    public Map<String, Object> analyze(List<Candle> candles, JsonNode config) {
        if (!config.path("enabled").asBoolean(true)) return unavailable("So khớp mẫu hình lịch sử đang tắt");
        int lookback = Math.max(8, config.path("lookbackBars").asInt(24));
        int future = Math.max(1, config.path("futureBars").asInt(12));
        int topCount = Math.max(1, Math.min(10, config.path("topMatches").asInt(5)));
        int minimum = Math.max(1, Math.min(topCount, config.path("minMatches").asInt(3)));
        int step = Math.max(1, config.path("candidateStepBars").asInt(3));
        int currentStart = candles.size() - lookback;
        if (currentStart < lookback + future) return unavailable("Chưa đủ nến để so mẫu lịch sử");
        double minCorrelation = config.path("minPathCorrelation").asDouble(.85);
        double minAmplitude = config.path("minAmplitudeSimilarity").asDouble(.7);
        double maxError = config.path("maxRelativePathError").asDouble(.2);
        double maxP95 = config.path("maxRelativePathP95Error").asDouble(.45);
        double tolerance = config.path("relativePathTolerance").asDouble(.25);
        double minCoverage = config.path("minBarsWithinRelativeTolerance").asDouble(.75);
        double minSimilarity = config.path("minSimilarity").asDouble(.82);
        double currentRange = range(candles, currentStart, lookback);
        List<Match> candidates = new ArrayList<>();
        int compared = 0;
        for (int end = lookback - 1; end + future < currentStart; end += step) {
            int start = end - lookback + 1; compared++;
            Metrics metrics = compare(candles, start, currentStart, lookback, tolerance);
            if (metrics == null) continue;
            double correlation = correlation(candles, start, currentStart, lookback);
            double pastRange = range(candles, start, lookback);
            double amplitude = Math.min(pastRange, currentRange) / Math.max(pastRange, currentRange);
            double similarity = clamp(((correlation + 1) / 2 * .7) + amplitude * .3);
            if (correlation < minCorrelation || amplitude < minAmplitude || metrics.average() > maxError
                    || metrics.p95() > maxP95 || metrics.coverage() < minCoverage || similarity < minSimilarity) continue;
            double forward = (candles.get(end + future).close() / candles.get(end).close() - 1) * 100;
            candidates.add(new Match(end, similarity, correlation, amplitude, metrics, forward));
        }
        candidates.sort(Comparator.comparingDouble(Match::similarity).reversed());
        List<Match> matches = new ArrayList<>();
        int separation = Math.max(lookback + future, step);
        for (Match candidate : candidates) {
            if (matches.stream().allMatch(match -> Math.abs(match.end() - candidate.end()) >= separation)) matches.add(candidate);
            if (matches.size() == topCount) break;
        }
        if (matches.size() < minimum) {
            Map<String, Object> value = unavailable("Chỉ tìm thấy " + matches.size() + "/" + minimum + " mẫu đủ giống - không cộng điểm");
            value.put("matched", matches.size()); value.put("compared", compared); return value;
        }
        double totalWeight = matches.stream().mapToDouble(Match::similarity).sum();
        double averageForward = matches.stream().mapToDouble(match -> match.forward() * match.similarity()).sum() / totalWeight;
        String side = averageForward > 0 ? "long" : averageForward < 0 ? "short" : "none";
        long agreeing = matches.stream().filter(match -> side.equals("long") ? match.forward() > 0 : match.forward() < 0).count();
        double agreement = agreeing / (double) matches.size();
        double minAgreement = config.path("minDirectionalAgreement").asDouble(.6);
        double minMove = config.path("minForwardMovePct").asDouble(.75);
        if (side.equals("none") || agreement < minAgreement || Math.abs(averageForward) < minMove) {
            Map<String, Object> value = unavailable("Các mẫu giống không đủ đồng thuận - không cộng điểm");
            value.put("matched", matches.size()); value.put("agreementPercent", agreement * 100); return value;
        }
        double averageSimilarity = matches.stream().mapToDouble(Match::similarity).average().orElse(0);
        double strength = clamp(averageSimilarity * agreement * clamp(Math.abs(averageForward) / minMove)
                * matches.size() / topCount);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("available", true); result.put("score", side.equals("long") ? strength : -strength); result.put("side", side);
        result.put("matched", matches.size()); result.put("compared", compared); result.put("avgSimilarity", averageSimilarity * 100);
        result.put("avgForwardReturnPct", averageForward); result.put("agreementPercent", agreement * 100);
        result.put("reasons", List.of(matches.size() + " mẫu OHLC tương tự", agreeing + "/" + matches.size() + " mẫu cùng hướng"));
        result.put("matches", matches.stream().map(match -> Map.of(
                "at", Instant.ofEpochMilli(candles.get(match.end()).openTime()).atZone(ZoneOffset.UTC).toInstant().toString(),
                "similarity", match.similarity() * 100, "correlation", match.correlation(),
                "amplitudeSimilarity", match.amplitude() * 100, "relativePathError", match.metrics().average() * 100,
                "p95RelativePathError", match.metrics().p95() * 100,
                "barsWithinRelativeTolerancePercent", match.metrics().coverage() * 100,
                "forwardReturnPct", match.forward())).toList());
        return result;
    }

    private static Metrics compare(List<Candle> candles, int first, int second, int bars, double tolerance) {
        double aBase = candles.get(first).close(), bBase = candles.get(second).close();
        if (aBase <= 0 || bBase <= 0) return null;
        List<Double> a = new ArrayList<>(), b = new ArrayList<>(), barErrors = new ArrayList<>();
        for (int i = 0; i < bars; i++) {
            Candle left = candles.get(first + i), right = candles.get(second + i);
            double[] lv = {left.open(), left.high(), left.low(), left.close()};
            double[] rv = {right.open(), right.high(), right.low(), right.close()};
            double error = 0;
            for (int j = 0; j < 4; j++) {
                if (lv[j] <= 0 || rv[j] <= 0) return null;
                double av = Math.log(lv[j] / aBase), bv = Math.log(rv[j] / bBase);
                a.add(av); b.add(bv); error += Math.abs(av - bv);
            }
            barErrors.add(error / 4);
        }
        double scale = Math.max(a.stream().mapToDouble(Double::doubleValue).max().orElse(0) - a.stream().mapToDouble(Double::doubleValue).min().orElse(0),
                b.stream().mapToDouble(Double::doubleValue).max().orElse(0) - b.stream().mapToDouble(Double::doubleValue).min().orElse(0));
        if (scale <= 1e-8) return null;
        List<Double> normalized = barErrors.stream().map(value -> value / scale).sorted().toList();
        double average = normalized.stream().mapToDouble(Double::doubleValue).average().orElse(1);
        double p95 = normalized.get(Math.min(normalized.size() - 1, (int) Math.floor(.95 * (normalized.size() - 1))));
        double coverage = normalized.stream().filter(value -> value <= tolerance).count() / (double) normalized.size();
        return new Metrics(average, p95, coverage);
    }
    private static double correlation(List<Candle> candles, int first, int second, int bars) {
        double aBase = candles.get(first).close(), bBase = candles.get(second).close();
        double aMean = 0, bMean = 0;
        for (int i = 0; i < bars; i++) { aMean += Math.log(candles.get(first + i).close() / aBase); bMean += Math.log(candles.get(second + i).close() / bBase); }
        aMean /= bars; bMean /= bars;
        double covariance = 0, aVariance = 0, bVariance = 0;
        for (int i = 0; i < bars; i++) {
            double av = Math.log(candles.get(first + i).close() / aBase) - aMean;
            double bv = Math.log(candles.get(second + i).close() / bBase) - bMean;
            covariance += av * bv; aVariance += av * av; bVariance += bv * bv;
        }
        return aVariance == 0 || bVariance == 0 ? 0 : covariance / Math.sqrt(aVariance * bVariance);
    }
    private static double range(List<Candle> candles, int start, int bars) {
        double high = Double.NEGATIVE_INFINITY, low = Double.POSITIVE_INFINITY;
        for (int i = start; i < start + bars; i++) { high = Math.max(high, candles.get(i).high()); low = Math.min(low, candles.get(i).low()); }
        return candles.get(start).close() <= 0 ? 0 : (high - low) / candles.get(start).close();
    }
    private static Map<String, Object> unavailable(String reason) {
        Map<String, Object> result = new LinkedHashMap<>(); result.put("available", false); result.put("score", 0);
        result.put("side", "none"); result.put("reasons", List.of(reason)); return result;
    }
    private static double clamp(double value) { return Math.max(0, Math.min(1, value)); }
    private record Metrics(double average, double p95, double coverage) {}
    private record Match(int end, double similarity, double correlation, double amplitude, Metrics metrics, double forward) {}
}
