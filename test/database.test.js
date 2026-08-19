import test from 'node:test';
import assert from 'node:assert/strict';

test('PostgreSQL document store supports atomic runtime persistence', {
  skip: !process.env.DATABASE_URL && !process.env.PGHOST,
}, async () => {
  const {
    closeDatabase, deleteDocument, getDocument, putDocument, updateDocument,
  } = await import('../src/db.js');
  const key = `test:document:${Date.now()}:${Math.random()}`;
  try {
    await putDocument(key, { count: 1 });
    assert.deepEqual(await getDocument(key), { count: 1 });
    await updateDocument(key, {}, (value) => ({ count: value.count + 1 }));
    assert.deepEqual(await getDocument(key), { count: 2 });
    assert.equal(await deleteDocument(key), true);
    assert.equal(await getDocument(key), null);
  } finally {
    await deleteDocument(key).catch(() => {});
    await closeDatabase();
  }
});
