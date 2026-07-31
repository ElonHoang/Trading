// Định dạng snapshot thành văn bản thuần (plain text) — an toàn cho Telegram
// mà không phải escape markdown.

import { fmtNum } from './analysis/engine.js';

const SIGNAL_ICON = {
  'MUA MẠNH': '🟢🟢',
  MUA: '🟢',
  'TRUNG LẬP': '⚪',
  BÁN: '🔴',
  'BÁN MẠNH': '🔴🔴',
};

function bar(score) {
  // Thanh trực quan -100..100
  const slots = 20;
  const pos = Math.round(((score + 100) / 200) * slots);
  return '['.concat('▬'.repeat(Math.max(0, pos)), '·'.repeat(Math.max(0, slots - pos)), ']');
}

export function formatSummary(s) {
  const L = [];
  const icon = SIGNAL_ICON[s.combined.signal] || '⚪';
  L.push(`${icon} ${s.symbol} · ${s.interval} · ${s.combined.signal}`);
  L.push(`Giá hiện tại: ${fmtNum(s.price.live)}` +
    (s.price.change24hPercent != null ? `  (24h: ${s.price.change24hPercent > 0 ? '+' : ''}${s.price.change24hPercent}%)` : ''));
  const drift = ((s.price.live - s.price.lastClose) / s.price.lastClose) * 100;
  if (Math.abs(drift) >= 0.15) {
    L.push(`Giá đóng nến ${s.interval} gần nhất: ${fmtNum(s.price.lastClose)} `
      + `(giá đã chạy ${drift > 0 ? '+' : ''}${drift.toFixed(2)}% từ lúc đó — mọi chỉ báo tính trên mức này)`);
  }
  L.push(`Điểm tổng hợp: ${s.combined.score} / 100  ${bar(s.combined.score)}`);
  L.push(`  · Quy tắc: ${s.rules.score}`);
  if (s.ml.available) {
    L.push(`  · Model ML: ${s.ml.probUpPercent}% khả năng tăng trong ${s.ml.horizonCandles} nến`);
    L.push(`      độ tin cậy ${translateReliability(s.ml.reliability)} `
      + `(AUC holdout ${s.ml.testAuc} / walk-forward ${s.ml.walkForwardAuc})`);
    if (s.ml.thresholds) {
      L.push(`      ngưỡng model này: >${s.ml.thresholds.bullishAbove} tăng mạnh, <${s.ml.thresholds.bearishBelow} giảm mạnh`
        + (s.ml.percentileVsHistory ? ` → hiện ở nhóm ${s.ml.percentileVsHistory}` : ''));
    }
    if (s.combined.mlWeightUsed === 0) {
      L.push('      ⚠️ KHÔNG được tính vào điểm tổng vì độ tin cậy thấp — chỉ để tham khảo');
    }
  } else {
    L.push(`  · Model ML: không dùng (${s.ml.reason})`);
  }
  if (s.higherTimeframe && typeof s.higherTimeframe.ruleScore === 'number') {
    L.push(`  · Khung ${s.higherTimeframe.interval}: ${s.higherTimeframe.signal} (${s.higherTimeframe.ruleScore})`);
  }
  return L.join('\n');
}

function translateReliability(r) {
  return { high: 'cao', medium: 'trung bình', low: 'thấp' }[r] || r;
}

export function formatIndicators(s) {
  const i = s.indicators;
  const L = ['📊 CHỈ BÁO'];

  L.push(`Khối lượng: ${fmtNum(i.volume)} (${i.volumeRatio}x trung bình ${s.indicatorParams?.volumeAvg ?? 20} nến)`);

  const share = i.cvdDeltaShare != null ? `${(i.cvdDeltaShare * 100).toFixed(1)}%` : '—';
  const slope = i.cvdSlope != null ? `${(i.cvdSlope * 100).toFixed(1)}%` : '—';
  L.push(`CVD luỹ tiến: ${fmtNum(i.cvd)}   nến này: ${share} khối lượng là mua chủ động ròng`);
  L.push(`CVD ${s.indicatorParams?.cvdSlope ?? 20} nến: ${slope} khối lượng cùng kỳ`);

  if (s.derivatives?.fundingRate != null) {
    L.push(`Funding: ${s.derivatives.fundingRatePercent}%`
      + (s.derivatives.openInterestChangePct != null
        ? `   OI: ${s.derivatives.openInterestChangePct > 0 ? '+' : ''}${s.derivatives.openInterestChangePct}% (14 kỳ 4h)`
        : ''));
  } else {
    L.push('Funding / OI: không có hợp đồng futures cho token này');
  }

  const ob = s.orderBook;
  if (ob) {
    L.push(`Sổ lệnh: lệch ${(ob.imbalance * 100).toFixed(1)}% về phía ${ob.imbalance > 0 ? 'mua' : 'bán'}`
      + (ob.depthSpanPct != null ? `   độ trải ±${ob.depthSpanPct.toFixed(2)}%` : ''));
    for (const w of ob.walls ?? []) {
      L.push(`   Tường ${w.side === 'bid' ? 'MUA ' : 'BÁN '} ${fmtNum(w.price)} `
        + `(${w.distancePct >= 0 ? '+' : ''}${w.distancePct.toFixed(2)}%, ${w.ratioToAvg.toFixed(1)}x TB)`);
    }
    if (ob.walls?.length) L.push('   (tường lệnh có thể là spoofing — đối chiếu CVD/volume)');
  }
  return L.join('\n');
}

export function formatBreakdown(s) {
  const L = ['🧮 PHÂN TÍCH THEO NHÓM (đóng góp vào điểm tổng)'];
  const names = {
    cvd: 'CVD', volume: 'Khối lượng', derivatives: 'Phái sinh (OI + funding)',
    positioning: 'Định vị đám đông', structure: 'Hỗ trợ/kháng cự', orderBook: 'Sổ lệnh',
  };
  const entries = Object.entries(s.rules.breakdown)
    .filter(([, v]) => v.weight > 0)
    .sort((a, b) => Math.abs(b[1].contributionPct) - Math.abs(a[1].contributionPct));
  for (const [key, v] of entries) {
    const sign = v.contributionPct > 0 ? '+' : '';
    L.push(`\n▸ ${names[key] || key} (trọng số ${v.weight}) → ${sign}${v.contributionPct}`);
    for (const r of v.reasons) L.push(`   · ${r}`);
  }
  return L.join('\n');
}

export function formatLevels(s) {
  const L = ['🎯 VÙNG GIÁ'];
  const st = s.structure;
  if (st.resistance.length) {
    L.push('Kháng cự: ' + st.resistance.slice(0, 4)
      .map((l) => `${fmtNum(l.price)} (+${l.distancePct}%, ${l.touches}x)`).join(' | '));
  }
  if (st.support.length) {
    L.push('Hỗ trợ:   ' + st.support.slice(0, 4)
      .map((l) => `${fmtNum(l.price)} (${l.distancePct}%, ${l.touches}x)`).join(' | '));
  }
  const lv = s.levels;
  if (lv.side === 'none') {
    L.push(`\n${lv.note || 'Không có setup rõ ràng.'}`);
  } else {
    L.push(`\n💼 SETUP ${lv.side === 'long' ? 'LONG' : 'SHORT'}`);
    const drift = ((s.price.live - lv.entry) / lv.entry) * 100;
    L.push(`Entry tham chiếu: ${fmtNum(lv.entry)} (giá đóng nến)`
      + (Math.abs(drift) >= 0.3
        ? `\n⚠️ Giá hiện tại ${fmtNum(s.price.live)} đã lệch ${drift > 0 ? '+' : ''}${drift.toFixed(2)}% — `
          + 'cân nhắc chờ giá về vùng entry hoặc dịch SL/TP theo cùng biên độ.'
        : ''));
    L.push(`Stop loss: ${fmtNum(lv.stopLoss)}  (rủi ro ${lv.riskPercent}% giá)`);
    for (const t of lv.targets) {
      const pct = ((t.price - lv.entry) / lv.entry) * 100;
      L.push(`${t.label} (${t.r}R): ${fmtNum(t.price)}  (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)`);
    }
    if (lv.srTargets?.length) {
      L.push('Mục tiêu theo S/R: ' + lv.srTargets
        .map((t) => `${fmtNum(t.price)} (${t.distancePct > 0 ? '+' : ''}${t.distancePct}%)`).join(' | '));
    }
  }
  if (s.conflicts?.length) {
    L.push('\n⚠️ XUNG ĐỘT TÍN HIỆU');
    for (const c of s.conflicts) L.push(`   · ${c}`);
  }
  return L.join('\n');
}

/** Bản tóm tắt nhanh, không cần LLM. */
export function formatQuick(s) {
  return [
    formatSummary(s),
    '',
    formatIndicators(s),
    '',
    formatLevels(s),
    '',
    `Nến đã đóng gần nhất: ${s.lastClosedCandleTime.replace('T', ' ').slice(0, 16)} UTC`,
    'Đây là phân tích kỹ thuật tự động, không phải lời khuyên đầu tư.',
  ].join('\n');
}

export function formatTrainResult(payload, verdict) {
  const m = payload.metrics;
  const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
  const L = [`✅ Đã train xong ${payload.symbol} ${payload.interval}`];
  L.push(`Dữ liệu: ${payload.candleRange.count} nến (${payload.candleRange.from.slice(0, 10)} → ${payload.candleRange.to.slice(0, 10)})`);
  L.push(`Nhãn: ${payload.dataset.thresholdMode}, horizon ${payload.dataset.horizon} nến`);
  L.push(`Mẫu học: ${payload.dataset.samples} (bỏ ${payload.dataset.skippedNeutral} mẫu nhiễu), tỉ lệ tăng ${pct(payload.dataset.positiveRate)}`);
  L.push(`Cây giữ lại: ${m.earlyStopping?.treesKept}/${m.earlyStopping?.maxTrees} (dừng sớm theo ${m.earlyStopping?.metric})`);
  L.push('');
  L.push('📈 KẾT QUẢ TRÊN DỮ LIỆU MỚI (out-of-sample)');
  L.push(`AUC holdout: ${m.test?.auc}   ·   AUC walk-forward (${m.walkForward.folds.length} fold): ${m.walkForward.meanAuc}`);
  L.push('   (0.5 = vô dụng như tung xu; >0.55 là đã khá tốt với dữ liệu giá)');
  if (m.tail?.combinedAccuracy != null) {
    L.push('');
    L.push('🎯 KHI MODEL TỰ TIN NHẤT (20% tín hiệu mạnh nhất mỗi chiều)');
    L.push(`Đúng ${pct(m.tail.combinedAccuracy)} trên ${m.tail.bullishSignals + m.tail.bearishSignals} lần `
      + `(${pct(m.tail.coverage)} số nến)`);
    L.push(`   · Báo TĂNG: ${m.tail.bullishSignals} lần, đúng ${pct(m.tail.bullishAccuracy)}`);
    L.push(`   · Báo GIẢM: ${m.tail.bearishSignals} lần, đúng ${pct(m.tail.bearishAccuracy)}`);
  }
  if (payload.calibration) {
    L.push(`Ngưỡng dùng thật: > ${payload.calibration.p80} = tăng mạnh, < ${payload.calibration.p20} = giảm mạnh `
      + `(trung vị ${payload.calibration.p50})`);
  }
  if (m.simulation?.trades) {
    L.push('');
    L.push(`💰 Mô phỏng (vốn kép, không SL): ${m.simulation.trades} lệnh, thắng ${pct(m.simulation.winRate)}, `
      + `tổng ${m.simulation.totalReturnPercent}%`);
    L.push(`   (bỏ qua ${m.simulation.skippedOverlap} tín hiệu vì trùng lệnh đang mở)`);
    L.push('   ⚠️ Đây chỉ là mô phỏng thô. Dùng /backtest để kiểm chứng có SL/TP thật.');
  }
  L.push('');
  L.push('🔍 Chỉ báo được model dùng nhiều nhất:');
  for (const f of payload.importance.slice(0, 8)) {
    L.push(`   ${f.feature} — ${f.pct.toFixed(1)}%`);
  }
  L.push('');
  L.push(`Đánh giá: ${verdict}`);
  return L.join('\n');
}

export function formatBacktest(r) {
  const st = r.stats;
  const L = [`📉 BACKTEST ${r.symbol} ${r.interval}`];
  L.push(`${r.period.from.slice(0, 10)} → ${r.period.to.slice(0, 10)} (${r.period.candles} nến)`);
  L.push(`Phí ${r.settings.feePercent}%/chiều · giữ tối đa ${r.settings.maxHoldBars} nến · `
    + `ML ${r.settings.usedModel ? `bật (trọng số ${r.settings.mlWeight})` : 'chưa có model'}`);
  L.push('');
  if (!st.trades) {
    L.push(st.note);
    return L.join('\n');
  }
  L.push(`Số lệnh: ${st.trades} (long ${st.longTrades} / short ${st.shortTrades})`);
  L.push(`Tỉ lệ thắng: ${st.winRatePercent}%  (long ${st.longWinRate ?? '—'}% / short ${st.shortWinRate ?? '—'}%)`);
  L.push(`Lãi TB khi thắng: ${st.avgWinPercent}%   Lỗ TB khi thua: ${st.avgLossPercent}%`);
  L.push(`Profit factor: ${st.profitFactor}   Kỳ vọng/lệnh: ${st.expectancyPercent}%`);
  L.push(`Tổng lợi nhuận (vốn kép): ${st.totalReturnPercent}%`);
  L.push(`Sụt giảm tối đa: -${st.maxDrawdownPercent}%`);
  L.push(`Mua và giữ cùng kỳ: ${st.buyHoldReturnPercent}%  → chiến lược ${st.beatBuyHold ? 'THẮNG' : 'THUA'} mua-giữ`);
  L.push(`Lý do đóng lệnh: ${Object.entries(st.exitReasons).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return L.join('\n');
}

/** Cắt tin nhắn dài thành nhiều phần <= limit ký tự, cắt tại ranh giới dòng. */
export function splitMessage(text, limit = 3900) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > limit) {
      if (cur) chunks.push(cur);
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
        cur = '';
        continue;
      }
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [''];
}
