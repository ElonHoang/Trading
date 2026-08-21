package vn.dongtien.trading.llm;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Small, dependency-free client for Anthropic's Messages API.  The old Node
 * runtime used the official SDK; keeping this HTTP client here makes the Java
 * runtime self-contained and keeps the API key on the server for Telegram and
 * CLI use.
 */
@Service
public class AnthropicService {
    private static final URI MESSAGES = URI.create("https://api.anthropic.com/v1/messages");
    private final ObjectMapper mapper;
    private final HttpClient http;
    private final String apiKey;
    private final String defaultModel;

    public AnthropicService(ObjectMapper mapper,
                            @Value("${dongtien.anthropic.api-key:}") String apiKey,
                            @Value("${dongtien.anthropic.model:claude-sonnet-4-20250514}") String defaultModel) {
        this.mapper = mapper;
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.defaultModel = defaultModel == null || defaultModel.isBlank()
                ? "claude-sonnet-4-20250514" : defaultModel.trim();
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
    }

    public boolean available() {
        return !apiKey.isBlank();
    }

    public Map<String, Object> generateReport(Map<String, Object> snapshot, JsonNode strategy) {
        String system = "";
        if (strategy != null && strategy.has("_prompt")) system = strategy.path("_prompt").asText("");
        return generateReport(snapshot, strategy, system, null);
    }

    public Map<String, Object> generateReport(Map<String, Object> snapshot, JsonNode strategy,
                                               String systemPrompt, String question) {
        String user = "Phân tích token " + snapshot.getOrDefault("symbol", "") + " trên khung thời gian "
                + snapshot.getOrDefault("interval", "") + "."
                + (question == null || question.isBlank() ? "" : "\nYêu cầu thêm từ người dùng: " + question)
                + "\n\nDữ liệu (JSON):\n```json\n"
                + compactSnapshot(snapshot) + "\n```\n\n"
                + "Chỉ diễn giải từ dữ liệu đã cho. Nêu rõ các tín hiệu xung đột, rủi ro và mức độ không chắc chắn."
                + " Không coi đây là lời khuyên đầu tư chắc chắn.";
        return message(resolveModel(strategy), maxTokens(strategy, 6000), systemPrompt, user);
    }

    public Map<String, Object> askAbout(Map<String, Object> snapshot, String question, JsonNode strategy) {
        String system = "Bạn là chuyên gia phân tích kỹ thuật crypto. Trả lời ngắn gọn bằng tiếng Việt, "
                + "chỉ dựa trên dữ liệu JSON được cung cấp, không bịa thêm dữ liệu ngoài. "
                + "Nêu rủi ro và không đưa ra cam kết lợi nhuận.";
        String user = "Dữ liệu phân tích " + snapshot.getOrDefault("symbol", "") + " "
                + snapshot.getOrDefault("interval", "") + ":\n```json\n" + compactSnapshot(snapshot)
                + "\n```\n\nCâu hỏi: " + (question == null ? "" : question.trim());
        return message(resolveModel(strategy), Math.min(maxTokens(strategy, 6000), 3000), system, user);
    }

    private Map<String, Object> message(String model, int maxTokens, String system, String user) {
        if (!available()) {
            throw new IllegalStateException("Chưa cấu hình ANTHROPIC_API_KEY");
        }
        try {
            ObjectNode body = mapper.createObjectNode();
            body.put("model", model);
            body.put("max_tokens", Math.max(1, maxTokens));
            if (system != null && !system.isBlank()) body.put("system", system);
            ArrayNode messages = body.putArray("messages");
            messages.addObject().put("role", "user").put("content", user);

            HttpRequest request = HttpRequest.newBuilder(MESSAGES)
                    .timeout(Duration.ofSeconds(120))
                    .header("Content-Type", "application/json")
                    .header("x-api-key", apiKey)
                    .header("anthropic-version", "2023-06-01")
                    .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
                    .build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            JsonNode payload = mapper.readTree(response.body());
            if (response.statusCode() / 100 != 2) {
                String message = payload.path("error").path("message").asText("");
                if (message.isBlank()) message = "Anthropic HTTP " + response.statusCode();
                throw new IllegalStateException(message);
            }
            String stop = payload.path("stop_reason").asText("");
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("model", payload.path("model").asText(model));
            if ("refusal".equals(stop)) {
                result.put("text", null);
                result.put("refusal", payload.path("stop_details").path("explanation")
                        .asText("Yêu cầu bị từ chối bởi bộ lọc an toàn."));
            } else {
                StringBuilder text = new StringBuilder();
                for (JsonNode block : payload.path("content")) {
                    if ("text".equals(block.path("type").asText())) {
                        if (!text.isEmpty()) text.append('\n');
                        text.append(block.path("text").asText());
                    }
                }
                result.put("text", text.toString().trim());
                result.put("truncated", "max_tokens".equals(stop));
            }
            Map<String, Object> usage = new LinkedHashMap<>();
            JsonNode rawUsage = payload.path("usage");
            if (rawUsage.has("input_tokens")) usage.put("inputTokens", rawUsage.path("input_tokens").asInt());
            if (rawUsage.has("output_tokens")) usage.put("outputTokens", rawUsage.path("output_tokens").asInt());
            if (rawUsage.has("cache_read_input_tokens")) usage.put("cacheRead", rawUsage.path("cache_read_input_tokens").asInt());
            if (!usage.isEmpty()) result.put("usage", usage);
            return result;
        } catch (IOException exception) {
            throw new IllegalStateException("Không gọi được Anthropic", exception);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Yêu cầu Anthropic bị gián đoạn", exception);
        }
    }

    private String resolveModel(JsonNode strategy) {
        String configured = strategy == null ? "" : strategy.path("llm").path("model").asText("").trim();
        return configured.isBlank() ? defaultModel : configured;
    }

    private static int maxTokens(JsonNode strategy, int fallback) {
        int configured = strategy == null ? fallback : strategy.path("llm").path("maxTokens").asInt(fallback);
        return Math.max(1, Math.min(configured, 16_000));
    }

    private String compactSnapshot(Map<String, Object> source) {
        Map<String, Object> copy = new LinkedHashMap<>(source);
        copy.remove("featureNames");
        // A full candle series is useful for charts but wastes context in an LLM report.
        copy.remove("series");
        try {
            return mapper.writerWithDefaultPrettyPrinter().writeValueAsString(copy);
        } catch (RuntimeException exception) {
            return String.valueOf(copy);
        }
    }
}
