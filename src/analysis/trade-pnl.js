// Lãi/lỗ THẬT của một kèo đã chốt — một chỗ duy nhất, dùng chung cho bản tổng
// hợp cuối ngày (`daily-review.js`) và tin đóng kèo trên Telegram
// (`telegram/caption.js`).
//
// Tách ra thành module lá vì hai bên dùng nó nằm ở hai tầng khác nhau: để hàm
// này trong `daily-review.js` thì lớp soạn tin nhắn phải import cả backtest,
// binance và config chỉ để tính một con số phần trăm.
//
// Thuần JS, không import gì.

const round = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null);

/**
 * Lãi/lỗ của MỘT kèo, tính đúng cách thoát lệnh mà tin nhắn đã dặn và backtest
 * đang dùng (`exitStrategy: 'scaled'`): chốt `partialFraction` ở TP1 rồi kéo SL
 * về entry, phần còn lại đóng ở giá thoát thật.
 *
 * Đây là % trên VỐN CỦA MỘT KÈO, chưa nhân đòn bẩy — cùng thang với
 * `expectancyPercent` của backtest, nên hai con số so được với nhau.
 *
 * `feePercent` trừ trên MỖI LẦN thoát, giống backtest: chốt hai lần thì mất phí
 * hai lần. Bỏ phí đi thì tổng PnL đẹp hơn thực tế một cách hệ thống.
 *
 * KHÔNG mô phỏng phần chốt ở TP2: `checkCall` chỉ ghi lại TP nào đã chạm chứ
 * không lưu giá thoát từng phần, nên phần còn lại được tính đóng trọn ở
 * `result.lastPrice`. Kèo chạy tới TP cuối vì vậy bị tính THẤP hơn thực tế một
 * chút — thà bảo thủ còn hơn tự cộng thêm phần không đo được.
 */
export function tradeReturnPercent(trade, { partialFraction = 0.5, feePercent = 0.06 } = {}) {
  const entry = Number(trade?.entry);
  const exit = Number(trade?.result?.lastPrice);
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(exit)) return null;
  const dir = trade.side === 'long' ? 1 : -1;
  const gain = (price) => ((price - entry) / entry) * 100 * dir;

  const tp1 = (trade.targets ?? [])[0];
  const tookPartial = Boolean(tp1) && (trade.result?.hitTps ?? []).includes(tp1.label)
    && trade.result?.status !== 'target';
  // Chạm TP cuối thì toàn bộ vị thế coi như đóng ở đó (đúng tin "Đóng 100% khối
  // lượng còn lại"), nên không tách phần TP1 ra nữa.
  const partial = tookPartial ? Number(partialFraction) : 0;
  const realized = tookPartial ? (gain(tp1.price) - feePercent) * partial : 0;
  return round(realized + (gain(exit) - feePercent) * (1 - partial), 2);
}

/**
 * Kèo đã chốt được phần ở TP1 hay chưa. Tin đóng kèo cần biết để nói rõ con số
 * `kết quả` gồm những gì — riêng trạng thái `breakeven` thì giá thoát ĐÚNG BẰNG
 * entry, nên nếu không kể phần TP1 ra thì con số trông như kèo chưa ăn được gì.
 */
export function tookPartialAtTp1(trade) {
  const tp1 = (trade?.targets ?? [])[0];
  return Boolean(tp1) && (trade?.result?.hitTps ?? []).includes(tp1.label)
    && trade?.result?.status !== 'target';
}
