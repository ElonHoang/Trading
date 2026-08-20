package vn.dongtien.auth;

import jakarta.annotation.PostConstruct;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;

@Repository
@Profile("!test & !demo")
public class PostgresDocumentStore implements DocumentStore {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public PostgresDocumentStore(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    @PostConstruct
    void createSchema() {
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS public.app_documents (
                  document_key VARCHAR(255) PRIMARY KEY,
                  document_value JSONB NOT NULL,
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """);
        jdbc.execute("""
                CREATE INDEX IF NOT EXISTS app_documents_updated_at_idx
                  ON public.app_documents (updated_at DESC)
                """);
    }

    @Override
    public Optional<JsonNode> find(String key) {
        List<JsonNode> rows = jdbc.query(
                "SELECT document_value::text FROM public.app_documents WHERE document_key = ?",
                (result, row) -> read(result.getString(1)), key);
        return rows.stream().findFirst();
    }

    @Override
    public List<StoredDocument> findByPrefix(String prefix) {
        return jdbc.query("""
                        SELECT document_key, document_value::text
                        FROM public.app_documents
                        WHERE document_key LIKE ?
                        ORDER BY updated_at DESC, document_key ASC
                        """,
                (result, row) -> new StoredDocument(result.getString(1), read(result.getString(2))),
                prefix + "%");
    }

    @Override
    public void put(String key, JsonNode value) {
        jdbc.update("""
                INSERT INTO public.app_documents (document_key, document_value, updated_at)
                VALUES (?, ?::jsonb, NOW())
                ON CONFLICT (document_key) DO UPDATE
                  SET document_value = EXCLUDED.document_value, updated_at = NOW()
                """, key, value.toString());
    }

    @Override
    public boolean delete(String key) {
        return jdbc.update("DELETE FROM public.app_documents WHERE document_key = ?", key) > 0;
    }

    private JsonNode read(String json) {
        try {
            return mapper.readTree(json);
        } catch (RuntimeException exception) {
            throw new IllegalStateException("Document trong PostgreSQL không phải JSON hợp lệ", exception);
        }
    }
}
