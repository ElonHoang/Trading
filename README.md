# AI phân tích kỹ thuật crypto

Công cụ phân tích kỹ thuật token crypto và đưa ra phán đoán hướng đi sắp tới.
Chạy **hoàn toàn trong trình duyệt** — không có server, không có backend giữ dữ liệu của bạn.

Ba tầng làm việc cùng nhau:

1. **Chỉ báo kỹ thuật** (JS thuần) — RSI, MACD, EMA, Bollinger, ATR, ADX, Stochastic, OBV,
   VWAP, vùng hỗ trợ/kháng cự, phân kỳ RSI, funding rate, open interest, lệch sổ lệnh,
   cùng xác nhận từ khung thời gian lớn hơn.
2. **Model học máy** — gradient boosting tự viết bằng JS, train trên chính lịch sử giá của
   token đó, trả về xác suất tăng/giảm. Train được ngay trong trình duyệt (Web Worker).
3. **Claude** — đọc toàn bộ số liệu trên, cân nhắc tín hiệu xung đột, viết nhận định và
   kịch bản bằng tiếng Việt.

Mọi tham số **tinh chỉnh được** ngay trên trang (tab Cấu hình / System prompt) — không cần sửa code.

---

## Dùng ngay

Mở trang GitHub Pages của repo này. Không cần cài gì, không cần đăng nhập.

Nhập mã token (`btc`, `eth`, `sol`…), chọn khung thời gian, bấm **Phân tích**.
Toàn bộ chỉ báo, vùng giá, điểm tổng hợp và dự đoán ML hoạt động **miễn phí**.

Muốn có thêm phần Claude viết báo cáo bằng lời thì vào tab **Cài đặt AI** và dán API key
của bạn (lấy ở [platform.claude.com](https://platform.claude.com/settings/keys)).

### Về API key

Trang này là tĩnh — không có server nào của tôi ở giữa. Key bạn nhập:

- lưu trong **localStorage của chính trình duyệt bạn**;
- chỉ gửi **trực tiếp** tới `api.anthropic.com`;
- không ai khác mở trang này thấy được key của bạn.

Nhưng bất kỳ ai dùng được máy đó đều đọc được key trong localStorage. **Nên tạo một key
riêng cho việc này và đặt hạn mức chi tiêu** trong Console của Anthropic, để nếu lộ thì
thiệt hại có giới hạn.

---

## Chạy ở máy mình

Yêu cầu Node.js ≥ 20.

```bash
git clone <repo-url>
cd <repo>
npm install
npm run web        # → http://localhost:5173
```

`npm run web` chỉ là một server tĩnh — **giống hệt** GitHub Pages, nên những gì bạn thấy ở
local đúng bằng những gì sẽ lên web.

Ngoài ra còn các lệnh dòng lệnh (chạy bằng Node, nhanh hơn train trong browser):

```bash
npm run analyze -- BTC 4h --no-ai   # phân tích trong terminal
npm run train -- BTC 4h             # train model, lưu vào models/
npm run backtest -- BTC 4h 3000     # backtest có SL/TP
npm run models:index                # cập nhật models/index.json
npm run bot                         # bot Telegram (xem bên dưới)
```

---

## Bot Telegram (tuỳ chọn)

Bot cần một máy chạy thường trú nên **không dùng được trên GitHub Pages**. Nếu muốn chạy:

```bash
cp .env.example .env    # điền TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_IDS, ANTHROPIC_API_KEY
npm run bot
```

Lệnh: `/a btc 4h` (phân tích + AI) · `/q btc 4h` (nhanh, không AI) · `/detail` · `/ask` ·
`/train` · `/backtest` · `/config` · `/set` · `/prompt` · `/watch` (cảnh báo tự động).

Bot dùng **cùng các module lõi** với bản web, chỉ khác lớp vào/ra.

---

## Tinh chỉnh AI

Tất cả ở tab **Cấu hình** trên trang (lưu trong trình duyệt bạn, không ảnh hưởng người khác).
Mặc định đọc từ `config/strategy.json`; nút "Về mặc định" xoá mọi thay đổi.

| Nhóm | Việc |
|---|---|
| `weights.*` | AI coi trọng nhóm tín hiệu nào. Đặt `0` để tắt hẳn một nhóm. |
| `thresholds.*` | Ngưỡng ra tín hiệu. Tăng `buy`/`sell` → ít lệnh hơn nhưng chọn lọc hơn. |
| `ml.*` | Horizon, cách gán nhãn, siêu tham số model. Sửa xong **phải train lại**. |
| `risk.*` | Khoảng stop loss (theo ATR), các mốc chốt lời, kiểu thoát lệnh. |
| `llm.*` | Model Claude, `effort` (low→max), giới hạn token. |
| `indicators.*` | Chu kỳ của từng chỉ báo. |

Tab **System prompt** sửa được "tính cách" và cấu trúc báo cáo của Claude — đây là cách
mạnh nhất để đổi cách nó viết: bảo thủ hơn, quyết đoán hơn, thêm quy tắc riêng của bạn.

---

## Kết quả kiểm chứng thật (đã chạy, không phải phỏng đoán)

Số liệu thật từ backtest trên dữ liệu Binance, giai đoạn 2025-03 → 2026-07, khung 4h,
phí 0.06%/chiều, chốt 50% ở TP1 rồi kéo SL về entry:

| Token | Cấu hình cũ (ngưỡng 18, SL 1.5 ATR) | Cấu hình mặc định hiện tại (30 / 2.5 ATR) | Mua & giữ |
|---|---|---|---|
| BTC | −15.6% (PF 0.94) | **+17.0%** (PF 1.21, 82 lệnh) | −32.0% |
| ETH | −21.2% (PF 0.99) | **+24.8%** (PF 1.15, 158 lệnh) | +6.2% |
| SOL | −40.6% (PF 0.93) | **−3.9%** (PF 1.04, 153 lệnh) | −51.6% |
| BNB | −23.8% (PF 0.94) | **−28.3%** (PF 0.88, 150 lệnh) | −7.0% |

**Đọc thẳng:** cấu hình mặc định tốt hơn ở 3/4 token nhưng xấu hơn ở BNB. Profit factor
trung bình chỉ quanh 1.0 — nghĩa là **hệ thống này về cơ bản chỉ hoà vốn, không phải máy in
tiền.** Nó thắng mua-và-giữ trong thị trường giảm, nhưng đó là vì nó vào cả lệnh short.

Model ML trên BTC 4h (5.445 mẫu, 16.000 nến từ 2019) — model đóng gói sẵn trong `models/`:

- AUC holdout **0.554**, walk-forward **0.541** (0.5 = tung xu, >0.55 đã là khá với dữ liệu giá)
- Khi model tự tin nhất (20% tín hiệu mạnh nhất mỗi chiều): đúng khoảng **55%**
- Nhưng mô phỏng giao dịch không SL vẫn **lỗ** → đúng hướng 55% chưa đủ để có lãi

Kết luận: **dùng tool này để đọc thị trường có hệ thống, không phải để bấm theo tín hiệu.**

## Những cơ chế chống tự lừa mình

Tool được viết để không nói dối bạn về chất lượng của chính nó:

- **Không shuffle dữ liệu.** Chia train/test theo thời gian — shuffle chuỗi thời gian là
  gian lận vì model sẽ thấy tương lai.
- **Walk-forward 4 fold** ngoài holdout. Nếu holdout đẹp mà walk-forward dưới 0.5, tool báo
  thẳng *"KHÔNG ĐÁNG TIN — dấu hiệu ăn may"* và không dùng ML.
- **Guard rail `ml.minTestAuc`.** Model dưới ngưỡng thì trọng số ML tự về 0; trang vẫn hiện
  xác suất nhưng ghi rõ *"KHÔNG được tính vào điểm tổng"*.
- **Early stopping theo AUC** trên tập validation riêng, tự cắt bỏ cây thừa.
- **Xác suất so theo phân vị của chính model** (p20/p80 trên holdout) thay vì ngưỡng tuyệt
  đối — vì xác suất bị nén quanh 0.5 thì 0.52 đã là tín hiệu mạnh của model đó.
- **Không có look-ahead.** Feature tại nến `i` chỉ dùng dữ liệu đến `i`. Nến đang chạy bị
  loại khỏi mọi tính toán chỉ báo.
- **Backtest bảo thủ.** Cùng một nến chạm cả SL và TP thì tính là SL.
- **Không cộng dồn lệnh trùng nhau** trong mô phỏng (nếu không lợi nhuận bị thổi phồng).
- **Feature đều là tỉ lệ**, không dùng giá tuyệt đối — giá BTC 2019 và 2026 không cùng thang đo.
- **Cảnh báo xung đột** tự động: ADX thấp, khung lớn ngược hướng, ML ngược quy tắc.
- **Cảnh báo cỡ mẫu.** Backtest dưới 40 lệnh bị ghi rõ là quá ít để kết luận.

---

## Cấu trúc code

Điểm quan trọng: **các module lõi không phụ thuộc Node**, nên browser và bot Telegram dùng
đúng một bộ code, không có bản sao nào bị lệch nhau.

```
index.html               Trang dashboard (GitHub Pages phục vụ từ đây)
web/                     Lớp riêng của browser
  app.js                 Giao diện + vẽ biểu đồ SVG (không dùng thư viện chart)
  style.css              Bảng màu đã kiểm chứng cho cả sáng và tối
  store.js               Cấu hình + system prompt + API key trong localStorage
  model-store.js         Model: đóng gói trong repo + bản tự train
  claude.js              Gọi Claude trực tiếp bằng fetch (có streaming)
  worker.js              Web Worker chạy train/backtest ngoài luồng giao diện
src/                     LÕI — dùng chung browser & Node
  data/binance.js        Nến, ticker, funding, OI, sổ lệnh (fallback nhiều host)
  indicators/index.js    Chỉ báo kỹ thuật
  features.js            32 feature đã chuẩn hoá cho ML
  ml/gbdt.js             Gradient boosting + AUC/logloss + hiệu chuẩn xác suất
  ml/dataset.js          Gán nhãn (atr / fixed / triple-barrier) + chia theo thời gian
  ml/train.js            Quy trình train + đánh giá (không ghi đĩa)
  analysis/engine.js     Tính điểm quy tắc, kết hợp ML, sinh mức giá
  backtest.js            Backtest có SL/TP, chốt lời từng phần
  ---- chỉ chạy ở Node ----
  bot.js, server.js, cli.js, config.js, ml/model-store.js, llm/claude.js, format.js
bin/                     CLI: train, backtest, build-model-index
config/strategy.json     Toàn bộ tham số mặc định
config/prompt.md         System prompt mặc định của Claude
models/                  Model đóng gói sẵn + index.json (manifest cho browser)
```

Vì sao `web/claude.js` dùng `fetch` thay vì `@anthropic-ai/sdk`: trang không có bước build
nên không import được package npm trong browser. Bản Node (`src/llm/claude.js`) vẫn dùng SDK
chính thức.

---

## Tự deploy bản của bạn

1. Fork hoặc clone repo này.
2. Vào **Settings → Pages → Source** chọn **GitHub Actions**.
3. Push lên `main`. Workflow `.github/workflows/deploy-pages.yml` sẽ kiểm tra rồi publish.

Workflow tự chặn commit làm vỡ trang: sai cú pháp JS, JSON hỏng, `models/index.json` lệch
với thư mục `models/`, hoặc module lõi vô tình import `node:*` (sẽ làm bản web chết).

### Thêm model cho mọi người dùng

Model bạn train trong browser chỉ nằm ở máy bạn. Muốn ai mở trang cũng có:

```bash
npm run train -- ETH 4h      # hoặc bấm "Tải file model" sau khi train trên web
npm run models:index         # cập nhật manifest
git add models/ && git commit -m "Thêm model ETH 4h" && git push
```

---

## Giới hạn cần biết

- Dữ liệu từ **Binance spot**. Token không list trên Binance sẽ báo `Invalid symbol`.
  Ở một số vùng `api.binance.com` bị chặn — code tự thử `data-api.binance.vision` và các
  host dự phòng khác.
- Funding rate / open interest chỉ có với token có hợp đồng futures.
- Cần ít nhất **210 nến đã đóng** để phân tích, **600 nến** để train.
- Train trong browser mất 1–3 phút tuỳ máy (Node nhanh hơn đáng kể).
- Model tự train lưu ở localStorage (~5 MB) — hết chỗ thì bản cũ nhất bị xoá.
- Phân tích kỹ thuật không dự đoán được tin tức, hack, hay quyết định của Fed.

**Đây là công cụ phân tích kỹ thuật tự động, không phải lời khuyên đầu tư.**

## cấu trúc sau khi done tp call kèo 
🚀 CẬP NHẬT: [CẶP_GIAO_DỊCH] HIT TP [1/2/3/FULL]! 
💰 Lợi nhuận hiện tại: +[X]% (Spot) | +[Y]% (Đòn bẩy [Z]x)

━━━━━━━━━━━━━━━━━━
🎯 CHI TIẾT CHỐT LỜI
• Entry đã gọi : [GIÁ_VÀO]
• Mốc TP vừa hit : [GIÁ_HIỆN_TẠI]
• Trạng thái lệnh : [Đã chốt 1 phần / Chốt hết / Gồng tiếp]

━━━━━━━━━━━━━━━━━━
🛠 HÀNH ĐỘNG TIẾP THEO (KHUYẾN NGHỊ)
✅ Chốt lời: Đóng [30%/50%/100%] khối lượng lệnh tại đây.
🛡 Quản lý rủi ro: Dời Stoploss về Entry (Hòa vốn) [hoặc dời về mức giá...]
👀 Mục tiêu tiếp: Hướng tới TP [2/3] tại giá [GIÁ_TP_TIẾP_THEO].

━━━━━━━━━━━━━━━━━━
💡 NHẬN ĐỊNH NGẮN
💬 [Ghi chú: Ví dụ - Lực mua/bán vẫn còn rất mạnh, anh em đã dời SL về Entry cứ yên tâm gồng tiếp nhé!]
🔗 Trích dẫn lại kèo gốc: [Link/Reply lại tin nhắn call kèo ban đầu]
