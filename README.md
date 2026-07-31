# Phân tích dòng tiền crypto

Công cụ đọc dòng tiền và vị thế của một token trên Binance, cho ra điểm tổng hợp và
setup vào lệnh (entry / stop loss / take profit) kèm lý do cụ thể.

Có ba mặt sử dụng, tất cả dùng **cùng một engine** nên số liệu luôn khớp nhau:

| Mặt | Lệnh | Ghi chú |
|---|---|---|
| Bot Telegram (chart) | `npm run bot` | Call kèo kèm ảnh chart, theo dõi liên tục |
| Web local | `npm start` | Dashboard tĩnh tại `/` và giao diện realtime tại `/realtime/` |
| CLI | `npm run analyze -- BTC 1h` | Phân tích trong terminal |

---

## Bộ chỉ báo bị giới hạn cố ý

Repo **chỉ** dùng 6 nhóm dữ liệu, mô tả chi tiết trong
[`.claude/skills/chi-bao/SKILL.md`](.claude/skills/chi-bao/SKILL.md):

| Nhóm | Trọng số | Nguồn |
|---|---|---|
| CVD (mua/bán chủ động) | 28 | suy từ `takerBuyVolume` của mỗi nến |
| Khối lượng | 22 | so với trung bình 20 nến |
| Phái sinh (funding + OI) | 18 | Binance futures |
| Định vị đám đông | 14 | tỉ lệ long/short tài khoản, vị thế top trader, taker ratio |
| Hỗ trợ / kháng cự | 12 | pivot gom cụm, kèm số lần chạm |
| Sổ lệnh | 6 | lệch mua/bán, tường lệnh, độ mỏng |

**EMA, RSI, MACD, Bollinger, ATR, ADX, Stochastic, VWAP, OBV và phân kỳ RSI đã bị xoá
khỏi codebase.** Đây là quyết định có chủ ý, không phải thiếu sót. Lấy lại từ commit
`2155bd4` nếu cần.

Hai điều đi kèm với lựa chọn đó, đo được chứ không phỏng đoán:

- Model ML yếu hơn hẳn. Bộ feature giảm từ 32 xuống 16; AUC holdout từ 0,554 xuống
  **0,5116**, walk-forward từ 0,541 xuống **0,5076** — dưới ngưỡng `ml.minTestAuc` 0,52
  nên **hệ thống tự động không dùng ML** để ra quyết định.
- Trong 16 feature còn lại, `cvdSlope` là feature mạnh nhất (14,9%), rồi
  `cvdSlopeChange` (10,4%). CVD thật sự có tín hiệu.

### Cái không có

- **Không có liquidity map / heatmap thanh lý.** Binance đã bỏ endpoint lịch sử thanh lý
  toàn thị trường (`/fapi/v1/allForceOrders` → 404); `forceOrders` cần API key và chỉ trả
  lệnh của chính bạn. Heatmap kiểu Coinglass là mô hình tự dựng, không phải dữ liệu
  Binance. Nhóm "định vị đám đông" thay thế phần đó bằng dữ liệu thật có lịch sử.
- **Không có lịch unlock / vesting.** CoinGecko không có trường nào về unlock và không có
  nguồn miễn phí nào khác. `circulatingPercent` thấp chỉ là chỉ dấu gián tiếp.

---

## Chạy ở máy mình

Yêu cầu Node.js ≥ 20.

```bash
git clone <repo-url>
cd <repo>
npm install
cp .env.example .env     # điền TELEGRAM_BOT_TOKEN và TELEGRAM_OWNER_IDS
npm run bot              # bot Telegram
npm start                # web local, mặc định http://localhost:3000
```

Các lệnh khác:

```bash
npm run analyze -- BTC 1h --no-ai   # phân tích trong terminal
npm run train -- BTC 4h             # train model, lưu vào models/
npm run backtest -- BTC 4h 3000     # backtest có SL/TP
npm run models:index                # BẮT BUỘC chạy sau khi thêm/xoá file trong models/
npm run bot:ai                      # bot Telegram bản có Claude (xem phần chi phí)
```

**Hai bot không chạy đồng thời được.** Telegram chỉ cho một tiến trình long-poll trên mỗi
token; chạy cả `npm run bot` và `npm run bot:ai` sẽ làm cả hai lỗi 409.

**Bot chạy từ máy này.** Tắt máy là bot ngừng — nó dùng long polling, không có webhook.
Muốn 24/7 thì cần host thường trú (Oracle Cloud Always Free chạy được nguyên code này).

---

## Bot Telegram

### Lệnh

| Lệnh | Quyền | Việc |
|---|---|---|
| `/ta <mã>` | ai cũng dùng | Call kèo, bot **tự chọn khung 1h hoặc 15m** tuỳ khung nào đủ điều kiện |
| `/ta <mã> <khung>` | ai cũng dùng | Xem khung cụ thể, vd `/ta btc 4h` |
| `/gia <mã>` | ai cũng dùng | Giá nhanh, không kèm ảnh |
| `/list` | ai cũng dùng | Danh sách theo dõi |
| `/id` | ai cũng dùng | Xem user id và quyền của mình |
| `/canhbao` `/tatcanhbao` | **chỉ chủ bot** | Bật/tắt theo dõi liên tục |
| `/add` `/del` | **chỉ chủ bot** | Sửa danh sách theo dõi |

Quyền lấy từ `TELEGRAM_OWNER_IDS` trong `.env`. **Để trống = chặn hết lệnh ghi**
(fail-closed) — cần thiết vì bot có thể ở trong group, nơi ai cũng sửa được watchlist
dùng chung. Gửi `/id` cho bot để lấy user id của mình.

### Theo dõi liên tục

Bật bằng `/canhbao`. Mỗi `alerts.pollSeconds` (60s) bot quét lại, nhưng **chỉ đánh giá lại
khi có nến mới đóng** — chỉ báo tính trên nến đã đóng nên poll dày hơn nến chỉ tốn request.

Cách chọn mã để quét:

1. Một request lấy ticker toàn sàn (~3.700 symbol, 80 request-weight).
2. Lọc cặp USDT đang giao dịch có khối lượng ≥ `alerts.scanMinQuoteVolumeUsd` ($3M).
3. Lấy hợp của top 15 khối lượng và top 15 biến động, cộng watchlist bạn tự thêm.

Kết quả khoảng 24 mã, tốn ~1.400 weight/lượt (24% giới hạn 6.000/phút). Phân tích đầy đủ
một mã tốn 56 weight — riêng `depth limit=1000` đã 50 — nên quét cả 479 cặp USDT sẽ tốn
~26.800 weight/lượt, vượt xa giới hạn.

### Điều kiện call kèo

Ba cửa phải qua hết:

1. `|điểm| ≥ thresholds.buy` (30) để có hướng long/short.
2. **Cổng đồng thuận**: ≥ `thresholds.consensusPercent` (60%) số nhóm **có dữ liệu** phải
   cùng hướng. Khác ngưỡng điểm — điểm 40 có thể chỉ đến từ 2 nhóm rất mạnh.
3. Bối cảnh cơ bản không phủ quyết (xem Kĩ năng 2).

Rồi mới tới ngưỡng báo `alerts.minAbsScore` (35). Bot **không** bắn tin "đứng ngoài" hay
"chờ tín hiệu" — điểm cao mà bị chặn thì không phải một kèo.

### Kèo đang mở

Một mã đã được call thì **không call lại** cho tới khi kèo đó chốt. Trạng thái lưu ở
`data/open-calls.json` (gitignored, phải ghi ra đĩa vì bot restart thường xuyên):

| Xảy ra | Xử lý |
|---|---|
| Chạm TP1 / TP2 | Báo cập nhật theo template bên dưới, kèo **vẫn mở** |
| Chạm TP cuối | Chốt kèo, mã được call lại từ nến sau |
| Chạm SL | Chốt kèo |
| Quá `alerts.maxHoldBars` (96 nến) | Hết hạn — không có mốc này thì kèo lửng lơ chặn mã đó mãi mãi |

Quy ước bảo thủ giống backtest: một nến chạm **cả** SL và TP thì tính là SL, vì không biết
cái nào xảy ra trước trong nến.

---

## Hai kĩ năng

Mọi phân tích đều phải đi qua chúng, không ước lượng bằng mắt, không bịa số.

| # | Kĩ năng | Việc | Tài liệu |
|---|---|---|---|
| 1 | Chỉ báo | 6 nhóm ở trên → điểm và setup | [`chi-bao`](.claude/skills/chi-bao/SKILL.md) |
| 2 | Tin tức & tokenomics | Tokenomics, rủi ro delist, tin tức → **xác nhận hoặc phủ quyết** setup | [`tin-tuc-tokenomics`](.claude/skills/tin-tuc-tokenomics/SKILL.md) |

**Kĩ năng 2 không cộng điểm.** Dòng tiền tính bằng giây đến giờ, tokenomics tính bằng ngày
đến tuần; trộn vào cùng thang `-100..100` sẽ làm méo điểm và mất khả năng backtest
(tokenomics không có lịch sử theo nến). Nó chỉ chặn: cặp không TRADING → chặn cả hai chiều;
có thông báo delist nhắc token → chặn long.

Nguồn dữ liệu của Kĩ năng 2, kèm mức độ tin được:

| Dữ liệu | Nguồn | Chính thức? | Cần key |
|---|---|---|---|
| Tokenomics | CoinGecko `/coins/{id}` | có | không |
| Trạng thái cặp | Binance `exchangeInfo` | **có — tin nhất** | không |
| Thông báo delist | Binance CMS `catalogId=161` | **KHÔNG chính thức** | không |
| Tin tức | RSS CoinDesk + Cointelegraph, lọc theo token | có | không |

Endpoint delist không có trong tài liệu API của Binance, có thể bị đổi hoặc chặn bất cứ
lúc nào, và giới hạn `pageSize ≤ 20` (lớn hơn trả HTTP 400). Vì vậy luôn kèm trạng thái cặp
làm chỗ dựa chính thức.

Tin tức là RSS **tin chung** được lọc theo tên/ticker: token lớn thường có tin, token nhỏ
hầu như không. "Không có tin" nghĩa là "không tìm thấy trong các nguồn này", không phải
"không có gì xảy ra".

---

## Cấu trúc tin nhắn

Mẫu tin call kèo nằm ở mục "Cấu trúc khi call lệnh" trong [`CLAUDE.md`](CLAUDE.md).
Mẫu tin cập nhật khi chạm TP nằm ở cuối file này.

---

## Tinh chỉnh

Mọi tham số ở `config/strategy.json`, không hardcode trong code. `setStrategyValue()` cố ý
**chỉ cho ghi vào khoá đã tồn tại** để gõ sai không tạo khoá rác.

| Nhóm | Việc |
|---|---|
| `weights.*` | Coi trọng nhóm nào. Đặt `0` để tắt hẳn. |
| `thresholds.*` | Ngưỡng tín hiệu, cổng đồng thuận, mức đám đông lệch, ngưỡng volume đột biến |
| `indicators.*` | Chu kỳ `volumeAvg` và `cvdSlope` (đều 20) |
| `risk.*` | `slPercent` 2,5% (thay cho bội số ATR trước đây), mốc TP theo R, `displayLeverage` chỉ để quy đổi hiển thị |
| `alerts.*` | Chu kỳ quét, ngưỡng báo, phạm vi sàng lọc, hạn giữ kèo |
| `ml.*` | Horizon, cách gán nhãn (`triple-barrier` theo % giá), siêu tham số. Sửa xong **phải train lại**. |
| `llm.*` | Chỉ ảnh hưởng bot AI |

Bản web giữ bản ghi đè riêng trong localStorage; nút "Về mặc định" xoá mọi thay đổi.

---

## Chi phí

Toàn bộ phần đang chạy **miễn phí, không cần API key nào**: Binance REST + WebSocket,
CoinGecko, Binance CMS, RSS, Telegram Bot API. Các thư viện (`express`, `grammy`,
`@napi-rs/canvas`) đều mã nguồn mở.

**Có một đường tính phí trong code:** `src/llm/claude.js` (dùng `@anthropic-ai/sdk`) và
`web/claude.js`, tính tiền theo token. Chỉ hai chỗ import nó: `npm run bot:ai` và
`npm run analyze`. Không có `ANTHROPIC_API_KEY` thì phần AI tự bị bỏ qua.

Nhưng `config/strategy.json` đang đặt `llm.enabled: true`, `model: claude-opus-5`,
`effort: high`, `maxTokens: 6000` — nghĩa là **ngay khi thêm key vào là nó gọi model đắt
nhất với effort cao nhất**. Muốn chắc chắn không phát sinh phí thì đặt `llm.enabled: false`.

Rủi ro tương lai: CoinGecko hiện gọi được không cần key nhưng đây là free tier của bên thứ
ba, họ đang đẩy mạnh tier có key. Nếu bị chặn thì Kĩ năng 2 mất phần tokenomics — code đã
viết null-safe nên xuống cấp êm, không sập.

---

## Kết quả kiểm chứng

Backtest BTCUSDT 4h, 3000 nến (~2025-03 → 2026-07), phí 0,06%/chiều, chốt 50% ở TP1 rồi
kéo SL về entry:

| Cổng đồng thuận | Lệnh | Long/Short | Win rate | Profit factor | Lợi nhuận |
|---|---|---|---|---|---|
| tắt / 50% / **60%** (đang dùng) | 60 | 14/46 | 50% | 1,05 | **+1,03%** |
| **70% / 90% / 100%** | 41 | 11/30 | 61% | 1,63 | **+26,76%** |

Mua & giữ cùng kỳ: **−30,6%**.

**Đọc thẳng:** ở mức 60% đang dùng, hệ thống về cơ bản **hoà vốn** — profit factor 1,05.
Mức 70% cho kết quả tốt hơn nhiều nhưng có hai lý do chưa thể tin ngay:

1. 41 lệnh chỉ vừa qua ngưỡng 40 mà chính README này coi là quá ít để kết luận, và đây là
   **một token, một giai đoạn**.
2. **Backtest chỉ có 3 nhóm có lịch sử** (volume, cvd, structure). `orderBook`,
   `derivatives`, `positioning` không có dữ liệu theo từng nến nên bị loại. Chạy thật có 6
   nhóm, nên cùng một % sẽ nghiêm khắc hơn nhiều: 70% = 3/3 khi backtest nhưng 5/6 khi chạy
   thật. **Luật này không kiểm chứng đầy đủ được bằng backtest.**

Ngưỡng `buy`/`sell` ±30 cũng là mức kế thừa từ bộ chỉ báo cũ, **chưa tinh chỉnh lại** cho
bộ dòng tiền.

Kết luận: dùng tool để đọc thị trường có hệ thống, không phải để bấm theo tín hiệu.

## Những cơ chế chống tự lừa mình

- **Không shuffle** dữ liệu chuỗi thời gian; chia train/test theo thời gian.
- **Walk-forward 4 fold** ngoài holdout. Holdout đẹp mà walk-forward kém thì tool báo thẳng
  là ăn may và không dùng ML.
- **Guard rail `ml.minTestAuc`.** Model dưới ngưỡng thì trọng số ML về 0 — đúng tình trạng
  hiện tại.
- **Không look-ahead.** Feature tại nến `i` chỉ dùng dữ liệu đến `i`. Nến đang chạy bị loại
  khỏi mọi tính toán (`closedCandles`).
- **Nhóm thiếu dữ liệu bị LOẠI khỏi chuẩn hoá trọng số**, không tính là 0 điểm. Tính là 0
  làm điểm bị pha loãng — lỗi này từng khiến backtest chỉ ra 9 lệnh toàn short thay vì 60
  lệnh có cả long.
- **Backtest bảo thủ.** Cùng một nến chạm cả SL và TP thì tính là SL.
- **Feature đều là tỉ lệ**, không dùng giá tuyệt đối.
- **Cảnh báo xung đột** tự động: phân kỳ giá vs CVD, khối lượng thấp, khung lớn ngược hướng.
- **Không im lặng bỏ qua.** Backtest báo số tín hiệu bị cổng đồng thuận loại; thông báo
  delist không đọc được thì báo là *chưa kiểm tra được*, khác với *đã kiểm tra và không thấy*.

---

## Cấu trúc code

Điểm quan trọng: **module lõi không phụ thuộc Node**, nên browser và Node dùng đúng một bộ
code. CI chặn cứng bằng `grep` trên 8 file cụ thể (xem `deploy-pages.yml`).

```
index.html               Dashboard tĩnh (GitHub Pages phục vụ từ đây)
web/                     Lớp riêng của browser: app.js, style.css, store.js,
                         model-store.js, claude.js, worker.js
public/index.html        Giao diện realtime (WebSocket Binance)
src/                     LÕI — dùng chung browser & Node
  data/binance.js        Nến, ticker, funding, OI, sổ lệnh + tường, định vị đám đông,
                         resolveSymbol (đối chiếu danh sách cặp thật)
  indicators/index.js    sma, cvd, cvdSlope, pivots, supportResistance
  features.js            16 feature cho ML
  ml/gbdt.js             Gradient boosting + AUC/logloss + hiệu chuẩn xác suất
  ml/dataset.js          Gán nhãn (triple-barrier / fixed theo % giá) + chia theo thời gian
  analysis/engine.js     6 nhóm chấm điểm, đồng thuận, kết hợp ML, sinh mức giá
  backtest.js            Backtest có SL/TP, chốt lời từng phần
  ---- chỉ chạy ở Node ----
  analysis/context.js    Kĩ năng 2: gộp tokenomics + delist + tin tức, luật cứng
  analysis/setup.js      Gộp kỹ thuật + bối cảnh → setup, lý do, phép chiếu hai chiều
  chart/render.js        Bộ vẽ dùng chung (canvas browser + @napi-rs/canvas)
  chart/png.js           Xuất PNG cho bot
  telegram/bot.js        Bot chart
  telegram/monitor.js    Vòng quét liên tục
  telegram/caption.js    Soạn tin theo template
  data/fundamentals.js   CoinGecko
  data/announcements.js  Thông báo delist Binance
  data/news.js           RSS
  data/open-calls.js     Trạng thái kèo đang mở
  bot.js, server.js, cli.js, config.js, format.js, llm/claude.js, ml/model-store.js
bin/                     CLI: train, backtest, build-model-index
config/strategy.json     Toàn bộ tham số
config/prompt.md         System prompt của Claude (chỉ bot AI dùng)
models/                  Model đóng gói sẵn + index.json
.claude/skills/          Hai kĩ năng
```

`src/analysis/engine.js` là trung tâm: `analyze()` trả về payload mà **mọi** giao diện đều
dùng. `src/chart/render.js` chỉ nhận một context 2D nên dùng được cả cho canvas trình duyệt
và `@napi-rs/canvas` — cùng một bộ vẽ, không có bản sao lệch nhau.

### Ràng buộc: lõi phải chạy được trong browser

Bản web là trang tĩnh **không có bước build** — browser `import` trực tiếp file trong `src/`
qua HTTP. Vì vậy 8 file này không được `import` từ `node:*` hay package npm:

```
src/indicators/index.js   src/features.js         src/ml/gbdt.js   src/ml/dataset.js
src/data/binance.js       src/analysis/engine.js  src/ml/train.js  src/backtest.js
```

Đây là lý do `web/claude.js` gọi Claude bằng `fetch` thay vì SDK.

---

## Giới hạn cần biết

- Dữ liệu từ **Binance spot**. `resolveSymbol` đối chiếu danh sách cặp thật nên `wbtc` →
  `WBTCUSDT` còn `ethbtc` → `ETHBTC`; mã không tồn tại thì báo lỗi rõ ràng.
- Funding rate, OI và định vị đám đông **chỉ có với token có hợp đồng futures**. Cổ phiếu
  token hoá (bStocks) không có → chỉ còn 4 nhóm, nên cổng đồng thuận tính trên mẫu nhỏ hơn
  và dễ đạt hơn một cách giả tạo.
- Cần **≥ 30 nến đã đóng** để chấm điểm, **≥ 60** cho ML feature, **≥ 600** để train.
- Sổ lệnh là **ảnh chụp**, bị spoofing được, không có lịch sử nên không backtest được.
- CVD ở đây là **xấp xỉ theo nến** (từ `takerBuyVolume`), không phải tick-by-tick.
- `openInterestChangePct` luôn tính trên `period=4h&limit=14` (~2,3 ngày) bất kể khung đang
  phân tích.
- Phân tích kỹ thuật không dự đoán được tin tức, hack, hay quyết định của Fed.

**Đây là công cụ phân tích kỹ thuật tự động, không phải lời khuyên đầu tư.**

---

## Cấu trúc sau khi done TP call kèo

```
🚀 CẬP NHẬT: [CẶP_GIAO_DỊCH] HIT TP [1/2/3/FULL]!
💰 Lợi nhuận: +[X]% (Spot) | +[Y]% (Đòn bẩy [Z]x)

━━━━━━━━━━━━━━━━━━
🎯 CHI TIẾT CHỐT LỜI
• Entry đã gọi : [GIÁ_VÀO]
• Mốc TP vừa hit : [GIÁ_TP]
• Trạng thái lệnh : [Đã chốt 1 phần, gồng tiếp / Chốt hết]

━━━━━━━━━━━━━━━━━━
🛠 HÀNH ĐỘNG TIẾP THEO
✅ Chốt lời: Đóng [X]% khối lượng lệnh tại đây.
🛡 Quản lý rủi ro: Dời Stoploss về Entry (hoà vốn).
👀 Mục tiêu tiếp: TP [2/3] tại giá [GIÁ_TP_TIẾP].

━━━━━━━━━━━━━━━━━━
💡 NHẬN ĐỊNH NGẮN
💬 [Nhận định dựa trên CVD hiện tại: còn thuận hay đã đảo chiều]
```

Các con số không tự đặt ra: `%` chốt lời lấy từ `risk.partialFraction` (cùng con số backtest
dùng cho chiến lược `scaled`), đòn bẩy quy đổi lấy từ `risk.displayLeverage`, và nhận định
suy từ `cvdSlope` hiện tại. Tin cập nhật **reply vào đúng tin call gốc** nhờ message id lưu
trong `data/open-calls.json`.
