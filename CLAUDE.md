# Repository instructions

## Runtime

- Runtime duy nhat la Java 17 + Spring Boot trong `server-java/`.
- Khong them Node.js, npm, Express, grammy, package.json hay `src/**/*.js` tro lai.
- Moi tac vu runtime la service Java va noi vao `TradingCommandRunner` neu can CLI.
- TiDB Cloud (MySQL-compatible) la persistence runtime ben ngoai Docker; migration nam trong
  `db/migrations/` va chay bang Flyway.
- Khong them lai PostgreSQL service, volume hay bien `POSTGRES_*` vao Compose. Tat ca service
  `web`, `bot`, `migrate-db` va `import-files` dung cung `JDBC_DATABASE_URL`, `DATABASE_USER`,
  `DATABASE_PASSWORD` cua TiDB Cloud.
- `JDBC_DATABASE_URL` phai dung endpoint TiDB Cloud va TLS identity verification, vi du:
  `jdbc:mysql://<endpoint>:4000/<database>?sslMode=VERIFY_IDENTITY&enabledTLSProtocols=TLSv1.2,TLSv1.3&connectionTimeZone=UTC`.
  Neu Connect panel cap CA rieng, cau hinh Java truststore trong URL theo tai lieu TiDB Cloud.

## Browser UI

- `web/`, `login/` va `public/` la JavaScript browser-only, khong can bundler.
- Browser phai goi REST Java cho analysis, training va backtest; khong import core tu `src/`.
- Giu UI khong phu thuoc Node package, filesystem hay `process.env`.

## Build and test

```powershell
mvn -f server-java/pom.xml test
mvn -f server-java/pom.xml clean package
```

Artifact: `server-java/target/dong-tien-ai.jar`.

## Trading invariants

- Whitelist `alerts.tradeSymbols` fail-closed.
- Chi dung nen da dong de tinh diem, ML va backtest.
- Spot chi fallback Futures khi Binance xac nhan symbol Spot khong ton tai.
- Nhom thieu du lieu bi loai khoi mau so khi scoring.
- Neu cung mot nen cham SL va TP trong backtest, uu tien SL.
- Model co `nFeatures` khong khop feature hien tai phai bi tu choi.
- Khong ghi secret, API key, OAuth secret hay Telegram token vao log.

## Database

- `app_documents` la lop tuong thich cho du lieu JSON cu.
- Khong sua migration `V...` da release; them migration moi.
- `R__import_document_store.sql` phai idempotent.
