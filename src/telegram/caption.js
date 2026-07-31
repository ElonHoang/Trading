// Soạn nội dung tin nhắn Telegram. Thuần hàm, không phụ thuộc grammy, nên test được riêng.

import { fmt, pct, compact, decimalsFor } from '../chart/render.js';

export const CAPTION_LIMIT = 1024;   // giới hạn caption ảnh của Telegram

// Telegram parse_mode HTML: chỉ 3 ký tự này cần escape.
export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function levelLine(list, price, d) {
  if (!list.length) return '—';
  return list
    .map((lv) => `${fmt(lv.price, d)} (${pct(((lv.price - price) / price) * 100)})`)
    .join(' · ');
}

/** Caption cho ảnh chart, cắt bớt nếu vượt giới hạn của Telegram. */
export function buildCaption(p) {
  const { symbol, interval, summary: s, ticker, derivatives, orderbook, levels } = p;
  const d = decimalsFor(s.price);
  const lines = [];

  lines.push(`<b>${esc(symbol)}</b> · ${esc(interval)}`);
  lines.push(`<b>${fmt(s.price, d)}</b>${ticker ? `  ${pct(ticker.priceChangePercent)} (24h)` : ''}`);
  lines.push('');
  lines.push(`Xu hướng: ${esc(s.trend.label)}`);

  if (s.rsi != null) lines.push(`RSI 14: ${fmt(s.rsi, 1)} · ${esc(s.rsiZone)}`);
  if (s.ma50 != null) {
    lines.push(`MA50 ${fmt(s.ma50, d)}${s.ma200 == null ? '' : ` · MA200 ${fmt(s.ma200, d)}`}`);
  }
  if (s.macdHistogram != null) {
    lines.push(`MACD: ${s.macdHistogram >= 0 ? 'trên' : 'dưới'} đường tín hiệu`);
  }
  if (s.atr != null) lines.push(`ATR 14: ${fmt(s.atr, d)} (${fmt(s.atrPercent, 2)}% giá)`);
  if (s.volumeVsAvg != null) {
    lines.push(`Khối lượng: ${compact(s.volume)} (${fmt(s.volumeVsAvg, 2)}× TB20)`);
  }

  const deriv = [];
  if (derivatives?.fundingRate != null) {
    deriv.push(`funding ${pct(derivatives.fundingRate * 100, 4)}`);
  }
  if (derivatives?.openInterest != null) {
    const chg = derivatives.openInterestChangePct;
    deriv.push(`OI ${compact(derivatives.openInterest)}${chg == null ? '' : ` (${pct(chg)})`}`);
  }
  if (orderbook) deriv.push(`sổ lệnh ${pct(orderbook.imbalance * 100)}`);
  if (deriv.length) lines.push(deriv.join(' · '));

  lines.push('');
  lines.push(`Kháng cự: ${levelLine(levels.resistance, s.price, d)}`);
  lines.push(`Hỗ trợ: ${levelLine(levels.support, s.price, d)}`);

  if (ticker) {
    lines.push('');
    lines.push(`24h: ${fmt(ticker.lowPrice, d)} – ${fmt(ticker.highPrice, d)} · KL ${compact(ticker.quoteVolume)}`);
  }
  if (!p.lastCandleClosed) lines.push('<i>Nến cuối chưa đóng.</i>');

  const text = lines.join('\n');
  // Cắt phải chừa chỗ cho thẻ đóng, nếu không HTML sẽ hỏng và Telegram từ chối.
  return text.length > CAPTION_LIMIT
    ? `${text.slice(0, CAPTION_LIMIT - 24)}\n<i>(đã cắt)</i>`
    : text;
}

/** Tin nhắn giá nhanh cho /gia. */
export function buildQuoteMessage(p) {
  const d = decimalsFor(p.summary.price);
  const chg = p.ticker ? `  ${pct(p.ticker.priceChangePercent)} (24h)` : '';
  const rsi = fmt(p.summary.rsi, 1);
  return `<b>${esc(p.symbol)}</b>  ${fmt(p.summary.price, d)}${chg}\n`
    + `RSI ${rsi} · ${esc(p.summary.trend.label)}`;
}
