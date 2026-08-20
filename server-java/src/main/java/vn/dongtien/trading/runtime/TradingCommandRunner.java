package vn.dongtien.trading.runtime;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
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

import java.nio.file.Files;
import java.nio.file.Path;
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

    public TradingCommandRunner(ObjectMapper mapper, BinanceClient binance, StrategyService strategies,
                                TradingUniverse universe, AnalysisService analysis, BacktestService backtest,
                                ModelTrainer trainer, ModelStore models, ImportFilesService importer,
                                TelegramBotService telegram, TradingPerformanceService performance,
                                DailyReviewService dailyReviews, DailyLossLogService dailyLossLogs,
                                AutoRetuneService autoRetune, ResearchService research, AnthropicService anthropic) {
        this.mapper = mapper; this.binance = binance; this.strategies = strategies; this.universe = universe;
        this.analysis = analysis; this.backtest = backtest; this.trainer = trainer; this.models = models;
        this.importer = importer; this.telegram = telegram; this.performance = performance;
        this.dailyReviews = dailyReviews; this.dailyLossLogs = dailyLossLogs; this.autoRetune = autoRetune;
        this.research = research; this.anthropic = anthropic;
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
    private void print(Object value) throws Exception { System.out.println(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(value)); }
    private static Path repositoryRoot() {
        Path current = Path.of("").toAbsolutePath().normalize();
        if (Files.isRegularFile(current.resolve("config/strategy.json"))) return current;
        if (Files.isRegularFile(current.resolve("../config/strategy.json"))) return current.resolve("..").normalize();
        return current;
    }
}
