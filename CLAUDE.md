# Repository instructions

## Runtime

- Backend/runtime duy nhat la Java 17 + Spring Boot trong `server-java/`.
- Khong them lai Node.js, npm, Express, grammy hay script `bin/*.js`.
- Moi tac vu nen la service Java va duoc noi vao `TradingCommandRunner` neu can CLI.
- PostgreSQL la persistence duy nhat. Migration nam trong `db/migrations` va chay bang Flyway.

## Browser modules

`web/`, `login/`, `public/` va cac dependency trong `src/` la JavaScript thuần browser,
khong phai backend. Cac module nay phai tiep tuc chay khong can bundler:

- `src/analysis/engine.js`
- `src/analysis/entry-quality.js`
- `src/analysis/historical-pattern.js`
- `src/backtest.js`
- `src/chart/render.js`
- `src/data/binance.js`
- `src/data/trading-universe.js`
- `src/features.js`
- `src/indicators/index.js`
- `src/ml/dataset.js`
- `src/ml/gbdt.js`
- `src/ml/train.js`

Khong import `node:*`, package npm, filesystem, `process.env` hoac code Java vao cac file nay.

## Build and test

```powershell
mvn -f server-java/pom.xml test
mvn -f server-java/pom.xml clean package
```

Artifact: `server-java/target/dong-tien-ai.jar`.

## Trading invariants

- Whitelist `alerts.tradeSymbols` fail-closed; khong tao keo ngoai danh sach.
- Chi cham diem nen da dong.
- Spot chi fallback sang Futures khi Binance xac nhan symbol spot khong ton tai.
- Loi transport Spot khong duoc tu dong doi thi truong.
- CVD la xap xi theo taker-buy volume cua nen, khong phai tick CVD.
- Nhom thieu du lieu bi loai khoi mau so trong scoring.
- Trong cung mot nen backtest, neu cham ca SL va TP thi uu tien SL.
- Model cu phai bi tu choi neu `nFeatures` khong khop feature hien tai.
- Khong ghi log secret, API key, OAuth secret hay Telegram token.

## Database

- `public.app_documents` la lop tuong thich cho du lieu JSON cu.
- Schema chuan hoa nam trong `trading`.
- Khong sua migration `V...` da release; tao version moi.
- Repeatable migration `R__import_document_store.sql` phai idempotent.

## Editing

- Giu thay doi gon trong module lien quan.
- Them test Java cho logic thuan va regression quan trong.
- Giu JavaScript frontend khong co buoc build.
- Dung UTF-8 khong BOM cho JSON/config.
