// Tokenomics từ CoinGecko (API công khai, không cần key).
//
// Binance không cung cấp dữ liệu cơ bản nào — không supply, không market cap,
// không FDV. Đây là nguồn duy nhất miễn phí có đủ các số đó.
//
// KHÔNG CÓ: lịch unlock / vesting. CoinGecko không có trường nào về unlock, và
// không có nguồn miễn phí nào khác. Đó là yếu tố tokenomics tác động giá mạnh
// nhất nhưng phải chấp nhận thiếu — đừng suy diễn thay nó.

const CG = 'https://api.coingecko.com/api/v3';

// CoinGecko free tier giới hạn vài chục request/phút -> cache mạnh tay.
const TTL_MS = 15 * 60e3;
const cache = new Map();   // key -> { at, value }

async function getJson(path, { timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(CG + path, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function cached(key, loader) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = await loader();
  cache.set(key, { at: now, value });
  return value;
}

/**
 * Ticker -> coin id của CoinGecko. Nhiều coin dùng chung ticker, nên dùng
 * /search (đã xếp theo market cap rank) và lấy kết quả có rank tốt nhất khớp
 * ticker — không lấy kết quả đầu tiên một cách mù quáng.
 */
export async function resolveCoinId(baseAsset) {
  const ticker = String(baseAsset || '').trim().toUpperCase();
  if (!ticker) return null;

  return cached(`id:${ticker}`, async () => {
    const j = await getJson(`/search?query=${encodeURIComponent(ticker)}`);
    const exact = (j.coins ?? []).filter((c) => c.symbol?.toUpperCase() === ticker);
    if (!exact.length) return null;
    // rank null = chưa có xếp hạng -> đẩy xuống cuối.
    exact.sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
    return exact[0].id;
  });
}

/**
 * Tokenomics của một token. Trả null nếu CoinGecko không biết token này hoặc
 * lỗi mạng — phía gọi phải xử lý null, không được coi là 0.
 */
export async function fetchTokenomics(baseAsset) {
  const id = await resolveCoinId(baseAsset).catch(() => null);
  if (!id) return null;

  return cached(`coin:${id}`, async () => {
    const j = await getJson(`/coins/${encodeURIComponent(id)}`
      + '?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false');
    const m = j.market_data ?? {};
    const circulating = m.circulating_supply ?? null;
    const total = m.total_supply ?? null;
    const max = m.max_supply ?? null;
    const mcap = m.market_cap?.usd ?? null;
    const fdv = m.fully_diluted_valuation?.usd ?? null;

    return {
      coinId: id,
      name: j.name,
      symbol: j.symbol?.toUpperCase() ?? null,
      marketCapRank: j.market_cap_rank ?? null,
      marketCapUsd: mcap,
      fdvUsd: fdv,
      // FDV/mcap > 1 nghĩa là còn token chưa lưu hành; càng cao thì áp lực pha
      // loãng trong tương lai càng lớn.
      fdvToMarketCap: mcap && fdv ? fdv / mcap : null,
      circulatingSupply: circulating,
      totalSupply: total,
      maxSupply: max,
      // % đã lưu hành so với tổng cung. Thấp = phần lớn token còn bị giữ lại.
      circulatingPercent: circulating && total ? (circulating / total) * 100 : null,
      volume24hUsd: m.total_volume?.usd ?? null,
      // Thanh khoản so với vốn hoá: thấp = khó vào/ra lệnh lớn.
      volumeToMarketCap: mcap && m.total_volume?.usd ? m.total_volume.usd / mcap : null,
      athChangePercent: m.ath_change_percentage?.usd ?? null,
      atlChangePercent: m.atl_change_percentage?.usd ?? null,
      priceChange7dPercent: m.price_change_percentage_7d ?? null,
      priceChange30dPercent: m.price_change_percentage_30d ?? null,
      categories: (j.categories ?? []).filter(Boolean).slice(0, 5),
      genesisDate: j.genesis_date ?? null,
    };
  });
}
