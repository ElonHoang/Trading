import pg from 'pg';

const { Pool } = pg;

let pool;

function database() {
  if (pool) return pool;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const host = process.env.PGHOST?.trim();
  if (!databaseUrl && !host) {
    throw new Error(
      'Thiếu DATABASE_URL hoặc PGHOST. Ứng dụng chỉ dùng PostgreSQL và không còn fallback về file JSON.',
    );
  }
  const sslEnabled = /^(1|true|yes|on)$/i.test(process.env.DATABASE_SSL ?? 'false');
  const rejectUnauthorized = !/^(0|false|no|off)$/i.test(
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? 'true',
  );
  pool = new Pool({
    ...(databaseUrl ? { connectionString: databaseUrl } : {
      host,
      port: Number(process.env.PGPORT) || 5432,
      database: process.env.PGDATABASE || 'trading',
      user: process.env.PGUSER || 'trading',
      password: process.env.PGPASSWORD,
    }),
    max: Math.max(1, Number(process.env.DATABASE_POOL_SIZE) || 10),
    ssl: sslEnabled ? { rejectUnauthorized } : false,
  });
  return pool;
}

let schemaPromise;

export function ensureDatabase() {
  schemaPromise ??= database().query(`
    CREATE TABLE IF NOT EXISTS public.app_documents (
      document_key VARCHAR(255) PRIMARY KEY,
      document_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS app_documents_updated_at_idx
      ON public.app_documents (updated_at DESC);
  `).catch((error) => {
    schemaPromise = undefined;
    throw error;
  });
  return schemaPromise;
}

const clone = (value) => (value == null ? value : structuredClone(value));

export async function getDocument(key, fallback = null) {
  await ensureDatabase();
  const result = await database().query(
    'SELECT document_value FROM public.app_documents WHERE document_key = $1',
    [key],
  );
  return result.rowCount ? result.rows[0].document_value : clone(fallback);
}

export async function requireDocument(key, description = key) {
  const value = await getDocument(key);
  if (value == null) {
    throw new Error(`Database chưa có ${description}. Chạy \"npm run db:import-files\" một lần.`);
  }
  return value;
}

export async function putDocument(key, value, client = null) {
  await ensureDatabase();
  await (client ?? database()).query(`
    INSERT INTO public.app_documents (document_key, document_value, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (document_key) DO UPDATE
      SET document_value = EXCLUDED.document_value,
          updated_at = NOW()
  `, [key, JSON.stringify(value)]);
  return value;
}

export async function deleteDocument(key) {
  await ensureDatabase();
  const result = await database().query(
    'DELETE FROM public.app_documents WHERE document_key = $1',
    [key],
  );
  return result.rowCount > 0;
}

export async function listDocuments(prefix) {
  await ensureDatabase();
  const result = await database().query(`
    SELECT document_key, document_value, updated_at
    FROM public.app_documents
    WHERE document_key LIKE $1
    ORDER BY updated_at DESC, document_key ASC
  `, [`${prefix}%`]);
  return result.rows.map((row) => ({
    key: row.document_key,
    value: row.document_value,
    updatedAt: row.updated_at,
  }));
}

/** Cập nhật nguyên tử một document bằng SELECT ... FOR UPDATE. */
export async function updateDocument(key, fallback, updater) {
  await ensureDatabase();
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    // Khoá cả trường hợp document chưa tồn tại; chỉ SELECT FOR UPDATE thì hai
    // tiến trình có thể cùng đọc fallback rồi ghi đè kết quả của nhau.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    const selected = await client.query(
      'SELECT document_value FROM public.app_documents WHERE document_key = $1 FOR UPDATE',
      [key],
    );
    const current = selected.rowCount ? selected.rows[0].document_value : clone(fallback);
    const next = await updater(clone(current));
    await putDocument(key, next, client);
    await client.query('COMMIT');
    return next;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase() {
  if (pool) await pool.end();
  pool = undefined;
  schemaPromise = undefined;
}

/** Dùng cho schema migration và các tác vụ cần một session PostgreSQL riêng. */
export async function withDatabaseClient(callback) {
  const client = await database().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}
