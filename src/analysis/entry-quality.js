// Cổng chất lượng trước khi cho phép vào lệnh. Dùng được ở browser và Node.
// Chỉ dựa vào CVD + volume của nến đã đóng hiện tại, không dùng dữ liệu tương lai.

export function evaluateEntryQuality({ side, cvdSlope, volumeRatio }, cfg = {}) {
  const enabled = cfg.enabled === true;
  if (!enabled || side === 'none') {
    return { enabled, met: true, reasons: [] };
  }

  const minAbsCvdSlope = Math.max(0, Number(cfg.minAbsCvdSlope ?? 0.03));
  const minVolumeRatio = Math.max(0, Number(cfg.minVolumeRatio ?? 1));
  const expectedCvdDirection = side === 'long' ? 1 : -1;
  const cvdMet = Number.isFinite(cvdSlope)
    && (cvdSlope * expectedCvdDirection) >= minAbsCvdSlope;
  const volumeMet = Number.isFinite(volumeRatio) && volumeRatio >= minVolumeRatio;
  const reasons = [];
  if (!cvdMet) {
    reasons.push(`CVD chưa đủ mạnh/cùng hướng (cần độ dốc ≥ ${(minAbsCvdSlope * 100).toFixed(1)}%)`);
  }
  if (!volumeMet) {
    reasons.push(`Volume chưa đạt ${minVolumeRatio.toFixed(1)}x trung bình`);
  }
  return {
    enabled,
    met: cvdMet && volumeMet,
    minAbsCvdSlope,
    minVolumeRatio,
    cvdMet,
    volumeMet,
    reasons,
  };
}
