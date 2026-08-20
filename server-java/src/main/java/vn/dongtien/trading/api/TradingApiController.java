package vn.dongtien.trading.api;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import vn.dongtien.trading.analysis.AnalysisService;
import vn.dongtien.trading.backtest.BacktestService;
import vn.dongtien.trading.config.StrategyService;
import vn.dongtien.trading.config.TradingUniverse;
import vn.dongtien.trading.llm.AnthropicService;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.ml.ModelTrainer;
import vn.dongtien.trading.watchlist.WatchlistService;

import java.util.List;
import java.util.Map;

@RestController
public class TradingApiController {
    private final BinanceClient binance;
    private final StrategyService strategies;
    private final TradingUniverse universe;
    private final AnalysisService analysis;
    private final WatchlistService watchlist;
    private final ModelTrainer trainer;
    private final BacktestService backtest;
    private final AnthropicService anthropic;
    private final ObjectMapper mapper;

    public TradingApiController(BinanceClient binance, StrategyService strategies, TradingUniverse universe,
                                AnalysisService analysis, WatchlistService watchlist, ModelTrainer trainer,
                                BacktestService backtest, AnthropicService anthropic, ObjectMapper mapper) {
        this.binance = binance; this.strategies = strategies; this.universe = universe;
        this.analysis = analysis; this.watchlist = watchlist; this.trainer = trainer;
        this.backtest = backtest; this.anthropic = anthropic; this.mapper = mapper;
    }

    @GetMapping("/api/intervals")
    List<String> intervals() { return BinanceClient.INTERVALS; }

    @GetMapping("/api/analyze")
    ResponseEntity<?> analyze(@RequestParam(required = false) String symbol,
                              @RequestParam(defaultValue = "4h") String interval,
                              @RequestParam(defaultValue = "180") int bars) {
        try {
            if (symbol == null || symbol.isBlank()) throw new IllegalArgumentException("Thiếu tham số symbol");
            String resolved = binance.resolveSymbol(symbol);
            universe.requireAllowed(resolved, strategies.strategy());
            return ResponseEntity.ok(analysis.analyze(resolved, interval, strategies.strategy(), Math.max(0, bars)));
        } catch (RuntimeException error) {
            return ResponseEntity.badRequest().body(Map.of("error", error.getMessage()));
        }
    }

    @GetMapping("/api/watchlist")
    List<String> watchlist() { return watchlist.read(); }

    @PostMapping("/api/watchlist")
    ResponseEntity<?> add(@RequestBody Map<String, Object> body) {
        try { return ResponseEntity.ok(watchlist.add(String.valueOf(body.getOrDefault("symbol", "")))); }
        catch (RuntimeException error) { return ResponseEntity.badRequest().body(Map.of("error", error.getMessage())); }
    }

    @DeleteMapping({"/api/watchlist", "/api/watchlist/{symbol}"})
    List<String> remove(@org.springframework.web.bind.annotation.PathVariable(required = false) String symbol,
                        @RequestParam(required = false) String value) {
        return watchlist.remove(symbol == null ? value : symbol);
    }

    /** Accepts a transient UI strategy so local configuration edits still take effect without JavaScript calculations. */
    @PostMapping("/api/analyze")
    ResponseEntity<?> analyzeWithStrategy(@RequestBody(required = false) Map<String, Object> body) {
        try {
            Map<String, Object> request = body == null ? Map.of() : body;
            JsonNode strategy = requestStrategy(request);
            String symbol = resolve(request.get("symbol"), strategy);
            String interval = string(request.get("interval"), "4h");
            int bars = boundedInt(request.get("bars"), 180, 0, 2_000);
            return ResponseEntity.ok(analysis.analyze(symbol, interval, strategy, bars));
        } catch (RuntimeException error) {
            return ResponseEntity.badRequest().body(Map.of("error", error.getMessage()));
        }
    }

    /** Runs the former Web Worker backtest in the Java runtime. */
    @PostMapping("/api/backtest")
    ResponseEntity<?> backtest(@RequestBody(required = false) Map<String, Object> body) {
        try {
            Map<String, Object> request = body == null ? Map.of() : body;
            JsonNode strategy = requestStrategy(request);
            String symbol = resolve(request.get("symbol"), strategy);
            String interval = string(request.get("interval"), "4h");
            int candles = boundedInt(request.get("candles"), 3000, 200, 20_000);
            return ResponseEntity.ok(backtest.run(symbol, interval, candles, strategy));
        } catch (RuntimeException error) {
            return ResponseEntity.badRequest().body(Map.of("error", error.getMessage()));
        }
    }

    /** Trains and persists a model in TiDB Cloud rather than browser storage. */
    @PostMapping("/api/train")
    ResponseEntity<?> train(@RequestBody(required = false) Map<String, Object> body) {
        try {
            Map<String, Object> request = body == null ? Map.of() : body;
            JsonNode strategy = requestStrategy(request);
            String symbol = resolve(request.get("symbol"), strategy);
            String interval = string(request.get("interval"), "4h");
            return ResponseEntity.ok(trainer.train(symbol, interval, strategy));
        } catch (RuntimeException error) {
            return ResponseEntity.badRequest().body(Map.of("error", error.getMessage()));
        }
    }

    /** Server-side Claude path for CLI, Telegram and deployments with a configured key. */
    @PostMapping("/api/ai/report")
    ResponseEntity<?> aiReport(@RequestBody(required = false) Map<String, Object> body) {
        return ai(body, false);
    }

    @PostMapping("/api/ai/ask")
    ResponseEntity<?> aiAsk(@RequestBody(required = false) Map<String, Object> body) {
        return ai(body, true);
    }

    @SuppressWarnings("unchecked")
    private ResponseEntity<?> ai(Map<String, Object> body, boolean ask) {
        try {
            if (!anthropic.available()) throw new IllegalStateException("Chưa cấu hình ANTHROPIC_API_KEY");
            Map<String, Object> request = body == null ? Map.of() : body;
            Object rawSnapshot = request.get("snapshot");
            Map<String, Object> snapshot;
            if (rawSnapshot instanceof Map<?, ?> map) {
                snapshot = new java.util.LinkedHashMap<>();
                map.forEach((key, value) -> snapshot.put(String.valueOf(key), value));
            } else {
                String symbol = resolve(request.get("symbol"));
                snapshot = analysis.analyze(symbol, string(request.get("interval"), "4h"), strategies.strategy(), 0);
            }
            String question = string(request.get("question"), "");
            return ResponseEntity.ok(ask
                    ? anthropic.askAbout(snapshot, question, strategies.strategy())
                    : anthropic.generateReport(snapshot, strategies.strategy(), strategies.prompt(), question));
        } catch (RuntimeException error) {
            return ResponseEntity.badRequest().body(Map.of("error", error.getMessage()));
        }
    }

    private String resolve(Object input) {
        return resolve(input, strategies.strategy());
    }

    private String resolve(Object input, JsonNode strategy) {
        String resolved = binance.resolveSymbol(string(input, ""));
        return universe.requireAllowed(resolved, strategy);
    }

    private JsonNode requestStrategy(Map<String, Object> request) {
        Object supplied = request.get("strategy");
        return supplied instanceof Map<?, ?> || supplied instanceof List<?> ? mapper.valueToTree(supplied) : strategies.strategy();
    }
    private static String string(Object value, String fallback) {
        String result = value == null ? "" : String.valueOf(value).trim();
        return result.isBlank() ? fallback : result;
    }
    private static int boundedInt(Object value, int fallback, int min, int max) {
        try { return Math.max(min, Math.min(max, Integer.parseInt(String.valueOf(value)))); }
        catch (RuntimeException ignored) { return fallback; }
    }
}
