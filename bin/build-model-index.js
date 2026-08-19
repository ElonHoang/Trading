// Tên lệnh được giữ để tương thích. Manifest giờ được dựng trực tiếp từ PostgreSQL.

import { closeDatabase } from '../src/db.js';
import { listModels } from '../src/ml/model-store.js';

try {
  const models = await listModels();
  console.log(JSON.stringify(models, null, 2));
  console.error(`Database có ${models.length} model; không còn tạo models/index.json.`);
} finally {
  await closeDatabase();
}
