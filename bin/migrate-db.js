import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDatabase, withDatabaseClient } from '../src/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');
const VERSION = /^(V[0-9]+)__.+[.]sql$/;
const REPEATABLE = /^R__.+[.]sql$/;

const checksum = (text) => crypto.createHash('sha256').update(text).digest('hex');

try {
  await withDatabaseClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version VARCHAR(32) PRIMARY KEY,
        filename TEXT NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query("SELECT pg_advisory_lock(hashtext('ta-ai-bot-schema-migrations'))");
    try {
      const files = (await fs.readdir(MIGRATIONS_DIR))
        .filter((file) => VERSION.test(file) || REPEATABLE.test(file))
        .sort((a, b) => {
          const aRepeatable = REPEATABLE.test(a);
          const bRepeatable = REPEATABLE.test(b);
          if (aRepeatable !== bRepeatable) return aRepeatable ? 1 : -1;
          return a.localeCompare(b);
        });

      for (const filename of files) {
        const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
        if (REPEATABLE.test(filename)) {
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await client.query('COMMIT');
            console.log(`repeated ${filename}`);
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
          continue;
        }

        const version = VERSION.exec(filename)[1];
        const hash = checksum(sql);
        const existing = await client.query(
          'SELECT filename, checksum FROM public.schema_migrations WHERE version = $1',
          [version],
        );
        if (existing.rowCount) {
          if (existing.rows[0].checksum !== hash) {
            throw new Error(
              `Migration ${version} đã chạy nhưng checksum thay đổi (${existing.rows[0].filename}).`,
            );
          }
          console.log(`kept     ${filename}`);
          continue;
        }

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(`
            INSERT INTO public.schema_migrations (version, filename, checksum)
            VALUES ($1, $2, $3)
          `, [version, filename, hash]);
          await client.query('COMMIT');
          console.log(`applied  ${filename}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('ta-ai-bot-schema-migrations'))");
    }
  });
} finally {
  await closeDatabase();
}
