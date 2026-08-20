package vn.dongtien.trading.backtest;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import vn.dongtien.trading.analysis.IndicatorService;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.market.Candle;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class BacktestService {
    private final BinanceClient binance;
    private final IndicatorService indicatorService;

    public BacktestService(BinanceClient binance, IndicatorService indicatorService) {
        this.binance = binance; this.indicatorService = indicatorService;
    }

    public Map<String, Object> run(String symbol, String interval, int count, JsonNode strategy) {
        List<Candle> candles = binance.fetchKlinesHistory(symbol, interval, count).stream().filter(Candle::closed).toList();
        var indicators = indicatorService.compute(candles,
                strategy.path("indicators").path("volumeAvg").asInt(20),
                strategy.path("indicators").path("cvdSlope").asInt(20));
        JsonNode thresholds = strategy.path("thresholds");
        double buy = thresholds.path("buy").asDouble(30), sell = thresholds.path("sell").asDouble(-30);
        double stopPercent = strategy.path("risk").path("slPercent").asDouble(2.5);
        double tp = strategy.path("risk").path("takeProfitR").isArray()
                ? strategy.path("risk").path("takeProfitR").get(0).asDouble(1) : 1;
        List<Map<String, Object>> trades = new ArrayList<>();
        for (int i = 60; i < candles.size() - 1; i++) {
            Double slope = indicators.cvdSlope().get(i), average = indicators.volumeAverage().get(i);
            if (slope == null || average == null) continue;
            Candle entryCandle = candles.get(i);
            double direction = Math.signum(entryCandle.close() - entryCandle.open());
            double volumeScore = Math.max(-1, Math.min(1, direction * .3 * entryCandle.volume() / average));
            double cvdScore = Math.max(-1, Math.min(1, slope * 3));
            double score = (cvdScore * 28 + volumeScore * 22) / 50 * 100;
            String side = score >= buy ? "long" : score <= sell ? "short" : null;
            if (side == null) continue;
            double entry = entryCandle.close();
            double risk = entry * stopPercent / 100;
            double stop = entry + (side.equals("long") ? -risk : risk);
            double target = entry + (side.equals("long") ? risk * tp : -risk * tp);
            String outcome = "expired";
            double exit = candles.get(Math.min(candles.size() - 1, i + 96)).close();
            int exitIndex = Math.min(candles.size() - 1, i + 96);
            for (int j = i + 1; j <= Math.min(candles.size() - 1, i + 96); j++) {
                Candle candle = candles.get(j);
                boolean stopped = side.equals("long") ? candle.low() <= stop : candle.high() >= stop;
                boolean won = side.equals("long") ? candle.high() >= target : candle.low() <= target;
                if (stopped || won) {
                    outcome = stopped ? "stopped" : "target"; exit = stopped ? stop : target; exitIndex = j; break;
                }
            }
            double returnPercent = (side.equals("long") ? exit / entry - 1 : entry / exit - 1) * 100;
            trades.add(Map.of("side", side, "entry", entry, "exit", exit, "outcome", outcome,
                    "returnPercent", returnPercent, "openedAt", entryCandle.openTime(), "closedAt", candles.get(exitIndex).openTime()));
            i = exitIndex;
        }
        long wins = trades.stream().filter(t -> "target".equals(t.get("outcome"))).count();
        long losses = trades.stream().filter(t -> "stopped".equals(t.get("outcome"))).count();
        double net = trades.stream().mapToDouble(t -> ((Number) t.get("returnPercent")).doubleValue()).sum();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("symbol", symbol); result.put("interval", interval); result.put("candles", candles.size());
        result.put("trades", trades); result.put("closedTrades", wins + losses); result.put("wins", wins); result.put("losses", losses);
        result.put("winRatePercent", wins + losses == 0 ? 0 : wins * 100d / (wins + losses)); result.put("netReturnPercent", net);
        return result;
    }
}
