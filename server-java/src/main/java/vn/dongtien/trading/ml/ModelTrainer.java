package vn.dongtien.trading.ml;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.trading.analysis.IndicatorService;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.market.Candle;
import vn.dongtien.trading.model.ModelStore;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Java implementation of the browser/Node model training workflow.  The tree
 * format intentionally remains compatible with models written by the former
 * JavaScript trainer and consumed by {@link GbdtPredictor}.
 */
@Service
public class ModelTrainer {
    private final BinanceClient binance;
    private final IndicatorService indicators;
    private final FeatureService features;
    private final ModelStore models;
    private final ObjectMapper mapper;

    public ModelTrainer(BinanceClient binance, IndicatorService indicators, FeatureService features,
                        ModelStore models, ObjectMapper mapper) {
        this.binance = binance;
        this.indicators = indicators;
        this.features = features;
        this.models = models;
        this.mapper = mapper;
    }

    public JsonNode train(String symbol, String interval, JsonNode strategy) {
        ObjectNode payload = trainCandidate(symbol, interval, strategy);
        models.save(symbol, interval, payload);
        return payload;
    }

    /**
     * Trains a fresh market model without replacing a reliable active model
     * unless the candidate is at least as good on holdout quality metrics.
     */
    public PromotionResult trainIfReliable(String symbol, String interval, JsonNode strategy) {
        ObjectNode candidate = trainCandidate(symbol, interval, strategy);
        JsonNode current = models.load(symbol, interval);
        double minimumAuc = clamp(strategy.path("ml").path("minTestAuc").asDouble(.52), .5, .99);
        double candidateAuc = metric(candidate, "test", "auc");
        double currentAuc = metric(current, "test", "auc");
        boolean candidateReliable = reliable(candidate, minimumAuc);
        boolean currentReliable = reliable(current, minimumAuc);
        boolean accepted = candidateReliable && (!currentReliable || candidateAuc >= currentAuc);
        if (accepted) models.save(symbol, interval, candidate);
        String status = accepted ? "promoted" : candidateReliable ? "kept-current-model" : "rejected-quality";
        return new PromotionResult(symbol, interval, status, accepted,
                finiteOrNull(candidateAuc), finiteOrNull(metric(candidate, "walkForward", "meanAuc")),
                finiteOrNull(currentAuc), current == null ? null : current.path("trainedAt").asText(null), null);
    }

    private ObjectNode trainCandidate(String symbol, String interval, JsonNode strategy) {
        if (!BinanceClient.INTERVAL_MS.containsKey(interval)) {
            throw new IllegalArgumentException("Khung thời gian không hợp lệ: " + interval);
        }
        JsonNode ml = strategy.path("ml");
        int candleCount = Math.min(20_000, Math.max(600, ml.path("trainCandles").asInt(16_000)));
        int horizon = Math.max(1, ml.path("horizon").asInt(24));
        double threshold = Math.max(.01, ml.path("thresholdPct").asDouble(1.5));
        String thresholdMode = ml.path("thresholdMode").asText("triple-barrier");
        List<Candle> candles = binance.fetchKlinesHistory(symbol, interval, candleCount).stream().filter(Candle::closed).toList();
        if (candles.size() < 600) {
            throw new IllegalStateException("Chỉ tải được " + candles.size() + " nến — cần tối thiểu 600 nến để train.");
        }
        var ind = indicators.compute(candles, strategy.path("indicators").path("volumeAvg").asInt(20),
                strategy.path("indicators").path("cvdSlope").asInt(20));
        List<double[]> x = new ArrayList<>();
        List<Integer> y = new ArrayList<>();
        int skippedNeutral = 0;
        int skippedAmbiguous = 0;
        for (int i = FeatureService.WARMUP; i < candles.size() - horizon; i++) {
            double[] vector = features.vector(candles, ind, i);
            if (vector == null) continue;
            int label = label(candles, i, horizon, threshold, thresholdMode);
            if (label == -2) { skippedNeutral++; continue; }
            if (label == -1) { skippedAmbiguous++; continue; }
            x.add(vector);
            y.add(label);
        }
        if (x.size() < 300) {
            throw new IllegalStateException("Chỉ có " + x.size() + " mẫu sau khi gán nhãn — cần tối thiểu 300.");
        }
        int split = Math.max(1, Math.min(x.size() - 1, (int) (x.size() * ml.path("trainRatio").asDouble(.75))));
        List<double[]> trainX = x.subList(0, split);
        List<Integer> trainY = y.subList(0, split);
        List<double[]> testX = x.subList(split, x.size());
        List<Integer> testY = y.subList(split, y.size());
        int treeCount = Math.max(1, Math.min(400, ml.path("nTrees").asInt(400)));
        double learningRate = clamp(ml.path("learningRate").asDouble(.05), .001, 1);

        ObjectNode evaluationModel = fitStumps(trainX, trainY, treeCount, learningRate);
        GbdtPredictor predictor = new GbdtPredictor();
        List<Double> trainProbabilities = probabilities(predictor, evaluationModel, trainX);
        List<Double> testProbabilities = probabilities(predictor, evaluationModel, testX);
        // Production model uses all observed historical labels, while all reported
        // quality metrics remain strictly holdout/walk-forward metrics.
        ObjectNode model = fitStumps(x, y, Math.max(1, evaluationModel.path("trees").size()), learningRate);

        ObjectNode payload = mapper.createObjectNode();
        payload.put("symbol", symbol);
        payload.put("interval", interval);
        payload.put("trainedAt", Instant.now().toString());
        payload.set("model", model);
        ObjectNode range = payload.putObject("candleRange");
        range.put("from", Instant.ofEpochMilli(candles.get(0).openTime()).toString());
        range.put("to", Instant.ofEpochMilli(candles.get(candles.size() - 1).openTime()).toString());
        range.put("count", candles.size());
        ObjectNode dataset = payload.putObject("dataset");
        dataset.put("samples", x.size());
        dataset.put("skippedNeutral", skippedNeutral);
        dataset.put("skippedAmbiguous", skippedAmbiguous);
        dataset.put("positiveRate", y.stream().mapToInt(Integer::intValue).average().orElse(0));
        dataset.put("horizon", horizon);
        dataset.put("thresholdMode", thresholdMode);
        dataset.put("thresholdPct", threshold);
        ArrayNode featureNames = dataset.putArray("featureNames");
        for (String name : FeatureService.NAMES) featureNames.add(name);
        ObjectNode params = payload.putObject("hyperParams");
        params.put("nTrees", treeCount);
        params.put("maxDepth", 1);
        params.put("learningRate", learningRate);
        params.put("lambda", ml.path("lambda").asDouble(3));
        params.put("minChildWeight", ml.path("minChildWeight").asInt(15));

        ObjectNode metrics = payload.putObject("metrics");
        metrics.set("train", metric(trainY, trainProbabilities));
        metrics.set("test", metric(testY, testProbabilities));
        metrics.set("tail", tail(testY, testProbabilities));
        metrics.set("walkForward", walkForward(x, y, treeCount, learningRate, predictor));
        ObjectNode stopping = metrics.putObject("earlyStopping");
        stopping.put("metric", "auc");
        stopping.put("treesKept", evaluationModel.path("trees").size());
        stopping.put("maxTrees", treeCount);
        payload.set("calibration", calibration(testProbabilities));
        payload.set("importance", importance(model));
        return payload;
    }

    private static double metric(JsonNode model, String group, String field) {
        if (model == null) return Double.NaN;
        return model.path("metrics").path(group).path(field).asDouble(Double.NaN);
    }

    private static boolean reliable(JsonNode model, double minimumAuc) {
        double auc = metric(model, "test", "auc");
        double walkForward = metric(model, "walkForward", "meanAuc");
        return Double.isFinite(auc) && auc >= minimumAuc
                && (!Double.isFinite(walkForward) || walkForward >= minimumAuc - .02);
    }

    private static Double finiteOrNull(double value) { return Double.isFinite(value) ? value : null; }

    /** -2 neutral/no barrier, -1 ambiguous barrier, 0 down, 1 up. */
    private static int label(List<Candle> candles, int index, int horizon, double threshold, String mode) {
        Candle entry = candles.get(index);
        if (!"triple-barrier".equals(mode)) {
            double change = (candles.get(index + horizon).close() / entry.close() - 1) * 100;
            return Math.abs(change) < threshold ? -2 : change > 0 ? 1 : 0;
        }
        double distance = entry.close() * threshold / 100;
        double upper = entry.close() + distance;
        double lower = entry.close() - distance;
        for (int j = index + 1; j <= index + horizon; j++) {
            Candle candle = candles.get(j);
            boolean up = candle.high() >= upper;
            boolean down = candle.low() <= lower;
            if (up && down) return -1;
            if (up) return 1;
            if (down) return 0;
        }
        return -2;
    }

    private ObjectNode metric(List<Integer> labels, List<Double> probabilities) {
        ObjectNode result = mapper.createObjectNode();
        if (labels.isEmpty()) return result;
        double correct = 0;
        double loss = 0;
        int confident = 0;
        int confidentCorrect = 0;
        for (int i = 0; i < labels.size(); i++) {
            double probability = clamp(probabilities.get(i), 1e-9, 1 - 1e-9);
            int predicted = probability >= .5 ? 1 : 0;
            if (predicted == labels.get(i)) correct++;
            loss += labels.get(i) == 1 ? -Math.log(probability) : -Math.log(1 - probability);
            if (Math.abs(probability - .5) >= .12) {
                confident++;
                if (predicted == labels.get(i)) confidentCorrect++;
            }
        }
        result.put("samples", labels.size());
        result.put("positiveRate", labels.stream().mapToInt(Integer::intValue).average().orElse(0));
        result.put("accuracy", round(correct / labels.size(), 4));
        result.put("auc", round(auc(labels, probabilities), 4));
        result.put("logLoss", round(loss / labels.size(), 4));
        if (confident > 0) result.put("confidentAccuracy", round(confidentCorrect / (double) confident, 4));
        else result.putNull("confidentAccuracy");
        result.put("confidentCoverage", round(confident / (double) labels.size(), 4));
        result.put("confidentSamples", confident);
        return result;
    }

    private ObjectNode tail(List<Integer> labels, List<Double> probabilities) {
        ObjectNode result = mapper.createObjectNode();
        if (labels.isEmpty()) return result;
        double p20 = percentile(probabilities, .2);
        double p80 = percentile(probabilities, .8);
        int up = 0, down = 0, upCorrect = 0, downCorrect = 0;
        for (int i = 0; i < labels.size(); i++) {
            if (probabilities.get(i) >= p80) { up++; if (labels.get(i) == 1) upCorrect++; }
            else if (probabilities.get(i) <= p20) { down++; if (labels.get(i) == 0) downCorrect++; }
        }
        int total = up + down;
        result.put("bullishSignals", up);
        if (up > 0) result.put("bullishAccuracy", round(upCorrect / (double) up, 4)); else result.putNull("bullishAccuracy");
        result.put("bearishSignals", down);
        if (down > 0) result.put("bearishAccuracy", round(downCorrect / (double) down, 4)); else result.putNull("bearishAccuracy");
        if (total > 0) result.put("combinedAccuracy", round((upCorrect + downCorrect) / (double) total, 4)); else result.putNull("combinedAccuracy");
        result.put("coverage", round(total / (double) labels.size(), 4));
        return result;
    }

    private ObjectNode walkForward(List<double[]> x, List<Integer> y, int trees, double rate, GbdtPredictor predictor) {
        ObjectNode result = mapper.createObjectNode();
        ArrayNode folds = result.putArray("folds");
        int firstTrain = (int) (x.size() * .4);
        int step = Math.max(1, (x.size() - firstTrain) / 4);
        double sum = 0;
        int count = 0;
        for (int fold = 0; fold < 4; fold++) {
            int trainEnd = firstTrain + fold * step;
            int testEnd = fold == 3 ? x.size() : Math.min(x.size(), trainEnd + step);
            if (trainEnd < 60 || testEnd - trainEnd < 20) continue;
            ObjectNode model = fitStumps(x.subList(0, trainEnd), y.subList(0, trainEnd), trees, rate);
            ObjectNode metrics = metric(y.subList(trainEnd, testEnd), probabilities(predictor, model, x.subList(trainEnd, testEnd)));
            ObjectNode item = folds.addObject();
            item.put("fold", fold + 1);
            item.put("trainSamples", trainEnd);
            item.put("trees", model.path("trees").size());
            metrics.properties().forEach(entry -> item.set(entry.getKey(), entry.getValue()));
            if (metrics.has("auc")) { sum += metrics.path("auc").asDouble(); count++; }
        }
        if (count > 0) result.put("meanAuc", round(sum / count, 4)); else result.putNull("meanAuc");
        return result;
    }

    private ObjectNode calibration(List<Double> probabilities) {
        ObjectNode result = mapper.createObjectNode();
        if (probabilities.isEmpty()) return result;
        double mean = probabilities.stream().mapToDouble(Double::doubleValue).average().orElse(0);
        double variance = probabilities.stream().mapToDouble(value -> Math.pow(value - mean, 2)).average().orElse(0);
        result.put("n", probabilities.size());
        result.put("p05", round(percentile(probabilities, .05), 5));
        result.put("p20", round(percentile(probabilities, .2), 5));
        result.put("p50", round(percentile(probabilities, .5), 5));
        result.put("p80", round(percentile(probabilities, .8), 5));
        result.put("p95", round(percentile(probabilities, .95), 5));
        result.put("mean", round(mean, 5));
        result.put("std", round(Math.sqrt(variance), 5));
        return result;
    }

    private ArrayNode importance(JsonNode model) {
        int[] counts = new int[Math.max(FeatureService.NAMES.size(), model.path("nFeatures").asInt())];
        for (JsonNode tree : model.path("trees")) count(tree, counts);
        int total = 0;
        for (int count : counts) total += count;
        ArrayNode result = mapper.createArrayNode();
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < counts.length; i++) order.add(i);
        order.sort((left, right) -> Integer.compare(counts[right], counts[left]));
        for (int index : order) {
            ObjectNode item = result.addObject();
            item.put("feature", index < FeatureService.NAMES.size() ? FeatureService.NAMES.get(index) : "f" + index);
            item.put("count", counts[index]);
            item.put("pct", round(total == 0 ? 0 : counts[index] * 100d / total, 2));
        }
        return result;
    }

    private static void count(JsonNode node, int[] counts) {
        if (node == null || node.has("v")) return;
        int feature = node.path("f").asInt(-1);
        if (feature >= 0 && feature < counts.length) counts[feature]++;
        count(node.path("L"), counts);
        count(node.path("R"), counts);
    }

    private ObjectNode fitStumps(List<double[]> x, List<Integer> y, int treeCount, double learningRate) {
        double positiveRate = y.stream().mapToInt(Integer::intValue).average().orElse(.5);
        positiveRate = clamp(positiveRate, 1e-6, 1 - 1e-6);
        double base = Math.log(positiveRate / (1 - positiveRate));
        double[] scores = new double[x.size()];
        java.util.Arrays.fill(scores, base);
        ObjectNode model = mapper.createObjectNode();
        model.put("type", "gbdt");
        model.put("base", base);
        model.put("learningRate", learningRate);
        model.put("nFeatures", x.get(0).length);
        ArrayNode trees = model.putArray("trees");
        for (int round = 0; round < treeCount; round++) {
            Split best = null;
            for (int feature = 0; feature < x.get(0).length; feature++) {
                final int selected = feature;
                List<Double> sorted = x.stream().map(row -> row[selected]).sorted().toList();
                for (int quantile : new int[]{20, 35, 50, 65, 80}) {
                    double threshold = sorted.get(Math.min(sorted.size() - 1, sorted.size() * quantile / 100));
                    Split candidate = evaluate(x, y, scores, feature, threshold);
                    if (best == null || candidate.loss() < best.loss()) best = candidate;
                }
            }
            if (best == null || !Double.isFinite(best.loss())) break;
            ObjectNode tree = trees.addObject();
            tree.put("f", best.feature());
            tree.put("thr", best.threshold());
            tree.putObject("L").put("v", best.left());
            tree.putObject("R").put("v", best.right());
            for (int i = 0; i < x.size(); i++) {
                scores[i] += learningRate * (x.get(i)[best.feature()] <= best.threshold() ? best.left() : best.right());
            }
        }
        return model;
    }

    private static Split evaluate(List<double[]> x, List<Integer> y, double[] scores, int feature, double threshold) {
        double left = 0;
        double right = 0;
        int leftCount = 0;
        int rightCount = 0;
        for (int i = 0; i < x.size(); i++) {
            double residual = y.get(i) - sigmoid(scores[i]);
            if (x.get(i)[feature] <= threshold) { left += residual; leftCount++; }
            else { right += residual; rightCount++; }
        }
        if (leftCount < 10 || rightCount < 10) return new Split(feature, threshold, 0, 0, Double.POSITIVE_INFINITY);
        left /= leftCount;
        right /= rightCount;
        double loss = 0;
        for (int i = 0; i < x.size(); i++) {
            double prediction = x.get(i)[feature] <= threshold ? left : right;
            double residual = y.get(i) - sigmoid(scores[i]);
            loss += Math.pow(residual - prediction, 2);
        }
        return new Split(feature, threshold, left, right, loss);
    }

    private static List<Double> probabilities(GbdtPredictor predictor, JsonNode model, List<double[]> rows) {
        List<Double> result = new ArrayList<>();
        for (double[] row : rows) result.add(predictor.predict(model, row));
        return result;
    }

    private static double auc(List<Integer> labels, List<Double> probabilities) {
        if (labels.isEmpty()) return .5;
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < labels.size(); i++) order.add(i);
        order.sort(Comparator.comparingDouble(probabilities::get));
        double positiveRanks = 0;
        int positives = 0;
        int negatives = 0;
        for (int rank = 0; rank < order.size(); rank++) {
            if (labels.get(order.get(rank)) == 1) { positives++; positiveRanks += rank + 1; }
            else negatives++;
        }
        return positives == 0 || negatives == 0 ? .5
                : (positiveRanks - positives * (positives + 1) / 2d) / (positives * negatives);
    }

    private static double percentile(List<Double> values, double probability) {
        if (values.isEmpty()) return 0;
        List<Double> sorted = values.stream().sorted().toList();
        return sorted.get(Math.max(0, Math.min(sorted.size() - 1, (int) Math.floor(probability * (sorted.size() - 1)))));
    }

    private static double sigmoid(double value) { return 1 / (1 + Math.exp(-clamp(value, -30, 30))); }

    private static double clamp(double value, double low, double high) { return Math.max(low, Math.min(high, value)); }

    private static double round(double value, int places) {
        if (!Double.isFinite(value)) return 0;
        double scale = Math.pow(10, places);
        return Math.round(value * scale) / scale;
    }

    public record PromotionResult(String symbol, String interval, String status, boolean promoted,
                                  Double candidateTestAuc, Double candidateWalkForwardAuc,
                                  Double previousTestAuc, String previousTrainedAt, String error) {
        public static PromotionResult failed(String symbol, String interval, String error) {
            return new PromotionResult(symbol, interval, "failed", false, null, null, null, null, error);
        }
    }

    private record Split(int feature, double threshold, double left, double right, double loss) {}
}
