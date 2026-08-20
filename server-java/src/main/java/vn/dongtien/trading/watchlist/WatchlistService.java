package vn.dongtien.trading.watchlist;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import vn.dongtien.auth.DocumentStore;
import vn.dongtien.trading.config.StrategyService;
import vn.dongtien.trading.config.TradingUniverse;

import java.util.ArrayList;
import java.util.List;

@Service
public class WatchlistService {
    private static final String KEY = "data:watchlist";
    private final DocumentStore documents;
    private final ObjectMapper mapper;
    private final StrategyService strategies;
    private final TradingUniverse universe;

    public WatchlistService(DocumentStore documents, ObjectMapper mapper, StrategyService strategies, TradingUniverse universe) {
        this.documents = documents;
        this.mapper = mapper;
        this.strategies = strategies;
        this.universe = universe;
    }

    public synchronized List<String> read() {
        JsonNode value = documents.find(KEY).orElse(null);
        List<String> result = new ArrayList<>();
        if (value != null && value.isArray()) for (JsonNode item : value) result.add(item.asText());
        return result;
    }

    public synchronized List<String> add(String input) {
        String symbol = universe.requireAllowed(input, strategies.strategy());
        List<String> values = read();
        if (!values.contains(symbol)) values.add(symbol);
        documents.put(KEY, mapper.valueToTree(values));
        return values;
    }

    public synchronized List<String> remove(String input) {
        String symbol = input == null ? "" : input.trim().toUpperCase();
        List<String> values = read();
        values.removeIf(symbol::equals);
        documents.put(KEY, mapper.valueToTree(values));
        return values;
    }
}
