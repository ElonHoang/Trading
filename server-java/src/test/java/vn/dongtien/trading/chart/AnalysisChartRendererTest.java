package vn.dongtien.trading.chart;

import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.InputStream;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AnalysisChartRendererTest {
    private final AnalysisChartRenderer renderer = new AnalysisChartRenderer();

    @Test
    void rendersHeadlessSafePngFromAnalysisMaps() throws Exception {
        Map<String, Object> snapshot = Map.of(
                "symbol", "BTCUSDT",
                "interval", "4h",
                "price", Map.of("lastClose", 105d, "change24hPercent", 2.35d),
                "combined", Map.of("signal", "MUA", "score", 42d),
                "indicators", Map.of("volumeRatio", 1.4d, "cvdSlope", .03d),
                "series", Map.of(
                        "time", List.of(1_700_000_000_000L, 1_700_014_400_000L, 1_700_028_800_000L,
                                1_700_043_200_000L, 1_700_057_600_000L, 1_700_072_000_000L),
                        "open", List.of(100d, 101d, 100d, 103d, 102d, 104d),
                        "high", List.of(102d, 103d, 104d, 105d, 106d, 107d),
                        "low", List.of(99d, 99d, 99d, 101d, 101d, 103d),
                        "close", List.of(101d, 100d, 103d, 102d, 104d, 105d),
                        "volume", List.of(12d, 16d, 19d, 14d, 21d, 24d),
                        "volumeAvg", List.of(10d, 12d, 14d, 15d, 16d, 18d),
                        "cvd", List.of(-1d, -2d, 1d, .5d, 3d, 5d),
                        "cvdDelta", List.of(-1d, -1d, 3d, -.5d, 2.5d, 2d)));
        Map<String, Object> setup = Map.of(
                "side", "long", "entry", 105d, "stopLoss", 101d, "rrToTp1", 1d,
                "targets", List.of(Map.of("label", "TP1", "price", 109d), Map.of("label", "TP2", "price", 113d)));
        AnalysisChartRenderer.RenderOptions options = new AnalysisChartRenderer.RenderOptions(480, 240, 100, 1, 6);

        byte[] png = renderer.renderAnalysisPng(snapshot, setup, null, null, options);

        assertTrue(png.length > 100);
        assertArrayEquals(new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47}, java.util.Arrays.copyOf(png, 4));
        BufferedImage decoded = ImageIO.read(new java.io.ByteArrayInputStream(png));
        assertNotNull(decoded);
        assertEquals(480, decoded.getWidth());
        assertEquals(398, decoded.getHeight());
        try (InputStream input = renderer.renderAnalysisPngStream(snapshot, setup, null, null, options)) {
            assertArrayEquals(png, input.readAllBytes());
        }
    }
}
