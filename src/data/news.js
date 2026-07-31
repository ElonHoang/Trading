// Tin tức crypto từ RSS công khai (không cần key).
//
// GIỚI HẠN PHẢI BIẾT: đây là RSS tin chung của toàn thị trường, được LỌC theo tên
// và ticker của token. Vì vậy:
//  - token vốn hoá lớn (BTC, ETH, SOL) thường có tin;
//  - token nhỏ hầu như KHÔNG BAO GIỜ xuất hiện -> "không có tin" nghĩa là
//    "không tìm thấy trong các nguồn này", KHÔNG phải "không có tin gì xảy ra".
// Muốn coverage theo từng token thì cần API có key (CryptoPanic...).

const FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
];

const TTL_MS = 15 * 60e3;
let cache = null;
let cacheAt = 0;

// Phân loại bằng TỪ KHOÁ, không phải phân tích cảm xúc bằng AI. Thô nhưng
// tái lập được và không bịa.
const NEGATIVE = [
  'hack', 'hacked', 'exploit', 'exploited', 'breach', 'stolen', 'drain',
  'delist', 'delisting', 'removal', 'halt', 'suspend', 'suspended',
  'lawsuit', 'sue', 'sued', 'sec charges', 'fraud', 'scam', 'rug',
  'bankrupt', 'insolvency', 'liquidated', 'outage', 'exploit',
  'investigation', 'probe', 'ban', 'banned', 'crackdown', 'dump',
];
const POSITIVE = [
  'listing', 'lists', 'listed', 'partnership', 'partners', 'integration',
  'upgrade', 'mainnet', 'launch', 'launches', 'etf approval', 'approved',
  'adoption', 'buyback', 'burn', 'staking rewards', 'funding round', 'raises',
  'record high', 'all-time high', 'rally', 'surge',
];

function stripTags(s) {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
}

function parseItems(xml, source) {
  const items = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const block = m[0];
    const title = stripTags(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const link = stripTags(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '');
    const date = stripTags(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '');
    const desc = stripTags(block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '');
    if (title) items.push({ title, link, date, desc: desc.slice(0, 300), source });
  }
  return items;
}

async function fetchAllItems() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;

  const results = await Promise.all(FEEDS.map(async (f) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const res = await fetch(f.url, { signal: ac.signal });
      if (!res.ok) return [];
      return parseItems(await res.text(), f.name);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }));

  cache = results.flat();
  cacheAt = now;
  return cache;
}

// Khớp theo BIÊN TỪ, không phải substring: "bank" từng bị tính là "ban",
// "urban" thành "ban", "abandon" thành "ban" — sinh cảnh báo tiêu cực sai.
const wordRe = new Map();
function hasKeyword(lower, keyword) {
  let re = wordRe.get(keyword);
  if (!re) {
    re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    wordRe.set(keyword, re);
  }
  return re.test(lower);
}

function classify(text) {
  const lower = text.toLowerCase();
  const neg = NEGATIVE.filter((k) => hasKeyword(lower, k));
  const pos = POSITIVE.filter((k) => hasKeyword(lower, k));
  if (neg.length && !pos.length) return { tone: 'negative', keywords: neg.slice(0, 3) };
  if (pos.length && !neg.length) return { tone: 'positive', keywords: pos.slice(0, 3) };
  if (neg.length && pos.length) return { tone: 'mixed', keywords: [...neg, ...pos].slice(0, 3) };
  return { tone: 'neutral', keywords: [] };
}

/**
 * Tin liên quan tới một token. `names` gồm ticker và tên đầy đủ (từ tokenomics)
 * để bắt được cả "Solana" lẫn "SOL".
 *
 * Ticker khớp theo biên từ và phải VIẾT HOA trong bài để tránh "SOL" trúng
 * "solution"; tên đầy đủ thì khớp không phân biệt hoa thường.
 */
export async function fetchTokenNews(ticker, fullName = null, { limit = 6 } = {}) {
  const items = await fetchAllItems();
  if (!items.length) return { available: false, items: [], counts: null };

  const tick = String(ticker || '').toUpperCase();
  const tickRe = tick.length >= 2 ? new RegExp(`\\b${tick}\\b`) : null;
  const nameRe = fullName && fullName.length >= 3
    ? new RegExp(`\\b${fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    : null;

  const matched = [];
  for (const it of items) {
    const hay = `${it.title} ${it.desc}`;
    if ((tickRe && tickRe.test(hay)) || (nameRe && nameRe.test(hay))) {
      matched.push({ ...it, ...classify(hay) });
    }
  }

  const counts = { negative: 0, positive: 0, mixed: 0, neutral: 0 };
  for (const m of matched) counts[m.tone]++;

  return {
    available: true,
    scanned: items.length,
    sources: FEEDS.map((f) => f.name),
    items: matched.slice(0, limit),
    counts,
    // Trả thẳng tin đại diện: `items` bị cắt theo `limit` nên phía gọi không tìm
    // được tin tiêu cực/tích cực trong đó dù `counts` báo có.
    firstNegative: matched.find((m) => m.tone === 'negative') ?? null,
    firstPositive: matched.find((m) => m.tone === 'positive') ?? null,
    // Ghi rõ để phía trên không hiểu sai "0 tin" thành "không có gì xảy ra".
    note: matched.length
      ? null
      : 'Không tìm thấy tin nào khớp token này trong RSS tin chung — không có nghĩa là không có tin',
  };
}
