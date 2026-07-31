// Gộp phân tích kỹ thuật (Kĩ năng 1) với bối cảnh cơ bản (Kĩ năng 2) thành một
// setup vào lệnh: hướng, entry, SL, TP, và LÝ DO NGẮN GỌN tại sao nên vào.
//
// Nguyên tắc: bối cảnh KHÔNG cộng điểm, chỉ xác nhận hoặc phủ quyết. Điểm vẫn
// hoàn toàn từ phần kỹ thuật để backtest còn ý nghĩa.

const GROUP_LABELS = {
  cvd: 'CVD',
  volume: 'Khối lượng',
  derivatives: 'OI + funding',
  positioning: 'Định vị đám đông',
  structure: 'Hỗ trợ/kháng cự',
  orderBook: 'Sổ lệnh',
};

/**
 * Chọn lý do đáng kể nhất của mỗi nhóm: dòng reasons có mũi tên "→" là dòng đã
 * được diễn giải thành kết luận, ưu tiên nó; không có thì lấy dòng đầu.
 */
function keyReason(group) {
  const decisive = group.reasons.find((r) => r.includes('→'));
  return decisive ?? group.reasons[0] ?? null;
}

/**
 * @param snapshot  kết quả engine.analyze()
 * @param context   kết quả buildContext() (có thể null nếu bỏ qua Kĩ năng 2)
 */
export function buildSetup(snapshot, context = null, {
  maxReasons = 5, consensusPercent = null,
} = {}) {
  let side = snapshot.combined.side;             // 'long' | 'short' | 'none'
  const lv = snapshot.levels;
  const blockers = [];
  const cons = snapshot.rules?.consensus ?? null;

  // --- Cổng đồng thuận: yêu cầu bao nhiêu % nhóm CÓ DỮ LIỆU phải cùng hướng ---
  // Khác ngưỡng điểm: |điểm| cao có thể đến từ ít nhóm rất mạnh. Cổng này đảm bảo
  // nhiều nhóm độc lập cùng xác nhận trước khi gọi kèo.
  let consensusGate = null;
  if (consensusPercent != null && cons && side !== 'none') {
    const met = cons.percent >= consensusPercent;
    consensusGate = {
      required: consensusPercent,
      actual: cons.percent,
      agree: cons.agree,
      activeGroups: cons.activeGroups,
      met,
    };
    if (!met) {
      side = 'none';
      blockers.push(`Chỉ ${cons.agree}/${cons.activeGroups} nhóm đồng thuận `
        + `(${cons.percent.toFixed(0)}%), cần ≥ ${consensusPercent}%`);
    }
  }

  // --- Phủ quyết từ bối cảnh ---
  if (context) {
    if (side === 'long' && context.blockLong) {
      blockers.push(...context.warnings
        .filter((w) => w.severity === 'critical')
        .map((w) => w.text));
    }
    if (side === 'short' && context.blockShort) {
      blockers.push(...context.warnings
        .filter((w) => w.severity === 'critical')
        .map((w) => w.text));
    }
  }

  // Chưa đủ đồng thuận thì "chờ", khác với "bị phủ quyết" bởi bối cảnh cơ bản.
  const vetoed = context != null && blockers.some((b) => !b.startsWith('Chỉ '));
  const blocked = blockers.length > 0;
  const finalSide = blocked ? 'none' : side;

  // --- Lý do: các nhóm đóng góp ĐÚNG HƯỚNG với tín hiệu, mạnh nhất trước ---
  const reasons = [];
  if (finalSide !== 'none') {
    const wanted = finalSide === 'long' ? 1 : -1;
    const groups = Object.entries(snapshot.rules.breakdown)
      .filter(([, v]) => v.weight > 0 && !v.skipped)
      .filter(([, v]) => Math.sign(v.contributionPct) === wanted)
      .sort((a, b) => Math.abs(b[1].contributionPct) - Math.abs(a[1].contributionPct));

    for (const [key, v] of groups) {
      const r = keyReason(v);
      if (!r) continue;
      reasons.push({
        source: 'Kĩ năng 1',
        group: GROUP_LABELS[key] ?? key,
        weight: v.weight,
        contribution: v.contributionPct,
        text: r,
      });
      if (reasons.length >= maxReasons) break;
    }

    // Khung lớn cùng hướng là lý do đáng kể.
    const htf = snapshot.higherTimeframe;
    if (htf && typeof htf.ruleScore === 'number'
      && Math.sign(htf.ruleScore) === wanted && Math.abs(htf.ruleScore) > 10) {
      reasons.push({
        source: 'Kĩ năng 1',
        group: `Khung ${htf.interval}`,
        text: `Khung lớn ${htf.interval} cùng hướng (${htf.ruleScore > 0 ? '+' : ''}${htf.ruleScore})`,
      });
    }

    // ML chỉ được nêu khi thực sự được tính vào điểm.
    if (snapshot.ml?.available && snapshot.combined.mlWeightUsed > 0) {
      const mlSide = snapshot.ml.probUp > 0.5 ? 'long' : 'short';
      if (mlSide === finalSide) {
        reasons.push({
          source: 'Model ML',
          group: 'ML',
          text: `Model cho ${snapshot.ml.probUpPercent}% khả năng tăng `
            + `(độ tin cậy ${snapshot.ml.reliability})`,
        });
      }
    }

    // Bối cảnh cơ bản ủng hộ.
    for (const s of context?.supports ?? []) {
      reasons.push({ source: 'Kĩ năng 2', group: 'Bối cảnh', text: s });
    }
  }

  // --- Cảnh báo: xung đột kỹ thuật + rủi ro cơ bản ---
  const cautions = [
    ...(snapshot.conflicts ?? []).map((c) => ({ source: 'Kĩ năng 1', text: c })),
    ...(context?.warnings ?? [])
      .filter((w) => w.severity !== 'critical')
      .map((w) => ({ source: 'Kĩ năng 2', severity: w.severity, text: w.text })),
  ];

  // TP1 định nghĩa là 1R nên R:R tới TP1 luôn = 1, vô nghĩa. Đo tới mục tiêu
  // cấu trúc gần nhất (mức S/R thật) mới cho biết còn bao nhiêu room.
  const firstStruct = lv.srTargets?.[0];
  const riskAbs = lv.entry != null && lv.stopLoss != null
    ? Math.abs(lv.entry - lv.stopLoss) : null;
  const rr = firstStruct && riskAbs
    ? Math.abs(firstStruct.price - lv.entry) / riskAbs
    : null;

  return {
    side: finalSide,
    signal: blocked ? 'ĐỨNG NGOÀI' : snapshot.combined.signal,
    score: snapshot.combined.score,
    strength: blocked ? 'blocked' : snapshot.combined.strength,
    blocked,
    blockers,
    entry: finalSide === 'none' ? null : lv.entry,
    stopLoss: finalSide === 'none' ? null : lv.stopLoss,
    riskPercent: finalSide === 'none' ? null : lv.riskPercent,
    targets: finalSide === 'none' ? [] : (lv.targets ?? []),
    srTargets: finalSide === 'none' ? [] : (lv.srTargets ?? []),
    rrToTp1: finalSide === 'none' ? null : (rr != null ? Number(rr.toFixed(2)) : null),
    reasons,
    cautions,
    contextBias: context?.bias ?? null,
    consensus: cons,
    consensusGate,
    vetoed,
    note: vetoed
      ? 'Bối cảnh cơ bản phủ quyết setup kỹ thuật.'
      : blocked
        ? 'Chưa đủ số nhóm đồng thuận — chờ thêm xác nhận.'
        : finalSide === 'none'
          ? (lv.note ?? 'Không có hướng rõ ràng — chờ tín hiệu.')
          : null,
  };
}

/**
 * Đặt stop loss cho một entry giả định: ưu tiên ra ngoài mức cấu trúc gần nhất,
 * nhưng không quá gần (dễ bị quét) và không quá xa (rủi ro lớn).
 */
function stopFor(entry, isLong, levels, slPercent) {
  const baseRisk = entry * (slPercent / 100);
  const fallback = isLong ? entry - baseRisk : entry + baseRisk;
  const level = isLong
    ? levels.support?.find((l) => l.price < entry)
    : levels.resistance?.find((l) => l.price > entry);
  if (!level) return { price: fallback, from: `${slPercent}% giá` };

  const buffer = baseRisk * 0.3;
  const candidate = isLong ? level.price - buffer : level.price + buffer;
  const dist = Math.abs(entry - candidate);
  if (dist > baseRisk * 0.4 && dist < baseRisk * 2.5) {
    return {
      price: candidate,
      from: `ngoài ${isLong ? 'hỗ trợ' : 'kháng cự'} ${level.price} (${level.touches} lần chạm)`,
    };
  }
  return { price: fallback, from: `${slPercent}% giá (mức cấu trúc quá ${dist <= baseRisk * 0.4 ? 'gần' : 'xa'})` };
}

/**
 * Phép chiếu hai chiều: nếu giá đi lên thì vào đâu, và nếu giá đi xuống thì vào
 * đâu — mỗi kịch bản có điều kiện kích hoạt, entry, SL, TP và điều kiện vô hiệu.
 *
 * Mọi mức đều neo vào hỗ trợ/kháng cự thật (kèm số lần chạm) và tường lệnh, chứ
 * không phải con số tự đặt ra.
 */
export function buildProjections(snapshot, risk = {}) {
  const price = snapshot.price.lastClose;
  const levels = snapshot.structure ?? { support: [], resistance: [] };
  const slPercent = risk.slPercent ?? 2.5;
  const tpR = risk.takeProfitR ?? [1, 2, 3];
  const walls = snapshot.orderBook?.walls ?? [];

  const build = (isLong) => {
    const gate = isLong
      ? levels.resistance?.[0]
      : levels.support?.[0];
    // Không có mức cấu trúc thì lấy mốc ±1% làm điều kiện xác nhận.
    const entry = gate ? gate.price : price * (isLong ? 1.01 : 0.99);
    const sl = stopFor(entry, isLong, levels, slPercent);
    const r = Math.abs(entry - sl.price);

    const targets = tpR.map((mult, i) => ({
      label: `TP${i + 1}`,
      r: mult,
      price: isLong ? entry + r * mult : entry - r * mult,
    }));

    // Mức cấu trúc phía trước làm mục tiêu tham chiếu (đáng tin hơn bội số R).
    const ahead = (isLong ? levels.resistance : levels.support)
      ?.filter((l) => (isLong ? l.price > entry : l.price < entry))
      .slice(0, 3)
      .map((l) => ({ price: l.price, touches: l.touches, distancePct: l.distancePct })) ?? [];

    // Chỉ nêu tường nằm GIỮA entry và TP cuối — tường cách 13% không liên quan
    // tới kèo nhắm 2%, nói ra chỉ gây nhiễu.
    const lastTp = targets[targets.length - 1]?.price ?? entry;
    const wallAhead = walls.find((w) => {
      if (isLong ? w.side !== 'ask' : w.side !== 'bid') return false;
      return isLong ? w.price > entry && w.price <= lastTp : w.price < entry && w.price >= lastTp;
    });

    // R:R tới TP1 luôn bằng 1 vì TP1 định nghĩa là 1R -> vô nghĩa. Đo tới mục
    // tiêu cấu trúc gần nhất mới cho biết kèo có đáng vào không.
    const firstStruct = ahead[0];
    const rrToStructure = firstStruct && r > 0
      ? Math.abs(firstStruct.price - entry) / r
      : null;

    return {
      direction: isLong ? 'long' : 'short',
      label: isLong ? 'Thế giá lên' : 'Thế giá xuống',
      trigger: gate
        ? `Nến đóng ${isLong ? 'trên' : 'dưới'} ${gate.price} `
          + `(${isLong ? 'kháng cự' : 'hỗ trợ'} ${gate.touches} lần chạm)`
        : `Giá ${isLong ? 'vượt' : 'mất'} mốc ${entry.toFixed(6)} (không có mức cấu trúc gần)`,
      entry,
      stopLoss: sl.price,
      stopFrom: sl.from,
      riskPercent: (r / entry) * 100,
      targets,
      structureTargets: ahead,
      // Tường lệnh phía trước là lực cản thật cần biết trước khi đặt TP.
      wallAhead: wallAhead
        ? `Tường ${wallAhead.side === 'ask' ? 'BÁN' : 'MUA'} ${wallAhead.price} `
          + `(${wallAhead.ratioToAvg.toFixed(1)}× TB) chắn trước — cân nhắc chốt sớm hơn`
        : null,
      invalidation: `Mất hiệu lực nếu nến đóng ${isLong ? 'dưới' : 'trên'} ${sl.price.toFixed(6)}`,
      // R:R tới mục tiêu cấu trúc gần nhất (mức S/R thật), không phải tới TP1.
      rrToStructure: rrToStructure != null ? Number(rrToStructure.toFixed(2)) : null,
      structureTargetLabel: firstStruct
        ? `${firstStruct.price} (${firstStruct.touches} lần chạm)` : null,
    };
  };

  const up = build(true);
  const down = build(false);
  const score = snapshot.combined.score;

  return {
    price,
    // Kịch bản nào đang được số liệu ủng hộ hơn — theo dấu điểm tổng hợp.
    // Đây là thứ tự ưu tiên suy từ điểm, KHÔNG phải xác suất thống kê.
    primary: score > 0 ? 'long' : score < 0 ? 'short' : 'none',
    primaryBasis: `điểm tổng hợp ${score > 0 ? '+' : ''}${score}`,
    up,
    down,
  };
}

/** Văn bản thuần, dùng cho CLI và Telegram. */
export function formatSetup(setup, fmtNum) {
  const L = [];
  if (setup.blocked) {
    L.push('⛔ ĐỨNG NGOÀI — bối cảnh phủ quyết');
    for (const b of setup.blockers) L.push(`   · ${b}`);
    return L.join('\n');
  }
  if (setup.side === 'none') {
    L.push(`⚪ ĐỨNG NGOÀI — ${setup.note}`);
  } else {
    L.push(`${setup.side === 'long' ? '🟢 LONG' : '🔴 SHORT'} · ${setup.signal} (${setup.score}/100)`);
    L.push(`Entry ${fmtNum(setup.entry)}   SL ${fmtNum(setup.stopLoss)} (−${setup.riskPercent}%)`);
    if (setup.targets.length) {
      L.push(`TP: ${setup.targets.map((t) => `${t.label} ${fmtNum(t.price)}`).join('  ·  ')}`
        + (setup.rrToTp1 ? `   R:R tới TP1 ≈ ${setup.rrToTp1}` : ''));
    }
  }
  if (setup.reasons.length) {
    L.push('');
    L.push('✅ TẠI SAO VÀO LỆNH');
    for (const r of setup.reasons) L.push(`   · [${r.group}] ${r.text}`);
  }
  if (setup.cautions.length) {
    L.push('');
    L.push('⚠️ CẦN LƯU Ý');
    for (const c of setup.cautions) L.push(`   · ${c.text}`);
  }
  return L.join('\n');
}
