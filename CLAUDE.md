# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ngôn ngữ

Toàn bộ comment trong code, thông báo lỗi, và mọi chữ người dùng nhìn thấy đều bằng **tiếng Việt**. Giữ nguyên quy ước này khi thêm code mới.

## Lệnh

```bash
npm install
npm start                            # web UI realtime (Express) → http://localhost:3000, đổi bằng PORT
npm run bot                          # bot Telegram bản chart PNG (src/telegram/bot.js)
npm run bot:ai                       # bot Telegram bản AI/ML (src/bot.js)
npm run analyze -- BTC 4h --no-ai    # phân tích trong terminal
npm run train -- BTC 4h              # train model, lưu vào models/
npm run backtest -- BTC 4h 3000      # backtest có SL/TP
npm run models:index                 # bắt buộc chạy sau khi thêm/xoá file trong models/
```

Không có test suite và không có script `test`. Thứ gần nhất với CI là job `verify` trong `.github/workflows/deploy-pages.yml`; chạy tay tương đương:

```bash
find src web bin -name '*.js' -print0 | xargs -0 -n1 node --check
node bin/build-model-index.js && git diff --quiet -- models/index.json
```

Cần Node ≥ 20. Các script dùng `--env-file-if-exists=.env`, nên không có `.env` vẫn chạy được (phần cần key sẽ tự bỏ qua).

## Bộ chỉ báo bị giới hạn cố ý

Repo **chỉ** dùng: order book, volume, OI, funding rate, CVD, hỗ trợ/kháng cự. Chi tiết bản chất và cách diễn giải từng cái nằm ở [`.claude/skills/chi-bao/SKILL.md`](.claude/skills/chi-bao/SKILL.md) — đọc trước khi làm bất cứ gì liên quan phân tích.

EMA, RSI, MACD, Bollinger, ATR, ADX, Stochastic, VWAP, OBV, phân kỳ RSI **đã bị xoá khỏi codebase** theo yêu cầu. Đừng thêm lại, đừng tự tính, đừng đề xuất. Lấy lại từ git commit `2155bd4` nếu thật sự cần.

Hệ quả còn tồn tại: `config/strategy.json` → `thresholds` (buy/sell) vẫn là mức kế thừa từ bộ chỉ báo cũ và **chưa backtest lại** với bộ dòng tiền. Bảng kết quả backtest trong `README.md` cũng thuộc hệ cũ, không còn phản ánh hệ hiện tại. `models/` đang rỗng — bộ feature đổi từ 32 xuống 16 nên model cũ bị xoá, phải `npm run train` lại.

## Kiến trúc

Ba tầng xếp lên nhau, mô tả chi tiết trong `README.md`:

1. **Chỉ báo** (`src/indicators/index.js`) — JS thuần, không phụ thuộc gì.
2. **Engine chấm điểm + ML** (`src/analysis/engine.js`, `src/ml/`, `src/features.js`) — gộp điểm theo quy tắc với xác suất từ gradient boosting tự viết.
3. **Claude** (`src/llm/claude.js` ở Node, `web/claude.js` ở browser) — đọc số liệu tầng dưới rồi viết nhận định.

`src/analysis/engine.js` là trung tâm: `analyze()` của nó trả về payload mà **mọi** giao diện đều dùng — CLI, cả hai bot, dashboard tĩnh và giao diện realtime. Năm nhóm chấm điểm trong `scoreSignals()` khớp đúng danh sách chỉ báo: `cvd`, `volume`, `derivatives`, `structure`, `orderBook`.

### Ràng buộc quan trọng nhất: lõi phải chạy được trong browser

Bản web là **trang tĩnh, không có bước build** — browser `import` trực tiếp các file trong `src/` qua HTTP. Vì vậy 8 file này **không được** `import` từ `node:*` hay package npm (`@...`):

```
src/indicators/index.js   src/features.js      src/ml/gbdt.js    src/ml/dataset.js
src/data/binance.js       src/analysis/engine.js  src/ml/train.js  src/backtest.js
```

CI chặn cứng bằng `grep` trên đúng danh sách này (`deploy-pages.yml`, bước "Kiểm tra các module lõi không phụ thuộc Node"). Chỉ các file *chỉ chạy ở Node* được phép dùng `node:*`: `bot.js`, `server.js`, `cli.js`, `config.js`, `ml/model-store.js`, `llm/claude.js`, `format.js`, `data/watchlist.js`, `chart/png.js`, `telegram/`.

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

`src/data/binance.js` dùng REST công khai của Binance, không cần API key, và tự thử nhiều host vì `api.binance.com` bị chặn ở một số vùng. Cần ≥ 210 nến đã đóng để phân tích, ≥ 600 để train. Funding rate và open interest chỉ có với token có hợp đồng futures — trả `null` chứ không lỗi.

`models/` **được commit** để người mở trang GitHub Pages có model sẵn. `models/index.json` là manifest cho browser và CI sẽ fail nếu nó lệch với thư mục.

## Trạng thái repo sau merge

Nhánh `develop` đã merge `main`. Bản triển khai song song trước đó của `develop` (`src/analysis/indicators.js`, `summary.js`, `analyze.js`) **đã bị xoá** — giờ chỉ còn một pipeline phân tích duy nhất là `src/analysis/engine.js`.

Còn lại hai bot, dùng cùng engine nhưng khác lớp vào/ra:

| | `npm run bot:ai` (`src/bot.js`) | `npm run bot` (`src/telegram/bot.js`) |
|---|---|---|
| Lệnh | `/a /q /ask /train /backtest /config /set /prompt /watch` | `/ta /gia /list /add /del` |
| Đặc điểm | có Claude, train/backtest, sửa config qua chat | gửi ảnh chart PNG, nút đổi khung |

**Hai bot dùng cùng `TELEGRAM_BOT_TOKEN`.** Telegram chỉ cho một tiến trình long-poll trên mỗi token; chạy cả hai cùng lúc sẽ làm cả hai lỗi 409.

Watchlist vẫn có hai đường ghi vào `data/watchlist.json`: `loadWatchlist`/`saveWatchlist` trong `src/config.js` (bot AI dùng) và `src/data/watchlist.js` (server + bot chart dùng). Ghi từ hai phía sẽ đè lẫn nhau — chưa hợp nhất.

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

### Cấu trúc khi call lẹnh

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

