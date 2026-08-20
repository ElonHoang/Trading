package vn.dongtien.trading.config;

import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import vn.dongtien.trading.market.BinanceClient;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

@Component
public class TradingUniverse {
    public List<String> symbols(JsonNode strategy) {
        JsonNode configured = strategy == null ? null : strategy.path("alerts").path("tradeSymbols");
        if (configured == null || !configured.isArray() || configured.isEmpty()) {
            throw new IllegalArgumentException("Thiếu alerts.tradeSymbols: bot không được phép tạo kèo khi chưa có whitelist.");
        }
        Set<String> result = new LinkedHashSet<>();
        for (JsonNode item : configured) {
            String raw = item.asText("").trim();
            if (raw.isEmpty()) throw new IllegalArgumentException("alerts.tradeSymbols không được chứa mã trống.");
            String symbol = BinanceClient.normalizeSymbol(raw);
            if (!symbol.endsWith("USDT")) {
                throw new IllegalArgumentException("alerts.tradeSymbols chỉ nhận cặp USDT, nhận được \"" + raw + "\".");
            }
            result.add(symbol);
        }
        return new ArrayList<>(result);
    }

    public String requireAllowed(String input, JsonNode strategy) {
        String symbol = BinanceClient.normalizeSymbol(input);
        if (!symbols(strategy).contains(symbol)) {
            throw new IllegalArgumentException(symbol + " không nằm trong danh sách token được phép giao dịch.");
        }
        return symbol;
    }
}
