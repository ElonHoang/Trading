package vn.dongtien.trading.data;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.auth.DocumentStore;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Persists monitor de-duplication state between process and GitHub Actions
 * runs.  It intentionally contains no call state; live calls are owned by
 * {@link OpenCallService}.
 */
@Service
public class MonitorStateService {
    public static final String KEY = "data:monitor-state";
    private final DocumentStore documents;
    private final ObjectMapper mapper;

    public MonitorStateService(DocumentStore documents, ObjectMapper mapper) {
        this.documents = documents;
        this.mapper = mapper;
    }

    public synchronized Map<String, StateEntry> readMonitorState() {
        Map<String, StateEntry> result = new LinkedHashMap<>();
        JsonNode root = documents.find(KEY).orElse(null);
        if (root == null || !root.isObject()) return result;
        root.properties().forEach(entry -> {
            JsonNode value = entry.getValue();
            if (value != null && value.isObject()) {
                Long candle = value.path("lastCandleTime").isNumber() ? value.path("lastCandleTime").asLong() : null;
                String signal = value.path("lastSignal").isNull() || value.path("lastSignal").isMissingNode()
                        ? null : value.path("lastSignal").asText(null);
                result.put(entry.getKey(), new StateEntry(candle, signal));
            }
        });
        return result;
    }

    public synchronized void saveMonitorState(Map<String, StateEntry> state) {
        ObjectNode root = mapper.createObjectNode();
        if (state != null) state.forEach((key, value) -> {
            if (key == null || value == null) return;
            ObjectNode row = root.putObject(key);
            if (value.lastCandleTime() == null) row.putNull("lastCandleTime");
            else row.put("lastCandleTime", value.lastCandleTime());
            if (value.lastSignal() == null) row.putNull("lastSignal");
            else row.put("lastSignal", value.lastSignal());
        });
        documents.put(KEY, root);
    }

    public record StateEntry(Long lastCandleTime, String lastSignal) {}
}
