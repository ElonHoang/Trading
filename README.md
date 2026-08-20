# Dong Tien AI

He thong phan tich crypto da chuyen runtime tu Node.js sang Java 17 + Spring Boot, voi TiDB Cloud
(MySQL-compatible) la database ben ngoai.
Khong co package.json, npm script, Express, grammy hay Node source trong runtime.
JavaScript chi con trong `web/`, `login/` va `public/` de ve giao dien tren trinh duyet.

## Chay

Yeu cau: Java 17+, Maven 3.6.3+, va mot TiDB Cloud cluster co the truy cap tu may chay app.

Sao chep `.env.example` thanh `.env`, sau do dien URL JDBC TLS, user va password cua cluster truoc
khi chay bat ky lenh nao. Docker Compose khong khoi dong database local; `migrate-db` ket noi truc tiep
toi TiDB Cloud, sau do `web`, `bot` va `import-files` giu nguyen quan he phu thuoc vao migration.

Luu y: Flyway tao schema TiDB moi. Neu ban dang co du lieu PostgreSQL cu, hay export/nhap du lieu
truoc; TiDB Cloud khong the tu doc database PostgreSQL cu qua migration.

```dotenv
JDBC_DATABASE_URL=jdbc:mysql://<tidb-cloud-endpoint>:4000/<database>?sslMode=VERIFY_IDENTITY&enabledTLSProtocols=TLSv1.2,TLSv1.3&connectionTimeZone=UTC
DATABASE_USER=<tidb-cloud-username>
DATABASE_PASSWORD=<tidb-cloud-password>
DATABASE_POOL_SIZE=5
DATABASE_MAX_LIFETIME_MS=300000
```

`sslMode=VERIFY_IDENTITY` bat TLS va kiem tra dung danh tinh endpoint. Dung dung endpoint/port trong
trang **Connect** cua TiDB Cloud (thong thuong port `4000`).
Voi cluster yeu cau CA rieng, import CA vao Java truststore va them `trustCertificateKeyStoreUrl` va
`trustCertificateKeyStorePassword` vao URL theo [huong dan TLS JDBC cua TiDB Cloud](https://docs.pingcap.com/tidbcloud/tidb-cloud-tls-connect-to-dedicated/).

Docker Compose (khuyen dung khi deploy):

```powershell
Copy-Item .env.example .env
# Dien TiDB Cloud credentials vao .env truoc khi chay.
docker compose up --build web
docker compose --profile bot up -d bot
docker compose --profile tools run --rm import-files
```

Khi chay JAR truc tiep, dat cung ba bien moi truong o tren trong shell/secret manager truoc:

```powershell
mvn -f server-java/pom.xml clean package
java -jar server-java/target/dong-tien-ai.jar migrate
java -jar server-java/target/dong-tien-ai.jar import-files --overwrite
java -jar server-java/target/dong-tien-ai.jar
```

- Dashboard: `http://localhost:8080/`
- Realtime UI: `http://localhost:8080/realtime/`
- Login: `http://localhost:8080/login/`

## Lenh Java

```powershell
java -jar server-java/target/dong-tien-ai.jar analyze BTC 4h
java -jar server-java/target/dong-tien-ai.jar train BTC 4h
java -jar server-java/target/dong-tien-ai.jar backtest BTC 4h 3000
java -jar server-java/target/dong-tien-ai.jar diagnose-sl BTC 4h 3000
java -jar server-java/target/dong-tien-ai.jar validate-filters BTC 4h 3000
java -jar server-java/target/dong-tien-ai.jar research-patterns --interval 4h
java -jar server-java/target/dong-tien-ai.jar daily-review
java -jar server-java/target/dong-tien-ai.jar daily-loss-log
java -jar server-java/target/dong-tien-ai.jar auto-retune
java -jar server-java/target/dong-tien-ai.jar alerts-once
java -jar server-java/target/dong-tien-ai.jar bot
```

`bot` su dung long polling. Khong chay hai instance voi cung Telegram token.

## Bien moi truong

| Bien | Mo ta |
|---|---|
| `JDBC_DATABASE_URL` | TiDB Cloud JDBC URL MySQL co `sslMode=VERIFY_IDENTITY` |
| `DATABASE_USER`, `DATABASE_PASSWORD` | Tai khoan TiDB Cloud; khong dat secret trong JDBC URL |
| `DATABASE_POOL_SIZE`, `DATABASE_MAX_LIFETIME_MS` | Pool JDBC; mac dinh 5 ket noi va tai tao sau 5 phut |
| `JAVA_SERVER_PORT` | Port Java, mac dinh `8080` |
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram |
| `TELEGRAM_ALLOWED_IDS` | Chat ID duoc phep doc/dung bot |
| `TELEGRAM_OWNER_IDS` | Chat ID duoc phep dung lenh ghi; de trong se fail-closed |
| `TELEGRAM_ALERT_CHAT_IDS` | Chat nhan alert da cau hinh |
| `ANTHROPIC_API_KEY` | API key cho Anthropic service phia Java |

## API

| Method | Path | Chuc nang |
|---|---|---|
| `GET` | `/api/intervals` | Khung thoi gian Binance |
| `GET` / `POST` | `/api/analyze` | Phan tich thi truong |
| `POST` | `/api/train` | Train va luu model TiDB Cloud |
| `POST` | `/api/backtest` | Backtest trong Java runtime |
| `POST` | `/api/ai/report`, `/api/ai/ask` | Claude qua Java service |
| `GET` / `POST` / `DELETE` | `/api/watchlist` | Watchlist |
| `GET` | `/api/content/strategy`, `/api/content/models` | Cau hinh va model |

## Kien truc

```text
server-java/src/main/java/vn/dongtien/
  trading/analysis/    scoring, setup, context, lifecycle, review, research
  trading/market/      Binance Spot/Futures
  trading/ml/          dataset, GBDT, training
  trading/backtest/    simulator
  trading/chart/       PNG renderer Java2D
  trading/telegram/    Telegram transport, captions, monitor
  trading/runtime/     CLI command dispatcher
  auth/                persistence, OAuth, dashboard APIs
web/, login/, public/  browser UI only
db/migrations/         Flyway migrations cho TiDB/MySQL
```

## Kiem thu

```powershell
mvn -f server-java/pom.xml test
```
