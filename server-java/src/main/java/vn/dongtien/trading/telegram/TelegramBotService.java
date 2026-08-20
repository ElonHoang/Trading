package vn.dongtien.trading.telegram;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import vn.dongtien.auth.DocumentStore;
import vn.dongtien.trading.analysis.AnalysisService;
import vn.dongtien.trading.analysis.AutoRetuneService;
import vn.dongtien.trading.analysis.ContextService;
import vn.dongtien.trading.analysis.SetupService;
import vn.dongtien.trading.backtest.BacktestService;
import vn.dongtien.trading.chart.AnalysisChartRenderer;
import vn.dongtien.trading.config.ConfigurationMutationService;
import vn.dongtien.trading.config.StrategyService;
import vn.dongtien.trading.config.TradingUniverse;
import vn.dongtien.trading.data.OpenCallService;
import vn.dongtien.trading.data.SubscriberService;
import vn.dongtien.trading.llm.AnthropicService;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.ml.ModelTrainer;
import vn.dongtien.trading.model.ModelStore;
import vn.dongtien.trading.watchlist.WatchlistService;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Java transport for Telegram. All analysis, training, backtesting, charting,
 * lifecycle monitoring and Claude calls are delegated to Java services.
 */
@Service
public class TelegramBotService {
    private static final String DEFAULT_INTERVAL = "4h";
    private static final int SERIES_BARS = 300;
    private static final int MESSAGE_LIMIT = 4_000;

    private final String token;
    private final Set<Long> allowed;
    private final Set<Long> owners;
    private final Set<Long> configuredAlertChats;
    private final ObjectMapper mapper;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
    private final BinanceClient binance;
    private final StrategyService strategies;
    private final ConfigurationMutationService mutations;
    private final TradingUniverse universe;
    private final AnalysisService analysis;
    private final WatchlistService watchlist;
    private final ModelTrainer trainer;
    private final BacktestService backtest;
    private final ModelStore models;
    private final AnthropicService anthropic;
    private final SubscriberService subscribers;
    private final OpenCallService openCalls;
    private final MonitorService monitorService;
    private final AutoRetuneService autoRetune;
    private final ContextService context;
    private final SetupService setups;
    private final AnalysisChartRenderer charts;
    private final ConcurrentMap<Long, Map<String, Object>> lastSnapshots = new ConcurrentHashMap<>();
    private final Set<String> busy = ConcurrentHashMap.newKeySet();
    private volatile MonitorService.Monitor monitor;

    public TelegramBotService(@Value("${dongtien.telegram.token:}") String token,
                              @Value("${dongtien.telegram.allowed-ids:}") String allowedIds,
                              @Value("${dongtien.telegram.owner-ids:}") String ownerIds,
                              @Value("${dongtien.telegram.alert-chat-ids:}") String alertChatIds,
                              ObjectMapper mapper, BinanceClient binance, StrategyService strategies,
                              ConfigurationMutationService mutations, TradingUniverse universe,
                              AnalysisService analysis, WatchlistService watchlist, ModelTrainer trainer,
                              BacktestService backtest, ModelStore models, AnthropicService anthropic,
                              SubscriberService subscribers, OpenCallService openCalls,
                              MonitorService monitorService, AutoRetuneService autoRetune,
                              ContextService context, SetupService setups, AnalysisChartRenderer charts) {
        this.token = token == null ? "" : token.trim();
        this.configuredAlertChats = ids(alertChatIds);
        this.allowed = ids(allowedIds);
        // Alert chats were readable in the former bot as well. Write commands
        // remain separately fail-closed behind TELEGRAM_OWNER_IDS.
        this.allowed.addAll(this.configuredAlertChats);
        this.owners = ids(ownerIds);
        this.mapper = mapper;
        this.binance = binance;
        this.strategies = strategies;
        this.mutations = mutations;
        this.universe = universe;
        this.analysis = analysis;
        this.watchlist = watchlist;
        this.trainer = trainer;
        this.backtest = backtest;
        this.models = models;
        this.anthropic = anthropic;
        this.subscribers = subscribers;
        this.openCalls = openCalls;
        this.monitorService = monitorService;
        this.autoRetune = autoRetune;
        this.context = context;
        this.setups = setups;
        this.charts = charts;
    }

    /** Long polls Telegram and keeps the Java monitor running on its scheduler. */
    public void runForever() {
        requireToken();
        MonitorService.Monitor runningMonitor = ensureMonitor();
        runningMonitor.start(pollSeconds());
        setCommands();
        long offset = 0;
        try {
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    JsonNode updates = get("getUpdates?timeout=45&offset=" + offset);
                    for (JsonNode update : updates.path("result")) {
                        offset = Math.max(offset, update.path("update_id").asLong() + 1);
                        handleUpdate(update);
                    }
                } catch (RuntimeException error) {
                    log("[telegram] polling error: " + message(error));
                    sleep(2_000);
                }
            }
        } finally {
            runningMonitor.stop();
        }
    }

    /** One monitor tick for the alerts-once Java command. */
    public void sendAlertsOnce() {
        requireToken();
        ensureMonitor().tick();
    }

    private void handleUpdate(JsonNode update) {
        JsonNode callback = update.path("callback_query");
        if (callback.isObject()) {
            handleCallback(callback);
            return;
        }
        JsonNode incoming = update.path("message");
        long chatId = incoming.path("chat").path("id").asLong();
        if (chatId == 0) return;
        if (!mayRead(chatId)) {
            safeSend(chatId, "Ban khong co quyen dung bot nay. Telegram ID cua ban: " + chatId);
            return;
        }
        String text = incoming.path("text").asText("").trim();
        if (!text.isEmpty()) handle(chatId, text);
    }

    private void handleCallback(JsonNode callback) {
        long chatId = callback.path("message").path("chat").path("id").asLong();
        String id = callback.path("id").asText("");
        if (!id.isBlank()) {
            try { post("answerCallbackQuery", Map.of("callback_query_id", id, "text", "Dang tai...")); }
            catch (RuntimeException ignored) { }
        }
        if (chatId == 0 || !mayRead(chatId)) return;
        String[] fields = callback.path("data").asText("").split(":", 3);
        if (fields.length == 3 && "ta".equals(fields[0])) {
            guarded(chatId, "analysis", () -> sendAnalysis(chatId, fields[1] + " " + fields[2], false));
        }
    }

    private void handle(long chatId, String raw) {
        Command command = command(raw);
        switch (command.name()) {
            case "/start", "/help" -> send(chatId, help());
            case "/id" -> send(chatId, "User ID: " + chatId + "\nQuyen ghi: " + (owners.contains(chatId) ? "co" : "khong"));
            case "/ta", "/analyze" -> guarded(chatId, "analysis", () -> sendAnalysis(chatId, command.args(), false));
            case "/a" -> guarded(chatId, "analysis", () -> sendAnalysis(chatId, command.args(), true));
            case "/q", "/quick" -> guarded(chatId, "analysis", () -> sendQuick(chatId, command.args()));
            case "/gia", "/price" -> guarded(chatId, "price", () -> sendQuote(chatId, command.args()));
            case "/detail" -> sendDetail(chatId);
            case "/ask" -> guarded(chatId, "ask", () -> ask(chatId, command.args()));
            case "/train" -> owner(chatId, () -> guarded(chatId, "train", () -> train(chatId, command.args())));
            case "/models" -> sendModels(chatId);
            case "/delmodel" -> owner(chatId, () -> guarded(chatId, "models", () -> deleteModel(chatId, command.args())));
            case "/backtest" -> guarded(chatId, "backtest", () -> runBacktest(chatId, command.args()));
            case "/config" -> sendConfig(chatId);
            case "/set" -> owner(chatId, () -> setConfig(chatId, command.args()));
            case "/prompt" -> send(chatId, "SYSTEM PROMPT\n\n" + strategies.prompt());
            case "/setprompt" -> owner(chatId, () -> setPrompt(chatId, command.args()));
            case "/list", "/watchlist" -> sendWatchlist(chatId);
            case "/add", "/watch" -> owner(chatId, () -> addWatch(chatId, command.args()));
            case "/del", "/remove", "/unwatch" -> owner(chatId, () -> removeWatch(chatId, command.args()));
            case "/canhbao", "/alerts" -> owner(chatId, () -> subscribe(chatId));
            case "/tatcanhbao", "/noalerts" -> owner(chatId, () -> unsubscribe(chatId));
            default -> {
                if (raw.startsWith("/")) send(chatId, "Lenh chua ho tro. Gui /help de xem huong dan.");
                else guarded(chatId, "analysis", () -> sendQuick(chatId, raw));
            }
        }
    }

    private void sendAnalysis(long chatId, String args, boolean withAi) {
        ParsedSymbol parsed = parseSymbol(args);
        Evaluation evaluation = evaluate(parsed.symbol(), parsed.interval(), SERIES_BARS);
        lastSnapshots.put(chatId, evaluation.snapshot());
        CaptionService.SplitCaption split = CaptionService.splitCaption(
                CaptionService.buildCaption(evaluation.snapshot(), evaluation.setup(), evaluation.limitPlan()));
        try {
            sendPhoto(chatId, split.caption(), charts.renderAnalysisPng(
                    evaluation.snapshot(), evaluation.setup(), evaluation.limitPlan(), evaluation.projections()));
        } catch (RuntimeException error) {
            log("[telegram] chart fallback: " + message(error));
            sendHtml(chatId, split.caption());
        }
        if (split.rest() != null && !split.rest().isBlank()) sendHtml(chatId, split.rest());
        if (!withAi) return;
        if (!anthropic.available()) {
            send(chatId, "Phan suy luan AI dang tat hoac chua cau hinh ANTHROPIC_API_KEY.");
            return;
        }
        Map<String, Object> report = anthropic.generateReport(evaluation.snapshot(), activeStrategy(), promptOrEmpty(), null);
        String refusal = text(report.get("refusal"));
        send(chatId, refusal.isBlank() ? text(report.get("text")) : "AI tu choi tra loi: " + refusal);
    }

    private void sendQuick(long chatId, String args) {
        ParsedSymbol parsed = parseSymbol(args);
        JsonNode strategy = activeStrategy();
        Map<String, Object> snapshot = analysis.analyze(resolveAllowed(parsed.symbol(), strategy), parsed.interval(), strategy, 0);
        lastSnapshots.put(chatId, snapshot);
        send(chatId, quickText(snapshot));
    }

    private void sendQuote(long chatId, String args) {
        ParsedSymbol parsed = parseSymbol(args);
        JsonNode strategy = activeStrategy();
        Map<String, Object> snapshot = analysis.analyze(resolveAllowed(parsed.symbol(), strategy), parsed.interval(), strategy, 0);
        lastSnapshots.put(chatId, snapshot);
        sendHtml(chatId, CaptionService.buildQuoteMessage(snapshot));
    }

    private void sendDetail(long chatId) {
        Map<String, Object> snapshot = lastSnapshots.get(chatId);
        if (snapshot == null) {
            send(chatId, "Chua co phan tich. Hay chay /ta BTC 4h hoac /q BTC 4h truoc.");
            return;
        }
        Map<String, Object> groups = map(map(snapshot.get("rules")).get("breakdown"));
        List<String> lines = new ArrayList<>();
        lines.add(text(snapshot.get("symbol")) + " " + text(snapshot.get("interval")) + " - chi tiet tin hieu");
        for (Map.Entry<String, Object> item : groups.entrySet()) {
            Map<String, Object> group = map(item.getValue());
            lines.add("- " + item.getKey() + ": " + display(group.get("score"))
                    + (Boolean.FALSE.equals(group.get("available")) ? " (khong co du lieu)" : ""));
            List<?> reasons = list(group.get("reasons"));
            for (Object reason : reasons.subList(0, Math.min(2, reasons.size()))) lines.add("  " + reason);
        }
        send(chatId, String.join("\n", lines));
    }

    private void ask(long chatId, String question) {
        if (question.isBlank()) throw new IllegalArgumentException("Cach dung: /ask <cau hoi>");
        Map<String, Object> snapshot = lastSnapshots.get(chatId);
        if (snapshot == null) throw new IllegalArgumentException("Chua co phan tich. Hay chay /ta truoc.");
        if (!anthropic.available()) throw new IllegalStateException("Chua cau hinh ANTHROPIC_API_KEY");
        Map<String, Object> answer = anthropic.askAbout(snapshot, question, activeStrategy());
        String refusal = text(answer.get("refusal"));
        send(chatId, refusal.isBlank() ? text(answer.get("text")) : "AI tu choi tra loi: " + refusal);
    }

    private void train(long chatId, String args) {
        ParsedSymbol parsed = parseSymbol(args);
        JsonNode strategy = activeStrategy();
        String symbol = resolveAllowed(parsed.symbol(), strategy);
        send(chatId, "Dang train " + symbol + " " + parsed.interval() + "...");
        JsonNode result = trainer.train(symbol, parsed.interval(), strategy);
        JsonNode metrics = result.path("metrics").path("test");
        send(chatId, "Da train " + symbol + " " + parsed.interval()
                + "\nSamples: " + result.path("dataset").path("samples").asInt()
                + "\nAUC test: " + metrics.path("auc").asText("-")
                + "\nAccuracy test: " + percent(metrics.path("accuracy").doubleValue()));
    }

    private void sendModels(long chatId) {
        List<DocumentStore.StoredDocument> entries = models.list();
        if (entries.isEmpty()) {
            send(chatId, "Chua co model nao. Dung /train BTC 4h de tao model dau tien.");
            return;
        }
        List<String> lines = new ArrayList<>(List.of("MODEL DA TRAIN"));
        for (DocumentStore.StoredDocument row : entries) {
            JsonNode model = row.value();
            lines.add(model.path("symbol").asText() + " " + model.path("interval").asText()
                    + " | samples " + model.path("dataset").path("samples").asInt()
                    + " | AUC " + model.path("metrics").path("test").path("auc").asText("-"));
        }
        send(chatId, String.join("\n", lines));
    }

    private void deleteModel(long chatId, String args) {
        ParsedSymbol parsed = parseSymbol(args);
        String symbol = resolveAllowed(parsed.symbol(), activeStrategy());
        boolean deleted = models.delete(symbol, parsed.interval());
        send(chatId, deleted ? "Da xoa model " + symbol + " " + parsed.interval() + "."
                : "Khong tim thay model " + symbol + " " + parsed.interval() + ".");
    }

    private void runBacktest(long chatId, String args) {
        ParsedSymbol parsed = parseSymbol(args);
        JsonNode strategy = activeStrategy();
        String symbol = resolveAllowed(parsed.symbol(), strategy);
        send(chatId, "Dang backtest " + symbol + " " + parsed.interval() + "...");
        Map<String, Object> stats = map(backtest.run(symbol, parsed.interval(), parseCandles(parsed.rest(), 3_000), strategy).get("stats"));
        send(chatId, "BACKTEST " + symbol + " " + parsed.interval()
                + "\nTrades: " + display(stats.get("trades"))
                + "\nWin rate: " + percent(stats.get("winRatePercent"))
                + "\nNet: " + percent(stats.get("totalReturnPercent"))
                + "\nProfit factor: " + display(stats.get("profitFactor"))
                + "\nMax drawdown: " + percent(stats.get("maxDrawdownPercent")));
    }

    private void sendConfig(long chatId) {
        List<String> lines = new ArrayList<>(List.of("CAU HINH (dung /set <khoa> <gia tri>)"));
        for (ConfigurationMutationService.Setting setting : mutations.listEditableSettings()) {
            lines.add(setting.path() + " = " + setting.value());
        }
        send(chatId, String.join("\n", lines));
    }

    private void setConfig(long chatId, String args) {
        int separator = args.indexOf(' ');
        if (separator < 1 || args.substring(separator + 1).trim().isBlank()) {
            throw new IllegalArgumentException("Cach dung: /set <khoa> <gia tri>. Vi du: /set weights.trend 30");
        }
        ConfigurationMutationService.StrategyChange change = mutations.setStrategyValue(
                args.substring(0, separator).trim(), args.substring(separator + 1).trim());
        send(chatId, "Da cap nhat " + change.path() + ": " + displayNode(change.oldValue()) + " -> " + displayNode(change.newValue()));
    }

    private void setPrompt(long chatId, String prompt) {
        if (prompt.length() < 50) throw new IllegalArgumentException("System prompt can it nhat 50 ky tu.");
        ConfigurationMutationService.PromptChange result = mutations.setPrompt(prompt);
        send(chatId, "Da cap nhat system prompt (" + result.oldLength() + " -> " + result.newLength() + " ky tu).");
    }

    private void sendWatchlist(long chatId) {
        List<String> values = watchlist.read();
        send(chatId, values.isEmpty() ? "Danh sach theo doi dang rong. Them bang /add BTC."
                : "DANG THEO DOI\n" + String.join("\n", values));
    }

    private void addWatch(long chatId, String args) {
        ParsedSymbol parsed = parseSymbol(args);
        List<String> values = watchlist.add(parsed.symbol());
        send(chatId, "Da them. Danh sach: " + String.join(", ", values));
    }

    private void removeWatch(long chatId, String args) {
        ParsedSymbol parsed = parseSymbol(args);
        List<String> values = watchlist.remove(BinanceClient.normalizeSymbol(parsed.symbol()));
        send(chatId, values.isEmpty() ? "Danh sach da rong." : "Con lai: " + String.join(", ", values));
    }

    private void subscribe(long chatId) {
        List<String> values = subscribers.addSubscriber(chatId);
        send(chatId, "Da bat canh bao tu dong cho chat nay (" + values.size() + " chat dang bat). Quet moi " + pollSeconds() + " giay.");
        ensureMonitor().start(pollSeconds());
    }

    private void unsubscribe(long chatId) {
        subscribers.removeSubscriber(chatId);
        send(chatId, "Da tat canh bao tu dong cho chat nay.");
    }

    private MonitorService.Monitor ensureMonitor() {
        MonitorService.Monitor current = monitor;
        if (current != null) return current;
        synchronized (this) {
            if (monitor == null) {
                monitor = monitorService.createMonitor(new MonitorService.Dependencies(
                        this::monitorTargets,
                        target -> evaluate(target.symbol(), target.interval(), SERIES_BARS).toMonitorEvaluation(),
                        this::notifyMonitor,
                        this::activeStrategy,
                        TelegramBotService::log,
                        (snapshot, setup) -> autoRetune.buildCallEvidence(mapper.valueToTree(snapshot), mapper.valueToTree(setup)),
                        (call, result, snapshot, historyLimit) -> autoRetune.recordClosedTrade(
                                mapper.valueToTree(call), mapper.valueToTree(result), mapper.valueToTree(snapshot), historyLimit),
                        (strategy, ignored) -> autoRetune.formatAutoRetuneReport(autoRetune.runAutoRetune(strategy))));
            }
            return monitor;
        }
    }

    private List<MonitorService.Target> monitorTargets() {
        if (alertRecipients().isEmpty()) return List.of();
        JsonNode strategy = activeStrategy();
        Collection<String> symbols = universe.symbols(strategy);
        if (strategy.path("alerts").path("requireFutures").asBoolean(true)) {
            try {
                Set<String> futures = new LinkedHashSet<>(binance.fetchFuturesSymbols());
                symbols = symbols.stream().filter(futures::contains).toList();
            } catch (RuntimeException error) {
                log("[monitor] futures unavailable: " + message(error));
            }
        }
        List<MonitorService.Target> result = new ArrayList<>();
        for (String symbol : symbols) for (String interval : callIntervals(strategy)) result.add(new MonitorService.Target(symbol, interval));
        return result;
    }

    private void notifyMonitor(MonitorService.Notification notification) {
        List<Long> recipients = alertRecipients();
        if (recipients.isEmpty()) return;
        JsonNode strategy = activeStrategy();
        Map<String, Object> risk = jsonMap(strategy.path("risk"));
        switch (notification.kind()) {
            case "progress" -> {
                String body = CaptionService.buildTpUpdate(notification.call(), notification.hitTps(), risk);
                for (Long chatId : recipients) safeSendHtml(chatId, body);
            }
            case "closed" -> {
                String body = CaptionService.buildClosedNote(notification.call(), notification.result(), risk,
                        strategy.path("dailyReview").path("feePercent").asDouble(.06));
                for (Long chatId : recipients) safeSendHtml(chatId, body);
            }
            case "call" -> notifyCall(notification, recipients);
            default -> log("[monitor] unsupported notification: " + notification.kind());
        }
    }

    private void notifyCall(MonitorService.Notification notification, List<Long> recipients) {
        String prefix = notification.changedFrom() == null || notification.changedFrom().isBlank() ? "<b>KEO MOI</b>\n"
                : "<b>" + CaptionService.esc(notification.changedFrom()) + " -> "
                + CaptionService.esc(notification.setup().get("signal")) + "</b>\n";
        CaptionService.SplitCaption split = CaptionService.splitCaption(prefix + CaptionService.buildCaption(
                notification.snapshot(), notification.setup(), map(notification.limitPlan())));
        byte[] image = null;
        try { image = charts.renderAnalysisPng(notification.snapshot(), notification.setup(), notification.limitPlan(), notification.projections()); }
        catch (RuntimeException error) { log("[monitor] chart failed: " + message(error)); }
        Map<String, Long> messageIds = new LinkedHashMap<>();
        for (Long chatId : recipients) try {
            Long id = image == null ? null : sendPhoto(chatId, split.caption(), image);
            if (image == null) sendHtml(chatId, split.caption());
            if (id != null) messageIds.put(String.valueOf(chatId), id);
            if (split.rest() != null && !split.rest().isBlank()) sendHtml(chatId, split.rest());
        } catch (RuntimeException error) {
            log("[monitor] send " + chatId + " failed: " + message(error));
        }
        if (!messageIds.isEmpty()) {
            try { openCalls.setCallMessages(notification.call().symbol(), messageIds); }
            catch (RuntimeException error) { log("[monitor] cannot save message id: " + message(error)); }
        }
    }

    private Evaluation evaluate(String input, String interval, int seriesBars) {
        if (!BinanceClient.INTERVAL_MS.containsKey(interval)) throw new IllegalArgumentException("Khung thoi gian khong hop le: " + interval);
        JsonNode strategy = activeStrategy();
        String symbol = resolveAllowed(input, strategy);
        Map<String, Object> snapshot = analysis.analyze(symbol, interval, strategy, seriesBars);
        Map<String, Object> options = new LinkedHashMap<>();
        JsonNode consensus = strategy.path("thresholds").get("consensusPercent");
        if (consensus != null && consensus.isNumber()) options.put("consensusPercent", consensus.numberValue());
        Map<String, Object> dry = setups.buildSetup(snapshot, null, options);
        Map<String, Object> marketContext = null;
        if (!"none".equals(text(dry.get("side")))) try { marketContext = context.buildContext(symbol); }
        catch (RuntimeException error) { log("[context] " + symbol + ": " + message(error)); }
        Map<String, Object> setup = marketContext == null ? dry : setups.buildSetup(snapshot, marketContext, options);
        Map<String, Object> risk = jsonMap(strategy.path("risk"));
        return new Evaluation(snapshot, setup, setups.buildProjections(snapshot, risk), setups.buildLimitPlan(snapshot, risk));
    }

    private JsonNode activeStrategy() { return autoRetune.applyActiveTuning(strategies.strategy(), autoRetune.readState()); }
    private String resolveAllowed(String input, JsonNode strategy) { return universe.requireAllowed(binance.resolveSymbol(input), strategy); }
    private String promptOrEmpty() { try { return strategies.prompt(); } catch (RuntimeException ignored) { return ""; } }

    private List<Long> alertRecipients() {
        LinkedHashSet<Long> values = new LinkedHashSet<>(configuredAlertChats);
        for (String id : subscribers.readSubscribers()) try { values.add(Long.parseLong(id)); } catch (NumberFormatException ignored) { }
        return new ArrayList<>(values);
    }

    private static List<String> callIntervals(JsonNode strategy) {
        List<String> values = new ArrayList<>();
        for (JsonNode node : strategy.path("alerts").path("callIntervals")) if (BinanceClient.INTERVAL_MS.containsKey(node.asText())) values.add(node.asText());
        if (values.isEmpty()) values.addAll(List.of("4h", "1h"));
        return values;
    }

    private long pollSeconds() {
        try { return Math.max(30, activeStrategy().path("alerts").path("pollSeconds").asLong(300)); }
        catch (RuntimeException ignored) { return 300; }
    }

    private ParsedSymbol parseSymbol(String args) {
        String[] parts = args == null || args.isBlank() ? new String[0] : args.trim().split("\\s+");
        if (parts.length == 0) throw new IllegalArgumentException("Thieu ma token. Vi du: BTC 4h");
        String interval = DEFAULT_INTERVAL;
        int next = 1;
        if (parts.length > 1 && BinanceClient.INTERVAL_MS.containsKey(parts[1])) { interval = parts[1]; next++; }
        return new ParsedSymbol(parts[0], interval, next >= parts.length ? "" : String.join(" ", Arrays.copyOfRange(parts, next, parts.length)));
    }

    private static int parseCandles(String raw, int fallback) {
        try { return Math.max(200, Math.min(20_000, Integer.parseInt(raw.trim()))); }
        catch (RuntimeException ignored) { return fallback; }
    }

    private void owner(long chatId, Runnable action) {
        if (owners.contains(chatId)) action.run();
        else send(chatId, (owners.isEmpty() ? "TELEGRAM_OWNER_IDS chua duoc cau hinh; lenh ghi bi chan an toan." : "Lenh nay chi danh cho chu bot.")
                + " User ID cua ban: " + chatId);
    }
    private boolean mayRead(long chatId) { return allowed.isEmpty() || allowed.contains(chatId); }

    private void guarded(long chatId, String kind, Runnable action) {
        String key = chatId + ":" + kind;
        if (!busy.add(key)) { send(chatId, "Dang xu ly mot yeu cau cung loai. Vui long cho."); return; }
        try { action.run(); } catch (RuntimeException error) { safeSend(chatId, "Loi: " + message(error)); } finally { busy.remove(key); }
    }

    private void send(long chatId, String text) { sendChunks(chatId, text, false); }
    private void sendHtml(long chatId, String text) { sendChunks(chatId, text, true); }
    private void safeSend(long chatId, String text) { try { send(chatId, text); } catch (RuntimeException ignored) { } }
    private void safeSendHtml(long chatId, String text) { try { sendHtml(chatId, text); } catch (RuntimeException ignored) { } }

    private void sendChunks(long chatId, String text, boolean html) {
        for (String chunk : chunks(text == null || text.isBlank() ? "-" : text, MESSAGE_LIMIT)) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("chat_id", chatId); body.put("text", chunk); body.put("disable_web_page_preview", true);
            if (html) body.put("parse_mode", "HTML");
            post("sendMessage", body);
        }
    }

    private Long sendPhoto(long chatId, String caption, byte[] png) {
        String boundary = "----DongTien" + System.nanoTime();
        List<byte[]> body = new ArrayList<>();
        multipart(body, boundary, "chat_id", String.valueOf(chatId));
        multipart(body, boundary, "caption", caption == null ? "" : caption);
        multipart(body, boundary, "parse_mode", "HTML");
        body.add(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"analysis.png\"\r\nContent-Type: image/png\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        body.add(png); body.add("\r\n".getBytes(StandardCharsets.UTF_8)); body.add(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(api("sendPhoto"))).timeout(Duration.ofSeconds(45))
                    .header("Content-Type", "multipart/form-data; boundary=" + boundary).POST(HttpRequest.BodyPublishers.ofByteArrays(body)).build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            JsonNode payload = mapper.readTree(response.body());
            if (response.statusCode() / 100 != 2 || !payload.path("ok").asBoolean(false)) throw new IllegalStateException(telegramError(payload, response.statusCode()));
            return payload.path("result").path("message_id").isNumber() ? payload.path("result").path("message_id").asLong() : null;
        } catch (IOException error) { throw new IllegalStateException("Khong gui duoc anh Telegram", error); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException("Telegram bi gian doan", error); }
    }

    private static void multipart(List<byte[]> body, String boundary, String name, String value) {
        body.add(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n").getBytes(StandardCharsets.UTF_8));
    }

    private JsonNode post(String method, Map<String, Object> body) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(api(method))).timeout(Duration.ofSeconds(45)).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body))).build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            JsonNode payload = mapper.readTree(response.body());
            if (response.statusCode() / 100 != 2 || !payload.path("ok").asBoolean(false)) throw new IllegalStateException(telegramError(payload, response.statusCode()));
            return payload;
        } catch (IOException error) { throw new IllegalStateException("Khong gui duoc Telegram", error); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException("Telegram bi gian doan", error); }
    }

    private JsonNode get(String method) {
        try {
            HttpResponse<String> response = http.send(HttpRequest.newBuilder(URI.create(api(method))).timeout(Duration.ofSeconds(55)).GET().build(), HttpResponse.BodyHandlers.ofString());
            JsonNode payload = mapper.readTree(response.body());
            if (response.statusCode() / 100 != 2 || !payload.path("ok").asBoolean(false)) throw new IllegalStateException(telegramError(payload, response.statusCode()));
            return payload;
        } catch (IOException error) { throw new IllegalStateException("Khong doc duoc Telegram", error); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException("Telegram bi gian doan", error); }
    }

    private void setCommands() {
        List<Map<String, Object>> values = new ArrayList<>();
        String[][] commands = {{"ta", "Phan tich chart"}, {"q", "Phan tich nhanh"}, {"a", "Phan tich kem AI"}, {"gia", "Gia nhanh"},
                {"canhbao", "Bat canh bao"}, {"tatcanhbao", "Tat canh bao"}, {"list", "Danh sach theo doi"}, {"help", "Huong dan"}};
        for (String[] command : commands) values.add(Map.of("command", command[0], "description", command[1]));
        try { post("setMyCommands", Map.of("commands", values)); } catch (RuntimeException error) { log("[telegram] set commands: " + message(error)); }
    }

    private String api(String method) { return "https://api.telegram.org/bot" + token + "/" + method; }
    private void requireToken() { if (token.isBlank()) throw new IllegalStateException("Thieu TELEGRAM_BOT_TOKEN"); }

    private static Set<Long> ids(String raw) {
        Set<Long> result = new LinkedHashSet<>();
        if (raw != null) for (String value : raw.split(",")) try { if (!value.trim().isEmpty()) result.add(Long.parseLong(value.trim())); } catch (NumberFormatException ignored) { }
        return result;
    }
    private static Command command(String raw) {
        String value = raw == null ? "" : raw.trim(); int split = value.indexOf(' ');
        String first = split < 0 ? value : value.substring(0, split); String args = split < 0 ? "" : value.substring(split + 1).trim();
        return first.startsWith("/") ? new Command(first.toLowerCase(Locale.ROOT).split("@", 2)[0], args) : new Command("", value);
    }
    private static List<String> chunks(String text, int limit) {
        List<String> result = new ArrayList<>(); String rest = text;
        while (rest.length() > limit) { int split = rest.lastIndexOf('\n', limit); if (split < limit / 2) split = rest.lastIndexOf(' ', limit); if (split < limit / 2) split = limit; result.add(rest.substring(0, split)); rest = rest.substring(split).trim(); }
        if (!rest.isBlank() || result.isEmpty()) result.add(rest); return result;
    }
    private static String help() {
        return "BOT PHAN TICH CRYPTO\n\n/ta BTC [khung] - chart + setup\n/a BTC [khung] - them bao cao AI\n/q BTC [khung] - nhanh\n/gia BTC - gia nhanh\n/detail | /ask <cau hoi>\n"
                + "/train BTC 4h | /models | /delmodel BTC 4h\n/backtest BTC 4h [so nen]\n/config | /set <khoa> <gia tri> | /prompt | /setprompt <noi dung>\n/list | /add BTC | /del BTC\n/canhbao | /tatcanhbao\n\nKhung: " + String.join(", ", BinanceClient.INTERVALS);
    }
    private static String quickText(Map<String, Object> snapshot) {
        Map<String, Object> combined = map(snapshot.get("combined")), price = map(snapshot.get("price")), levels = map(snapshot.get("levels"));
        return text(snapshot.get("symbol")) + " " + text(snapshot.get("interval")) + "\n" + text(combined.get("signal")) + " | diem " + display(combined.get("score"))
                + "\nGia: " + display(price.get("lastClose")) + (levels.get("stopLoss") == null ? "" : "\nSL: " + display(levels.get("stopLoss")));
    }
    private static Map<String, Object> map(Object value) {
        Map<String, Object> result = new LinkedHashMap<>(); if (value instanceof Map<?, ?> source) source.forEach((key, item) -> result.put(String.valueOf(key), item)); return result;
    }
    private Map<String, Object> jsonMap(JsonNode node) {
        Map<String, Object> result = new LinkedHashMap<>(); if (node != null && node.isObject()) node.properties().forEach(entry -> result.put(entry.getKey(), jsonValue(entry.getValue()))); return result;
    }
    private Object jsonValue(JsonNode node) {
        if (node == null || node.isNull()) return null; if (node.isObject()) return jsonMap(node); if (node.isArray()) { List<Object> values = new ArrayList<>(); for (JsonNode item : node) values.add(jsonValue(item)); return values; }
        return node.isBoolean() ? node.asBoolean() : node.isNumber() ? node.numberValue() : node.asText();
    }
    private static List<?> list(Object value) { return value instanceof List<?> values ? values : List.of(); }
    private static String text(Object value) { return value == null ? "" : String.valueOf(value); }
    private static String display(Object value) {
        return value instanceof Number number ? String.format(Locale.ROOT, "%.4f", number.doubleValue()).replaceAll("0+$", "").replaceAll("\\.$", "") : value == null ? "-" : String.valueOf(value);
    }
    private static String displayNode(JsonNode value) { return value == null ? "-" : value.isTextual() ? value.asText() : value.toString(); }
    private static String percent(Object value) { double number = value instanceof Number n ? n.doubleValue() : Double.NaN; if (!Double.isFinite(number)) return value == null ? "-" : String.valueOf(value); return String.format(Locale.ROOT, "%.2f%%", Math.abs(number) <= 1 ? number * 100 : number); }
    private static String telegramError(JsonNode payload, int status) { String value = payload.path("description").asText(""); return value.isBlank() ? "Telegram HTTP " + status : value; }
    private static String message(RuntimeException error) { return error.getMessage() == null || error.getMessage().isBlank() ? "Loi khong xac dinh" : error.getMessage(); }
    private static void sleep(long millis) { try { Thread.sleep(millis); } catch (InterruptedException error) { Thread.currentThread().interrupt(); } }
    private static void log(String value) { System.err.println(value); }

    private record Command(String name, String args) { }
    private record ParsedSymbol(String symbol, String interval, String rest) { }
    private record Evaluation(Map<String, Object> snapshot, Map<String, Object> setup, Map<String, Object> projections, Map<String, Object> limitPlan) {
        MonitorService.Evaluation toMonitorEvaluation() { return new MonitorService.Evaluation(snapshot, setup, projections, limitPlan); }
    }
}
