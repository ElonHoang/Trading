package vn.dongtien.trading.model;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import vn.dongtien.auth.DocumentStore;

import java.util.List;
import java.util.Locale;

@Service
public class ModelStore {
    private final DocumentStore documents;
    public ModelStore(DocumentStore documents) { this.documents = documents; }

    public JsonNode load(String symbol, String interval) {
        return documents.find(key(symbol, interval)).orElse(null);
    }

    public void save(String symbol, String interval, JsonNode model) { documents.put(key(symbol, interval), model); }
    public boolean delete(String symbol, String interval) { return documents.delete(key(symbol, interval)); }
    public List<DocumentStore.StoredDocument> list() { return documents.findByPrefix("model:"); }

    private static String key(String symbol, String interval) {
        String safeSymbol = symbol.replaceAll("[^A-Za-z0-9]", "").toUpperCase(Locale.ROOT);
        String safeInterval = interval.replaceAll("[^A-Za-z0-9]", "");
        return "model:" + safeSymbol + "_" + safeInterval;
    }
}
