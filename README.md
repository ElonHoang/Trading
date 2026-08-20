# Dong Tien AI

He thong phan tich dong tien crypto, dashboard, backtest, model ML va Telegram bot.
Backend da duoc chuyen hoan toan sang Java 17/Spring Boot. Repository khong can
Node.js, npm hay package npm de build va van hanh.

JavaScript con lai trong `web/`, `login/`, `public/` va mot tap module thuần trong
`src/` chi chay truc tiep trong trinh duyet. Chung khong phai Node.js backend.

## Yeu cau

- Java 17+
- Maven 3.6.3+
- PostgreSQL 15+
- Docker/Compose (tuy chon)

## Chay local

Tao `.env` tu `.env.example`, sau do khoi tao database va import cau hinh:

```powershell
mvn -f server-java/pom.xml clean package
java -jar server-java/target/dong-tien-ai.jar migrate
java -jar server-java/target/dong-tien-ai.jar import-files --overwrite
java -jar server-java/target/dong-tien-ai.jar
```

Dashboard: `http://localhost:8080/`

Trang realtime: `http://localhost:8080/realtime/`

Dang nhap: `http://localhost:8080/login/`

Chay thu UI khong can PostgreSQL (du lieu chi nam trong bo nho):

```powershell
java -jar server-java/target/dong-tien-ai.jar --spring.profiles.active=demo --spring.autoconfigure.exclude=org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration,org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration
```

## Lenh Java

Tat ca tac vu cu dung chung mot executable JAR:

```powershell
java -jar server-java/target/dong-tien-ai.jar analyze BTC 4h
java -jar server-java/target/dong-tien-ai.jar backtest BTC 4h 3000
java -jar server-java/target/dong-tien-ai.jar train BTC 4h
java -jar server-java/target/dong-tien-ai.jar diagnose-sl BTC 4h 3000
java -jar server-java/target/dong-tien-ai.jar validate-filters BTC 4h 3000
java -jar server-java/target/dong-tien-ai.jar research-patterns BTC 4h 3000
java -jar server-java/target/dong-tien-ai.jar daily-review
java -jar server-java/target/dong-tien-ai.jar models-index
java -jar server-java/target/dong-tien-ai.jar alerts-once
java -jar server-java/target/dong-tien-ai.jar bot
```

`bot` long-poll Telegram. Khong chay dong thoi nhieu instance voi cung token vi
Telegram chi cho mot consumer `getUpdates`.

## Docker

```powershell
docker compose up --build postgres migrate-db import-files web
docker compose --profile bot up --build bot
```

`migrate-db`, `web`, `bot` va `import-files` deu dung cung image Java. Flyway chay
cac file trong `db/migrations` va khoa checksum cac migration versioned.

## Bien moi truong

| Bien | Mo ta |
|---|---|
| `JDBC_DATABASE_URL` | JDBC URL PostgreSQL |
| `DATABASE_USER` | Tai khoan database |
| `DATABASE_PASSWORD` | Mat khau database |
| `DATABASE_POOL_SIZE` | So connection toi da |
| `JAVA_SERVER_PORT` | Cong local, mac dinh `8080` |
| `PORT` | Cong container/Render |
| `TELEGRAM_BOT_TOKEN` | Token Telegram bot |
| `TELEGRAM_ALLOWED_IDS` | Danh sach chat ID cach nhau bang dau phay |
| `TELEGRAM_ALERT_CHAT_IDS` | Noi nhan alert mot lan |
| `ANTHROPIC_API_KEY` | API key cho tinh nang Claude phia browser/tich hop sau nay |
| `GOOGLE_CLIENT_ID` | OAuth Google |
| `GOOGLE_CLIENT_SECRET` | OAuth Google |
| `GITHUB_CLIENT_ID` | OAuth GitHub |
| `GITHUB_CLIENT_SECRET` | OAuth GitHub |

## API

| Method | Path | Chuc nang |
|---|---|---|
| `GET` | `/api/intervals` | Khung thoi gian Binance |
| `GET` | `/api/analyze?symbol=BTC&interval=4h&bars=180` | Snapshot phan tich |
| `GET` | `/api/watchlist` | Danh sach theo doi |
| `POST` | `/api/watchlist` | Them `{ "symbol": "BTC" }` |
| `DELETE` | `/api/watchlist/{symbol}` | Xoa symbol |
| `GET` | `/api/content/strategy` | Cau hinh dang active |
| `GET` | `/api/content/prompt` | System prompt |
| `GET` | `/api/content/models` | Model da train |
| `GET` | `/api/trading-performance?range=week` | Hieu suat giao dich |
| `GET` | `/api/auth/session` | User, OAuth provider va CSRF token |

## Kien truc

```text
server-java/src/main/java/vn/dongtien/
  auth/                 OAuth, session, dashboard performance
  trading/api/          REST API thay Express
  trading/market/       Binance Spot/Futures client
  trading/analysis/     volume, CVD, S/R va scoring
  trading/ml/           feature, GBDT predict/train
  trading/backtest/     backtest theo thoi gian
  trading/watchlist/    persistence watchlist
  trading/telegram/     Telegram Bot API client
  trading/runtime/      command dispatcher va import

db/migrations/          Flyway PostgreSQL
web/, login/, public/   giao dien browser
src/                    ES module thuan browser cho che do tinh tai client
```

Java backend la nguon chay production. Cac module `src/**/*.js` duoc dong goi lam
static resource chi de dashboard co the train/backtest ngay trong Web Worker.
Chung khong duoc import `node:*`, doc filesystem, doc environment hay dung package npm.

## Kiem thu

```powershell
mvn -f server-java/pom.xml test
```

Test hien bao phu OAuth/session, PnL dashboard, symbol normalization, whitelist,
volume/CVD va kha nang doc model GBDT cu duoc tao boi browser.
