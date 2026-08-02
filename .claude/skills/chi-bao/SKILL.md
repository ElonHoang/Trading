---
name: chi-bao
description: Bộ tín hiệu DUY NHẤT được dùng trong repo — Open Interest, Funding Rate, CVD, Volume, Order Book, hỗ trợ/kháng cự và mẫu hình lịch sử. Dùng BẮT BUỘC trước khi đưa ra bất kỳ phân tích hay nhận định thị trường nào. Gồm bản chất từng tín hiệu, tác động tới giá, cách lấy số trong code, thứ tự tin cậy và giới hạn thật.
---

# Kĩ năng 1 — Chỉ báo

Đây là toàn bộ tín hiệu được phép dùng: 6 nhóm chỉ báo/dữ liệu hiện có và mẫu hình lịch sử. Các chỉ báo giá thuần (EMA, RSI, MACD, Bollinger, ATR, ADX, Stochastic, VWAP, OBV, phân kỳ RSI) đã bị xoá khỏi hệ thống — đừng dùng, đừng tự tính lại, đừng đề xuất thêm vào.

Không ước lượng bằng mắt, không bịa số. Mọi con số phải lấy từ code.

## Lấy số

```js
import { fetchKlines, fetchOrderBookImbalance, fetchDerivatives } from './src/data/binance.js';
import { computeIndicators, supportResistance } from './src/indicators/index.js';
import { closedCandles } from './src/analysis/engine.js';
import { loadStrategy } from './src/config.js';

const strategy = await loadStrategy();
const candles = closedCandles(await fetchKlines('BTCUSDT', '4h', 400));
const ind = computeIndicators(candles, strategy.indicators);
const sr = supportResistance(candles);
const i = candles.length - 1;                       // nến đã đóng gần nhất

const ob = await fetchOrderBookImbalance('BTCUSDT');    // null nếu lỗi
const der = await fetchDerivatives('BTCUSDT');          // null nếu không có futures
```

**Luôn dùng `closedCandles()`.** Nến đang chạy làm mọi con số nhảy loạn và tạo phân kỳ giả.

---

## 1. Open Interest (OI) — hợp đồng mở

**Bản chất:** tổng số hợp đồng phái sinh đang mở và chưa tất toán. OI đại diện cho mức độ quan tâm và lượng **tiền mới** đang được bơm vào thị trường.

**Tác động tới giá:**

| Giá | OI | Ý nghĩa |
|---|---|---|
| tăng | tăng | xu hướng tăng **rất mạnh** — tiền mới vào mở Long, hỗ trợ đà tăng tiếp diễn |
| giảm | tăng | xu hướng giảm **rất mạnh** — tiền mới vào mở Short, phe bán áp đảo |
| tăng | giảm | lực đang cạn — người chơi chốt lời hoặc bị thanh lý, dễ đi ngang hoặc đảo chiều |
| giảm | giảm | lực đang cạn — Long rút ra, nhịp giảm hết đà |

**Lấy ở đâu:** `der.openInterest`, `der.openInterestChangePct`.

---

## 2. Funding Rate — phí tài trợ

**Bản chất:** phí định kỳ phe Long trả cho phe Short (hoặc ngược lại) để giữ giá hợp đồng tương lai sát giá spot.

**Tác động tới giá:**

- **Dương** (Long trả Short): đám đông lạc quan, mở nhiều Long. Nhưng nếu phí **quá cao** thì rất dễ **Long Squeeze** — giá sập mạnh đột ngột để thanh lý các lệnh Long quá mức.
- **Âm** (Short trả Long): đám đông bi quan, mở nhiều Short. Nếu **âm quá sâu**, cá mập thường đẩy giá lên tạo **Short Squeeze**, buộc phe Short mua lại giá cao và đẩy giá vọt tiếp.

Nói cách khác funding cực đoan là **tín hiệu ngược**, không phải tín hiệu thuận.

**Lấy ở đâu:** `der.fundingRate`. Ngưỡng cực đoan: `strategy.thresholds.fundingExtreme`.

---

## 3. CVD (Cumulative Volume Delta)

**Bản chất:** chênh lệch giữa khối lượng **mua chủ động** (market buy) và **bán chủ động** (market sell). Cho thấy ai đang thực sự gõ lệnh "mua ngay" hay "bán thẳng tay".

**Tác động tới giá — quan trọng nhất là phân kỳ:**

- **Phân kỳ tăng giá (cá mập gom hàng):** giá **đi ngang hoặc giảm nhẹ** nhưng CVD **tăng**. Có lực mua chủ động âm thầm gom hàng. Giá thường bật tăng sau đó.
- **Phân kỳ giảm giá (cá mập phân phối):** giá **đi ngang hoặc rướn lên nhẹ** nhưng CVD **cắm đầu giảm**. Lực bán chủ động đang xả lên đầu phe mua. Cảnh báo giá sắp sập.

Chú ý điều kiện "giá đi ngang" — đây là trường hợp mạnh nhất, không phải chỉ so dấu giá với dấu CVD.

**Lấy ở đâu:** `ind.cvd` (luỹ tiến), `ind.cvdDelta` (từng nến), `ind.cvdSlope` (độ dốc chuẩn hoá theo volume cùng kỳ, trong `[-1, 1]`).

---

## 4. Volume — khối lượng

**Bản chất:** tổng lượng token giao dịch trong một khoảng thời gian. Vai trò của volume là **xác nhận** tính hợp lệ của đường giá.

**Tác động tới giá:**

- **Breakout + volume lớn:** xu hướng mới là **thật**, dòng tiền lớn đã tham gia, giá tiếp tục theo hướng bứt phá.
- **Breakout + volume nhỏ:** thường là **bẫy** (bull trap / bear trap). Giá chạy nhưng không có dòng tiền thật ủng hộ, rất dễ quay đầu.
- **Volume đột biến ở đỉnh/đáy:** giá giảm sâu mà xuất hiện cột volume khổng lồ thường là **panic sell** cuối cùng trước khi tạo đáy. Ở vùng đỉnh là **FOMO** tột độ trước khi tạo đỉnh. Đây là tín hiệu **cạn lực**, không phải xác nhận.

**Lấy ở đâu:** `candles[i].volume`, `ind.volumeAvg[i]`. Ngưỡng đột biến: `strategy.thresholds.volumeSpikeRatio`.

---

## 5. Order Book — sổ lệnh

**Bản chất:** danh sách lệnh chờ mua (bid) và chờ bán (ask) đặt sẵn ở các mức giá.

**Tác động tới giá:**

- **Tường mua dày:** lượng lớn lệnh chờ mua ở một mức giá phía dưới → giá chạm về đây được hỗ trợ cứng, khó xuyên thủng.
- **Tường bán dày:** lượng lớn lệnh chờ bán cản phía trên → kháng cự mạnh, cần volume rất lớn mới phá qua.
- **Sổ lệnh mỏng:** khoảng trống giữa các lệnh quá lớn → chỉ cần volume nhỏ cũng làm giá nhảy vọt hoặc sập mạnh (slippage).

**Ghi chú bắt buộc nêu khi trình bày:** sổ lệnh có thể bị thao túng bằng **spoofing** — đặt lệnh lớn để dọa thị trường rồi huỷ ngay trước khi khớp. Vì vậy **luôn phải xét sổ lệnh song song với CVD và Volume** để biết lệnh nào là thật.

**Lấy ở đâu:** `ob.imbalance`, `ob.bidValue`, `ob.askValue`, `ob.walls`, `ob.thin`.

---

## 6. Định vị đám đông (thay cho liquidity map)

**Binance public API KHÔNG có liquidity map / heatmap thanh lý.** Endpoint lịch sử thanh ly toàn thị trường (`/fapi/v1/allForceOrders`) đã bị Binance bỏ (404); `/fapi/v1/forceOrders` cần API key và chỉ trả lệnh của chính bạn; luồng WebSocket `!forceOrder@arr` chỉ có sự kiện trực tiếp, không có lịch sử. Heatmap kiểu Coinglass là **mô hình tự dựng**, không phải dữ liệu Binance.

Thứ có thật, public, **có lịch sử nên backtest được** — ba endpoint định vị:

| Trường | Ý nghĩa |
|---|---|
| `longAccountPercent` | % tài khoản đang long. Lệch mạnh khỏi 50% = đám đông một bên |
| `longAccountChangePoints` | tỉ lệ long tăng/giảm bao nhiêu điểm % trong cửa sổ → đám đông đang dồn thêm về đâu |
| `topLongPercent` | % vị thế long của top trader. **Lệch so với đám đông là tín hiệu đáng chú ý** |
| `takerBuySellRatio` | >1 = taker mua áp đảo |

**Tác động tới giá — cùng logic thanh lý bạn mô tả:** đám đông dồn về long quá mức thì bên có thể bị thanh lý là **long**, giá dễ bị đạp xuống để quét; dồn về short quá mức thì dễ bị đẩy lên tạo short squeeze. Vì vậy lệch quá `thresholds.crowdSkew` (mặc định 0,12) được tính là **tín hiệu ngược**, giống funding cực đoan.

Top trader long nhiều hơn đám đông thì nghiêng tăng, và ngược lại — đây là cách gần nhất với "cá mập đang làm gì" mà dữ liệu công khai cho phép.

**Lấy ở đâu:** `fetchPositioning(symbol, interval)`; chu kỳ do Binance giới hạn (`5m…1d`), khung khác được map qua `positioningPeriod()`. `null` với token không có futures.

---

## 7. Hỗ trợ / kháng cự

**Bản chất:** các vùng giá đã từng chặn giá nhiều lần, dựng từ đỉnh/đáy swing (pivot) rồi gom các mức gần nhau lại.

`supportResistance(candles, { left, right, tolerancePct, maxLevels })` trả `{ support, resistance }`, mỗi mức có `price`, `touches`, `lastIndex`. Các mức cách nhau dưới `tolerancePct` (mặc định 0,6%) được nhập thành một.

**`touches` càng cao thì mức càng đáng tin** — khi trình bày phải nêu kèm số này. Mức đã bị phá (giá đóng vượt qua) đổi vai: kháng cự cũ thành hỗ trợ mới.

Đối chiếu với sổ lệnh: một mức S/R có `touches` cao **và** có tường lệnh ở đó là xác nhận mạnh nhất.

## 8. Mẫu hình lịch sử

**Bản chất:** chỉ chạy khi token có đủ `historicalPattern.requiredHistoryMonths` tháng lịch sử liên tục (mặc định 6 tháng). Khi đủ điều kiện, bot so đường giá đóng nến đã chuẩn hoá và biên độ high/low của `historicalPattern.lookbackBars` nến gần nhất với các đoạn nến trong tối đa `historicalPattern.maxMonths` tháng. Giá tuyệt đối không được dùng để so, nên BTC ở hai mức giá khác nhau vẫn có thể có cùng hình dạng/biên độ tương đối. Token mới list dưới 6 tháng thì nhóm này bị loại hoàn toàn, không cộng/trừ điểm.

**Điều kiện cộng điểm:** chỉ lấy tối đa `topMatches` mẫu không chồng lấp, có độ giống tối thiểu `minSimilarity`. Bot nhìn tiếp `futureBars` nến sau từng mẫu cũ; chỉ cộng điểm long hoặc short khi có ít nhất `minMatches` mẫu, tỷ lệ cùng hướng đạt `minDirectionalAgreement`, và mức đi trung bình đạt `minForwardMovePct`. Mẫu giống nhưng kết quả sau đó lẫn lộn **không được cộng điểm**.

**Lấy ở đâu:** `fetchKlinesHistory()` và `analyzeHistoricalPattern()` trong `src/analysis/historical-pattern.js`. Luôn dùng nến đã đóng. Khi backtest, matcher nhận `endIndex = i`, vì vậy mọi nến dùng để đánh giá mẫu cũ đều phải tồn tại trước nến mô phỏng hiện tại — không look-ahead.

**Giới hạn:** đây là thống kê mẫu nhỏ trên riêng một token/khung, không phải xác suất chắc chắn và không phải lý do vào lệnh độc lập. Cache lịch sử chỉ giảm request; nến mới nhất vẫn được tải riêng ở mỗi lần phân tích.

---

## Thứ tự tin cậy khi xung đột

```
OI + định vị đám đông (giờ–ngày)  >  CVD (nhiều nến)  >  Volume (từng nến)  >  Order book (giây–phút)
```

Hỗ trợ/kháng cự là khung tham chiếu cho cả bốn nhóm trên, không phải tín hiệu vào lệnh độc lập.

Xung đột thì **nói rõ là xung đột**, đừng ép ra kết luận dứt khoát — đúng nguyên tắc trong `config/prompt.md`.

## Giới hạn thật — phải nêu khi trình bày

- **CVD ở đây là xấp xỉ theo nến, không phải tick-by-tick.** Suy ra từ `takerBuyVolume` của mỗi nến (`delta = 2×takerBuy − volume`), nên biết bên nào chủ động hơn trong cả nến nhưng không thấy thứ tự khớp bên trong nến.
- **`openInterestChangePct` luôn tính trên `period=4h&limit=14`** (≈ 2,3 ngày), hardcode trong `fetchDerivatives`. Phân tích khung 15m thì con số OI đó **không cùng khung thời gian** — phải nói rõ mốc.
- **OI và funding là `null` với token không có hợp đồng futures.** Kiểm `der?.openInterest != null`; thiếu thì ghi "không có hợp đồng futures", không ghi 0.
- **Order book là ảnh chụp tại một thời điểm**, không có lịch sử nên **không backtest được**. Cộng với spoofing, đừng dùng nó làm căn cứ chính.
- **Volume chỉ của Binance spot**, không phải tổng toàn thị trường.
- Cần ≥ `MIN_CANDLES` (30) nến đã đóng để chấm điểm; ML cần ≥ `features.WARMUP` (60).
- **Cổ phiếu token hoá (bStocks) không có futures** → mất cả `derivatives` và `positioning`, chỉ còn 4 nhóm. Cổng đồng thuận tính trên mẫu nhỏ hơn nên **dễ đạt hơn một cách giả tạo** — cảnh giác khi thấy chúng trong danh sách quét.
- **Chi phí request**: phân tích đầy đủ 1 mã tốn 56 request-weight (riêng `depth limit=1000` đã 50), giới hạn Binance 6.000/phút. Đừng gọi `analyze` trong vòng lặp rộng — sàng lọc trước bằng `screenSymbols()` (1 request, 80 weight cho cả sàn).

## Vào điểm tổng như thế nào

`scoreSignals()` trong `src/analysis/engine.js` có 7 nhóm: `cvd`, `volume`, `derivatives` (OI + funding), `positioning` (định vị đám đông), `structure` (S/R), `orderBook`, `historicalPattern`. Trọng số ở `config/strategy.json` → `weights`; đặt `0` là tắt hẳn một nhóm.

**Nhóm thiếu dữ liệu bị LOẠI khỏi phép chuẩn hoá**, không tính là 0 điểm. Điều này quan trọng: order book không có lịch sử nên trong backtest nó luôn thiếu; nếu tính là 0 thì điểm tổng bị pha loãng và gần như không bao giờ vượt ngưỡng (đã từng làm backtest chỉ ra 9 lệnh thay vì 60).

Đổi cách đánh giá thì sửa `weights`/`thresholds`, **đừng sửa hàm chỉ báo**. Sửa xong phải chạy lại `npm run backtest` trước khi tin.

## Cổng đồng thuận — khác ngưỡng điểm

`scoreSignals()` trả thêm `consensus`: bao nhiêu nhóm **có dữ liệu** thực sự cùng hướng với điểm tổng (mỗi nhóm phải có `|score| ≥ thresholds.consensusMinGroupScore`, mặc định 0,15).

Đây không trùng với ngưỡng điểm: `|điểm| ≥ 30` có thể chỉ đến từ 2 nhóm rất mạnh trong khi 4 nhóm còn lại trung tính. Cổng đòi nhiều nhóm độc lập cùng xác nhận.

`buildSetup(snapshot, context, { consensusPercent })` sẽ đặt `side = 'none'` nếu chưa đạt, và ghi lý do vào `blockers`.

**Cảnh báo phải nêu khi bàn về ngưỡng này:** số nhóm có dữ liệu khác nhau giữa chạy thật và backtest — chạy thật có thêm `orderBook`, `derivatives`, `positioning`; backtest có `volume`, `cvd`, `structure` và `historicalPattern` khi đủ mẫu. Vì vậy cùng một % đồng thuận không hoàn toàn tương đương. **Không kiểm chứng đầy đủ được bằng backtest.**

Đo thật trên BTC 4h, 3000 nến: mức 60% (đang dùng) không loại tín hiệu nào, cho 60 lệnh / PF 1,05 / +1,03%. Mức 70% loại 41 tín hiệu, còn 41 lệnh / PF 1,63 / +26,76%. Nhưng 41 lệnh chỉ vừa qua ngưỡng 40 mà `README.md` coi là quá ít để kết luận.

## Setup và phép chiếu

`src/analysis/setup.js`:

- `buildSetup(snapshot, context, opts)` → `side`, `entry`, `stopLoss`, `riskPercent`, `targets`, `rrToTp1` (R:R tới **mục tiêu cấu trúc gần nhất**, không phải tới TP1 — TP1 định nghĩa là 1R nên đo tới nó luôn ra 1, vô nghĩa), `reasons` (chỉ nhóm cùng hướng, xếp theo đóng góp thật), `cautions`, `notes`, `blockers`.
- `buildProjections(snapshot, risk)` → hai kịch bản lên/xuống, mỗi cái có điều kiện kích hoạt (đóng nến qua mức S/R thật kèm số lần chạm), entry, SL đặt ngoài mức cấu trúc, TP, và điều kiện vô hiệu. `primary` là kịch bản đang được điểm ủng hộ — **thứ tự ưu tiên suy từ điểm, không phải xác suất thống kê**.
