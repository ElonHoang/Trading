---
name: tin-tuc-tokenomics
description: Bối cảnh cơ bản của token — tokenomics (supply, FDV/vốn hoá, % lưu hành, thanh khoản), rủi ro delist trên Binance, và tin tức lọc theo token. Dùng SAU khi đã có phân tích kỹ thuật từ skill chi-bao, để xác nhận hoặc phủ quyết setup và cho ra hướng vào lệnh. Nêu rõ nguồn nào chính thức, nguồn nào không, và dữ liệu nào KHÔNG có.
---

# Kĩ năng 2 — Tin tức và tokenomics

Lớp này **không cho điểm**. Nó xác nhận hoặc **phủ quyết** setup kỹ thuật của [`chi-bao`](../chi-bao/SKILL.md).

Lý do tách riêng: dòng tiền tính bằng giây đến giờ, tokenomics và tin tức tính bằng ngày đến tuần. Trộn vào cùng thang `-100..100` sẽ làm méo điểm kỹ thuật và **không backtest được** (tokenomics không có lịch sử theo nến). Điểm vẫn hoàn toàn từ Kĩ năng 1.

Diễn giải bằng **luật cứng**, không dùng LLM — mọi kết luận ở đây tái lập được.

## Lấy số

```js
import { buildContext } from './src/analysis/context.js';
import { buildSetup, buildProjections } from './src/analysis/setup.js';

const context = await buildContext(snapshot.symbol);   // null-safe từng nguồn
const setup = buildSetup(snapshot, context);           // gộp kỹ thuật + bối cảnh
const projections = buildProjections(snapshot, strategy.risk);
```

`buildContext` không bao giờ throw vì lỗi mạng — nguồn nào lỗi thì phần đó là `null` và có `warnings` giải thích. Bối cảnh là lớp phụ, **không được chặn phần kỹ thuật**.

## Nguồn dữ liệu — cái nào tin được đến đâu

| Dữ liệu | Nguồn | Chính thức? | Key? |
|---|---|---|---|
| Tokenomics | CoinGecko `/coins/{id}` | có (API công khai) | không |
| Ticker → coin id | CoinGecko `/search`, chọn theo `market_cap_rank` | có | không |
| Trạng thái cặp (TRADING/BREAK/HALT) | Binance `exchangeInfo` | **có — đáng tin nhất** | không |
| Thông báo delist/list | Binance CMS `catalogId=161/48` | **KHÔNG chính thức** | không |
| Tin tức | RSS CoinDesk + Cointelegraph, lọc theo tên/ticker | có | không |
| **Lịch unlock / vesting** | **KHÔNG CÓ nguồn miễn phí** | — | — |

Ba điều phải nêu khi trình bày:

- **Endpoint thông báo delist không phải API chính thức.** Hiện hoạt động, không cần key, nhưng Binance có thể đổi hoặc chặn bất cứ lúc nào. Nó cũng **giới hạn `pageSize` ≤ 20** (lớn hơn trả HTTP 400). Luôn kèm nguồn chính thức là trạng thái cặp làm chỗ dựa.
- **Lịch unlock không lấy được** — mà đây là yếu tố tokenomics tác động giá mạnh nhất. `circulatingPercent` thấp chỉ là *chỉ dấu gián tiếp* rằng còn nhiều cung sẽ ra, không phải lịch cụ thể. Đừng suy diễn thay nó.
- **Tin tức là RSS tin chung được lọc theo token.** Token lớn thường có tin; token nhỏ hầu như không bao giờ xuất hiện. **"Không có tin" nghĩa là "không tìm thấy trong các nguồn này", không phải "không có gì xảy ra"** — `news.note` ghi rõ điều đó, hãy nhắc lại khi báo cáo.

## Luật cứng

**Phủ quyết (chặn vào lệnh):**

| Điều kiện | Hệ quả |
|---|---|
| Trạng thái cặp ≠ TRADING (BREAK/HALT) | chặn **cả long và short** — không giao dịch được |
| Thông báo delist có nhắc ticker | chặn **long** (delist làm thanh khoản cạn, giá thường sập); không chặn short |

**Cảnh báo (giảm tin cậy, không chặn):**

| Điều kiện | Ngưỡng | Ý nghĩa |
|---|---|---|
| FDV / vốn hoá cao | ≥ `fdvRatioWarn` (2), nặng ≥ 4 | phần lớn cung chưa lưu hành → áp lực pha loãng |
| % lưu hành thấp | < 50% | phần lớn token còn bị giữ lại |
| Khối lượng 24h / vốn hoá thấp | < 2% | thanh khoản mỏng, dễ trượt giá |
| Xếp hạng vốn hoá | > 300 | token nhỏ, biến động cao |
| Tin tiêu cực | ≥ 2 tin | phân loại bằng **từ khoá khớp biên từ** |

Phân loại tin là **từ khoá, không phải phân tích cảm xúc AI**. Khớp theo biên từ chứ không phải substring — trước đây `"bank"` bị tính là `"ban"` và sinh cảnh báo tiêu cực sai.

**Ủng hộ:** FDV/vốn hoá ≤ 1,15 · xếp hạng ≤ 50 · có tin tích cực và không có tin tiêu cực.

## Từ bối cảnh ra hướng vào lệnh

`buildSetup(snapshot, context)` trả về:

- `side` — `long` / `short` / `none`, đã áp phủ quyết của bối cảnh
- `entry`, `stopLoss`, `riskPercent`, `targets`, `rrToTp1` (R:R tới **mục tiêu cấu trúc gần nhất**, không phải tới TP1 — TP1 luôn bằng 1R nên đo tới nó là vô nghĩa)
- `reasons` — lý do ngắn gọn, xếp theo đóng góp thật vào điểm, chỉ lấy nhóm **cùng hướng** với tín hiệu; mỗi nhóm lấy dòng đã diễn giải (có `→`)
- `cautions` — xung đột kỹ thuật + cảnh báo cơ bản
- `blockers` — lý do bị phủ quyết

`buildProjections(snapshot, risk)` trả **hai kịch bản** cho cả hai chiều, mỗi cái có: điều kiện kích hoạt (đóng nến qua mức S/R thật), `entry`, `stopLoss` (ưu tiên đặt ngoài mức cấu trúc, kèm lý do trong `stopFrom`), `targets`, mục tiêu theo S/R, tường lệnh **nằm giữa entry và TP cuối** (tường cách 13% không liên quan tới kèo nhắm 2%), và điều kiện vô hiệu. `primary` cho biết kịch bản nào đang được điểm ủng hộ — đây là **thứ tự ưu tiên suy từ điểm, không phải xác suất thống kê**.

## Theo dõi liên tục

`src/telegram/monitor.js` quét lại watchlist theo `alerts.pollSeconds` (kẹp tối thiểu 30s). Hai quy tắc chống spam và chống sai:

1. **Chỉ đánh giá lại khi có nến mới đóng.** Chỉ báo tính trên nến đã đóng nên poll dày hơn nến chỉ tốn request mà không ra kết quả mới.
2. Chỉ báo khi `|điểm| ≥ alerts.minAbsScore` **và** tín hiệu đổi so với lần trước (`alerts.onlyOnSignalChange`).

Bật trong Telegram bằng `/canhbao`, tắt bằng `/tatcanhbao`. Chat id lưu ở `data/alert-chats.json` (đã gitignore).
