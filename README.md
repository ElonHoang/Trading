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

## Deploy mien phi: Render + GitHub Actions

Kien truc nay chay $0/thang. Doi lai, khong co tien trinh song lien tuc:

| Thanh phan | Chay o dau | Vai tro |
|---|---|---|
| `dong-tien-ai-web` | Render Web Service (goi free) | Dashboard, REST API, chay Flyway migration |
| `daily-learning.yml` | GitHub Actions, 08:07 gio VN | `learn-once` — loss log, review, learning log, train model |
| `weekly-purge.yml` | GitHub Actions, 08:37 thu Hai | `purge-history` — xoa keo da dong qua 30 ngay |
| `telegram-alerts.yml` | GitHub Actions, moi 2 gio | `alerts-once` — quet va ban alert |

Nhung gi **khong** co trong cau hinh nay:

- **Bot Telegram tuong tac.** Cac lenh `/set`, `/add`, `/del`, `/canhbao` can long polling lien tuc
  nen khong chay duoc. Alert mot chieu van co qua workflow. Muon lenh tuong tac thi phai co mot
  tien trinh chay nen (Render Background Worker tra phi, hoac VM tu quan).
- **Phan hoi tuc thi.** Web ngu sau 15 phut khong co request; lan vao lai cho ~50s de khoi dong.
- **Alert theo thoi gian thuc.** Cron GitHub la best-effort va co the tre vai phut khi he thong tai cao.

### Cac buoc

Repo nay da co san mot Web Service tren Render (runtime Docker, region Singapore) theo doi nhanh
`production`. Blueprint cua Render **khong nhan** service tao tay: bam New > Blueprint se tao them
mot service thu hai voi URL khac. Vi vay giu service dang co va chinh Settings cua no; giu
[render.yaml](render.yaml) lam tai lieu ghi dung cau hinh can co.

1. Merge code vao `production` va push. Render tu deploy lai (autoDeploy).
2. Trong **Settings** cua service, dat:
   - `Branch` = `production`
   - `Instance Type` = Free
   - `Health Check Path` = `/healthz` — **chi them sau khi ban deploy da co route nay**, neu khong
     Render se danh dau service unhealthy va rollback.
3. Trong **Environment**, dien cac bien co gia tri co dinh:
   `PORT=10000`, `SESSION_COOKIE_SECURE=true`, `SESSION_TIMEOUT=8h`, `DATABASE_MIGRATE=true`,
   `TRADING_LEARNING_SCHEDULER_ENABLED=false`, `DATABASE_POOL_SIZE=5`,
   `DATABASE_MAX_LIFETIME_MS=300000`, `TRADING_TIMEZONE=Asia/Ho_Chi_Minh`.
   Bat buoc them `JDBC_DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD`. Cac bien
   OAuth/local-auth/Anthropic de trong neu chua dung; cac provider dang nhap se fail-closed dung
   nhu thiet ke.
4. Cho web live, lay domain `https://<ten>.onrender.com` roi them redirect URI vao OAuth app:
   `https://<ten>.onrender.com/login/oauth2/code/google` va `.../code/github`.
   `OAuthClientConfig` sinh redirect tu `{baseUrl}`, con `forward-headers-strategy: framework` giup
   Spring doc dung scheme HTTPS phia sau proxy cua Render.
5. Vao **Settings > Secrets and variables > Actions** cua repo GitHub va them cac secret:
   `JDBC_DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD` (bat buoc),
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_IDS` (cho alert),
   `ANTHROPIC_API_KEY` (neu dung Anthropic trong daily review).
6. Chay thu tay tung workflow bang nut **Run workflow** truoc khi tin vao lich cron.

### Ngan sach GitHub Actions

Repo **public**: khong gioi han phut, khong can tinh toan gi.

Repo **private** goi Free: 2000 phut/thang. Ba workflow deu cache jar theo noi dung
`server-java/**` va cac thu muc UI, nen chi lan chay dau tien sau moi thay doi code moi phai build
(~4 phut); cac lan sau chi ~1-2 phut. Uoc tinh voi cron mac dinh: alert moi 2 gio (~360 lan) +
learning hang ngay (30 lan) + purge hang tuan (4 lan) roi vao khoang 700-900 phut/thang. Neu day
alert len moi 30 phut thi vuot han ngach — sua `cron` trong
[.github/workflows/telegram-alerts.yml](.github/workflows/telegram-alerts.yml) va tinh lai.

> GitHub tu tat scheduled workflow sau **60 ngay** repo khong co commit moi. Neu repo im lang, phai
> vao bat lai thu cong.

### Luu y van hanh

- Ba workflow deu dat `DATABASE_MIGRATE=false`; chi Render web chay Flyway. Deploy web truoc khi bat
  cron lan dau.
- `daily-learning` va `weekly-purge` dung chung `concurrency: trading-learning` nen khong bao gio
  chong len nhau. Chung thay the `TradingStateLock` — khoa nay chi chan trong mot tien trinh, khong
  chan giua hai job.
- **Khong bat `TRADING_LEARNING_SCHEDULER_ENABLED=true`** o Render trong cau hinh nay. Bat len se
  chay trung job voi GitHub Actions va hai ben cung ghi vao state auto-retune.
- Web goi free co 512MB RAM. Backtest hay train nang tren dashboard co the OOM; chay bang CLI o may
  hoac them mot workflow rieng thay vi bam tren web.
- Health check dung `GET /healthz` — route public duy nhat ngoai trang dang nhap, chi tra hang so.
- Cac profile `tools` (`import-files`, `telegram-history`) van chay bang Docker Compose o may ban.

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
java -jar server-java/target/dong-tien-ai.jar learn-once
java -jar server-java/target/dong-tien-ai.jar purge-history
java -jar server-java/target/dong-tien-ai.jar alerts-once
java -jar server-java/target/dong-tien-ai.jar bot
```

`bot` su dung long polling. Khong chay hai instance voi cung Telegram token.

`learn-once` va `purge-history` chay dung workflow ma `TradingLearningScheduler` chay theo
cron trong bot worker. Dung chung khi khong co worker chay nen (vi du Render goi free) va
de mot scheduler ben ngoai goi. Khong bat `TRADING_LEARNING_SCHEDULER_ENABLED` o service
nao khac trong luc dung hai lenh nay, neu khong job se chay trung.

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

Khi khong co worker chay nen (vi du Render goi free), hai job nay chay bang GitHub Actions
cron goi `learn-once` va `purge-history` — cung workflow, chi khac nguon kich hoat. Luc do
`TRADING_LEARNING_SCHEDULER_ENABLED` phai la `false` o moi service, neu khong job se chay
trung. Xem muc Deploy mien phi ben tren.

## Bien moi truong

| Bien | Mo ta |
|---|---|
| `JDBC_DATABASE_URL` | TiDB Cloud JDBC URL MySQL co `sslMode=VERIFY_IDENTITY` |
| `DATABASE_USER`, `DATABASE_PASSWORD` | Tai khoan TiDB Cloud; khong dat secret trong JDBC URL |
| `DATABASE_POOL_SIZE`, `DATABASE_MAX_LIFETIME_MS` | Pool JDBC; mac dinh 5 ket noi va tai tao sau 5 phut |
| `DATABASE_MIGRATE` | Chay Flyway luc khoi dong, mac dinh `true`. Khi deploy nhieu service, chi de mot service (web) dat `true` |
| `JAVA_SERVER_PORT` | Port Java, mac dinh `8080` |
| `SESSION_COOKIE_SECURE`, `SESSION_TIMEOUT` | Dat `true` khi deploy HTTPS; session mac dinh het han sau 8 gio |
| `LOCAL_AUTH_ADMIN_*`, `LOCAL_AUTH_VIEWER_*` | Hai tai khoan local: admin ghi/xoa, viewer chi xem; mat khau phai la BCrypt hash cost 12 |
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram |
| `TELEGRAM_ALLOWED_IDS` | Chat ID duoc phep doc/dung bot |
| `TELEGRAM_OWNER_IDS` | Chat ID duoc phep dung lenh ghi; de trong se fail-closed |
| `TELEGRAM_ALERT_CHAT_IDS` | Chat nhan alert da cau hinh |
| `ANTHROPIC_API_KEY` | API key cho Anthropic service phia Java |
| `TRADING_TIMEZONE` | Mui gio job, mac dinh `Asia/Ho_Chi_Minh` |
| `TRADING_LEARNING_SCHEDULER_ENABLED` | Bat cron job hoc/don lich su trong tien trinh. Compose chi bat o service `bot`. Khi dung GitHub Actions cron thi phai `false` o moi noi |
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

### Han muc Binance

Binance tinh weight theo **IP**, cua so mot phut, va tra ve so weight da dung trong header
`X-MBX-USED-WEIGHT-1M`. `BinanceRateLimiter` doc chinh header do thay vi tu doan bang weight,
giu rieng ngan sach cho spot (6000/phut) va futures (2400/phut).

- Cham 80% han muc: request bi giu lai toi dau phut sau, tuc lam cham lai thay vi bi cam.
- Gap `429`: doc `Retry-After`. Gap `418`/`-1003`: doc moc `banned until` ngay trong body.
- Trong luc bi cam, client **khong goi Binance nua** ma bao loi ngay. Goi tiep khi dang bi
  cam se keo dai lenh cam.
- `api`, `api1`, `api2`, `data-api` dung CHUNG mot ngan sach IP. Vi vay khi gap 429/418,
  `getJson` **khong** chuyen sang host khac — lam vay chi tieu them phan han muc da het.

Han muc nay theo tung tien trinh. Web tren Render va runner GitHub Actions dung IP datacenter
dung chung, nen van co the bi cam vi luu luong cua nguoi khac tren cung IP.

## Kiem thu

```powershell
mvn -f server-java/pom.xml test
```
