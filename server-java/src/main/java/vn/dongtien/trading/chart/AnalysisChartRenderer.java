package vn.dongtien.trading.chart;

import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import java.awt.AlphaComposite;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.Stroke;
import java.awt.geom.Line2D;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Array;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.NumberFormat;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Java2D port of the former {@code src/chart/png.js} renderer.
 *
 * <p>The renderer works only with a {@link BufferedImage}; it does not create a window, query a
 * screen device, or depend on native fonts. That makes it safe to use from the headless Java
 * runtime used by the Telegram worker. Logical Java fonts are deliberately used so a minimal
 * server installation still produces a readable chart.</p>
 */
@Service
public final class AnalysisChartRenderer {
    public static final int DEFAULT_WIDTH = 1280;
    public static final int DEFAULT_PRICE_HEIGHT = 560;
    public static final int DEFAULT_CVD_HEIGHT = 210;
    public static final int DEFAULT_SCALE = 2;

    private static final int HEADER_HEIGHT = 58;
    private static final int MAX_BARS = 90;
    private static final int MAX_BARS_WITH_SETUP = 45;
    private static final double FORWARD_RATIO = .34d;
    private static final int PAD_LEFT = 8;
    private static final int PAD_RIGHT = 68;
    private static final int PAD_TOP = 10;
    private static final int PAD_BOTTOM = 22;
    private static final Locale VIETNAMESE = Locale.forLanguageTag("vi-VN");

    private static final Color UP = color("#26a69a");
    private static final Color DOWN = color("#ef5350");
    private static final Color VOLUME_AVERAGE = color("#8b949e");
    private static final Color CVD = color("#58a6ff");
    private static final Color GRID = color("#1d232c");
    private static final Color GRID_SOFT = color("#2b333e");
    private static final Color TEXT = color("#8b949e");
    private static final Color ACCENT = color("#58a6ff");
    private static final Color ACCENT_INK = color("#04101f");
    private static final Color BACKGROUND = color("#0e1116");
    private static final Color CROSSHAIR = color("#64748b");
    private static final Color TITLE = color("#e6edf3");
    private static final Color UP_DIM = color("#26a69a55");
    private static final Color DOWN_DIM = color("#ef535055");
    private static final Color UP_BOX = color("#26a69a33");
    private static final Color DOWN_BOX = color("#ef535033");
    private static final Color UP_BOX_STROKE = color("#26a69a99");
    private static final Color DOWN_BOX_STROKE = color("#ef535099");
    private static final Color UP_LINE = color("#26a69aaa");
    private static final Color UP_BAR = color("#26a69acc");
    private static final Color DOWN_BAR = color("#ef5350cc");

    /** Renders a default-size PNG without a trade overlay. */
    public byte[] renderAnalysisPng(Map<String, ?> snapshot) {
        return renderAnalysisPng(snapshot, null, null, null, RenderOptions.defaults());
    }

    /** Renders a default-size PNG using an actionable setup when one is available. */
    public byte[] renderAnalysisPng(Map<String, ?> snapshot, Map<String, ?> setup) {
        return renderAnalysisPng(snapshot, setup, null, null, RenderOptions.defaults());
    }

    /**
     * Renders a default-size PNG. If {@code setup} cannot be drawn, a matching pending limit
     * order is preferred, followed by the primary conditional projection. This mirrors the
     * fallback order of the former Node renderer.
     */
    public byte[] renderAnalysisPng(Map<String, ?> snapshot, Map<String, ?> setup,
                                   Map<String, ?> limitPlan, Map<String, ?> projections) {
        return renderAnalysisPng(snapshot, setup, limitPlan, projections, RenderOptions.defaults());
    }

    /**
     * Convenience overload for lifecycle records that retain limit plans and projections as
     * {@link Object}. Non-map values are treated as absent rather than making a notification
     * fail solely because its optional overlay is unavailable.
     */
    public byte[] renderAnalysisPng(Map<String, ?> snapshot, Map<String, ?> setup,
                                   Object limitPlan, Object projections) {
        return renderAnalysisPng(snapshot, setup, map(limitPlan), map(projections), RenderOptions.defaults());
    }

    /**
     * Renders the analysis snapshot to PNG bytes. {@code snapshot.series} must include the
     * parallel arrays {@code time, open, high, low, close, volume}; CVD arrays are optional.
     */
    public byte[] renderAnalysisPng(Map<String, ?> snapshot, Map<String, ?> setup,
                                   Map<String, ?> limitPlan, Map<String, ?> projections,
                                   RenderOptions options) {
        if (snapshot == null) throw new IllegalArgumentException("Thieu snapshot phan tich");
        RenderOptions effectiveOptions = options == null ? RenderOptions.defaults() : options;
        Map<String, ?> series = map(snapshot.get("series"));
        List<Double> close = numbers(series.get("close"));
        if (close.isEmpty()) {
            throw new IllegalArgumentException("Snapshot thieu series.close - goi analyze voi includeSeries");
        }
        for (Double value : close) {
            if (value == null) throw new IllegalArgumentException("series.close chua gia tri khong hop le");
        }

        Map<String, Object> box = chooseBox(setup, limitPlan, projections);
        int requestedBars = effectiveOptions.maxBars() == null ? 0 : effectiveOptions.maxBars();
        int bars = requestedBars > 0 ? requestedBars : (box == null ? MAX_BARS : MAX_BARS_WITH_SETUP);
        int from = Math.max(0, close.size() - bars);

        List<Candle> candles = candles(series, close, from);
        if (candles.isEmpty()) {
            throw new IllegalArgumentException("Snapshot khong co nen hop le de ve chart");
        }
        List<Double> volumeAverage = slice(numbers(series.get("volumeAvg")), from, candles.size());
        List<Double> cvd = slice(numbers(series.get("cvd")), from, candles.size());
        List<Double> cvdDelta = slice(numbers(series.get("cvdDelta")), from, candles.size());

        int width = effectiveOptions.width();
        int logicalHeight = HEADER_HEIGHT + effectiveOptions.priceHeight() + effectiveOptions.cvdHeight();
        int scale = effectiveOptions.scale();
        BufferedImage image = new BufferedImage(width * scale, logicalHeight * scale, BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = image.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            graphics.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            graphics.scale(scale, scale);
            graphics.setColor(BACKGROUND);
            graphics.fillRect(0, 0, width, logicalHeight);

            drawHeader(graphics, width, snapshot);
            Graphics2D priceGraphics = (Graphics2D) graphics.create();
            try {
                priceGraphics.translate(0, HEADER_HEIGHT);
                drawPricePanel(priceGraphics, candles, volumeAverage, string(snapshot.get("interval"), ""),
                        width, effectiveOptions.priceHeight(), List.<Map<String, ?>>of(), List.<Map<String, ?>>of(), box);
            } finally {
                priceGraphics.dispose();
            }

            Graphics2D cvdGraphics = (Graphics2D) graphics.create();
            try {
                cvdGraphics.translate(0, HEADER_HEIGHT + effectiveOptions.priceHeight());
                drawCvdPanel(cvdGraphics, candles, cvd, cvdDelta, width, effectiveOptions.cvdHeight(),
                        box == null ? 0d : FORWARD_RATIO);
            } finally {
                cvdGraphics.dispose();
            }
        } finally {
            graphics.dispose();
        }

        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (!ImageIO.write(image, "png", output)) throw new IllegalStateException("Java khong co PNG ImageIO writer");
            return output.toByteArray();
        } catch (IOException error) {
            throw new IllegalStateException("Khong the ma hoa chart PNG", error);
        }
    }

    /** Opens a newly rendered PNG as an input stream, suitable for multipart Telegram uploads. */
    public InputStream renderAnalysisPngStream(Map<String, ?> snapshot) {
        return new ByteArrayInputStream(renderAnalysisPng(snapshot));
    }

    /** Opens a setup-overlay PNG as an input stream. */
    public InputStream renderAnalysisPngStream(Map<String, ?> snapshot, Map<String, ?> setup) {
        return new ByteArrayInputStream(renderAnalysisPng(snapshot, setup));
    }

    /** Opens a newly rendered PNG as an input stream, suitable for multipart Telegram uploads. */
    public InputStream renderAnalysisPngStream(Map<String, ?> snapshot, Map<String, ?> setup,
                                               Map<String, ?> limitPlan, Map<String, ?> projections) {
        return new ByteArrayInputStream(renderAnalysisPng(snapshot, setup, limitPlan, projections));
    }

    /** Stream variant of the {@link #renderAnalysisPng(Map, Map, Object, Object)} convenience overload. */
    public InputStream renderAnalysisPngStream(Map<String, ?> snapshot, Map<String, ?> setup,
                                               Object limitPlan, Object projections) {
        return new ByteArrayInputStream(renderAnalysisPng(snapshot, setup, limitPlan, projections));
    }

    /** Opens a newly rendered PNG as an input stream, using the supplied output dimensions. */
    public InputStream renderAnalysisPngStream(Map<String, ?> snapshot, Map<String, ?> setup,
                                               Map<String, ?> limitPlan, Map<String, ?> projections,
                                               RenderOptions options) {
        return new ByteArrayInputStream(renderAnalysisPng(snapshot, setup, limitPlan, projections, options));
    }

    private static void drawHeader(Graphics2D graphics, int width, Map<String, ?> snapshot) {
        Map<String, ?> price = map(snapshot.get("price"));
        Map<String, ?> combined = map(snapshot.get("combined"));
        Map<String, ?> indicators = map(snapshot.get("indicators"));
        Double lastClose = number(price.get("lastClose"));
        Double change = number(price.get("change24hPercent"));
        Color priceColor = change == null ? TITLE : change >= 0 ? UP : DOWN;
        double centerY = HEADER_HEIGHT / 2d;

        double x = 12;
        graphics.setFont(font(Font.BOLD, 21));
        graphics.setColor(TITLE);
        String pair = string(snapshot.get("symbol"), "") + " \u00b7 " + string(snapshot.get("interval"), "");
        drawText(graphics, pair, x, centerY, Horizontal.LEFT, Vertical.MIDDLE);
        x += textWidth(graphics, pair) + 12;

        if (lastClose != null) {
            String priceText = fmt(lastClose, decimalsFor(lastClose));
            graphics.setFont(font(Font.BOLD, 24));
            graphics.setColor(priceColor);
            drawText(graphics, priceText, x, centerY, Horizontal.LEFT, Vertical.MIDDLE);
            x += textWidth(graphics, priceText) + 10;
        }
        if (change != null) {
            graphics.setFont(font(Font.PLAIN, 15));
            graphics.setColor(priceColor);
            drawText(graphics, pct(change, 2), x, centerY, Horizontal.LEFT, Vertical.MIDDLE);
        }

        List<String> bits = new ArrayList<>();
        String signal = string(combined.get("signal"), "");
        Double score = number(combined.get("score"));
        if (!signal.isBlank() && score != null) bits.add(signal + " " + signed(score, 1));
        Double volumeRatio = number(indicators.get("volumeRatio"));
        if (volumeRatio != null) bits.add("KL " + plainNumber(volumeRatio) + "x");
        Double cvdSlope = number(indicators.get("cvdSlope"));
        if (cvdSlope != null) bits.add("CVD " + pct(cvdSlope * 100d, 1));
        if (!bits.isEmpty()) {
            graphics.setFont(font(Font.PLAIN, 14));
            graphics.setColor(TEXT);
            drawText(graphics, String.join("   ", bits), width - 12d, centerY, Horizontal.RIGHT, Vertical.MIDDLE);
        }

        graphics.setColor(GRID);
        graphics.setStroke(stroke(1));
        graphics.draw(new Line2D.Double(0, HEADER_HEIGHT - .5d, width, HEADER_HEIGHT - .5d));
    }

    private static void drawPricePanel(Graphics2D graphics, List<Candle> candles, List<Double> volumeAverage,
                                       String interval, int width, int height, List<Map<String, ?>> levels,
                                       List<Map<String, ?>> walls, Map<String, Object> setup) {
        graphics.setFont(font(Font.PLAIN, 13));
        int volumeHeight = (int) Math.round((height - PAD_TOP - PAD_BOTTOM) * .2d);
        double fullWidth = width - PAD_LEFT - PAD_RIGHT;
        boolean hasSetup = usableBox(setup);
        double plotWidth = hasSetup ? fullWidth * (1d - FORWARD_RATIO) : fullWidth;
        double zoneX = PAD_LEFT + plotWidth;
        double zoneWidth = fullWidth - plotWidth;
        double plotHeight = height - PAD_TOP - PAD_BOTTOM - volumeHeight - 6d;

        PriceRange range = priceRange(candles, levels, setup, hasSetup);
        double step = plotWidth / candles.size();
        int decimals = decimalsFor(candles.get(candles.size() - 1).close());

        graphics.setColor(GRID);
        graphics.setStroke(stroke(1));
        graphics.setColor(TEXT);
        for (int grid = 0; grid <= 4; grid++) {
            double y = PAD_TOP + (plotHeight / 4d) * grid;
            graphics.setColor(GRID);
            graphics.draw(new Line2D.Double(PAD_LEFT, y, width - PAD_RIGHT, y));
            graphics.setColor(TEXT);
            drawText(graphics, fmt(range.high() - ((range.high() - range.low()) / 4d) * grid, decimals),
                    width - PAD_RIGHT + 7d, y, Horizontal.LEFT, Vertical.MIDDLE);
        }

        List<Double> usedRight = new ArrayList<>();
        List<Double> usedLeft = new ArrayList<>();
        for (Map<String, ?> level : levels) {
            String kind = string(level.get("kind"), "");
            if (!"support".equals(kind) && !"resistance".equals(kind)) continue;
            Double price = number(level.get("price"));
            if (price == null || price < range.low() || price > range.high()) continue;
            double y = yOf(price, range, plotHeight);
            Color levelColor = "support".equals(kind) ? UP : DOWN;
            graphics.setColor(levelColor);
            graphics.setStroke(dashed((float) Math.min(2.5d, 1d + (number(level.get("touches")) == null ? 0d
                    : Math.max(0d, number(level.get("touches")) - 1d) * .5d)), 5, 4));
            graphics.draw(new Line2D.Double(PAD_LEFT, y, width - PAD_RIGHT, y));
            if (claim(usedRight, y, 11)) {
                graphics.setColor(levelColor);
                drawText(graphics, ("support".equals(kind) ? "HT " : "KC ") + fmt(price, decimals)
                                + " \u00b7 " + plainNumber(or(number(level.get("touches")), 1d)) + "x",
                        width - PAD_RIGHT - 4d, y - 2d, Horizontal.RIGHT, Vertical.BOTTOM);
            }
        }

        for (Map<String, ?> wall : walls) {
            String side = string(wall.get("side"), "");
            Double price = number(wall.get("price"));
            if ((!"bid".equals(side) && !"ask".equals(side)) || price == null
                    || price < range.low() || price > range.high()) continue;
            double y = yOf(price, range, plotHeight);
            Color wallColor = "bid".equals(side) ? UP : DOWN;
            graphics.setColor(wallColor);
            graphics.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, .28f));
            graphics.setStroke(stroke(5));
            graphics.draw(new Line2D.Double(PAD_LEFT, y, width - PAD_RIGHT, y));
            graphics.setComposite(AlphaComposite.SrcOver);
            if (claim(usedLeft, y, 11)) {
                graphics.setColor(wallColor);
                Double ratio = number(wall.get("ratioToAvg"));
                drawText(graphics, "Tuong " + ("bid".equals(side) ? "MUA " : "BAN ")
                                + (ratio == null ? "?" : fixed(ratio, 1)) + "x",
                        PAD_LEFT + 3d, y - 2d, Horizontal.LEFT, Vertical.BOTTOM);
            }
        }

        double bodyWidth = Math.max(1d, Math.min(step * .7d, 14d));
        for (int index = 0; index < candles.size(); index++) {
            Candle candle = candles.get(index);
            Color candleColor = candle.close() >= candle.open() ? UP : DOWN;
            double x = xOf(index, step);
            graphics.setColor(candleColor);
            graphics.setStroke(stroke(1));
            graphics.draw(new Line2D.Double(x, yOf(candle.high(), range, plotHeight), x, yOf(candle.low(), range, plotHeight)));
            double bodyTop = yOf(Math.max(candle.open(), candle.close()), range, plotHeight);
            double bodyHeight = Math.max(1d, Math.abs(yOf(candle.close(), range, plotHeight)
                    - yOf(candle.open(), range, plotHeight)));
            graphics.fill(new Rectangle2D.Double(x - bodyWidth / 2d, bodyTop, bodyWidth, bodyHeight));
        }

        if (hasSetup) drawTradeBox(graphics, setup, range, decimals, zoneX, zoneWidth, plotHeight);

        Candle last = candles.get(candles.size() - 1);
        double lastY = yOf(last.close(), range, plotHeight);
        graphics.setColor(ACCENT);
        graphics.setStroke(dashed(1, 4, 3));
        graphics.draw(new Line2D.Double(PAD_LEFT, lastY, width - PAD_RIGHT, lastY));
        graphics.setColor(ACCENT);
        graphics.fill(new Rectangle2D.Double(width - PAD_RIGHT + 2d, lastY - 8d, PAD_RIGHT - 4d, 16d));
        graphics.setColor(ACCENT_INK);
        drawText(graphics, fmt(last.close(), decimals), width - PAD_RIGHT + 6d, lastY, Horizontal.LEFT, Vertical.MIDDLE);

        double volumeTop = PAD_TOP + plotHeight + 6d;
        double volumeMax = 0d;
        for (Candle candle : candles) volumeMax = Math.max(volumeMax, candle.volume());
        if (volumeMax <= 0d) volumeMax = 1d;
        final double finalVolumeMax = volumeMax;
        for (int index = 0; index < candles.size(); index++) {
            Candle candle = candles.get(index);
            double x = xOf(index, step);
            double volumeY = volumeTop + volumeHeight - candle.volume() / finalVolumeMax * volumeHeight;
            graphics.setColor(candle.close() >= candle.open() ? UP_DIM : DOWN_DIM);
            graphics.fill(new Rectangle2D.Double(x - bodyWidth / 2d, volumeY, bodyWidth,
                    Math.max(.6d, volumeTop + volumeHeight - volumeY)));
        }
        if (hasValue(volumeAverage)) {
            graphics.setColor(VOLUME_AVERAGE);
            graphics.setStroke(dashed(1.2f, 4, 3));
            drawPolyline(graphics, volumeAverage, index -> xOf(index, step),
                    value -> volumeTop + volumeHeight - value / finalVolumeMax * volumeHeight);
        }

        graphics.setColor(TEXT);
        int every = Math.max(1, (int) Math.ceil(candles.size() / 6d));
        for (int index = 0; index < candles.size(); index += every) {
            drawText(graphics, timeLabel(candles.get(index).openTime(), interval), xOf(index, step),
                    height - PAD_BOTTOM + 7d, index == 0 ? Horizontal.LEFT : Horizontal.CENTER, Vertical.TOP);
        }
    }

    private static void drawTradeBox(Graphics2D graphics, Map<String, Object> setup, PriceRange range, int decimals,
                                     double zoneX, double zoneWidth, double plotHeight) {
        Double entry = number(setup.get("entry"));
        if (entry == null) return;
        double entryY = yOf(entry, range, plotHeight);
        List<Map<String, ?>> targets = maps(setup.get("targets"));
        Map<String, ?> finalTarget = null;
        for (Map<String, ?> target : targets) if (number(target.get("price")) != null) finalTarget = target;
        if (finalTarget != null) {
            Double targetPrice = number(finalTarget.get("price"));
            drawPositionBox(graphics, entryY, yOf(targetPrice, range, plotHeight), zoneX, zoneWidth,
                    UP_BOX, UP_BOX_STROKE, plotHeight);
        }
        Double stopLoss = number(setup.get("stopLoss"));
        if (stopLoss != null) {
            drawPositionBox(graphics, entryY, yOf(stopLoss, range, plotHeight), zoneX, zoneWidth,
                    DOWN_BOX, DOWN_BOX_STROKE, plotHeight);
        }

        List<Double> used = new ArrayList<>();
        for (int index = 0; index < targets.size(); index++) {
            Map<String, ?> target = targets.get(index);
            Double price = number(target.get("price"));
            if (price == null) continue;
            double y = clamp(yOf(price, range, plotHeight), PAD_TOP, PAD_TOP + plotHeight);
            graphics.setColor(UP_LINE);
            graphics.setStroke(dashed(1, 3, 3));
            graphics.draw(new Line2D.Double(zoneX, y, zoneX + zoneWidth, y));
            if (claim(used, y, 15)) {
                String label = string(target.get("label"), "TP" + (index + 1));
                double move = (price - entry) / entry * 100d;
                String text = label + " " + fmt(price, decimals) + " (" + pct(move, 2) + ")";
                drawFilledLabel(graphics, text, zoneX + 3d, y, UP, ACCENT_INK, Horizontal.LEFT);
            }
        }

        graphics.setColor(ACCENT);
        graphics.setStroke(dashed(1.2f, 5, 4));
        graphics.draw(new Line2D.Double(PAD_LEFT, entryY, zoneX + zoneWidth, entryY));

        if (stopLoss != null) {
            double move = (stopLoss - entry) / entry * 100d;
            drawFilledLabel(graphics, "Cat lo " + fmt(stopLoss, decimals) + " (" + pct(move, 2) + ")",
                    zoneX + zoneWidth - 2d, clamp(yOf(stopLoss, range, plotHeight), PAD_TOP, PAD_TOP + plotHeight),
                    DOWN, ACCENT_INK, Horizontal.RIGHT);
        }
        String side = "long".equals(string(setup.get("side"), "")) ? "LONG" : "SHORT";
        Double rr = number(setup.get("rrToTp1"));
        boolean pending = bool(setup.get("pending"), false);
        String text = (pending ? "CHO " : "") + side + (pending ? " \u00b7 qua " : " vao ") + fmt(entry, decimals)
                + (rr == null || rr == 0d ? "" : " \u00b7 R:R " + fmt(rr, 2));
        drawFilledLabel(graphics, text, zoneX + 2d, entryY, pending ? TEXT : ACCENT, ACCENT_INK, Horizontal.LEFT);
    }

    private static void drawPositionBox(Graphics2D graphics, double firstY, double secondY, double zoneX,
                                        double zoneWidth, Color fill, Color border, double plotHeight) {
        double y1 = clamp(firstY, PAD_TOP, PAD_TOP + plotHeight);
        double y2 = clamp(secondY, PAD_TOP, PAD_TOP + plotHeight);
        double top = Math.min(y1, y2);
        double height = Math.abs(y2 - y1);
        graphics.setColor(fill);
        graphics.fill(new Rectangle2D.Double(zoneX, top, zoneWidth, height));
        graphics.setColor(border);
        graphics.setStroke(stroke(1));
        graphics.draw(new Rectangle2D.Double(zoneX, top, zoneWidth, height));
    }

    private static void drawFilledLabel(Graphics2D graphics, String text, double anchorX, double y,
                                        Color background, Color ink, Horizontal alignment) {
        graphics.setFont(font(Font.PLAIN, 13));
        double width = textWidth(graphics, text) + 10d;
        double x = alignment == Horizontal.RIGHT ? anchorX - width : anchorX;
        graphics.setColor(background);
        graphics.fill(new Rectangle2D.Double(x, y - 8d, width, 16d));
        graphics.setColor(ink);
        drawText(graphics, text, x + 5d, y, Horizontal.LEFT, Vertical.MIDDLE);
    }

    private static void drawCvdPanel(Graphics2D graphics, List<Candle> candles, List<Double> cvd,
                                     List<Double> cvdDelta, int width, int height, double forwardRatio) {
        graphics.setFont(font(Font.PLAIN, 13));
        double plotWidth = (width - PAD_LEFT - PAD_RIGHT) * (1d - forwardRatio);
        int barsHeight = (int) Math.round((height - 14 - 8) * .38d);
        double lineHeight = height - 14 - 8 - barsHeight - 4d;
        double step = plotWidth / candles.size();
        List<Double> values = cvd.stream().filter(value -> value != null).toList();
        if (values.isEmpty()) return;
        double low = values.stream().mapToDouble(Double::doubleValue).min().orElse(0d);
        double high = values.stream().mapToDouble(Double::doubleValue).max().orElse(0d);
        double span = high - low;
        if (span == 0d) span = Math.abs(high);
        if (span == 0d) span = 1d;
        final double finalLow = low;
        final double finalSpan = span;

        graphics.setColor(GRID);
        graphics.setStroke(stroke(1));
        for (double value : List.of(high, low + span / 2d, low)) {
            double y = 14 + lineHeight - ((value - low) / span) * lineHeight;
            graphics.setColor(GRID);
            graphics.draw(new Line2D.Double(PAD_LEFT, y, PAD_LEFT + plotWidth, y));
            graphics.setColor(TEXT);
            drawText(graphics, compact(value), width - PAD_RIGHT + 7d, y, Horizontal.LEFT, Vertical.MIDDLE);
        }
        graphics.setColor(CVD);
        graphics.setStroke(stroke(1.6f));
        drawPolyline(graphics, cvd, index -> xOf(index, step),
                value -> 14 + lineHeight - ((value - finalLow) / finalSpan) * lineHeight);

        List<Double> shares = new ArrayList<>();
        double extent = .05d;
        for (int index = 0; index < candles.size(); index++) {
            Double delta = at(cvdDelta, index);
            double volume = candles.get(index).volume();
            Double share = delta == null || volume == 0d ? null : delta / volume;
            shares.add(share);
            if (share != null) extent = Math.max(extent, Math.abs(share));
        }
        double barsTop = 14 + lineHeight + 4d;
        double finalExtent = extent;
        java.util.function.DoubleFunction<Double> yBar = value -> barsTop + barsHeight / 2d
                - value / finalExtent * (barsHeight / 2d);
        double barWidth = Math.max(1d, Math.min(step * .7d, 14d));
        graphics.setColor(GRID_SOFT);
        graphics.setStroke(stroke(1));
        graphics.draw(new Line2D.Double(PAD_LEFT, yBar.apply(0d), PAD_LEFT + plotWidth, yBar.apply(0d)));
        for (int index = 0; index < shares.size(); index++) {
            Double share = shares.get(index);
            if (share == null) continue;
            double y = yBar.apply(share);
            graphics.setColor(share >= 0d ? UP_BAR : DOWN_BAR);
            graphics.fill(new Rectangle2D.Double(xOf(index, step) - barWidth / 2d, share >= 0d ? y : yBar.apply(0d),
                    barWidth, Math.max(.8d, Math.abs(y - yBar.apply(0d)))));
        }
        graphics.setColor(TEXT);
        drawText(graphics, "\u00b1" + fixed(extent * 100d, 0) + "%", width - PAD_RIGHT + 7d, yBar.apply(0d),
                Horizontal.LEFT, Vertical.MIDDLE);
        drawText(graphics, "CVD luy tien \u00b7 cot = mua chu dong rong moi nen (% KL)", PAD_LEFT + 2d, 2d,
                Horizontal.LEFT, Vertical.TOP);
    }

    private static PriceRange priceRange(List<Candle> candles, List<Map<String, ?>> levels,
                                         Map<String, Object> setup, boolean hasSetup) {
        double low = Double.POSITIVE_INFINITY;
        double high = Double.NEGATIVE_INFINITY;
        for (Candle candle : candles) {
            low = Math.min(low, candle.low());
            high = Math.max(high, candle.high());
        }
        List<Double> setupPrices = new ArrayList<>();
        if (hasSetup) {
            addIfNumber(setupPrices, number(setup.get("entry")));
            addIfNumber(setupPrices, number(setup.get("stopLoss")));
            for (Map<String, ?> target : maps(setup.get("targets"))) addIfNumber(setupPrices, number(target.get("price")));
        }
        Double setupLow = setupPrices.isEmpty() ? null : setupPrices.stream().mapToDouble(Double::doubleValue).min().orElseThrow();
        Double setupHigh = setupPrices.isEmpty() ? null : setupPrices.stream().mapToDouble(Double::doubleValue).max().orElseThrow();
        if (setupLow != null) {
            low = Math.min(low, setupLow);
            high = Math.max(high, setupHigh);
        }
        double bandPadding = setupLow == null ? 0d : (setupHigh - setupLow) * .6d;
        double keepLow = setupLow == null ? low : setupLow - bandPadding;
        double keepHigh = setupHigh == null ? high : setupHigh + bandPadding;
        for (Map<String, ?> level : levels) {
            Double price = number(level.get("price"));
            if (price == null) continue;
            if (hasSetup && (price < keepLow || price > keepHigh)) continue;
            if (!hasSetup && (price <= low * .85d || price >= high * 1.15d)) continue;
            low = Math.min(low, price);
            high = Math.max(high, price);
        }
        if (!Double.isFinite(low) || !Double.isFinite(high)) throw new IllegalArgumentException("Nen co gia khong hop le");
        double padding = (high - low) * .06d;
        if (padding == 0d) padding = Math.max(Math.abs(high) * .01d, 1d);
        return new PriceRange(low - padding, high + padding);
    }

    private static List<Candle> candles(Map<String, ?> series, List<Double> close, int from) {
        List<Double> open = numbers(series.get("open"));
        List<Double> high = numbers(series.get("high"));
        List<Double> low = numbers(series.get("low"));
        List<Double> volume = numbers(series.get("volume"));
        List<?> time = values(series.get("time"));
        List<Candle> candles = new ArrayList<>();
        for (int index = from; index < close.size(); index++) {
            double closing = close.get(index);
            double opening = or(at(open, index), closing);
            double highest = Math.max(Math.max(opening, closing), or(at(high, index), Math.max(opening, closing)));
            double lowest = Math.min(Math.min(opening, closing), or(at(low, index), Math.min(opening, closing)));
            double tradedVolume = Math.max(0d, or(at(volume, index), 0d));
            Long openTime = longNumber(at(time, index));
            candles.add(new Candle(openTime == null ? index : openTime, opening, highest, lowest, closing, tradedVolume));
        }
        return candles;
    }

    private static Map<String, Object> chooseBox(Map<String, ?> setup, Map<String, ?> limitPlan,
                                                  Map<String, ?> projections) {
        Map<String, Object> direct = normalizedBox(setup, false);
        if (direct != null) return direct;

        Map<String, ?> plan = map(limitPlan);
        String lean = string(plan.get("lean"), "");
        for (Map<String, ?> order : maps(plan.get("orders"))) {
            if (lean.equals(string(order.get("direction"), ""))) {
                Map<String, Object> box = normalizedBox(order, true);
                if (box != null) return box;
            }
        }

        Map<String, ?> values = map(projections);
        String primary = string(values.get("primary"), "");
        Map<String, ?> projection = "short".equals(primary) ? map(values.get("down"))
                : "long".equals(primary) ? map(values.get("up")) : Map.<String, Object>of();
        return normalizedBox(projection, true);
    }

    private static Map<String, Object> normalizedBox(Map<String, ?> source, boolean pending) {
        if (source == null || source.isEmpty()) return null;
        String side = string(source.get("side"), string(source.get("direction"), "none")).toLowerCase(Locale.ROOT);
        Double entry = number(source.get("entry"));
        if ((!"long".equals(side) && !"short".equals(side)) || entry == null) return null;
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("side", side);
        result.put("entry", entry);
        result.put("stopLoss", number(source.get("stopLoss")));
        result.put("targets", maps(source.get("targets")));
        Double rr = number(source.get("rrToTp1"));
        result.put("rrToTp1", rr == null ? number(source.get("rrToStructure")) : rr);
        result.put("pending", pending || bool(source.get("pending"), false));
        return result;
    }

    private static boolean usableBox(Map<String, ?> box) {
        return box != null && ("long".equals(string(box.get("side"), "")) || "short".equals(string(box.get("side"), "")))
                && number(box.get("entry")) != null;
    }

    private static void drawPolyline(Graphics2D graphics, List<Double> series,
                                     java.util.function.IntToDoubleFunction xOf,
                                     java.util.function.DoubleFunction<Double> yOf) {
        boolean started = false;
        double previousX = 0d;
        double previousY = 0d;
        for (int index = 0; index < series.size(); index++) {
            Double value = series.get(index);
            if (value == null) {
                started = false;
                continue;
            }
            double x = xOf.applyAsDouble(index);
            double y = yOf.apply(value);
            if (started) graphics.draw(new Line2D.Double(previousX, previousY, x, y));
            previousX = x;
            previousY = y;
            started = true;
        }
    }

    private static double xOf(int index, double step) {
        return PAD_LEFT + step * (index + .5d);
    }

    private static double yOf(double price, PriceRange range, double plotHeight) {
        return PAD_TOP + plotHeight - ((price - range.low()) / (range.high() - range.low())) * plotHeight;
    }

    private static boolean claim(List<Double> used, double value, double minimumDistance) {
        for (double prior : used) if (Math.abs(prior - value) < minimumDistance) return false;
        used.add(value);
        return true;
    }

    private static boolean hasValue(List<Double> values) {
        for (Double value : values) if (value != null) return true;
        return false;
    }

    private static void drawText(Graphics2D graphics, String text, double x, double y,
                                 Horizontal horizontal, Vertical vertical) {
        FontMetrics metrics = graphics.getFontMetrics();
        double adjustedX = switch (horizontal) {
            case LEFT -> x;
            case CENTER -> x - metrics.stringWidth(text) / 2d;
            case RIGHT -> x - metrics.stringWidth(text);
        };
        double baseline = switch (vertical) {
            case TOP -> y + metrics.getAscent();
            case MIDDLE -> y + (metrics.getAscent() - metrics.getDescent()) / 2d;
            case BOTTOM -> y - metrics.getDescent();
        };
        graphics.drawString(text, (float) adjustedX, (float) baseline);
    }

    private static double textWidth(Graphics2D graphics, String text) {
        return graphics.getFontMetrics().stringWidth(text);
    }

    private static Font font(int style, int size) {
        return new Font(Font.SANS_SERIF, style, size);
    }

    private static Stroke stroke(float width) {
        return new BasicStroke(width, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER);
    }

    private static Stroke stroke(double width) {
        return stroke((float) width);
    }

    private static Stroke dashed(float width, float... dash) {
        return new BasicStroke(width, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER, 10f, dash, 0f);
    }

    private static Stroke dashed(double width, float... dash) {
        return dashed((float) width, dash);
    }

    private static Color color(String hex) {
        String value = hex.charAt(0) == '#' ? hex.substring(1) : hex;
        long parsed = Long.parseLong(value, 16);
        if (value.length() == 6) return new Color((int) parsed);
        return new Color((int) (parsed >> 24) & 0xff, (int) (parsed >> 16) & 0xff,
                (int) (parsed >> 8) & 0xff, (int) parsed & 0xff);
    }

    public static int decimalsFor(double value) {
        double absolute = Math.abs(value);
        if (!Double.isFinite(value) || absolute == 0d) return 2;
        if (absolute < .001d) return 8;
        if (absolute < 1d) return 6;
        if (absolute < 100d) return 4;
        return 2;
    }

    public static String fmt(double value, int decimals) {
        if (!Double.isFinite(value)) return "\u2014";
        NumberFormat formatter = NumberFormat.getNumberInstance(VIETNAMESE);
        formatter.setMinimumFractionDigits(decimals);
        formatter.setMaximumFractionDigits(decimals);
        return formatter.format(value);
    }

    public static String pct(double value, int decimals) {
        if (!Double.isFinite(value)) return "\u2014";
        double rounded = BigDecimal.valueOf(value).setScale(decimals, RoundingMode.HALF_UP).doubleValue();
        return (rounded > 0d ? "+" : "") + fmt(rounded, decimals) + "%";
    }

    private static String compact(double value) {
        if (!Double.isFinite(value)) return "\u2014";
        double absolute = Math.abs(value);
        if (absolute >= 1_000_000_000d) return fmt(value / 1_000_000_000d, 2) + "B";
        if (absolute >= 1_000_000d) return fmt(value / 1_000_000d, 2) + "M";
        if (absolute >= 1_000d) return fmt(value / 1_000d, 2) + "K";
        return fmt(value, 2);
    }

    private static String timeLabel(long epochMillis, String interval) {
        ZonedDateTime time;
        try {
            time = Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault());
        } catch (RuntimeException ignored) {
            return "?";
        }
        boolean intraday = interval != null && (interval.matches(".*m$") || interval.matches("^\\d+h$"));
        return intraday ? String.format(Locale.ROOT, "%02d/%02d %02d:%02d", time.getDayOfMonth(), time.getMonthValue(),
                time.getHour(), time.getMinute()) : String.format(Locale.ROOT, "%02d/%02d/%04d", time.getDayOfMonth(),
                time.getMonthValue(), time.getYear());
    }

    private static String plainNumber(double value) {
        if (Math.rint(value) == value) return Long.toString(Math.round(value));
        return Double.toString(value);
    }

    private static String signed(double value, int decimals) {
        String formatted = fmt(value, decimals);
        return value > 0d ? "+" + formatted : formatted;
    }

    private static String fixed(double value, int decimals) {
        return String.format(Locale.ROOT, "%." + decimals + "f", value);
    }

    private static double clamp(double value, double low, double high) {
        return Math.max(low, Math.min(high, value));
    }

    private static void addIfNumber(List<Double> values, Double value) {
        if (value != null) values.add(value);
    }

    private static double or(Double value, double fallback) {
        return value == null ? fallback : value;
    }

    private static boolean bool(Object value, boolean fallback) {
        return value instanceof Boolean flag ? flag : fallback;
    }

    private static String string(Object value, String fallback) {
        return value == null ? fallback : String.valueOf(value);
    }

    private static Double number(Object value) {
        if (value == null) return null;
        try {
            double parsed = value instanceof Number number ? number.doubleValue() : Double.parseDouble(String.valueOf(value));
            return Double.isFinite(parsed) ? parsed : null;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static Long longNumber(Object value) {
        Double parsed = number(value);
        return parsed == null || parsed < Long.MIN_VALUE || parsed > Long.MAX_VALUE ? null : parsed.longValue();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, ?> map(Object value) {
        return value instanceof Map<?, ?> values ? (Map<String, ?>) values : Map.of();
    }

    private static List<Double> numbers(Object value) {
        List<Double> result = new ArrayList<>();
        for (Object item : values(value)) result.add(number(item));
        return result;
    }

    private static List<Map<String, ?>> maps(Object value) {
        List<Map<String, ?>> result = new ArrayList<>();
        for (Object item : values(value)) {
            Map<String, ?> mapped = map(item);
            if (!mapped.isEmpty()) result.add(mapped);
        }
        return result;
    }

    private static List<?> values(Object value) {
        if (value == null) return List.of();
        if (value instanceof List<?> list) return list;
        List<Object> result = new ArrayList<>();
        if (value instanceof Iterable<?> iterable) {
            for (Object item : iterable) result.add(item);
            return result;
        }
        if (value.getClass().isArray()) {
            int length = Array.getLength(value);
            for (int index = 0; index < length; index++) result.add(Array.get(value, index));
        }
        return result;
    }

    private static <T> T at(List<T> values, int index) {
        return index >= 0 && index < values.size() ? values.get(index) : null;
    }

    private static List<Double> slice(List<Double> source, int from, int size) {
        List<Double> result = new ArrayList<>();
        for (int index = 0; index < size; index++) result.add(at(source, from + index));
        return result;
    }

    private record Candle(long openTime, double open, double high, double low, double close, double volume) {}
    private record PriceRange(double low, double high) {}
    private enum Horizontal { LEFT, CENTER, RIGHT }
    private enum Vertical { TOP, MIDDLE, BOTTOM }

    /** Render dimensions expressed in logical pixels before supersampling. */
    public record RenderOptions(int width, int priceHeight, int cvdHeight, int scale, Integer maxBars) {
        public RenderOptions {
            if (width < 320 || width > 4096) throw new IllegalArgumentException("width phai nam trong 320..4096");
            if (priceHeight < 180 || priceHeight > 2048) throw new IllegalArgumentException("priceHeight phai nam trong 180..2048");
            if (cvdHeight < 80 || cvdHeight > 1024) throw new IllegalArgumentException("cvdHeight phai nam trong 80..1024");
            if (scale < 1 || scale > 4) throw new IllegalArgumentException("scale phai nam trong 1..4");
            if (maxBars != null && maxBars < 1) throw new IllegalArgumentException("maxBars phai duong hoac null");
        }

        public static RenderOptions defaults() {
            return new RenderOptions(DEFAULT_WIDTH, DEFAULT_PRICE_HEIGHT, DEFAULT_CVD_HEIGHT, DEFAULT_SCALE, null);
        }
    }
}
