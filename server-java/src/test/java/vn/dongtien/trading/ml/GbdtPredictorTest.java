package vn.dongtien.trading.ml;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import static org.junit.jupiter.api.Assertions.assertTrue;

class GbdtPredictorTest {
    @Test
    void traversesSerializedTreesProducedByTheBrowserTrainer() {
        var model = new ObjectMapper().readTree("""
                {"base":0,"learningRate":1,"trees":[{"f":0,"thr":0.5,"L":{"v":-2},"R":{"v":2}}]}
                """);
        GbdtPredictor predictor = new GbdtPredictor();
        assertTrue(predictor.predict(model, new double[]{0}) < .2);
        assertTrue(predictor.predict(model, new double[]{1}) > .8);
    }
}
