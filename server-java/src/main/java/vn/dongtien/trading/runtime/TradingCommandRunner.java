package vn.dongtien.trading.runtime;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;
import vn.dongtien.auth.TradingPerformanceService;
import vn.dongtien.trading.analysis.AnalysisService;
import vn.dongtien.trading.analysis.AutoRetuneService;
import vn.dongtien.trading.analysis.DailyLossLogService;
import vn.dongtien.trading.analysis.DailyReviewService;
import vn.dongtien.trading.analysis.ResearchService;
import vn.dongtien.trading.backtest.BacktestService;
import vn.dongtien.trading.config.StrategyService;
import vn.dongtien.trading.config.TradingUniverse;
import vn.dongtien.trading.market.BinanceClient;
import vn.dongtien.trading.llm.AnthropicService;
import vn.dongtien.trading.ml.ModelTrainer;
import vn.dongtien.trading.model.ModelStore;
import vn.dongtien.trading.telegram.TelegramBotService;
import vn.dongtien.trading.telegram.TelegramCallHistoryParser;
import vn.dongtien.trading.telegram.TelegramHistoryClient;
import vn.dongtien.trading.telegram.TelegramHistoryImportService;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;

@Component
public class TradingCommandRunner implements ApplicationRunner {
    private final ObjectMapper mapper;
    private final BinanceClient binance;
    private final StrategyService strategies;
    private final TradingUniverse universe;
    private final AnalysisService analysis;
    private final BacktestService backtest;
    private final ModelTrainer trainer;
    private final ModelStore models;
    private final ImportFilesService importer;
    private final TelegramBotService telegram;
    private final TradingPerformanceService performance;
    private final DailyReviewService dailyReviews;
    private final DailyLossLogService dailyLossLogs;
    private final AutoRetuneService autoRetune;
    private final ResearchService research;
    private final AnthropicService anthropic;
    private final TelegramHistoryClient telegramHistory;
    private final TelegramHistoryImportService telegramImports;
    private final Environment environment;

    public TradingCommandRunner(ObjectMapper mapper, BinanceClient binance, StrategyService strategies,
                                TradingUniverse universe, AnalysisService analysis, BacktestService backtest,
                                ModelTrainer trainer, ModelStore models, ImportFilesService importer,
                                TelegramBotService telegram, TradingPerformanceService performance,
                                DailyReviewService dailyReviews, DailyLossLogService dailyLossLogs,
                                AutoRetuneService autoRetune, ResearchService research, AnthropicService anthropic,
                                TelegramHistoryClient telegramHistory, TelegramHistoryImportService telegramImports,
                                Environment environment) {
        this.mapper = mapper; this.binance = binance; this.strategies = strategies; this.universe = universe;
        this.analysis = analysis; this.backtest = backtest; this.trainer = trainer; this.models = models;
        this.importer = importer; this.telegram = telegram; this.performance = performance;
        this.dailyReviews = dailyReviews; this.dailyLossLogs = dailyLossLogs; this.autoRetune = autoRetune;
        this.research = research; this.anthropic = anthropic;
        this.telegramHistory = telegramHistory; this.telegramImports = telegramImports; this.environment = environment;
    }

    @Override
    public void run(ApplicationArguments arguments) throws Exception {
        List<String> args = arguments.getNonOptionArgs();
        if (args.isEmpty()) return;
        String command = args.get(0);
        switch (command) {
            case "analyze" -> {
                String symbol = allowedSymbol(args.size() > 1 ? args.get(1) : "BTC");
                String interval = args.size() > 2 ? args.get(2) : "4h";
                Map<String, Object> snapshot = analysis.analyze(symbol, interval, strategies.strategy(), 0);
                if (!arguments.containsOption("no-ai") && anthropic.available()
                        && strategies.strategy().path("llm").path("enabled").asBoolean(true)) {
                    snapshot.put("ai", anthropic.generateReport(snapshot, strategies.strategy(), strategies.prompt(), null));
                }
                print(snapshot);
            }
            case "backtest" -> {
                String symbol = allowedSymbol(args.size() > 1 ? args.get(1) : "BTC");
                String interval = args.size() > 2 ? args.get(2) : "4h";
                int candles = args.size() > 3 ? Integer.parseInt(args.get(3)) : 3000;
                Map<String, Object> result = backtest.run(symbol, interval, candles, strategies.strategy());
                result.put("command", command); print(result);
            }
            case "diagnose-sl" -> print(research.diagnoseStopLoss(
                    args.size() > 1 ? args.get(1) : "BTC", args.size() > 2 ? args.get(2) : "4h",
                    args.size() > 3 ? Integer.parseInt(args.get(3)) : 3000, strategies.strategy()));
            case "validate-filters" -> print(research.validateFilters(
                    args.size() > 1 ? args.get(1) : "BTC", args.size() > 2 ? args.get(2) : "4h",
                    args.size() > 3 ? Integer.parseInt(args.get(3)) : 3000, strategies.strategy()));
            case "research-patterns" -> {
                String interval = option(arguments, "interval", args.size() > 2 ? args.get(2) : "4h");
                String symbol = option(arguments, "symbol", args.size() > 1 ? args.get(1) : null);
                print(research.researchPatterns(symbol, interval, strategies.strategy()));
            }
            case "train" -> {
                String symbol = allowedSymbol(args.size() > 1 ? args.get(1) : "BTC");
                String interval = args.size() > 2 ? args.get(2) : "4h";
                print(trainer.train(symbol, interval, strategies.strategy()));
            }
            case "daily-review" -> {
                DailyLossLogService.Dependencies dependencies = new DailyLossLogService.Dependencies(null, null, -1,
                        arguments.containsOption("force"), false, arguments.containsOption("refresh-unknown"));
                DailyLossLogService.Result losses = dailyLossLogs.recordDailyLossLog(strategies.strategy(), autoRetune,
                        System.currentTimeMillis(), dependencies);
                Map<String, Object> review = dailyReviews.runDailyReview(strategies.strategy(),
                        arguments.containsOption("force"), arguments.containsOption("no-training"));
                Map<String, Object> output = new java.util.LinkedHashMap<>();
                output.put("lossLogStatus", losses.status());
                output.put("lossLog", losses.log());
                output.put("review", review);
                output.put("telegramSummary", dailyReviews.formatDailyReview(review));
                print(output);
            }
            case "daily-loss-log" -> {
                DailyLossLogService.Result result = dailyLossLogs.recordDailyLossLog(strategies.strategy(), autoRetune,
                        System.currentTimeMillis(), DailyLossLogService.Dependencies.defaults());
                Map<String, Object> output = new java.util.LinkedHashMap<>();
                output.put("status", result.status());
                output.put("log", result.log());
                print(output);
            }
            case "auto-retune" -> print(autoRetune.runAutoRetune(strategies.strategy()));
            case "import-files" -> print(Map.of("imported", importer.run(repositoryRoot(), arguments.containsOption("overwrite"))));
            case "models-index" -> print(models.list());
            case "migrate" -> System.out.println("Database migrations completed by Flyway.");
            case "alerts-once" -> telegram.sendAlertsOnce();
            case "bot" -> telegram.runForever();
            case "telegram-list-chats" -> {
                List<Map<String, Object>> chats = telegramHistory.listChats().stream()
                        .map(TelegramHistoryClient.ChatSummary::asMap).toList();
                print(Map.of("chats", chats, "count", chats.size(),
                        "note", "Chon mot id va chay telegram-import-history --chat-id=<id>."));
            }
            case "telegram-import-history" -> {
                long chatId = requiredLongOption(arguments, "chat-id");
                ZoneId zone = ZoneId.of(environment.getProperty("TRADING_TIMEZONE", "Asia/Ho_Chi_Minh"));
                LocalDate date = LocalDate.parse(option(arguments, "date", LocalDate.now(zone).minusDays(1).toString()));
                int lookbackDays = boundedIntOption(arguments, "lookback-days", 14, 1, 90);
                int maxMessages = boundedIntOption(arguments, "max-messages", 3_000, 100, 10_000);
                List<TelegramCallHistoryParser.HistoryMessage> messages = telegramHistory.history(
                        chatId, date, zone, lookbackDays, maxMessages);
                TelegramCallHistoryParser.ParseResult parsed = new TelegramCallHistoryParser().parse(chatId, date, zone, messages);
                Map<String, Object> output = new java.util.LinkedHashMap<>(telegramImports.store(parsed, arguments.containsOption("apply")).asMap());
                output.put("date", date.toString());
                output.put("mode", arguments.containsOption("apply") ? "apply" : "dry-run");
                output.put("message", arguments.containsOption("apply")
                        ? "Chi cac keo nhan dang duoc moi duoc luu; du lieu Telegram khong duoc dua vao training."
                        : "Dry-run: chua ghi database. Them --apply sau khi kiem tra ket qua.");
                print(output);
            }
            default -> throw new IllegalArgumentException("Lệnh Java không hợp lệ: " + command);
        }
    }

    private String allowedSymbol(String input) {
        String symbol = binance.resolveSymbol(input);
        return universe.requireAllowed(symbol, strategies.strategy());
    }
    private static String option(ApplicationArguments arguments, String name, String fallback) {
        List<String> values = arguments.getOptionValues(name);
        return values == null || values.isEmpty() || values.get(0).isBlank() ? fallback : values.get(0);
    }
    private static long requiredLongOption(ApplicationArguments arguments, String name) {
        String value = option(arguments, name, null);
        if (value == null) throw new IllegalArgumentException("Thieu --" + name + "=<gia-tri>");
        try { return Long.parseLong(value); }
        catch (NumberFormatException exception) { throw new IllegalArgumentException("--" + name + " phai la so nguyen", exception); }
    }
    private static int boundedIntOption(ApplicationArguments arguments, String name, int fallback, int min, int max) {
        String value = option(arguments, name, Integer.toString(fallback));
        try {
            int parsed = Integer.parseInt(value);
            if (parsed < min || parsed > max) throw new IllegalArgumentException("--" + name + " phai nam trong " + min + ".." + max);
            return parsed;
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException("--" + name + " phai la so nguyen", exception);
        }
    }
    private void print(Object value) throws Exception { System.out.println(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(value)); }
    private static Path repositoryRoot() {
        Path current = Path.of("").toAbsolutePath().normalize();
        if (Files.isRegularFile(current.resolve("config/strategy.json"))) return current;
        if (Files.isRegularFile(current.resolve("../config/strategy.json"))) return current.resolve("..").normalize();
        return current;
    }
}
