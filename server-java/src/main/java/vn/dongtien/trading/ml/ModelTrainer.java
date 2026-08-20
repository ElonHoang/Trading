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

@Service
public class ModelTrainer {
    private final BinanceClient binance;
    private final IndicatorService indicators;
    private final FeatureService features;
    private final ModelStore models;
    private final ObjectMapper mapper;

    public ModelTrainer(BinanceClient binance, IndicatorService indicators, FeatureService features,
                        ModelStore models, ObjectMapper mapper) {
        this.binance = binance; this.indicators = indicators; this.features = features; this.models = models; this.mapper = mapper;
    }

    public JsonNode train(String symbol, String interval, JsonNode strategy) {
        JsonNode ml = strategy.path("ml");
        int candleCount = ml.path("trainCandles").asInt(16_000);
        int horizon = ml.path("horizon").asInt(24);
        double threshold = ml.path("thresholdPct").asDouble(1.5);
        List<Candle> candles = binance.fetchKlinesHistory(symbol, interval, candleCount).stream().filter(Candle::closed).toList();
        var ind = indicators.compute(candles, strategy.path("indicators").path("volumeAvg").asInt(20),
                strategy.path("indicators").path("cvdSlope").asInt(20));
        List<double[]> x = new ArrayList<>();
        List<Integer> y = new ArrayList<>();
        for (int i = FeatureService.WARMUP; i < candles.size() - horizon; i++) {
            double[] vector = features.vector(candles, ind, i);
            if (vector == null) continue;
            double change = (candles.get(i + horizon).close() / candles.get(i).close() - 1) * 100;
            if (Math.abs(change) < threshold) continue;
            x.add(vector); y.add(change > 0 ? 1 : 0);
        }
        if (x.size() < 100) throw new IllegalStateException("Không đủ mẫu để train: " + x.size());
        int split = Math.max(1, (int) (x.size() * ml.path("trainRatio").asDouble(.75)));
        List<double[]> trainX = x.subList(0, split); List<Integer> trainY = y.subList(0, split);
        int treeCount = Math.min(ml.path("nTrees").asInt(400), 400);
        double learningRate = ml.path("learningRate").asDouble(.05);
        ObjectNode model = fitStumps(trainX, trainY, treeCount, learningRate);
        List<Double> probabilities = new ArrayList<>();
        GbdtPredictor predictor = new GbdtPredictor();
        for (int i = split; i < x.size(); i++) probabilities.add(predictor.predict(model, x.get(i)));
        double accuracy = 0;
        for (int i = 0; i < probabilities.size(); i++) if ((probabilities.get(i) >= .5 ? 1 : 0) == y.get(split + i)) accuracy++;
        accuracy = probabilities.isEmpty() ? 0 : accuracy / probabilities.size();
        ObjectNode payload = mapper.createObjectNode();
        payload.put("symbol", symbol); payload.put("interval", interval); payload.put("trainedAt", Instant.now().toString());
        payload.set("model", model);
        ObjectNode dataset = payload.putObject("dataset"); dataset.put("samples", x.size()); dataset.put("horizon", horizon);
        dataset.put("thresholdMode", ml.path("thresholdMode").asText("fixed"));
        ObjectNode test = payload.putObject("metrics").putObject("test");
        test.put("accuracy", accuracy); test.put("auc", auc(y.subList(split, y.size()), probabilities));
        ArrayNode importance = payload.putArray("importance");
        for (String name : FeatureService.NAMES) importance.addObject().put("feature", name).put("count", 0).put("pct", 0);
        models.save(symbol, interval, payload);
        return payload;
    }

    private ObjectNode fitStumps(List<double[]> x, List<Integer> y, int treeCount, double learningRate) {
        double positiveRate = y.stream().mapToInt(Integer::intValue).average().orElse(.5);
        positiveRate = Math.max(1e-6, Math.min(1 - 1e-6, positiveRate));
        double base = Math.log(positiveRate / (1 - positiveRate));
        double[] scores = new double[x.size()]; java.util.Arrays.fill(scores, base);
        ObjectNode model = mapper.createObjectNode(); model.put("type", "gbdt"); model.put("base", base);
        model.put("learningRate", learningRate); model.put("nFeatures", x.get(0).length);
        ArrayNode trees = model.putArray("trees");
        for (int round = 0; round < treeCount; round++) {
            Split best = null;
            for (int feature = 0; feature < x.get(0).length; feature++) {
                final int f = feature;
                List<Double> sorted = x.stream().map(row -> row[f]).sorted().toList();
                for (int q : new int[]{20, 35, 50, 65, 80}) {
                    double threshold = sorted.get(Math.min(sorted.size() - 1, sorted.size() * q / 100));
                    Split candidate = evaluate(x, y, scores, feature, threshold);
                    if (best == null || candidate.loss() < best.loss()) best = candidate;
                }
            }
            if (best == null) break;
            ObjectNode tree = trees.addObject(); tree.put("f", best.feature()); tree.put("thr", best.threshold());
            tree.putObject("L").put("v", best.left()); tree.putObject("R").put("v", best.right());
            for (int i = 0; i < x.size(); i++) scores[i] += learningRate * (x.get(i)[best.feature()] <= best.threshold() ? best.left() : best.right());
        }
        return model;
    }

    private static Split evaluate(List<double[]> x, List<Integer> y, double[] scores, int feature, double threshold) {
        double left = 0, right = 0; int leftCount = 0, rightCount = 0;
        for (int i = 0; i < x.size(); i++) {
            double residual = y.get(i) - sigmoid(scores[i]);
            if (x.get(i)[feature] <= threshold) { left += residual; leftCount++; } else { right += residual; rightCount++; }
        }
        if (leftCount < 10 || rightCount < 10) return new Split(feature, threshold, 0, 0, Double.POSITIVE_INFINITY);
        left /= leftCount; right /= rightCount;
        double loss = 0;
        for (int i = 0; i < x.size(); i++) {
            double prediction = x.get(i)[feature] <= threshold ? left : right;
            double residual = y.get(i) - sigmoid(scores[i]); loss += Math.pow(residual - prediction, 2);
        }
        return new Split(feature, threshold, left, right, loss);
    }

    private static double auc(List<Integer> labels, List<Double> probabilities) {
        if (labels.isEmpty()) return .5;
        List<Integer> order = new ArrayList<>(); for (int i = 0; i < labels.size(); i++) order.add(i);
        order.sort(Comparator.comparingDouble(probabilities::get));
        double positiveRanks = 0; int positives = 0, negatives = 0;
        for (int rank = 0; rank < order.size(); rank++) {
            if (labels.get(order.get(rank)) == 1) { positives++; positiveRanks += rank + 1; } else negatives++;
        }
        return positives == 0 || negatives == 0 ? .5 : (positiveRanks - positives * (positives + 1) / 2d) / (positives * negatives);
    }
    private static double sigmoid(double value) { return 1 / (1 + Math.exp(-value)); }
    private record Split(int feature, double threshold, double left, double right, double loss) {}
}
