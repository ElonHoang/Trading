package vn.dongtien.trading.data;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import vn.dongtien.auth.DocumentStore;

import java.util.ArrayList;
import java.util.List;

/** Durable list of Telegram chat ids which opted in to automatic alerts. */
@Service
public class SubscriberService {
    public static final String KEY = "data:subscribers";

    private final DocumentStore documents;
    private final ObjectMapper mapper;

    public SubscriberService(DocumentStore documents, ObjectMapper mapper) {
        this.documents = documents;
        this.mapper = mapper;
    }

    public synchronized List<String> readSubscribers() {
        JsonNode value = documents.find(KEY).orElse(null);
        if (value == null || !value.isArray()) return List.of();
        List<String> ids = new ArrayList<>();
        for (JsonNode entry : value) ids.add(entry.asText());
        return ids;
    }

    public synchronized List<String> addSubscriber(Object chatId) {
        String id = String.valueOf(chatId);
        List<String> ids = new ArrayList<>(readSubscribers());
        if (!ids.contains(id)) ids.add(id);
        return save(ids);
    }

    public synchronized List<String> removeSubscriber(Object chatId) {
        String id = String.valueOf(chatId);
        List<String> ids = new ArrayList<>(readSubscribers());
        ids.removeIf(id::equals);
        return save(ids);
    }

    private List<String> save(List<String> ids) {
        ArrayNode value = mapper.createArrayNode();
        ids.forEach(value::add);
        documents.put(KEY, value);
        return List.copyOf(ids);
    }
}
