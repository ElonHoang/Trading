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
# Dang nhap Telegram bang tai khoan cua ban de liet ke nhom (OTP/2FA chi nhap trong terminal):
docker compose --profile tools run --rm telegram-history
# Sau khi chon id cua mot nhom, kiem tra ket qua ngay truoc roi moi them --apply de luu:
docker compose --profile tools run --rm telegram-history telegram-import-history --chat-id=<id> --date=2026-08-24
docker compose --profile tools run --rm telegram-history telegram-import-history --chat-id=<id> --date=2026-08-24 --apply
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

## Nhap lich su call tu Telegram

`telegram-history` la CLI tuong tac, khong phai bot chay nen. Lan dau tien no hoi so dien thoai, ma OTP va (neu co) mat khau 2FA ngay trong terminal; phien dang nhap duoc giu trong Docker volume rieng va khong nam trong Git. Lenh liet ke chat chi hien thi cac chat cua tai khoan da dang nhap. Sau do phai truyen dung `--chat-id` cua nhom muon doc; chuong trinh khong quet hay lay tu nhom khac.

Importer chi nhan dang caption call/cap nhat do chinh bot nay tao ra, mac dinh `dry-run`, va bo qua tin nhan mo ho. Du lieu nhap duoc luu rieng de hien thi lich su/PnL tren dashboard, khong dua vao training hay auto-retune. Dieu nay la can thiet vi [dieu khoan Telegram API](https://core.telegram.org/api/terms) cam su dung du lieu lay tu Telegram de train hay fine-tune AI/ML. Job don lich su hang tuan cung xoa cac ban ghi import da dong qua han giu du lieu.

## Hoc tu ket qua keo va don lich su

Khi chay service `bot` qua Docker Compose, worker bot tu dong chay job luc 08:07 gio
Viet Nam: luu log loss, tong hop W/L/PnL cua ngay truoc, ghi learning log vao TiDB,
va chi ap dung tinh chinh/model moi neu vuot qua cac cong kiem chung hien co. Model
thi truong duoc train lai toi da 3 cap co keo da dong trong ngay; model cu duoc giu
neu candidate khong dat AUC holdout an toan.

Luc 08:37 thu Hai, worker chi xoa cac keo da dong qua 30 ngay trong lich su trading.
Keo dang mo, cau hinh, model va learning log khong bi xoa. Co the doi lich, so ngay
giu va bat/tat job bang cac bien `TRADING_*` ben duoi. Khong bat scheduler tren web
hoac Vercel; chi mot worker bot persistent duoc phep chay job nay.

## Bien moi truong

| Bien | Mo ta |
|---|---|
| `JDBC_DATABASE_URL` | TiDB Cloud JDBC URL MySQL co `sslMode=VERIFY_IDENTITY` |
| `DATABASE_USER`, `DATABASE_PASSWORD` | Tai khoan TiDB Cloud; khong dat secret trong JDBC URL |
| `DATABASE_POOL_SIZE`, `DATABASE_MAX_LIFETIME_MS` | Pool JDBC; mac dinh 5 ket noi va tai tao sau 5 phut |
| `JAVA_SERVER_PORT` | Port Java, mac dinh `8080` |
| `SESSION_COOKIE_SECURE`, `SESSION_TIMEOUT` | Dat `true` khi deploy HTTPS; session mac dinh het han sau 8 gio |
| `LOCAL_AUTH_ADMIN_*`, `LOCAL_AUTH_VIEWER_*` | Hai tai khoan local: admin ghi/xoa, viewer chi xem; mat khau phai la BCrypt hash cost 12 |
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram |
| `TELEGRAM_ALLOWED_IDS` | Chat ID duoc phep doc/dung bot |
| `TELEGRAM_OWNER_IDS` | Chat ID duoc phep dung lenh ghi; de trong se fail-closed |
| `TELEGRAM_ALERT_CHAT_IDS` | Chat nhan alert da cau hinh |
| `ANTHROPIC_API_KEY` | API key cho Anthropic service phia Java |
| `TRADING_TIMEZONE` | Mui gio job, mac dinh `Asia/Ho_Chi_Minh` |
| `TRADING_LEARNING_SCHEDULER_ENABLED` | Bat job hoc/don lich su; Compose chi bat trong service `bot` |
| `TRADING_HISTORY_RETENTION_DAYS` | So ngay giu keo da dong, mac dinh `30` |
| `TRADING_DAILY_MODEL_MAX_PAIRS` | Toi da cap symbol/interval duoc train moi ngay, mac dinh `3` |
| `TRADING_DAILY_MODEL_TRAINING_ENABLED` | Bat/tat train lai market model sau daily review |

Đăng nhập nội bộ dùng Spring Security với BCrypt, CSRF và đổi session ID sau khi xác thực. Chỉ lưu password hash vào `LOCAL_AUTH_ADMIN_PASSWORD_HASH` và `LOCAL_AUTH_VIEWER_PASSWORD_HASH`, không lưu mật khẩu thô. Vì BCrypt có ký tự `$`, trong `.env` hãy đặt mỗi hash giữa nháy đơn; ứng dụng cũng đọc đúng giá trị này khi chạy Java trực tiếp. Admin có quyền gọi API ghi/xóa; viewer chỉ được dùng các route GET. Google/GitHub (nếu được cấu hình) mặc định nhận `ROLE_VIEWER`, tức chỉ xem. Khi deploy Internet, bắt buộc dùng HTTPS và đặt `SESSION_COOKIE_SECURE=true`; Docker Compose mặc định giá trị này là `true` nếu biến chưa được khai báo.
Khi chạy Docker ở localhost bằng HTTP, đặt riêng `SESSION_COOKIE_SECURE=false` trong `.env`.

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
