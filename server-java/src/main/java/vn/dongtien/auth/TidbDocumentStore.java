package vn.dongtien.auth;

import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;

/**
 * JSON document persistence for TiDB Cloud's MySQL-compatible SQL dialect.
 *
 * <p>Document values are passed to the JDBC driver as JSON text. TiDB validates
 * the text when it writes to the {@code JSON} column, so no database-specific
 * casts or driver-specific JSON wrapper are needed.</p>
 */
@Repository
@Profile("!test & !demo")
public class TidbDocumentStore implements DocumentStore {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public TidbDocumentStore(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    @Override
    public Optional<JsonNode> find(String key) {
        List<JsonNode> rows = jdbc.query(
                "SELECT document_value FROM app_documents WHERE document_key = ?",
                (result, row) -> read(result.getString(1)), key);
        return rows.stream().findFirst();
    }

    @Override
    public List<StoredDocument> findByPrefix(String prefix) {
        return jdbc.query("""
                        SELECT document_key, document_value
                        FROM app_documents
                        WHERE document_key LIKE ?
                        ORDER BY updated_at DESC, document_key ASC
                        """,
                (result, row) -> new StoredDocument(result.getString(1), read(result.getString(2))),
                prefix + "%");
    }

    @Override
    public void put(String key, JsonNode value) {
        String json = value.toString();
        jdbc.update("""
                INSERT INTO app_documents (document_key, document_value)
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE
                  document_value = ?, updated_at = CURRENT_TIMESTAMP(6)
                """, key, json, json);
    }

    @Override
    public boolean delete(String key) {
        return jdbc.update("DELETE FROM app_documents WHERE document_key = ?", key) > 0;
    }

    private JsonNode read(String json) {
        try {
            return mapper.readTree(json);
        } catch (RuntimeException exception) {
            throw new IllegalStateException("Document trong TiDB khong phai JSON hop le", exception);
        }
    }
}
