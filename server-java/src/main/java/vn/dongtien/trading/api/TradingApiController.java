package vn.dongtien.trading.api;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import vn.dongtien.trading.analysis.AnalysisService;
import vn.dongtien.trading.config.StrategyService;
import vn.dongtien.trading.config.TradingUniverse;
import vn.dongtien.trading.market.BinanceClient;
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

    public TradingApiController(BinanceClient binance, StrategyService strategies, TradingUniverse universe,
                                AnalysisService analysis, WatchlistService watchlist) {
        this.binance = binance; this.strategies = strategies; this.universe = universe;
        this.analysis = analysis; this.watchlist = watchlist;
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
}
