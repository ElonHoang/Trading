package vn.dongtien.trading.runtime;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import vn.dongtien.auth.DocumentStore;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

@Service
public class ImportFilesService {
    private final DocumentStore documents;
    private final ObjectMapper mapper;

    public ImportFilesService(DocumentStore documents, ObjectMapper mapper) { this.documents = documents; this.mapper = mapper; }

    public List<String> run(Path root, boolean overwrite) {
        List<String> imported = new ArrayList<>();
        importJson(root.resolve("config/strategy.json"), "config:strategy", overwrite, imported);
        importText(root.resolve("config/prompt.md"), "config:prompt", overwrite, imported);
        importJson(root.resolve("data/watchlist.json"), "data:watchlist", overwrite, imported);
        importJson(root.resolve("data/subscribers.json"), "data:subscribers", overwrite, imported);
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
                                if (!symbol.isBlank() && !interval.isBlank()) {
                                    put("model:" + symbol.toUpperCase() + "_" + interval, model, overwrite, imported);
                                }
                            } catch (IOException | RuntimeException error) {
                                throw new IllegalStateException("Không import được " + path + ": " + error.getMessage(), error);
                            }
                        });
            } catch (IOException error) { throw new IllegalStateException("Không đọc được thư mục models", error); }
        }
        return imported;
    }

    private void importJson(Path file, String key, boolean overwrite, List<String> imported) {
        if (!Files.isRegularFile(file)) return;
        try { put(key, mapper.readTree(Files.readString(file)), overwrite, imported); }
        catch (IOException error) { throw new IllegalStateException("Không đọc được " + file, error); }
    }
    private void importText(Path file, String key, boolean overwrite, List<String> imported) {
        if (!Files.isRegularFile(file)) return;
        try { put(key, mapper.valueToTree(java.util.Map.of("text", Files.readString(file))), overwrite, imported); }
        catch (IOException error) { throw new IllegalStateException("Không đọc được " + file, error); }
    }
    private void put(String key, JsonNode value, boolean overwrite, List<String> imported) {
        if (!overwrite && documents.find(key).isPresent()) return;
        documents.put(key, value); imported.add(key);
    }
}
