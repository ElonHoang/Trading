// Lớp bối cảnh cơ bản — Kĩ năng 2 (tin tức + tokenomics + rủi ro delist).
//
// TẠI SAO TÁCH RIÊNG khỏi điểm kỹ thuật: dòng tiền tính bằng giây đến giờ, còn
// tin tức và tokenomics tính bằng ngày đến tuần. Trộn vào cùng thang -100..100 sẽ
// làm méo điểm kỹ thuật và không backtest được (tokenomics không có lịch sử theo
// nến). Vì vậy lớp này chỉ XÁC NHẬN hoặc PHỦ QUYẾT setup, không cộng vào điểm.
//
// Diễn giải bằng LUẬT CỨNG, không dùng LLM: mọi kết luận ở đây tái lập được.

import { baseAssetOf } from '../data/binance.js';
import { fetchTokenomics } from '../data/fundamentals.js';
import { fetchDelistRisk } from '../data/announcements.js';
import { fetchTokenNews } from '../data/news.js';

const DEFAULTS = {
  // FDV/mcap từ mức này trở lên = còn nhiều token chưa lưu hành -> áp lực pha loãng.
  fdvRatioWarn: 2,
  fdvRatioSevere: 4,
  // % đã lưu hành dưới mức này = phần lớn cung còn bị giữ lại.
  circulatingWarnPercent: 50,
  // Thanh khoản/vốn hoá dưới mức này = khó vào ra lệnh lớn.
  volumeToMcapWarn: 0.02,
  // Vốn hoá xếp hạng trên mức này = token nhỏ, rủi ro cao.
  rankRiskyAbove: 300,
};

/**
 * Thu thập bối cảnh cho một cặp. Mọi nguồn lỗi thì trả null cho phần đó thay vì
 * làm sập cả phân tích — bối cảnh là lớp phụ, không được chặn phần kỹ thuật.
 */
export async function buildContext(symbol, cfg = {}) {
  const t = { ...DEFAULTS, ...cfg };
  const baseAsset = await baseAssetOf(symbol).catch(() => null);

  const [tokenomics, delistRisk] = await Promise.all([
    baseAsset ? fetchTokenomics(baseAsset).catch(() => null) : null,
    fetchDelistRisk(symbol, baseAsset).catch(() => null),
  ]);
  const news = baseAsset
    ? await fetchTokenNews(baseAsset, tokenomics?.name ?? null).catch(() => null)
    : null;

  const warnings = [];   // { severity: 'critical'|'warn'|'info', text }
  const supports = [];   // lý do ủng hộ, dạng chuỗi ngắn
  let blockLong = false;
  let blockShort = false;

  // --- Rủi ro delist: nghiêm trọng nhất, chặn thẳng ---
  if (delistRisk) {
    if (delistRisk.symbolStatus && !delistRisk.statusIsTrading) {
      warnings.push({
        severity: 'critical',
        text: `Cặp đang ở trạng thái ${delistRisk.symbolStatus} (không giao dịch) — không vào lệnh`,
      });
      blockLong = true;
      blockShort = true;
    }
    if (delistRisk.matchedAnnouncements?.length) {
      const a = delistRisk.matchedAnnouncements[0];
      warnings.push({
        severity: 'critical',
        text: `Có thông báo delist nhắc tới ${baseAsset}: "${a.title}"`,
      });
      // Delist làm thanh khoản cạn và giá thường sập -> chặn long, không chặn short.
      blockLong = true;
    }
    if (delistRisk.unparsedNotices?.length) {
      warnings.push({
        severity: 'info',
        text: `${delistRisk.unparsedNotices.length} thông báo removal không ghi token trong tiêu đề — nên tự mở kiểm tra`,
      });
    }
    if (!delistRisk.sourceAvailable) {
      warnings.push({
        severity: 'info',
        text: 'Không đọc được thông báo Binance (endpoint không chính thức) — chỉ dựa vào trạng thái cặp',
      });
    }
  }

  // --- Tokenomics ---
  if (tokenomics) {
    const r = tokenomics.fdvToMarketCap;
    if (r != null) {
      if (r >= t.fdvRatioSevere) {
        warnings.push({
          severity: 'warn',
          text: `FDV gấp ${r.toFixed(1)}× vốn hoá — phần lớn cung chưa lưu hành, áp lực pha loãng rất lớn`,
        });
      } else if (r >= t.fdvRatioWarn) {
        warnings.push({
          severity: 'warn',
          text: `FDV gấp ${r.toFixed(1)}× vốn hoá — còn nhiều token sẽ được mở khoá`,
        });
      } else if (r <= 1.15) {
        supports.push(`FDV chỉ gấp ${r.toFixed(2)}× vốn hoá — gần như đã lưu hành hết, ít áp lực pha loãng`);
      }
    }
    if (tokenomics.circulatingPercent != null
      && tokenomics.circulatingPercent < t.circulatingWarnPercent) {
      warnings.push({
        severity: 'warn',
        text: `Chỉ ${tokenomics.circulatingPercent.toFixed(1)}% tổng cung đang lưu hành`,
      });
    }
    if (tokenomics.volumeToMarketCap != null
      && tokenomics.volumeToMarketCap < t.volumeToMcapWarn) {
      warnings.push({
        severity: 'warn',
        text: `Khối lượng 24h chỉ ${(tokenomics.volumeToMarketCap * 100).toFixed(2)}% vốn hoá — thanh khoản mỏng, dễ trượt giá`,
      });
    }
    if (tokenomics.marketCapRank != null && tokenomics.marketCapRank > t.rankRiskyAbove) {
      warnings.push({
        severity: 'warn',
        text: `Xếp hạng vốn hoá #${tokenomics.marketCapRank} — token nhỏ, biến động và rủi ro cao`,
      });
    } else if (tokenomics.marketCapRank != null && tokenomics.marketCapRank <= 50) {
      supports.push(`Vốn hoá #${tokenomics.marketCapRank} — token lớn, thanh khoản tốt`);
    }
  } else {
    warnings.push({
      severity: 'info',
      text: 'Không lấy được tokenomics (CoinGecko không có token này hoặc lỗi mạng)',
    });
  }

  // --- Tin tức (phân loại bằng từ khoá) ---
  if (news?.available && news.items.length) {
    const neg = news.counts.negative;
    const pos = news.counts.positive;
    const worst = news.firstNegative;
    const best = news.firstPositive;
    if (neg > 0 && worst) {
      warnings.push({
        severity: neg >= 2 ? 'warn' : 'info',
        text: `${neg} tin tiêu cực (${worst.keywords.join(', ')}): "${worst.title.slice(0, 90)}"`,
      });
    }
    if (pos > 0 && neg === 0 && best) {
      supports.push(`${pos} tin tích cực (${best.keywords.join(', ')}): "${best.title.slice(0, 90)}"`);
    }
  } else if (news?.note) {
    warnings.push({ severity: 'info', text: news.note });
  }

  const critical = warnings.filter((w) => w.severity === 'critical');
  return {
    baseAsset,
    tokenomics,
    delistRisk,
    news,
    warnings,
    supports,
    blockLong,
    blockShort,
    // Bối cảnh không cho điểm, chỉ cho hướng nghiêng để hiển thị.
    bias: critical.length ? 'blocked'
      : warnings.some((w) => w.severity === 'warn') && !supports.length ? 'negative'
        : supports.length && !warnings.some((w) => w.severity === 'warn') ? 'positive'
          : 'neutral',
  };
}
