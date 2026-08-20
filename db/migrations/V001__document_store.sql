-- TiDB/MySQL document store. The selected TiDB database is the application
-- namespace, so table names must remain unqualified (no PostgreSQL public schema).
CREATE TABLE IF NOT EXISTS app_documents (
  document_key VARCHAR(255) NOT NULL,
  document_value JSON NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (document_key),
  KEY app_documents_updated_at_idx (updated_at)
);
