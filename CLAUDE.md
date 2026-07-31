# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ngôn ngữ

Toàn bộ comment trong code, thông báo lỗi, và mọi chữ người dùng nhìn thấy đều bằng **tiếng Việt**. Giữ nguyên quy ước này khi thêm code mới.

## Lệnh

```bash
npm install
npm start                            # / = dashboard tĩnh, /realtime/ = WebSocket. PORT đổi được
npm run bot                          # bot Telegram bản chart PNG (src/telegram/bot.js)
npm run bot:ai                       # bot Telegram bản AI/ML (src/bot.js) — TÍNH PHÍ nếu có key
npm run analyze -- BTC 1h --no-ai    # phân tích trong terminal
npm run train -- BTC 4h              # train model, lưu vào models/
npm run backtest -- BTC 4h 3000      # backtest có SL/TP
npm run models:index                 # bắt buộc chạy sau khi thêm/xoá file trong models/
```

Hai bot **không chạy đồng thời được** — Telegram chỉ cho một tiến trình long-poll trên mỗi token, chạy cả hai sẽ lỗi 409.

Không có test suite và không có script `test`. Thứ gần nhất với CI là job `verify` trong `.github/workflows/deploy-pages.yml`; chạy tay tương đương:

```bash
find src web bin -name '*.js' -print0 | xargs -0 -n1 node --check
node bin/build-model-index.js && git diff --quiet -- models/index.json
```

Cần Node ≥ 20. Các script dùng `--env-file-if-exists=.env`, nên không có `.env` vẫn chạy được (phần cần key sẽ tự bỏ qua).

## Bộ chỉ báo bị giới hạn cố ý

Repo **chỉ** dùng 6 nhóm: CVD, volume, phái sinh (funding + OI), định vị đám đông, hỗ trợ/kháng cự, order book. Chi tiết bản chất và cách diễn giải từng cái nằm ở [`.claude/skills/chi-bao/SKILL.md`](.claude/skills/chi-bao/SKILL.md) — đọc trước khi làm bất cứ gì liên quan phân tích.

EMA, RSI, MACD, Bollinger, ATR, ADX, Stochastic, VWAP, OBV, phân kỳ RSI **đã bị xoá khỏi codebase** theo yêu cầu. Đừng thêm lại, đừng tự tính, đừng đề xuất. Lấy lại từ git commit `2155bd4` nếu thật sự cần.

**Không có liquidity map** — Binance đã bỏ endpoint lịch sử thanh lý (404). Nhóm `positioning` thay thế bằng 3 endpoint tỉ lệ long/short có thật và có lịch sử. **Không có lịch unlock** — không có nguồn miễn phí.

Hai hệ quả còn tồn tại, đo được:

- Model ML yếu đi: feature 32 → 16, AUC holdout 0,554 → **0,5116**, walk-forward 0,541 → **0,5076**. Dưới `ml.minTestAuc` (0,52) nên hệ thống **tự không dùng ML**. `models/BTCUSDT_4h.json` là model đã train lại với bộ mới.
- `thresholds.buy`/`sell` (±30) vẫn là mức kế thừa từ bộ chỉ báo cũ, **chưa tinh chỉnh lại**. Xem bảng đo cổng đồng thuận trong `README.md`.

## Kiến trúc

Ba tầng xếp lên nhau, mô tả chi tiết trong `README.md`:

1. **Chỉ báo** (`src/indicators/index.js`) — JS thuần, không phụ thuộc gì.
2. **Engine chấm điểm + ML** (`src/analysis/engine.js`, `src/ml/`, `src/features.js`) — gộp điểm theo quy tắc với xác suất từ gradient boosting tự viết.
3. **Claude** (`src/llm/claude.js` ở Node, `web/claude.js` ở browser) — đọc số liệu tầng dưới rồi viết nhận định.

`src/analysis/engine.js` là trung tâm: `analyze()` của nó trả về payload mà **mọi** giao diện đều dùng — CLI, cả hai bot, dashboard tĩnh và giao diện realtime. Sáu nhóm chấm điểm trong `scoreSignals()` khớp đúng danh sách chỉ báo: `cvd` 28, `volume` 22, `derivatives` 18, `positioning` 14, `structure` 12, `orderBook` 6.

### Hai bất biến của phần chấm điểm — đừng phá

**1. Nhóm thiếu dữ liệu bị LOẠI khỏi chuẩn hoá trọng số**, không tính là 0 điểm. Order book và positioning không có lịch sử theo nến nên trong backtest chúng luôn thiếu; tính là 0 sẽ pha loãng điểm và gần như không bao giờ vượt ngưỡng. Lỗi này từng khiến backtest ra 9 lệnh (toàn short) thay vì 60 lệnh (14 long / 46 short).

**2. Cổng đồng thuận khác ngưỡng điểm.** `consensus.percent` đếm bao nhiêu nhóm *có dữ liệu* cùng hướng; `|điểm| ≥ 30` có thể chỉ đến từ 2 nhóm rất mạnh. Số nhóm có dữ liệu **khác nhau giữa chạy thật (6) và backtest (3)**, nên cùng một % sẽ nghiêm khắc hơn nhiều khi chạy thật. Luật này không kiểm chứng đầy đủ được bằng backtest.

### Lớp trên engine

- `src/analysis/context.js` — Kĩ năng 2. Không cộng điểm, chỉ xác nhận hoặc phủ quyết. Mọi nguồn null-safe: lỗi mạng thì phần đó là `null` kèm `warnings`, không được chặn phần kỹ thuật.
- `src/analysis/setup.js` — gộp kỹ thuật + bối cảnh thành setup (entry/SL/TP + lý do xếp theo đóng góp thật), và `buildProjections()` cho hai kịch bản lên/xuống neo vào mức S/R thật.
- `src/telegram/monitor.js` — vòng quét. Chỉ đánh giá lại **khi có nến mới đóng**; chỉ bắn khi có kèo thật (không bắn "đứng ngoài"/"chờ tín hiệu").
- `src/data/open-calls.js` — kèo đang mở. Một mã đã call thì không call lại tới khi chạm SL, TP cuối, hoặc quá `alerts.maxHoldBars`.

`cautions` chỉ chứa mức `warn`; mức `info` (không tìm thấy tin, thông báo không ghi token) chuyển sang `notes` và **không hiển thị**. Riêng "không đọc được thông báo delist" là `warn` vì nghĩa là kiểm tra đã *thất bại*, khác với *đã kiểm tra và không thấy gì*.

### Ràng buộc quan trọng nhất: lõi phải chạy được trong browser

Bản web là **trang tĩnh, không có bước build** — browser `import` trực tiếp các file trong `src/` qua HTTP. Vì vậy 8 file này **không được** `import` từ `node:*` hay package npm (`@...`):

```
src/indicators/index.js   src/features.js      src/ml/gbdt.js    src/ml/dataset.js
src/data/binance.js       src/analysis/engine.js  src/ml/train.js  src/backtest.js
```

CI chặn cứng bằng `grep` trên đúng danh sách này (`deploy-pages.yml`, bước "Kiểm tra các module lõi không phụ thuộc Node").

Các file *chỉ chạy ở Node* được phép dùng `node:*` và package npm (đường dẫn tính từ `src/`):

```
bot.js  server.js  cli.js  config.js  format.js
llm/claude.js  ml/model-store.js
analysis/context.js  analysis/setup.js
chart/png.js
data/watchlist.js  data/subscribers.js  data/open-calls.js
data/fundamentals.js  data/announcements.js  data/news.js
telegram/bot.js  telegram/monitor.js  telegram/caption.js
```

Thêm file mới vào `src/` thì phải quyết ngay nó thuộc nhóm nào: nếu browser cần import thì không được dùng `node:*`.

Đây là lý do `web/claude.js` gọi Claude bằng `fetch` thay vì `@anthropic-ai/sdk`, dù bản Node dùng SDK.

### Cấu hình là dữ liệu, không phải code

`config/strategy.json` chứa toàn bộ tham số: `indicators`, `weights`, `thresholds`, `ml`, `risk`, `llm`, `alerts`, `analysis`. `config/prompt.md` là system prompt của Claude.

Không hardcode ngưỡng hay trọng số vào code — thêm khoá vào `strategy.json` rồi đọc qua `loadStrategy()`. `setStrategyValue()` cố tình **chỉ cho ghi vào khoá đã tồn tại** để gõ sai không tạo khoá rác. Khoá bắt đầu bằng `_` (như `_note`) bị bỏ khi liệt kê.

Browser giữ bản ghi đè riêng trong localStorage (`web/store.js`), mặc định đọc từ `strategy.json`.

### Bất biến về tính đúng đắn — đừng phá

`README.md` mô tả các cơ chế chống tự lừa mình. Khi sửa phần ML hoặc backtest, giữ nguyên:

- **Không shuffle** dữ liệu chuỗi thời gian; chia train/test theo thời gian (`timeSplit`, `walkForwardFolds`).
- **Không look-ahead**: feature tại nến `i` chỉ dùng dữ liệu đến `i`. Nến đang chạy bị loại khỏi mọi tính toán — dùng `closedCandles()`.
- Model dưới `ml.minTestAuc` thì trọng số ML về 0, nhưng vẫn hiện xác suất kèm ghi chú không được tính điểm.
- Xác suất so theo **phân vị của chính model** (p20/p80 trên holdout), không theo ngưỡng tuyệt đối.
- Backtest bảo thủ: một nến chạm cả SL và TP thì tính là SL.

### Dữ liệu

`src/data/binance.js` dùng REST công khai của Binance, không cần API key, và tự thử nhiều host vì `api.binance.com` bị chặn ở một số vùng.

- **`resolveSymbol()` đối chiếu danh sách cặp thật** (cache 6h), không đoán bằng hậu tố. Đoán từng làm `wbtc` → `WBTC` (mã không tồn tại). Giờ `wbtc` → `WBTCUSDT`, `ethbtc` → `ETHBTC`, `btctry` → `BTCTRY`; mã bịa báo lỗi rõ ràng.
- **`MIN_CANDLES` = 30** nến đã đóng để chấm điểm, `features.WARMUP` = 60 cho ML, ≥ 600 để train.
- Funding, OI và định vị đám đông **chỉ có với token có futures** — trả `null` chứ không lỗi. Cổ phiếu token hoá (bStocks) không có, nên chỉ còn 4 nhóm và cổng đồng thuận dễ đạt hơn một cách giả tạo.
- **Chi phí request-weight**: phân tích đầy đủ 1 mã = 56 (riêng `depth limit=1000` đã 50). Giới hạn Binance 6.000/phút. Vì vậy vòng quét sàng lọc bằng 1 request ticker toàn sàn (80 weight) rồi chỉ đào sâu ~24 mã.

`models/` **được commit** để người mở trang GitHub Pages có model sẵn. `models/index.json` là manifest cho browser và CI sẽ fail nếu nó lệch với thư mục.

### Cạm bẫy đã gặp

- **Đừng dùng PowerShell `Set-Content -Encoding utf8` cho file trong repo** — nó thêm BOM. `JSON.parse` từ chối BOM nên `config/strategy.json` bị hỏng và `loadStrategy()` throw ở mọi lần đọc. Dùng công cụ ghi file hoặc Node.
- **Giá phải làm tròn theo độ lớn** (`roundPrice` trong engine), không dùng số thập phân cố định. `round(v, 6)` từng làm mọi mức giá của SHIB bẹt về `0.00000500`.
- **`@napi-rs/canvas` cần `GlobalFonts.loadSystemFonts()`** — font mặc định thiếu glyph tiếng Việt, "TRUNG LẬP" ra "TRUNG LOP".
- **Từ khoá tin tức phải khớp biên từ**, không phải substring: `"bank"` từng bị tính là `"ban"` và sinh cảnh báo tiêu cực sai.
- **Binance CMS giới hạn `pageSize ≤ 20`**, lớn hơn trả HTTP 400 và `catch` sẽ nuốt lỗi thành "không có thông báo nào".
- **Caption Telegram tối đa 1024 ký tự** — dùng `splitCaption()`, đừng cắt cứng.

## Trạng thái repo sau merge

Nhánh `develop` đã merge `main`. Bản triển khai song song trước đó của `develop` (`src/analysis/indicators.js`, `summary.js`, `analyze.js`) **đã bị xoá** — giờ chỉ còn một pipeline phân tích duy nhất là `src/analysis/engine.js`.

Còn lại hai bot, dùng cùng engine nhưng khác lớp vào/ra:

| | `npm run bot:ai` (`src/bot.js`) | `npm run bot` (`src/telegram/bot.js`) |
|---|---|---|
| Lệnh | `/a /q /ask /train /backtest /config /set /prompt /watch` | `/ta /gia /list /add /del /canhbao /tatcanhbao /id` |
| Đặc điểm | có Claude (**tính phí**), train/backtest, sửa config qua chat | ảnh chart + kèo, theo dõi liên tục, phân quyền |
| Quyền | `TELEGRAM_ALLOWED_IDS`, trống = mở cho tất cả | `TELEGRAM_OWNER_IDS`, trống = **chặn hết lệnh ghi** |

**Hai bot dùng cùng `TELEGRAM_BOT_TOKEN`.** Telegram chỉ cho một tiến trình long-poll trên mỗi token; chạy cả hai cùng lúc sẽ làm cả hai lỗi 409.

Bot chart phân quyền fail-closed: `/canhbao`, `/tatcanhbao`, `/add`, `/del` yêu cầu user id nằm trong `TELEGRAM_OWNER_IDS`. Lệnh chỉ đọc mở cho tất cả. Cần thiết vì bot có thể ở trong group, nơi ai cũng sửa được watchlist dùng chung. `/id` trả về user id để chủ bot tự cấu hình.

Khung call kèo là `CALL_INTERVALS = ['1h', '15m']` — xét 1h trước (ít nhiễu hơn), rơi xuống 15m khi 1h chưa đủ điều kiện. **Không dùng 4h để call**, nhưng `/ta btc 4h` vẫn xem được.

Watchlist vẫn có hai đường ghi vào `data/watchlist.json`: `loadWatchlist`/`saveWatchlist` trong `src/config.js` (bot AI dùng) và `src/data/watchlist.js` (server + bot chart dùng). Ghi từ hai phía sẽ đè lẫn nhau — chưa hợp nhất.

File trạng thái, đều gitignored: `data/alert-chats.json` (chat đã bật cảnh báo), `data/open-calls.json` (kèo đang mở).

### Giao diện

`src/server.js` phục vụ cả hai, và mở `web/ src/ config/ models/` để browser import module trực tiếp:

- `/` — dashboard tĩnh (`index.html` + `web/`), giống hệt bản GitHub Pages, mọi tính toán chạy trong browser.
- `/realtime/` — `public/index.html`, nến cập nhật qua WebSocket Binance; **điểm và chỉ báo lấy từ `/api/analyze`**, không tính ở client, vì chỉ báo chỉ được tính trên nến đã đóng. Khi nến đóng, trang tự gọi lại snapshot.

`src/chart/render.js` chỉ nhận một context 2D nên dùng được cả cho canvas trình duyệt và `@napi-rs/canvas` khi bot xuất PNG — cùng một bộ vẽ, không có bản sao lệch nhau.

## Skill

Trước khi đưa ra bất kỳ phân tích thị trường nào, **phải** dựa vào các kĩ năng trong `.claude/skills/`. Không tự tính chỉ báo bằng tay, không ước lượng bằng mắt, không bịa số.

| # | Kĩ năng | Nội dung | Đường dẫn |
|---|---|---|---|
| 1 | Chỉ báo | Order book, volume, OI, funding, CVD, định vị đám đông, hỗ trợ/kháng cự — cho ra điểm và setup | [`.claude/skills/chi-bao/SKILL.md`](.claude/skills/chi-bao/SKILL.md) |
| 2 | Tin tức & tokenomics | Tokenomics, rủi ro delist, tin tức — xác nhận hoặc **phủ quyết** setup của Kĩ năng 1 | [`.claude/skills/tin-tuc-tokenomics/SKILL.md`](.claude/skills/tin-tuc-tokenomics/SKILL.md) |

Kĩ năng 2 **không cộng điểm** — dòng tiền tính bằng giây/giờ còn tokenomics tính bằng ngày/tuần, trộn vào một thang sẽ làm méo điểm và mất khả năng backtest.

Hai mẫu tin nhắn: mẫu **call kèo** ở ngay dưới đây; mẫu **cập nhật khi chạm TP** ở cuối `README.md`. Cả hai được `src/telegram/caption.js` sinh ra (`buildCaption` và `buildTpUpdate`) — sửa mẫu thì phải sửa cả hàm tương ứng.

### Cấu trúc khi call lệnh

🔥 [CẶP_GIAO_DỊCH] | Khung [KHUNG_TG]
💰 Giá hiện tại: [GIÁ_HIỆN_TẠI] ([+/- %])
🚨 KHUYẾN NGHỊ: 🔴 [SHORT/BÁN] hoặc 🟢 [LONG/MUA] (Điểm: [ĐIỂM]/100)

━━━━━━━━━━━━━━━━━━
🎯 CHI TIẾT LỆNH
• Entry (Vào lệnh): [GIÁ_VÀO]
• Stoploss (Cắt lỗ): [GIÁ_SL] (Rủi ro [+/- %])
• Take Profit (Chốt lời):
   👉 TP 1: [GIÁ_TP1]
   👉 TP 2: [GIÁ_TP2]
   👉 TP 3: [GIÁ_TP3]
⚖️ Tỷ lệ R:R: [TỶ_LỆ]

━━━━━━━━━━━━━━━━━━
📊 DỮ LIỆU THỊ TRƯỜNG
• Hỗ trợ/Kháng cự : HT [GIÁ_HT] | KC [GIÁ_KC]
• Dòng tiền (CVD) : CVD [+/- %] | Vol [X]x | Sổ lệnh [+/- %]
• Tâm lý đám đông : Funding [+/- %] | OI [+/- %] | [X]% Đang Long

━━━━━━━━━━━━━━━━━━
💡 LÝ DO VÀO LỆNH
🔻 [Lý do 1: Ví dụ - Giá đi ngang nhưng CVD giảm → Đang phân phối]
🔻 [Lý do 2: Ví dụ - Đám đông dồn Long quá mức → Dễ bị quét thanh lý]
🔻 [Lý do 3: Ghi chú về tin tức, khối lượng...]

