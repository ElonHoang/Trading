package vn.dongtien.trading.analysis;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.auth.DocumentStore;

import java.time.Instant;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Writes a compact, durable learning record for each daily review. */
@Service
public class LearningLogService {
    private static final Pattern DAY_LABEL = Pattern.compile("^NGÀY\\s+(\\d{2})/(\\d{2})/(\\d{4})$");

    private final DocumentStore documents;
    private final ObjectMapper mapper;

    public LearningLogService(DocumentStore documents, ObjectMapper mapper) {
        this.documents = documents;
        this.mapper = mapper;
    }

    /** Keeps only fields that are useful for comparing losses across days. */
    public ObjectNode compactLoss(PostMortemService.Replay row) {
        ObjectNode out = mapper.createObjectNode();
        if (row == null) return out;
        putNullable(out, "tradeId", row.tradeId());
        putNullable(out, "symbol", row.symbol());
        putNullable(out, "interval", row.interval());
        putNullable(out, "side", row.side());
        putNullable(out, "cause", row.kind() == null ? null : row.kind().value());
        putNullable(out, "reason", row.reason());
        putNullable(out, "barsToSl", row.barsToSl());
        putNullable(out, "barsAfterSl", row.barsAfterSl());
        putNullable(out, "mfeBeforeSlR", row.mfeBeforeSlR());
        putNullable(out, "maxAdverseR", row.maxAdverseR());
        putNullable(out, "slPercent", row.slPercent());
        putNullable(out, "neededSlPercent", row.neededSlPercent());
        putNullable(out, "reachedTp1After", row.reachedTp1After());
        putNullable(out, "barsToTp1AfterSl", row.barsToTp1AfterSl());
        putNullable(out, "reachedTp1Soon", row.reachedTp1Soon());
        putNullable(out, "widerStopSaves", row.widerStopSaves());
        putNode(out, "entryEvidence", row.evidence());
        return out;
    }

    public ObjectNode compactLoss(JsonNode row) {
        ObjectNode out = mapper.createObjectNode();
        String[] fields = {"tradeId", "symbol", "interval", "side", "reason", "barsToSl", "barsAfterSl",
                "mfeBeforeSlR", "maxAdverseR", "slPercent", "neededSlPercent", "reachedTp1After",
                "barsToTp1AfterSl", "reachedTp1Soon", "widerStopSaves"};
        for (String field : fields) putNode(out, field, row == null ? null : row.get(field));
        putNode(out, "cause", row == null ? null : row.get("kind"));
        if (out.path("cause").isNull()) putNode(out, "cause", row == null ? null : row.get("cause"));
        putNode(out, "entryEvidence", row == null ? null : row.get("evidence"));
        if (out.path("entryEvidence").isNull()) putNode(out, "entryEvidence", row == null ? null : row.get("entryEvidence"));
        return out;
    }

    /**
     * Converts the verbose daily-review result into the stable schema used by
     * the learning log.  Unknown fields are intentionally not copied: this
     * record is a long-lived data contract rather than an opaque dump.
     */
    public ObjectNode buildLearningRecord(JsonNode report, JsonNode strategy, JsonNode activeTuning, Instant generatedAt) {
        JsonNode safeReport = report != null && report.isObject() ? report : mapper.createObjectNode();
        JsonNode safeStrategy = strategy != null && strategy.isObject() ? strategy : mapper.createObjectNode();
        ObjectNode out = mapper.createObjectNode();
        out.put("schemaVersion", 1);
        out.put("generatedAt", (generatedAt == null ? Instant.now() : generatedAt).toString());

        ObjectNode review = out.putObject("review");
        putNode(review, "status", safeReport.get("status"));
        putNode(review, "window", safeReport.get("window"));
        putNode(review, "summary", safeReport.get("summary"));
        putNode(review, "comparison", safeReport.get("comparison"));
        putNode(review, "market", safeReport.get("market"));

        JsonNode postMortem = safeReport.get("postMortem");
        if (postMortem == null || !postMortem.isObject()) out.putNull("lossAnalysis");
        else {
            ObjectNode loss = out.putObject("lossAnalysis");
            putNodeOrNumber(loss, "total", postMortem.get("total"), 0);
            putNodeOrNumber(loss, "decided", postMortem.get("decided"), 0);
            if (postMortem.get("counts") == null) loss.set("counts", mapper.createObjectNode());
            else loss.set("counts", postMortem.get("counts"));
            putNode(loss, "verdict", postMortem.get("verdict"));
            putNode(loss, "sweptSharePercent", postMortem.get("sweptSharePercent"));
            putNode(loss, "wrongWaySharePercent", postMortem.get("wrongWaySharePercent"));
            putNode(loss, "reversedSharePercent", postMortem.get("reversedSharePercent"));
            putNode(loss, "medianSlPercent", postMortem.get("medianSlPercent"));
            putNode(loss, "medianNeededSlPercent", postMortem.get("medianNeededSlPercent"));
            ArrayNode trades = loss.putArray("trades");
            if (postMortem.path("rows").isArray()) for (JsonNode row : postMortem.path("rows")) trades.add(compactLoss(row));
            putNode(loss, "error", postMortem.get("error"));
        }

        ArrayNode candidates = out.putArray("candidates");
        if (safeReport.path("candidates").isArray()) for (JsonNode candidate : safeReport.path("candidates")) {
            ObjectNode value = candidates.addObject();
            putNode(value, "id", candidate.get("id"));
            putNode(value, "label", candidate.get("label"));
            putNode(value, "changes", candidate.get("changes"));
            putNode(value, "because", candidate.get("because"));
            putNode(value, "improves", candidate.get("improves"));
            putNode(value, "guardOk", candidate.get("guardOk"));
            putNode(value, "passes", candidate.get("passes"));
            putNode(value, "holdout", candidate.get("holdout"));
            putNode(value, "guardHoldout", candidate.get("guardHoldout"));
            putNode(value, "byPair", candidate.get("byPair"));
        }

        ObjectNode decision = out.putObject("decision");
        putNode(decision, "selected", safeReport.get("selected"));
        putNode(decision, "activeTuning", activeTuning);
        putNode(decision, "cooldownUntil", safeReport.get("nextTuneAt"));

        ObjectNode effective = out.putObject("effectiveStrategy");
        putNode(effective, "entryQuality", safeStrategy.get("entryQuality"));
        putNode(effective, "risk", safeStrategy.get("risk"));
        ObjectNode alerts = effective.putObject("alerts");
        putNode(alerts, "minAbsScore", safeStrategy.path("alerts").get("minAbsScore"));
        ObjectNode thresholds = effective.putObject("thresholds");
        putNode(thresholds, "buy", safeStrategy.path("thresholds").get("buy"));
        putNode(thresholds, "sell", safeStrategy.path("thresholds").get("sell"));
        putNode(thresholds, "consensusPercent", safeStrategy.path("thresholds").get("consensusPercent"));
        return out;
    }

    public ObjectNode buildLearningRecord(JsonNode report, JsonNode strategy, JsonNode activeTuning) {
        return buildLearningRecord(report, strategy, activeTuning, Instant.now());
    }

    public WriteResult writeLearningLog(JsonNode report, JsonNode strategy, JsonNode activeTuning, String text) {
        ObjectNode record = buildLearningRecord(report, strategy, activeTuning, Instant.now());
        String date = dateFor(report, record.path("generatedAt").asText());
        String key = "learning:loss:" + date;
        ObjectNode persisted = mapper.createObjectNode();
        persisted.set("record", record);
        persisted.put("text", text == null ? "" : text.trim());
        documents.put(key, persisted);
        return new WriteResult("database:" + key, "database:" + key, record);
    }

    private String dateFor(JsonNode report, String fallback) {
        String label = report == null ? "" : report.path("window").path("label").asText("");
        Matcher match = DAY_LABEL.matcher(label);
        if (match.matches()) return match.group(3) + "-" + match.group(2) + "-" + match.group(1);
        String since = report == null ? "" : report.path("window").path("since").asText("");
        String value = since.isBlank() ? fallback : since;
        return value.length() >= 10 ? value.substring(0, 10) : Instant.now().toString().substring(0, 10);
    }

    private static void putNullable(ObjectNode target, String field, Object value) {
        if (value == null) { target.putNull(field); return; }
        if (value instanceof String text) target.put(field, text);
        else if (value instanceof Integer number) target.put(field, number);
        else if (value instanceof Long number) target.put(field, number);
        else if (value instanceof Double number) target.put(field, number);
        else if (value instanceof Boolean bool) target.put(field, bool);
        else if (value instanceof JsonNode node) target.set(field, node);
        else target.put(field, value.toString());
    }
    private static void putNode(ObjectNode target, String field, JsonNode value) {
        if (value == null || value.isMissingNode()) target.putNull(field); else target.set(field, value);
    }
    private static void putNodeOrNumber(ObjectNode target, String field, JsonNode value, int fallback) {
        if (value == null || value.isMissingNode() || value.isNull()) target.put(field, fallback); else target.set(field, value);
    }

    public record WriteResult(String jsonFile, String textFile, JsonNode record) {}
}
