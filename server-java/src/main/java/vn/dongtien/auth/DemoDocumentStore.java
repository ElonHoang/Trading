package vn.dongtien.auth;

import jakarta.annotation.PostConstruct;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

@Repository
@Profile("demo")
public class DemoDocumentStore implements DocumentStore {
    private final ObjectMapper mapper;
    private final Map<String, JsonNode> values = new ConcurrentHashMap<>();

    public DemoDocumentStore(ObjectMapper mapper) { this.mapper = mapper; }

    @PostConstruct
    void loadFiles() {
        Path root = Path.of("").toAbsolutePath().normalize();
        if (!Files.isRegularFile(root.resolve("config/strategy.json")) && Files.isRegularFile(root.resolve("../config/strategy.json"))) {
            root = root.resolve("..").normalize();
        }
        readJson(root.resolve("config/strategy.json"), "config:strategy");
        readText(root.resolve("config/prompt.md"), "config:prompt");
        readJson(root.resolve("data/watchlist.json"), "data:watchlist");
        Path models = root.resolve("models");
        if (Files.isDirectory(models)) {
            try (var files = Files.list(models)) {
                files.filter(path -> path.getFileName().toString().endsWith(".json"))
                        .filter(path -> !path.getFileName().toString().equals("index.json"))
                        .forEach(path -> {
                            try {
                                JsonNode model = mapper.readTree(Files.readString(path));
                                String symbol = model.path("symbol").asText();
                                String interval = model.path("interval").asText();
                                if (!symbol.isBlank() && !interval.isBlank()) values.put("model:" + symbol.toUpperCase() + "_" + interval, model);
                            } catch (IOException ignored) {}
                        });
            } catch (IOException ignored) {}
        }
    }

    @Override public Optional<JsonNode> find(String key) { return Optional.ofNullable(values.get(key)); }
    @Override public List<StoredDocument> findByPrefix(String prefix) {
        List<StoredDocument> result = new ArrayList<>();
        values.forEach((key, value) -> { if (key.startsWith(prefix)) result.add(new StoredDocument(key, value)); });
        result.sort(Comparator.comparing(StoredDocument::key)); return result;
    }
    @Override public void put(String key, JsonNode value) { values.put(key, value); }
    @Override public boolean delete(String key) { return values.remove(key) != null; }

    private void readJson(Path path, String key) {
        if (!Files.isRegularFile(path)) return;
        try { values.put(key, mapper.readTree(Files.readString(path))); } catch (IOException ignored) {}
    }
    private void readText(Path path, String key) {
        if (!Files.isRegularFile(path)) return;
        try { values.put(key, mapper.valueToTree(Map.of("text", Files.readString(path)))); } catch (IOException ignored) {}
    }
}
