package vn.dongtien.auth;

import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

import java.util.List;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

@RestController
@RequestMapping("/api/content")
public class DatabaseContentController {
    private final DocumentStore documents;

    public DatabaseContentController(DocumentStore documents) {
        this.documents = documents;
    }

    @GetMapping("/strategy")
    ResponseEntity<?> strategy() {
        return json("config:strategy", "Database chưa có strategy. Chạy npm run db:import-files.");
    }

    @GetMapping(value = "/prompt", produces = MediaType.TEXT_PLAIN_VALUE)
    ResponseEntity<?> prompt() {
        return documents.find("config:prompt")
                .map(value -> {
                    JsonNode text = value.isTextual() ? value : value.path("text");
                    return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(text.asText(""));
                })
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/models")
    ResponseEntity<List<Map<String, Object>>> models() {
        List<Map<String, Object>> rows = documents.findByPrefix("model:").stream().map(row -> {
            JsonNode model = row.value();
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("symbol", model.path("symbol").asText(""));
            metadata.put("interval", model.path("interval").asText(""));
            metadata.put("trainedAt", model.path("trainedAt").asText(""));
            metadata.put("samples", nullableNumber(model.path("dataset").path("samples")));
            metadata.put("testAuc", nullableNumber(model.path("metrics").path("test").path("auc")));
            metadata.put("testAccuracy", nullableNumber(model.path("metrics").path("test").path("accuracy")));
            metadata.put("walkForwardAuc", nullableNumber(model.path("metrics").path("walkForward").path("meanAuc")));
            metadata.put("source", "database");
            return metadata;
        }).toList();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(rows);
    }

    @GetMapping("/models/{symbol}/{interval}")
    ResponseEntity<?> model(@PathVariable String symbol, @PathVariable String interval) {
        String safeSymbol = symbol.replaceAll("[^A-Za-z0-9]", "").toUpperCase(Locale.ROOT);
        String safeInterval = interval.replaceAll("[^A-Za-z0-9]", "");
        return json("model:" + safeSymbol + "_" + safeInterval, "Không tìm thấy model");
    }

    private ResponseEntity<?> json(String key, String error) {
        return documents.find(key)
                .<ResponseEntity<?>>map(value -> ResponseEntity.ok()
                        .cacheControl(CacheControl.noStore()).body(value))
                .orElseGet(() -> ResponseEntity.status(404).body(Map.of("error", error)));
    }

    private static Object nullableNumber(JsonNode value) {
        return value.isNumber() ? value.numberValue() : null;
    }
}
