package vn.dongtien.auth;

import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class TradingPerformanceController {
    private final TradingPerformanceService service;

    public TradingPerformanceController(TradingPerformanceService service) {
        this.service = service;
    }

    @GetMapping("/api/trading-performance")
    ResponseEntity<?> performance(@RequestParam(defaultValue = "week") String range) {
        try {
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.noStore())
                    .body(service.performance(range));
        } catch (IllegalArgumentException exception) {
            return ResponseEntity.badRequest().body(Map.of("error", exception.getMessage()));
        }
    }
}
