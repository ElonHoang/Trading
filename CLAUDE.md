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
npm run review:daily                 # rà soát 24h: tỉ lệ thua, truy nguyên, đề xuất chỉnh
npm run diagnose:sl -- BTC 4h 3000   # đối chiếu đặc điểm lệnh SL với lệnh có lãi
npm run validate:filters -- BTC 4h 3000 # chọn trên 75% lịch sử, xác nhận trên 25% cuối
npm run models:index                 # bắt buộc chạy sau khi thêm/xoá file trong models/
```

Hai bot **không chạy đồng thời được** — Telegram chỉ cho một tiến trình long-poll trên mỗi token, chạy cả hai sẽ lỗi 409.

Không có test suite và không có script `test`; có thể chạy kiểm tra thủ công:

```bash
find src web bin -name '*.js' -print0 | xargs -0 -n1 node --check
node bin/build-model-index.js && git diff --quiet -- models/index.json
```

Cần Node ≥ 20. Các script dùng `--env-file-if-exists=.env`, nên không có `.env` vẫn chạy được (phần cần key sẽ tự bỏ qua).

## Bộ chỉ báo bị giới hạn cố ý

Repo dùng 7 nhóm: CVD, volume, phái sinh (funding + OI), định vị đám đông, hỗ trợ/kháng cự, order book và mẫu hình lịch sử. Mẫu hình lịch sử so đường giá + biên độ hiện tại với tối đa 6 tháng dữ liệu; chỉ được cộng điểm nếu diễn biến sau các mẫu cũ đủ đồng thuận. Chi tiết bản chất và cách diễn giải từng cái nằm ở [`.claude/skills/chi-bao/SKILL.md`](.claude/skills/chi-bao/SKILL.md) — đọc trước khi làm bất cứ gì liên quan phân tích.

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

`src/analysis/engine.js` là trung tâm: `analyze()` của nó trả về payload mà **mọi** giao diện đều dùng — CLI, cả hai bot, dashboard tĩnh và giao diện realtime. Bảy nhóm chấm điểm trong `scoreSignals()` khớp đúng danh sách tín hiệu: `cvd` 28, `volume` 22, `derivatives` 18, `positioning` 14, `structure` 12, `orderBook` 6, `historicalPattern` 10.

### Hai bất biến của phần chấm điểm — đừng phá

**1. Nhóm thiếu dữ liệu bị LOẠI khỏi chuẩn hoá trọng số**, không tính là 0 điểm. Order book và positioning không có lịch sử theo nến nên trong backtest chúng luôn thiếu; tính là 0 sẽ pha loãng điểm và gần như không bao giờ vượt ngưỡng. Lỗi này từng khiến backtest ra 9 lệnh (toàn short) thay vì 60 lệnh (14 long / 46 short).

**2. Cổng đồng thuận khác ngưỡng điểm.** `consensus.percent` đếm bao nhiêu nhóm *có dữ liệu* cùng hướng; `|điểm| ≥ 30` có thể chỉ đến từ 2 nhóm rất mạnh. Số nhóm có dữ liệu khác nhau giữa chạy thật (có thêm phái sinh, định vị và sổ lệnh) và backtest (volume/CVD/cấu trúc, cộng mẫu hình lịch sử khi đủ bằng chứng), nên cùng một % không hoàn toàn tương đương. Luật này không kiểm chứng đầy đủ được bằng backtest.

### Lớp trên engine

- `src/analysis/context.js` — Kĩ năng 2. Không cộng điểm, chỉ xác nhận hoặc phủ quyết. Mọi nguồn null-safe: lỗi mạng thì phần đó là `null` kèm `warnings`, không được chặn phần kỹ thuật.
- `src/analysis/auto-retune.js` — sau 3 SL liên tiếp, lưu bằng chứng lúc vào lệnh rồi kiểm chứng candidate bằng chia lịch sử theo thời gian; chỉ tự ghi cấu hình khi PF dương, đủ mẫu và drawdown giảm.
- `src/analysis/daily-review.js` — rà soát theo **thời gian**, khác `auto-retune` ở ba điểm: kích hoạt theo lịch chứ không theo chuỗi SL; kèo `breakeven` **không** tính là thua; candidate sinh từ chẩn đoán và đi theo chiều đã đo (nới SL, bỏ bám cấu trúc, kéo TP1 gần lại) thay vì luôn siết chặt. Mỗi candidate bị đo **hai lần**: trên các cặp vừa thua phải giảm tỉ lệ SL mà không làm tiền xấu đi, trên bộ canh gác `dailyReview.guardSymbols` ở khung 4h phải giữ kỳ vọng dương tuyệt đối. Mặc định `autoApply: false` — chỉ đề xuất, vì runner bị huỷ sau mỗi lượt nên cấu hình tự ghi sẽ mất.

  Cửa sổ thống kê do `dailyReview.windowMode` quyết định, **khác** `everyHours` (chỉ là nhịp chạy). Mặc định `calendar-day`: chỉ đếm kèo chốt trong ngày, qua 00:00 theo `dayOffsetHours` (VN = 7) là reset về 0. Chế độ cũ `all` cộng dồn tới `autoRetune.historyLimit` = 200 kèo trong khi tiêu đề vẫn in "24H", nên báo cáo một ngày hiện mấy chục kèo. Kèo **đang mở không bao giờ được tính** — `recordClosedTrade` chỉ chạy lúc kèo chạm SL/TP/hết hạn. Chưa đủ `minClosedTrades` thì vẫn báo cáo số của ngày, chỉ không đem đi backtest.
- `src/analysis/post-mortem.js` — phát lại từng kèo đã dính SL **mà chưa chốt TP1** trên nến thật rồi xếp vào 4 nhóm: `bi-quet` (SL nằm trong nhiễu, giá quay lại chạm TP1), `sai-huong` (đi ngược ngay từ nến đầu), `dao-chieu`, `chua-du-nen`. Thuần JS, không import gì — nến do bên gọi truyền vào. **Không cộng điểm, không ghi cấu hình**: nó chỉ nói nên đem hướng nào đi backtest. Hai nhóm đầu đòi cách sửa ngược nhau (nới SL / đừng vào lệnh), nên gộp chúng lại thành "tỉ lệ thua" là mất đúng phần thông tin có ích. Bắt buộc chạy **sau**, không phải lúc vừa dính SL: lúc đó nến sau chưa tồn tại nên chưa phân biệt được hai nhóm đó.
- `src/analysis/setup.js` — gộp kỹ thuật + bối cảnh thành setup (entry/SL/TP + lý do xếp theo đóng góp thật), và `buildProjections()` cho hai kịch bản lên/xuống neo vào mức S/R thật.
- `src/telegram/monitor.js` — vòng quét. Chỉ đánh giá lại **khi có nến mới đóng**; chỉ bắn khi có kèo thật (không bắn "đứng ngoài"/"chờ tín hiệu"). Có **cửa soi lại sau báo cáo ngày** (`learning.reviewAtUtc` + `pauseAfterReviewMinutes`): trong 30 phút kể từ lúc bản tổng hợp cuối ngày chạy, vòng quét không mở kèo mới. Neo vào **báo cáo**, không phải vào từng lần dính SL. Cửa chỉ chặn việc MỞ kèo — theo dõi kèo đang chạy vẫn nguyên, dừng nó thì kèo đang mở mất người canh. Kèo bị hoãn được xét lại ở lượt sau chứ không mất: kiểm tra đặt **trước** `state.set`, vì ghi `lastSignal` rồi mới bỏ qua sẽ tiêu mất lần "tín hiệu đổi" và với `onlyOnSignalChange` thì hoãn hoá ra là huỷ.

  Cửa suy ra từ **đồng hồ**, không lưu trạng thái, vì bản rà soát chạy `--no-write` nên không có đường ghi lại "tôi vừa báo cáo xong" — cho nó ghi thì nó thành nguồn ghi thứ hai và đua với vòng quét. Đổi lại, `reviewAtUtc` phải khớp cron của runner bằng tay. Nhịp Actions bị throttle còn ~3 tiếng nên cửa 30 phút chỉ có khoảng 1/6 cơ hội hứng được một lượt quét; đặt 180 nếu muốn chắc chắn chặn được một lượt.
- `src/data/open-calls.js` — kèo đang mở. Một mã đã call thì không call lại tới khi chạm SL, TP cuối, hoặc quá `alerts.maxHoldBars`.

`cautions` chỉ chứa mức `warn`; mức `info` (không tìm thấy tin, thông báo không ghi token) chuyển sang `notes` và **không hiển thị**. Riêng "không đọc được thông báo delist" là `warn` vì nghĩa là kiểm tra đã *thất bại*, khác với *đã kiểm tra và không thấy gì*.

### Ràng buộc quan trọng nhất: lõi phải chạy được trong browser

Bản web là **trang tĩnh, không có bước build** — browser `import` trực tiếp các file trong `src/` qua HTTP. Vì vậy 10 file này **không được** `import` từ `node:*` hay package npm (`@...`):

```
src/indicators/index.js   src/features.js      src/ml/gbdt.js    src/ml/dataset.js
src/data/binance.js       src/analysis/engine.js  src/analysis/historical-pattern.js
src/analysis/entry-quality.js  src/ml/train.js     src/backtest.js
```

Khi sửa các module này, hãy kiểm tra thủ công rằng chúng không import module chỉ có ở Node.

Các file *chỉ chạy ở Node* được phép dùng `node:*` và package npm (đường dẫn tính từ `src/`):

```
bot.js  server.js  cli.js  config.js  format.js
llm/claude.js  ml/model-store.js
analysis/context.js  analysis/setup.js
analysis/auto-retune.js
chart/png.js
data/watchlist.js  data/subscribers.js  data/open-calls.js
data/fundamentals.js  data/announcements.js  data/news.js
telegram/bot.js  telegram/monitor.js  telegram/caption.js
```

Thêm file mới vào `src/` thì phải quyết ngay nó thuộc nhóm nào: nếu browser cần import thì không được dùng `node:*`.

Đây là lý do `web/claude.js` gọi Claude bằng `fetch` thay vì `@anthropic-ai/sdk`, dù bản Node dùng SDK.

### Cấu hình là dữ liệu, không phải code

`config/strategy.json` chứa toàn bộ tham số: `indicators`, `weights`, `thresholds`, `ml`, `historicalPattern`, `entryQuality`, `autoRetune`, `risk`, `llm`, `alerts`, `analysis`. `config/prompt.md` là system prompt của Claude.

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

`models/` **được commit** để dashboard browser có model sẵn. `models/index.json` là manifest cho browser; chạy `npm run models:index` sau khi thêm hoặc xoá model để giữ khớp với thư mục.

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

Khung call kèo là `CALL_INTERVALS = ['4h', '1h']` — xét 4h trước, rơi xuống 1h khi 4h chưa đủ điều kiện. Định nghĩa ở cả `src/telegram/alerts-once.js` và `src/telegram/bot.js`; **sửa thì phải sửa cả hai**.

**4h là khung duy nhất có lợi thế đo được.** Trên 7 cặp, chia 75% để chọn / 25% mới hơn để xác nhận, cấu hình hiện tại cho 4h: win 56,6% · PF 1,29 · kỳ vọng +0,314%/lệnh · +45,08% ở đoạn giữ lại. Cùng phép đo trên 1h/15m: PF 0,64 và kỳ vọng **âm**. Nặng hơn nữa, win rate trên 1h/15m khớp gần đúng `1/(1+k)` với TP = k·R (đo 52,0% / 61,4% / 75,8% / 79,2% ở k = 1 / 0,5 / 0,33 / 0,25) — tức là **kết quả của rào cản, không phải của lợi thế**. Đã quét 21 vùng điều kiện ở R:R 1R trên 1h/15m: không vùng nào đạt 70% ở cả hai đoạn, kể cả nới xuống 60%.

Vì vậy 15m **đã bị bỏ** khỏi danh sách call. 1h giữ lại làm phương án rơi, nhưng kèo sinh từ 1h là phần **kéo win rate xuống** — không phải phần đã kiểm chứng. `/ta btc 15m` vẫn xem được.

### Những núm đã đo và KHÔNG được siết

Bản năng "nhiều SL thì siết điều kiện vào lệnh cho chắc" đã được kiểm chứng và **sai**. Đo trên 6 cặp, chia 75/25 theo thời gian, đoạn giữ lại:

| Siết cái gì | Tỉ lệ SL thật | PF |
|---|---|---|
| không siết (gốc) | 49,0% | 0,45 |
| `consensusPercent` ≥ 70/75/80 | 54,2% | 0,25 |
| `thresholds.buy` ≥ 35 | 53,3% | 0,33 |
| `thresholds.buy` ≥ 40 | 55,0% | 0,33 |

`diagnose:sl` nói cùng chuyện: lệnh SL có đồng thuận **cao hơn** lệnh có lãi ở cả 4 cặp đo được, và trên BTC 15m còn có volume cao hơn (2,08 vs 1,49).

Hệ quả cần biết: **3 trong 4 candidate của `autoRetune` đang siết đúng những núm này** — `score-threshold`, `flow-confirmation` (CVD+volume), `flow-and-score`. Nếu chuỗi SL kích hoạt và một trong số đó được áp, khả năng cao là làm xấu thêm. Riêng `smaller-stop` thì siết **sai chiều**: dữ liệu nói `slPercent` phải NỚI ra, không phải thu vào (2,5 → 3,5 giảm SL thật từ 48,7% xuống 28,6% trên 1h/15m).

### Ba khoá `risk` phải đổi cùng nhau

`slPercent 4` · `takeProfitR [0,75; 1,5; 2,25]` · `preferSrLevels false` là **một gói**, không tách rời được. Đo trên 8 cặp khung 4h, 3000 nến, chia 75% chọn / 25% mới hơn xác nhận, có áp cổng `alerts.minAbsScore` 35 như production:

| | trước (2,5 · 0,5R · bám cấu trúc) | sau |
|---|---|---|
| Tỉ lệ dính SL | 36,3% | 32,8% |
| PF | 1,084 | 1,43 |
| Kỳ vọng/lệnh | +0,063% | +0,580% |
| Tổng đoạn giữ lại | +13,3% | +67,3% |

Hai cạm bẫy đã đo, đừng lặp lại:

- **Nới `slPercent` mà vẫn để `preferSrLevels: true` thì vô ích.** `buildLevels` bám SL vào S/R khi khoảng cách nằm trong `0,4×`–`2,5×` mức cơ sở, nên nới `slPercent` chỉ nới luôn vùng chấp nhận — khoảng cách thật vẫn neo vào mức S/R. Đo được: 2,5 → 3 → 3,5 → 4 cho tỉ lệ SL 35,8% → 35,9% → 35,8% → 35,4%, tức đứng yên. Tắt bám cấu trúc rồi thì cả tỉ lệ SL lẫn kỳ vọng mới cải thiện **đơn điệu** theo `slPercent` ở cả hai đoạn dữ liệu.
- **Đẩy TP ra xa làm TĂNG tỉ lệ dính SL**, vì TP1 chính là cái kích hoạt kéo SL về entry. Giữ SL 2,5%, chỉ đổi TP1: 0,5R → SL 35,8%; 0,75R → 45,3%; 1R → 51,5%; 1,5R → 57,9%. Muốn vừa ít SL vừa lãi hơn thì phải nới SL trước rồi mới đẩy TP.

`autoRetune` có candidate `smaller-stop` siết `slPercent` và `autoRetune.minSlPercent` vẫn là 1,5 — tức nếu cơ chế đó được bật thật, nó có quyền kéo 4 xuống 1,5 và xoá sạch thay đổi này.

Ba thứ khác đang chết lặng, biết để khỏi mất thời gian:

- `historicalPattern` có trọng số 10 nhưng đóng góp **đúng 0** trong mọi backtest — `requiredHistoryMonths: 6` không đạt được trên cửa sổ 3000 nến của 1h/15m.
- `models/` chỉ có `BTCUSDT_4h`, nên `ml.weightVsRules` vô hiệu ở phần lớn mã. Model đó cũng dưới `ml.minTestAuc`.
- `autoRetune.enabled` bị `loadActionStrategy()` đặt `false` ở production (GitHub Actions) — toàn bộ cơ chế tự kiểm chứng sau 3 SL **chưa từng chạy thật**.

Watchlist vẫn có hai đường ghi vào `data/watchlist.json`: `loadWatchlist`/`saveWatchlist` trong `src/config.js` (bot AI dùng) và `src/data/watchlist.js` (server + bot chart dùng). Ghi từ hai phía sẽ đè lẫn nhau — chưa hợp nhất.

File trạng thái, đều gitignored: `data/alert-chats.json` (chat đã bật cảnh báo), `data/open-calls.json` (kèo đang mở).

### Triển khai: bản chạy thật nằm ở repo KHÁC

Kèo tự động **không** chạy từ repo này. Ba repo, chia theo quyền:

| Repo | Vai trò |
|---|---|
| `ElonHoang/Trading` (repo này, public) | mã nguồn. Runner checkout nhánh `production` |
| `ElonHoang/Trading-runner` (public) | chạy cron 5 phút, gọi `npm run scan:github` |
| `ElonHoang/Trading-state` (private) | `open-calls.json`, `monitor-state.json`, `auto-retune.json` dạng plaintext |

`npm run scan:github` **trùng lệnh với `alerts:once`** — runner gọi tên đó, giữ hai tên cho khớp và đừng để lệch nhau.

`.github/workflows/telegram-alerts.yml` trong repo này là bản **fallback, chỉ chạy tay**. Schedule đã bị bỏ có chủ đích: nó lưu trạng thái ở nhánh `bot-state` mã hoá, còn runner lưu ở `Trading-state` — hai nguồn riêng biệt, nên bật cả hai sẽ khiến mỗi kèo bị bắn hai lần rồi SL/TP được theo dõi trên hai bản lệch nhau. **Đừng bật lại schedule ở đây** khi runner còn sống.

`.github/workflows/daily-review.yml` cũng **chỉ chạy tay**, cùng một lý do: trạng thái thật nằm ở `Trading-state`, còn workflow trong repo này chỉ đọc được nhánh `bot-state` của chính nó, nên đặt lịch ở đây sẽ rà soát lịch sử **cũ** và báo tỉ lệ thua không khớp kèo đã bắn.

Bản rà soát chạy thật là `Trading-runner/.github/workflows/daily-review.yml`, cron `7 1 * * *` (**08:07 giờ VN**), chạy `npm run review:daily -- --telegram --force --no-write`. Nó chỉ khôi phục `data/auto-retune.json` từ `Trading-state` rồi xoá bản checkout đi — `open-calls.json` và `monitor-state.json` thuộc về vòng quét, không đụng tới. `--force` vì cron đã lo nhịp 24h, `--no-write` vì bản rà soát chỉ đọc lịch sử — nó **không được** trở thành nguồn ghi thứ hai vào trạng thái dùng chung.

Giờ chạy đó quyết định `dailyReview.dayOffsetDays` phải là **-1**: 08:07 sáng mà rà "ngày đang chạy" thì cửa sổ mới mở được 8 tiếng, khung 4h vừa đóng 2 nến, báo cáo gần như trống. Đổi cron về cuối ngày thì mới đặt lại 0. Sửa ở repo này là đủ — runner checkout `production` nên cấu hình đi theo, không cần sửa workflow bên kia.

Nhịp cron thực tế của GitHub Actions là **~3 tiếng, không phải 5 phút** — scheduled workflow trên runner công khai bị throttle nặng. Đây là một lý do nữa khiến khung 15m không bao giờ hoạt động như thiết kế (96 nến/ngày mà quét 8 lần), còn 4h (6 nến/ngày) thì vừa. Muốn nhịp đáng tin thì chạy `Dockerfile` ở máy riêng, tăng tần suất cron không giúp gì.

### Giao diện

`src/server.js` phục vụ cả hai, và mở `web/ src/ config/ models/` để browser import module trực tiếp:

- `/` — dashboard tĩnh cục bộ (`index.html` + `web/`), mọi tính toán chạy trong browser.
- `/realtime/` — `public/index.html`, nến cập nhật qua WebSocket Binance; **điểm và chỉ báo lấy từ `/api/analyze`**, không tính ở client, vì chỉ báo chỉ được tính trên nến đã đóng. Khi nến đóng, trang tự gọi lại snapshot.

`src/chart/render.js` chỉ nhận một context 2D nên dùng được cả cho canvas trình duyệt và `@napi-rs/canvas` khi bot xuất PNG — cùng một bộ vẽ, không có bản sao lệch nhau.

## Skill

Trước khi đưa ra bất kỳ phân tích thị trường nào, **phải** dựa vào các kĩ năng trong `.claude/skills/`. Không tự tính chỉ báo bằng tay, không ước lượng bằng mắt, không bịa số.

| # | Kĩ năng | Nội dung | Đường dẫn |
|---|---|---|---|
| 1 | Chỉ báo | Order book, volume, OI, funding, CVD, định vị đám đông, hỗ trợ/kháng cự, mẫu hình lịch sử — cho ra điểm và setup | [`.claude/skills/chi-bao/SKILL.md`](.claude/skills/chi-bao/SKILL.md) |
| 2 | Tin tức & tokenomics | Tokenomics, rủi ro delist, tin tức — xác nhận hoặc **phủ quyết** setup của Kĩ năng 1 | [`.claude/skills/tin-tuc-tokenomics/SKILL.md`](.claude/skills/tin-tuc-tokenomics/SKILL.md) |
| 3 | Trading in the Zone | Kỷ luật thực thi: tư duy xác suất, SL/R:R, không FOMO/revenge trade và kiểm chứng sau chuỗi SL; không tạo tín hiệu hay cộng điểm | [`.claude/skills/trading-in-the-zone/SKILL.md`](.claude/skills/trading-in-the-zone/SKILL.md) |

Kĩ năng 2 **không cộng điểm** — dòng tiền tính bằng giây/giờ còn tokenomics tính bằng ngày/tuần, trộn vào một thang sẽ làm méo điểm và mất khả năng backtest.

Kĩ năng 3 cũng **không cộng điểm và không tự đổi cấu hình theo vài lệnh đơn lẻ**. Sau chuỗi SL, chỉ `auto-retune` đã kiểm chứng theo thời gian mới được áp dụng thay đổi an toàn.

Hai mẫu tin nhắn: mẫu **call kèo** ở ngay dưới đây; mẫu **cập nhật khi chạm TP** ở cuối `README.md`. Cả hai được `src/telegram/caption.js` sinh ra (`buildCaption` và `buildTpUpdate`) — sửa mẫu thì phải sửa cả hàm tương ứng.

### Cấu trúc khi call lệnh

🔥 [CẶP_GIAO_DỊCH] | Khung [KHUNG_TG]
💰 Giá hiện tại: [GIÁ_HIỆN_TẠI] ([+/- %])
🚨 KHUYẾN NGHỊ: 🔴 [SHORT/BÁN] hoặc 🟢 [LONG/MUA] hoặc 🟡 [LIMIT]

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
💡 LÝ DO VÀO LỆNH
🔻 [Lý do 1: Ví dụ - Giá đi ngang nhưng CVD giảm → Đang phân phối]
🔻 [Lý do 2: Ví dụ - Đám đông dồn Long quá mức → Dễ bị quét thanh lý]
🔻 [Lý do 3: Ghi chú về tin tức, khối lượng...]

