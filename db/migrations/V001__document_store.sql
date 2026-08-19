-- Lớp tương thích trong giai đoạn chuyển repository sang schema chuẩn hóa.
CREATE TABLE IF NOT EXISTS public.app_documents (
  document_key VARCHAR(255) PRIMARY KEY,
  document_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_documents_value_not_null CHECK (document_value <> 'null'::jsonb)
);

CREATE INDEX IF NOT EXISTS app_documents_updated_at_idx
  ON public.app_documents (updated_at DESC);
