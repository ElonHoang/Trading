package vn.dongtien.trading.config;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import vn.dongtien.auth.DocumentStore;

import java.util.List;

@Service
public class StrategyService {
    private static final String STRATEGY_KEY = "config:strategy";
    private static final String PROMPT_KEY = "config:prompt";
    private final DocumentStore documents;
    private final ObjectMapper mapper;

    public StrategyService(DocumentStore documents, ObjectMapper mapper) { this.documents = documents; this.mapper = mapper; }

    public JsonNode strategy() {
        return documents.find(STRATEGY_KEY).orElseThrow(() ->
                new IllegalStateException("Database chưa có cấu hình strategy. Chạy lệnh Java import-files."));
    }

    public String prompt() {
        JsonNode value = documents.find(PROMPT_KEY).orElseThrow(() ->
                new IllegalStateException("Database chưa có system prompt. Chạy lệnh Java import-files."));
        return value.isTextual() ? value.asText() : value.path("text").asText();
    }

    public void saveStrategy(JsonNode value) { documents.put(STRATEGY_KEY, value); }
    public void savePrompt(String value) { documents.put(PROMPT_KEY, mapper.valueToTree(java.util.Map.of("text", value))); }

    public List<String> flatten() {
        java.util.ArrayList<String> result = new java.util.ArrayList<>();
        flatten(strategy(), "", result);
        return result;
    }

    private static void flatten(JsonNode node, String prefix, List<String> result) {
        node.properties().forEach(entry -> {
            if (entry.getKey().startsWith("_")) return;
            String path = prefix.isEmpty() ? entry.getKey() : prefix + "." + entry.getKey();
            if (entry.getValue().isObject()) flatten(entry.getValue(), path, result);
            else result.add(path + " = " + entry.getValue());
        });
    }
}
