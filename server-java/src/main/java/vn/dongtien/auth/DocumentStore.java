package vn.dongtien.auth;

import tools.jackson.databind.JsonNode;

import java.util.List;
import java.util.Optional;

public interface DocumentStore {
    Optional<JsonNode> find(String key);

    List<StoredDocument> findByPrefix(String prefix);

    void put(String key, JsonNode value);

    boolean delete(String key);

    record StoredDocument(String key, JsonNode value) {}
}
