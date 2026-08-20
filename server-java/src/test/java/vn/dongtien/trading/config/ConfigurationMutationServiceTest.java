package vn.dongtien.trading.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import vn.dongtien.auth.DocumentStore;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ConfigurationMutationServiceTest {
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void updatesExistingLeavesWithTypeAwareCoercionWithoutMutatingTheOldTree() throws Exception {
        MemoryDocumentStore documents = new MemoryDocumentStore();
        JsonNode original = mapper.readTree("""
                {"weights":{"trend":10},"enabled":false,"mode":"balanced","risk":{"takeProfitR":[1,2,3]}}
                """);
        documents.put("config:strategy", original);
        documents.put("config:prompt", mapper.valueToTree(Map.of("text", "old prompt")));
        ConfigurationMutationService service = service(documents, Path.of("config"));

        var number = service.setStrategyValue("weights.trend", "30.5");
        assertEquals(10, number.oldValue().asInt());
        assertEquals(30.5, number.newValue().asDouble());
        assertEquals(10, original.path("weights").path("trend").asInt(), "the source tree stays untouched");

        service.setStrategyValue("enabled", "on");
        service.setStrategyValue("mode", "careful mode");
        service.setStrategyValue("risk.takeProfitR", "0.5, 1, tp3");
        JsonNode saved = documents.find("config:strategy").orElseThrow();
        assertTrue(saved.path("enabled").asBoolean());
        assertEquals("careful mode", saved.path("mode").asText());
        assertEquals(0.5, saved.path("risk").path("takeProfitR").get(0).asDouble());
        assertEquals("tp3", saved.path("risk").path("takeProfitR").get(2).asText());
    }

    @Test
    void rejectsUnknownOrNonLeafPaths() throws Exception {
        MemoryDocumentStore documents = seededDocuments();
        ConfigurationMutationService service = service(documents, Path.of("config"));

        assertThrows(IllegalArgumentException.class, () -> service.setStrategyValue("weights.missing", "3"));
        assertThrows(IllegalArgumentException.class, () -> service.setStrategyValue("weights", "3"));
        assertThrows(IllegalArgumentException.class, () -> service.setStrategyValue("enabled", "perhaps"));
        assertThrows(IllegalArgumentException.class, () -> service.setStrategyValue("weights..trend", "3"));
    }

    @Test
    void restoresStrategyAndPromptFromExplicitConfigDirectory(@TempDir Path tempDirectory) throws Exception {
        Path config = Files.createDirectories(tempDirectory.resolve("config"));
        Files.writeString(config.resolve("strategy.json"), "{\"weights\":{\"trend\":99},\"enabled\":true}", StandardCharsets.UTF_8);
        Files.writeString(config.resolve("prompt.md"), "restored system prompt", StandardCharsets.UTF_8);
        MemoryDocumentStore documents = seededDocuments();
        ConfigurationMutationService service = service(documents, config);

        var strategyResult = service.resetStrategyFromConfigFile();
        var promptResult = service.resetPromptFromConfigFile();

        assertTrue(strategyResult.restored(), strategyResult.message());
        assertTrue(promptResult.restored(), promptResult.message());
        assertEquals(99, documents.find("config:strategy").orElseThrow().path("weights").path("trend").asInt());
        assertEquals("restored system prompt", new StrategyService(documents, mapper).prompt());
    }

    @Test
    void reportsMissingResetFileWithoutChangingPersistedData(@TempDir Path tempDirectory) throws Exception {
        MemoryDocumentStore documents = seededDocuments();
        ConfigurationMutationService service = service(documents, tempDirectory);

        var result = service.resetStrategyFromConfigFile();

        assertFalse(result.restored());
        assertTrue(result.message().contains("Không tìm thấy"));
        assertEquals(10, documents.find("config:strategy").orElseThrow().path("weights").path("trend").asInt());
    }

    private ConfigurationMutationService service(MemoryDocumentStore documents, Path config) {
        return new ConfigurationMutationService(new StrategyService(documents, mapper), mapper, config);
    }

    private MemoryDocumentStore seededDocuments() throws Exception {
        MemoryDocumentStore documents = new MemoryDocumentStore();
        documents.put("config:strategy", mapper.readTree("""
                {"weights":{"trend":10},"enabled":false,"mode":"balanced","risk":{"takeProfitR":[1,2,3]}}
                """));
        documents.put("config:prompt", mapper.valueToTree(Map.of("text", "old prompt")));
        return documents;
    }

    private static final class MemoryDocumentStore implements DocumentStore {
        private final Map<String, JsonNode> values = new HashMap<>();

        @Override public Optional<JsonNode> find(String key) { return Optional.ofNullable(values.get(key)); }
        @Override public List<StoredDocument> findByPrefix(String prefix) {
            return values.entrySet().stream().filter(entry -> entry.getKey().startsWith(prefix))
                    .map(entry -> new StoredDocument(entry.getKey(), entry.getValue())).toList();
        }
        @Override public void put(String key, JsonNode value) { values.put(key, value); }
        @Override public boolean delete(String key) { return values.remove(key) != null; }
    }
}
