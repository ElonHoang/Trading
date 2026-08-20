package vn.dongtien.trading.ml;

import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

@Component
public class GbdtPredictor {
    public double predict(JsonNode model, double[] features) {
        double score = model.path("base").asDouble();
        double learningRate = model.path("learningRate").asDouble();
        for (JsonNode tree : model.path("trees")) score += learningRate * tree(tree, features);
        return 1d / (1d + Math.exp(-score));
    }

    private double tree(JsonNode node, double[] features) {
        JsonNode cursor = node;
        while (!cursor.has("v")) {
            int feature = cursor.path("f").asInt();
            cursor = features[feature] <= cursor.path("thr").asDouble() ? cursor.path("L") : cursor.path("R");
        }
        return cursor.path("v").asDouble();
    }
}
