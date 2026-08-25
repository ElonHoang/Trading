package vn.dongtien.trading.telegram;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;
import vn.dongtien.auth.DocumentStore;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Persists approved Telegram imports separately from bot-owned learning state. */
@Service
public class TelegramHistoryImportService {
    public static final String STATE_KEY = "data:telegram-imported-trades";

    private final DocumentStore documents;
    private final ObjectMapper mapper;
    private final Clock clock;

    @Autowired
    public TelegramHistoryImportService(DocumentStore documents, ObjectMapper mapper) {
        this(documents, mapper, Clock.systemUTC());
    }

    TelegramHistoryImportService(DocumentStore documents, ObjectMapper mapper, Clock clock) {
        this.documents = documents;
        this.mapper = mapper;
        this.clock = clock;
    }

    public ImportResult store(TelegramCallHistoryParser.ParseResult parsed, boolean apply) {
        List<TelegramCallHistoryParser.ImportedTrade> candidates = parsed == null ? List.of() : parsed.trades();
        ObjectNode state = documentCopy();
        ArrayNode existing = ensureTrades(state);
        Set<String> ids = new LinkedHashSet<>();
        for (JsonNode row : existing) {
            String id = row.path("id").asText("");
            if (!id.isBlank()) ids.add(id);
        }

        int newRecords = 0;
        for (TelegramCallHistoryParser.ImportedTrade trade : candidates) {
            if (trade == null || !ids.add(trade.id())) continue;
            existing.add(toJson(trade));
            newRecords++;
        }
        state.put("updatedAt", Instant.now(clock).toString());
        state.put("source", "telegram-import");
        if (apply && newRecords > 0) documents.put(STATE_KEY, state);

        return new ImportResult(candidates.size(), newRecords, candidates.size() - newRecords,
                parsed == null ? 0 : parsed.recognisedOpenCalls(), parsed == null ? 0 : parsed.skippedClosures(),
                parsed == null ? 0 : parsed.scannedMessages(), apply, apply && newRecords > 0);
    }

    private ObjectNode documentCopy() {
        JsonNode saved = documents.find(STATE_KEY).orElse(null);
        if (saved instanceof ObjectNode object) return object.deepCopy();
        return mapper.createObjectNode();
    }

    private ArrayNode ensureTrades(ObjectNode state) {
        if (state.path("trades").isArray()) return (ArrayNode) state.path("trades");
        return state.putArray("trades");
    }

    private ObjectNode toJson(TelegramCallHistoryParser.ImportedTrade trade) {
        ObjectNode row = mapper.createObjectNode();
        row.put("id", trade.id());
        row.put("source", "telegram-import");
        row.put("chatId", trade.chatId());
        row.put("messageId", trade.messageId());
        row.put("symbol", trade.symbol());
        row.put("interval", trade.interval());
        row.put("side", trade.side());
        row.put("openedAt", trade.openedAt().toString());
        row.put("closedAt", trade.closedAt().toString());
        row.put("entry", trade.entry());
        row.put("stopLoss", trade.stopLoss());
        ArrayNode targets = row.putArray("targets");
        for (TelegramCallHistoryParser.Target target : trade.targets()) {
            ObjectNode item = targets.addObject();
            item.put("label", target.label());
            item.put("price", target.price());
        }
        ObjectNode result = row.putObject("result");
        result.put("status", trade.status());
        ArrayNode hitTps = result.putArray("hitTps");
        for (String target : trade.hitTps()) hitTps.add(target);
        if (trade.lastPrice() == null) result.putNull("lastPrice");
        else result.put("lastPrice", trade.lastPrice());
        return row;
    }

    public record ImportResult(int parsedTrades, int newRecords, int alreadyPresent, int recognisedOpenCalls,
                               int skippedClosures, int scannedMessages, boolean applyRequested, boolean persisted) {
        public Map<String, Object> asMap() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("parsedTrades", parsedTrades);
            value.put("newRecords", newRecords);
            value.put("alreadyPresent", alreadyPresent);
            value.put("recognisedOpenCalls", recognisedOpenCalls);
            value.put("skippedClosures", skippedClosures);
            value.put("scannedMessages", scannedMessages);
            value.put("applyRequested", applyRequested);
            value.put("persisted", persisted);
            value.put("storage", STATE_KEY);
            value.put("training", "excluded");
            return value;
        }
    }
}
