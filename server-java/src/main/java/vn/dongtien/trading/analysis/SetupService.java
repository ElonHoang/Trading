package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.DoubleFunction;

/**
 * Turns a technical analysis snapshot plus optional fundamental context into an
 * actionable setup, limit plan, or conditional projection.  Context is never
 * added to the technical score: it can only confirm or veto the result.
 */
@Service
public class SetupService {
    private static final Map<String, String> GROUP_LABELS = Map.of(
            "cvd", "CVD",
            "volume", "Khối lượng",
            "derivatives", "OI + funding",
            "positioning", "Định vị đám đông",
            "structure", "Hỗ trợ/kháng cự",
            "orderBook", "Sổ lệnh",
            "historicalPattern", "Mẫu hình lịch sử");

    public Map<String, Object> buildSetup(Map<String, ?> snapshot) {
        return buildSetup(snapshot, null, SetupOptions.defaults());
    }

    public Map<String, Object> buildSetup(Map<String, ?> snapshot, Map<String, ?> context) {
        return buildSetup(snapshot, context, SetupOptions.defaults());
    }

    public Map<String, Object> buildSetup(Map<String, ?> snapshot, Map<String, ?> context, Map<String, ?> options) {
        Map<String, ?> values = options == null ? Map.of() : options;
        int maxReasons = (int) number(values.get("maxReasons"), 5);
        Double consensusPercent = numberOrNull(values.get("consensusPercent"));
        return buildSetup(snapshot, context, new SetupOptions(maxReasons, consensusPercent));
    }

    public Map<String, Object> buildSetup(Map<String, ?> snapshot, Map<String, ?> context, SetupOptions options) {
        if (snapshot == null) throw new IllegalArgumentException("Thiếu snapshot phân tích");
        SetupOptions effective = options == null ? SetupOptions.defaults() : options;
        Map<String, Object> combined = map(snapshot.get("combined"));
        Map<String, Object> levels = map(snapshot.get("levels"));
        String side = textOr(combined.get("side"), "none");
        List<String> blockers = new ArrayList<>();
        Map<String, Object> rules = map(snapshot.get("rules"));
        Map<String, Object> consensus = mapOrNull(rules.get("consensus"));

        // The initial Java analysis port called this field "passed" rather than
        // the former JS pair "enabled" / "met".  Accept both shapes so the
        // independently-tested CVD/volume gate remains enforced.
        Map<String, Object> quality = mapOrNull(snapshot.get("entryQuality"));
        boolean qualityEnabled = quality != null && (quality.containsKey("enabled")
                ? bool(quality.get("enabled"), false) : quality.containsKey("passed"));
        boolean qualityMet = quality == null ? true : quality.containsKey("met")
                ? bool(quality.get("met"), true) : bool(quality.get("passed"), true);
        if (!"none".equals(side) && qualityEnabled && !qualityMet) {
            side = "none";
            blockers.addAll(strings(quality.get("reasons")));
        }

        Map<String, Object> consensusGate = null;
        if (effective.consensusPercent() != null && consensus != null && !"none".equals(side)) {
            double actual = number(consensus.get("percent"), 0);
            boolean met = actual >= effective.consensusPercent();
            consensusGate = new LinkedHashMap<>();
            consensusGate.put("required", effective.consensusPercent());
            consensusGate.put("actual", consensus.get("percent"));
            consensusGate.put("agree", consensus.get("agree"));
            consensusGate.put("activeGroups", consensus.get("activeGroups"));
            consensusGate.put("met", met);
            if (!met) {
                side = "none";
                blockers.add("Chỉ " + textOr(consensus.get("agree"), "null") + "/"
                        + textOr(consensus.get("activeGroups"), "null") + " nhóm đồng thuận ("
                        + fixed(actual, 0) + "%), cần ≥ " + jsNumber(effective.consensusPercent()) + "%");
            }
        }

        if (context != null) {
            if ("long".equals(side) && bool(context.get("blockLong"), false)) {
                blockers.addAll(criticalWarnings(context));
            }
            if ("short".equals(side) && bool(context.get("blockShort"), false)) {
                blockers.addAll(criticalWarnings(context));
            }
        }

        boolean vetoed = context != null && blockers.stream().anyMatch(value -> !value.startsWith("Chỉ "));
        boolean blocked = !blockers.isEmpty();
        String finalSide = blocked ? "none" : side;
        List<Map<String, Object>> reasons = finalSide.equals("none")
                ? new ArrayList<>() : reasons(snapshot, context, finalSide, effective.maxReasons());

        List<Map<String, Object>> cautions = new ArrayList<>();
        for (String conflict : strings(snapshot.get("conflicts"))) {
            cautions.add(textEntry("Kĩ năng 1", conflict));
        }
        if (context != null) {
            for (Map<String, Object> warning : maps(context.get("warnings"))) {
                if (!"warn".equals(warning.get("severity"))) continue;
                Map<String, Object> caution = textEntry("Kĩ năng 2", textOrEmpty(warning.get("text")));
                caution.put("severity", warning.get("severity"));
                cautions.add(caution);
            }
        }
        List<String> notes = new ArrayList<>();
        if (context != null) {
            for (Map<String, Object> warning : maps(context.get("warnings"))) {
                if ("info".equals(warning.get("severity"))) notes.add(textOrEmpty(warning.get("text")));
            }
        }

        Map<String, Object> firstStructure = first(maps(levels.get("srTargets")));
        Double entry = numberOrNull(levels.get("entry"));
        Double stopLoss = numberOrNull(levels.get("stopLoss"));
        Double riskAbs = entry != null && stopLoss != null ? Math.abs(entry - stopLoss) : null;
        Double rr = firstStructure != null && riskAbs != null && riskAbs != 0
                ? Math.abs(number(firstStructure.get("price"), 0) - entry) / riskAbs : null;

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("side", finalSide);
        result.put("signal", blocked ? "LIMIT" : combined.get("signal"));
        result.put("score", combined.get("score"));
        result.put("strength", blocked ? "blocked" : combined.get("strength"));
        result.put("blocked", blocked);
        result.put("blockers", blockers);
        result.put("entry", "none".equals(finalSide) ? null : levels.get("entry"));
        result.put("stopLoss", "none".equals(finalSide) ? null : levels.get("stopLoss"));
        result.put("riskPercent", "none".equals(finalSide) ? null : levels.get("riskPercent"));
        result.put("targets", "none".equals(finalSide) ? List.of() : maps(levels.get("targets")));
        result.put("srTargets", "none".equals(finalSide) ? List.of() : maps(levels.get("srTargets")));
        result.put("rrToTp1", "none".equals(finalSide) || rr == null ? null : round(rr, 2));
        result.put("reasons", reasons);
        result.put("cautions", cautions);
        result.put("notes", notes);
        result.put("contextBias", context == null ? null : context.get("bias"));
        result.put("consensus", consensus);
        result.put("consensusGate", consensusGate);
        result.put("vetoed", vetoed);
        result.put("note", vetoed ? "Bối cảnh cơ bản phủ quyết setup kỹ thuật."
                : blocked ? "Chưa đủ số nhóm đồng thuận — chờ thêm xác nhận."
                : "none".equals(finalSide) ? textOr(levels.get("note"), "Không có hướng rõ ràng — chờ tín hiệu.")
                : null);
        return result;
    }

    public Map<String, Object> buildSetup(Map<String, ?> snapshot, Map<String, ?> context, JsonNode options) {
        return buildSetup(snapshot, context, object(options));
    }

    /** Builds true buy/sell limit orders anchored at the nearest usable S/R level. */
    public Map<String, Object> buildLimitPlan(Map<String, ?> snapshot, Map<String, ?> risk) {
        if (snapshot == null) throw new IllegalArgumentException("Thiếu snapshot phân tích");
        Map<String, Object> priceMap = map(snapshot.get("price"));
        double price = requireNumber(priceMap.get("lastClose"), "snapshot.price.lastClose");
        Map<String, Object> structure = map(snapshot.get("structure"));
        Map<String, ?> settings = risk == null ? Map.of() : risk;
        Map<String, Object> limit = map(settings.get("limitOrder"));
        LimitSettings config = new LimitSettings(
                number(limit.get("minDistancePercent"), .5),
                number(limit.get("maxDistancePercent"), 4),
                number(limit.get("zoneWidthR"), .3),
                number(limit.get("maxZoneFractionOfDistance"), .5),
                number(limit.get("fallbackPullbackPercent"), 1.5),
                limit.containsKey("expiryBars") ? limit.get("expiryBars") : 6,
                number(limit.get("minLeanScore"), 10),
                number(settings.get("slPercent"), 2.5),
                numbers(settings.get("takeProfitR"), List.of(1d, 2d, 3d)));
        double score = number(map(snapshot.get("combined")).get("score"), 0);
        String lean = score >= config.minLeanScore() ? "long" : score <= -config.minLeanScore() ? "short" : null;
        List<Map<String, Object>> orders = new ArrayList<>();
        if ("long".equals(lean)) orders.add(limitOrder(true, price, structure, config));
        else if ("short".equals(lean)) orders.add(limitOrder(false, price, structure, config));
        else {
            orders.add(limitOrder(true, price, structure, config));
            orders.add(limitOrder(false, price, structure, config));
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("price", price);
        result.put("lean", lean);
        result.put("leanBasis", "điểm tổng hợp " + signed(score));
        result.put("orders", orders);
        return result;
    }

    public Map<String, Object> buildLimitPlan(Map<String, ?> snapshot, JsonNode risk) {
        return buildLimitPlan(snapshot, object(risk));
    }

    /** Builds conditional long and short breakout scenarios without treating either as a probability. */
    public Map<String, Object> buildProjections(Map<String, ?> snapshot, Map<String, ?> risk) {
        if (snapshot == null) throw new IllegalArgumentException("Thiếu snapshot phân tích");
        double price = requireNumber(map(snapshot.get("price")).get("lastClose"), "snapshot.price.lastClose");
        Map<String, Object> levels = map(snapshot.get("structure"));
        Map<String, ?> settings = risk == null ? Map.of() : risk;
        double slPercent = number(settings.get("slPercent"), 2.5);
        List<Double> takeProfitR = numbers(settings.get("takeProfitR"), List.of(1d, 2d, 3d));
        List<Map<String, Object>> walls = maps(map(snapshot.get("orderBook")).get("walls"));
        Map<String, Object> up = projection(true, price, levels, walls, slPercent, takeProfitR);
        Map<String, Object> down = projection(false, price, levels, walls, slPercent, takeProfitR);
        double score = number(map(snapshot.get("combined")).get("score"), 0);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("price", price);
        result.put("primary", score > 0 ? "long" : score < 0 ? "short" : "none");
        result.put("primaryBasis", "điểm tổng hợp " + signed(score));
        result.put("up", up);
        result.put("down", down);
        return result;
    }

    public Map<String, Object> buildProjections(Map<String, ?> snapshot, JsonNode risk) {
        return buildProjections(snapshot, object(risk));
    }

    /** Plain-text rendering for CLI and Telegram use. */
    public String formatSetup(Map<String, ?> setup, DoubleFunction<String> formatNumber) {
        if (setup == null) throw new IllegalArgumentException("Thiếu setup");
        if (formatNumber == null) throw new IllegalArgumentException("Thiếu hàm định dạng số");
        List<String> lines = new ArrayList<>();
        if (bool(setup.get("blocked"), false)) {
            lines.add("⛔ ĐỨNG NGOÀI — bối cảnh phủ quyết");
            for (String blocker : strings(setup.get("blockers"))) lines.add("   · " + blocker);
            return String.join("\n", lines);
        }
        String side = textOr(setup.get("side"), "none");
        if ("none".equals(side)) {
            lines.add("⚪ ĐỨNG NGOÀI — " + textOr(setup.get("note"), ""));
        } else {
            lines.add(("long".equals(side) ? "🟢 LONG" : "🔴 SHORT") + " · "
                    + textOr(setup.get("signal"), "") + " (" + display(setup.get("score")) + "/100)");
            Double entry = numberOrNull(setup.get("entry"));
            Double stop = numberOrNull(setup.get("stopLoss"));
            lines.add("Entry " + formatNumber.apply(entry == null ? Double.NaN : entry)
                    + "   SL " + formatNumber.apply(stop == null ? Double.NaN : stop)
                    + " (−" + display(setup.get("riskPercent")) + "%)");
            List<Map<String, Object>> targets = maps(setup.get("targets"));
            if (!targets.isEmpty()) {
                List<String> labels = new ArrayList<>();
                for (Map<String, Object> target : targets) {
                    Double targetPrice = numberOrNull(target.get("price"));
                    labels.add(textOr(target.get("label"), "") + " "
                            + formatNumber.apply(targetPrice == null ? Double.NaN : targetPrice));
                }
                Double rr = numberOrNull(setup.get("rrToTp1"));
                lines.add("TP: " + String.join("  ·  ", labels)
                        + (rr != null && rr != 0 ? "   R:R tới TP1 ≈ " + display(rr) : ""));
            }
        }
        List<Map<String, Object>> reasons = maps(setup.get("reasons"));
        if (!reasons.isEmpty()) {
            lines.add("");
            lines.add("✅ TẠI SAO VÀO LỆNH");
            for (Map<String, Object> reason : reasons) {
                lines.add("   · [" + textOr(reason.get("group"), "") + "] " + textOr(reason.get("text"), ""));
            }
        }
        List<Map<String, Object>> cautions = maps(setup.get("cautions"));
        if (!cautions.isEmpty()) {
            lines.add("");
            lines.add("⚠️ CẦN LƯU Ý");
            for (Map<String, Object> caution : cautions) lines.add("   · " + textOr(caution.get("text"), ""));
        }
        return String.join("\n", lines);
    }

    private List<Map<String, Object>> reasons(Map<String, ?> snapshot, Map<String, ?> context,
                                               String side, int maxReasons) {
        int wanted = "long".equals(side) ? 1 : -1;
        Map<String, Object> rules = map(snapshot.get("rules"));
        Map<String, Object> breakdown = map(rules.get("breakdown"));
        List<Group> groups = new ArrayList<>();
        for (Map.Entry<String, Object> entry : breakdown.entrySet()) {
            Map<String, Object> group = mapOrNull(entry.getValue());
            if (group == null || number(group.get("weight"), 0) <= 0 || bool(group.get("skipped"), false)) continue;
            double contribution = number(group.get("contributionPct"), 0);
            if (sign(contribution) == wanted) groups.add(new Group(entry.getKey(), group, contribution));
        }
        groups.sort(Comparator.comparingDouble((Group group) -> Math.abs(group.contribution())).reversed());

        List<Map<String, Object>> result = new ArrayList<>();
        for (Group group : groups) {
            String reason = keyReason(group.value());
            if (reason == null) continue;
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("source", "Kĩ năng 1");
            entry.put("group", GROUP_LABELS.getOrDefault(group.key(), group.key()));
            entry.put("weight", group.value().get("weight"));
            entry.put("contribution", group.value().get("contributionPct"));
            entry.put("text", reason);
            result.add(entry);
            // Deliberately test after adding: this preserves the JS behavior for
            // an explicit maxReasons of zero.
            if (result.size() >= maxReasons) break;
        }

        Map<String, Object> higherTimeframe = mapOrNull(snapshot.get("higherTimeframe"));
        Double htfScore = higherTimeframe == null ? null : numberOrNull(higherTimeframe.get("ruleScore"));
        if (htfScore != null && sign(htfScore) == wanted && Math.abs(htfScore) > 10) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("source", "Kĩ năng 1");
            entry.put("group", "Khung " + textOr(higherTimeframe.get("interval"), "null"));
            entry.put("text", "Khung lớn " + textOr(higherTimeframe.get("interval"), "null")
                    + " cùng hướng (" + signed(htfScore) + ")");
            result.add(entry);
        }

        Map<String, Object> ml = mapOrNull(snapshot.get("ml"));
        Map<String, Object> combined = map(snapshot.get("combined"));
        if (ml != null && bool(ml.get("available"), false) && number(combined.get("mlWeightUsed"), 0) > 0) {
            String mlSide = number(ml.get("probUp"), 0) > .5 ? "long" : "short";
            if (side.equals(mlSide)) {
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("source", "Model ML");
                entry.put("group", "ML");
                entry.put("text", "Model cho " + textOr(ml.get("probUpPercent"), "null")
                        + "% khả năng tăng (độ tin cậy " + textOr(ml.get("reliability"), "null") + ")");
                result.add(entry);
            }
        }
        if (context != null) {
            for (String support : strings(context.get("supports"))) {
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("source", "Kĩ năng 2");
                entry.put("group", "Bối cảnh");
                entry.put("text", support);
                result.add(entry);
            }
        }
        return result;
    }

    private Map<String, Object> limitOrder(boolean longSide, double price, Map<String, Object> structure,
                                            LimitSettings config) {
        List<Map<String, Object>> levels = maps(structure.get(longSide ? "support" : "resistance"));
        Map<String, Object> level = null;
        for (Map<String, Object> candidate : levels) {
            Double candidatePrice = numberOrNull(candidate.get("price"));
            if (candidatePrice == null || (longSide ? candidatePrice >= price : candidatePrice <= price)) continue;
            double distance = Math.abs(price - candidatePrice) / price * 100;
            if (distance >= config.minDistancePercent() && distance <= config.maxDistancePercent()) {
                level = candidate;
                break;
            }
        }
        double anchor = level == null ? price * (longSide ? 1 - config.fallbackPullbackPercent() / 100
                : 1 + config.fallbackPullbackPercent() / 100) : requireNumber(level.get("price"), "structure.price");
        double entry = anchor;
        double baseRisk = entry * config.slPercent() / 100;
        double gap = Math.abs(price - anchor);
        double width = Math.min(baseRisk * config.zoneWidthR(), gap * config.maxZoneFractionOfDistance());
        Map<String, Object> zone = new LinkedHashMap<>();
        zone.put("low", longSide ? anchor : anchor - width);
        zone.put("high", longSide ? anchor + width : anchor);
        double stopLoss = longSide ? entry - baseRisk : entry + baseRisk;
        double risk = Math.abs(entry - stopLoss);
        List<Map<String, Object>> targets = targets(entry, risk, longSide, config.takeProfitR());
        List<Map<String, Object>> ahead = ahead(longSide, structure, entry);
        Map<String, Object> firstStructure = first(ahead);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("direction", longSide ? "long" : "short");
        result.put("label", longSide ? "Mua chờ (buy limit)" : "Bán chờ (sell limit)");
        result.put("anchor", anchor);
        result.put("fromStructure", level != null);
        result.put("anchorTouches", level == null ? null : level.get("touches"));
        result.put("basis", level != null
                ? (longSide ? "hỗ trợ " : "kháng cự ") + jsNumber(requireNumber(level.get("price"), "structure.price"))
                + " (" + textOr(level.get("touches"), "null") + " lần chạm)"
                : "lùi " + vi(config.fallbackPullbackPercent()) + "% từ giá — không có mức cấu trúc nào trong "
                + vi(config.minDistancePercent()) + "–" + vi(config.maxDistancePercent()) + "%");
        result.put("zone", zone);
        result.put("entry", entry);
        result.put("distancePercent", (entry - price) / price * 100);
        result.put("stopLoss", stopLoss);
        result.put("riskPerUnit", risk);
        result.put("riskPercent", risk / entry * 100);
        result.put("targets", targets);
        result.put("structureTargets", ahead);
        result.put("rrToStructure", firstStructure != null && risk > 0
                ? round(Math.abs(requireNumber(firstStructure.get("price"), "structureTarget.price") - entry) / risk, 2) : null);
        result.put("structureTargetLabel", firstStructure == null ? null
                : jsNumber(requireNumber(firstStructure.get("price"), "structureTarget.price"))
                + " (" + textOr(firstStructure.get("touches"), "null") + " lần chạm)");
        result.put("expiryBars", config.expiryBars());
        return result;
    }

    private Map<String, Object> projection(boolean longSide, double price, Map<String, Object> levels,
                                           List<Map<String, Object>> walls, double slPercent, List<Double> takeProfitR) {
        Map<String, Object> gate = first(maps(levels.get(longSide ? "resistance" : "support")));
        double entry = gate == null ? price * (longSide ? 1.01 : .99) : requireNumber(gate.get("price"), "structure.price");
        Stop stop = stopFor(entry, longSide, levels, slPercent);
        double risk = Math.abs(entry - stop.price());
        List<Map<String, Object>> targets = targets(entry, risk, longSide, takeProfitR);
        List<Map<String, Object>> ahead = ahead(longSide, levels, entry);
        double lastTp = targets.isEmpty() ? entry : requireNumber(targets.get(targets.size() - 1).get("price"), "target.price");
        Map<String, Object> wall = null;
        for (Map<String, Object> candidate : walls) {
            String candidateSide = textOr(candidate.get("side"), "");
            Double candidatePrice = numberOrNull(candidate.get("price"));
            if (candidatePrice == null || (longSide ? !"ask".equals(candidateSide) : !"bid".equals(candidateSide))) continue;
            if (longSide ? candidatePrice > entry && candidatePrice <= lastTp : candidatePrice < entry && candidatePrice >= lastTp) {
                wall = candidate;
                break;
            }
        }
        Map<String, Object> firstStructure = first(ahead);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("direction", longSide ? "long" : "short");
        result.put("label", longSide ? "Thế giá lên" : "Thế giá xuống");
        result.put("trigger", gate != null
                ? "Nến đóng " + (longSide ? "trên " : "dưới ") + jsNumber(entry) + " ("
                + (longSide ? "kháng cự " : "hỗ trợ ") + textOr(gate.get("touches"), "null") + " lần chạm)"
                : "Giá " + (longSide ? "vượt" : "mất") + " mốc " + fixed(entry, 6) + " (không có mức cấu trúc gần)");
        result.put("entry", entry);
        result.put("stopLoss", stop.price());
        result.put("stopFrom", stop.from());
        result.put("riskPercent", risk / entry * 100);
        result.put("targets", targets);
        result.put("structureTargets", ahead);
        result.put("wallAhead", wall == null ? null
                : "Tường " + ("ask".equals(wall.get("side")) ? "BÁN " : "MUA ")
                + jsNumber(requireNumber(wall.get("price"), "wall.price")) + " ("
                + fixed(number(wall.get("ratioToAvg"), 0), 1) + "× TB) chắn trước — cân nhắc chốt sớm hơn");
        result.put("invalidation", "Mất hiệu lực nếu nến đóng " + (longSide ? "dưới " : "trên ") + fixed(stop.price(), 6));
        result.put("rrToStructure", firstStructure != null && risk > 0
                ? round(Math.abs(requireNumber(firstStructure.get("price"), "structureTarget.price") - entry) / risk, 2) : null);
        result.put("structureTargetLabel", firstStructure == null ? null
                : jsNumber(requireNumber(firstStructure.get("price"), "structureTarget.price"))
                + " (" + textOr(firstStructure.get("touches"), "null") + " lần chạm)");
        return result;
    }

    private static Stop stopFor(double entry, boolean longSide, Map<String, Object> levels, double slPercent) {
        double baseRisk = entry * slPercent / 100;
        double fallback = longSide ? entry - baseRisk : entry + baseRisk;
        List<Map<String, Object>> candidates = maps(levels.get(longSide ? "support" : "resistance"));
        Map<String, Object> level = null;
        for (Map<String, Object> candidate : candidates) {
            Double price = numberOrNull(candidate.get("price"));
            if (price != null && (longSide ? price < entry : price > entry)) {
                level = candidate;
                break;
            }
        }
        if (level == null) return new Stop(fallback, jsNumber(slPercent) + "% giá");
        double buffer = baseRisk * .3;
        double candidate = requireNumber(level.get("price"), "structure.price") + (longSide ? -buffer : buffer);
        double distance = Math.abs(entry - candidate);
        if (distance > baseRisk * .4 && distance < baseRisk * 2.5) {
            return new Stop(candidate, "ngoài " + (longSide ? "hỗ trợ " : "kháng cự ")
                    + jsNumber(requireNumber(level.get("price"), "structure.price")) + " ("
                    + textOr(level.get("touches"), "null") + " lần chạm)");
        }
        return new Stop(fallback, jsNumber(slPercent) + "% giá (mức cấu trúc quá "
                + (distance <= baseRisk * .4 ? "gần" : "xa") + ")");
    }

    private static List<Map<String, Object>> targets(double entry, double risk, boolean longSide, List<Double> multipliers) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (int i = 0; i < multipliers.size(); i++) {
            double multiple = multipliers.get(i);
            Map<String, Object> target = new LinkedHashMap<>();
            target.put("label", "TP" + (i + 1));
            target.put("r", multiple);
            target.put("price", longSide ? entry + risk * multiple : entry - risk * multiple);
            result.add(target);
        }
        return result;
    }

    private static List<Map<String, Object>> ahead(boolean longSide, Map<String, Object> structure, double entry) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (Map<String, Object> level : maps(structure.get(longSide ? "resistance" : "support"))) {
            Double price = numberOrNull(level.get("price"));
            if (price == null || (longSide ? price <= entry : price >= entry)) continue;
            Map<String, Object> copy = new LinkedHashMap<>();
            copy.put("price", level.get("price"));
            copy.put("touches", level.get("touches"));
            copy.put("distancePct", level.get("distancePct"));
            result.add(copy);
            if (result.size() == 3) break;
        }
        return result;
    }

    private static String keyReason(Map<String, Object> group) {
        List<String> reasons = strings(group.get("reasons"));
        for (String reason : reasons) if (reason.contains("→")) return reason;
        return reasons.isEmpty() ? null : reasons.get(0);
    }

    private static List<String> criticalWarnings(Map<String, ?> context) {
        List<String> result = new ArrayList<>();
        for (Map<String, Object> warning : maps(context.get("warnings"))) {
            if ("critical".equals(warning.get("severity"))) result.add(textOrEmpty(warning.get("text")));
        }
        return result;
    }

    private static Map<String, Object> textEntry(String source, String text) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("source", source);
        result.put("text", text);
        return result;
    }

    private static List<Double> numbers(Object value, List<Double> fallback) {
        if (value == null) return fallback;
        if (!(value instanceof List<?> raw)) return fallback;
        List<Double> result = new ArrayList<>();
        for (Object item : raw) {
            Double number = numberOrNull(item);
            if (number != null) result.add(number);
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return value instanceof Map<?, ?> raw ? (Map<String, Object>) raw : Map.of();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> mapOrNull(Object value) {
        return value instanceof Map<?, ?> raw ? (Map<String, Object>) raw : null;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> maps(Object value) {
        if (!(value instanceof List<?> raw)) return List.of();
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : raw) if (item instanceof Map<?, ?> map) result.add((Map<String, Object>) map);
        return result;
    }

    private static Map<String, Object> first(List<Map<String, Object>> values) {
        return values.isEmpty() ? null : values.get(0);
    }

    private static List<String> strings(Object value) {
        if (!(value instanceof List<?> raw)) return List.of();
        List<String> result = new ArrayList<>();
        for (Object item : raw) if (item != null) result.add(String.valueOf(item));
        return result;
    }

    private static boolean bool(Object value, boolean fallback) {
        if (value instanceof Boolean bool) return bool;
        if (value instanceof String text) return Boolean.parseBoolean(text);
        return fallback;
    }

    private static Double numberOrNull(Object value) {
        if (value instanceof Number number) return number.doubleValue();
        if (value instanceof String text) {
            try {
                return Double.parseDouble(text);
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private static double number(Object value, double fallback) {
        Double parsed = numberOrNull(value);
        return parsed == null ? fallback : parsed;
    }

    private static double requireNumber(Object value, String name) {
        Double parsed = numberOrNull(value);
        if (parsed == null) throw new IllegalArgumentException("Thiếu số " + name);
        return parsed;
    }

    private static String textOr(Object value, String fallback) {
        return value == null ? fallback : String.valueOf(value);
    }

    private static String display(Object value) {
        return value instanceof Number number ? jsNumber(number.doubleValue()) : textOr(value, "");
    }

    private static String textOrEmpty(Object value) {
        return textOr(value, "");
    }

    private static int sign(double value) {
        return value > 0 ? 1 : value < 0 ? -1 : 0;
    }

    private static Double round(double value, int places) {
        double scale = Math.pow(10, places);
        return Math.round(value * scale) / scale;
    }

    private static String fixed(double value, int places) {
        return String.format(Locale.ROOT, "%." + places + "f", value);
    }

    private static String signed(double value) {
        return (value > 0 ? "+" : "") + jsNumber(value);
    }

    private static String jsNumber(double value) {
        if (Double.isFinite(value) && Math.rint(value) == value) return Long.toString((long) value);
        return Double.toString(value);
    }

    private static String vi(double value) {
        return jsNumber(value).replace('.', ',');
    }

    private static Map<String, Object> object(JsonNode node) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (node == null || !node.isObject()) return result;
        node.properties().forEach(entry -> result.put(entry.getKey(), value(entry.getValue())));
        return result;
    }

    private static Object value(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) return null;
        if (node.isObject()) return object(node);
        if (node.isArray()) {
            List<Object> result = new ArrayList<>();
            for (JsonNode child : node) result.add(value(child));
            return result;
        }
        if (node.isBoolean()) return node.asBoolean();
        if (node.isIntegralNumber()) return node.asLong();
        if (node.isNumber()) return node.asDouble();
        return node.asText();
    }

    public record SetupOptions(int maxReasons, Double consensusPercent) {
        public static SetupOptions defaults() { return new SetupOptions(5, null); }
    }

    private record Group(String key, Map<String, Object> value, double contribution) {}
    private record Stop(double price, String from) {}
    private record LimitSettings(double minDistancePercent, double maxDistancePercent, double zoneWidthR,
                                 double maxZoneFractionOfDistance, double fallbackPullbackPercent, Object expiryBars,
                                 double minLeanScore, double slPercent, List<Double> takeProfitR) {}
}
