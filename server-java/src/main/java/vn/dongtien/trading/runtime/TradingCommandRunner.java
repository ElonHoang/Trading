package vn.dongtien.trading.runtime;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;
import vn.dongtien.auth.TradingPerformanceService;
import vn.dongtien.trading.analysis.AnalysisService;
import vn.dongtien.trading.backtest.BacktestService;
import vn.dongtien.trading.config.StrategyService;
import vn.dongtien.trading.config.TradingUniverse;
import vn.dongtien.trading.market.BinanceClient;
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

    public TradingCommandRunner(ObjectMapper mapper, BinanceClient binance, StrategyService strategies,
                                TradingUniverse universe, AnalysisService analysis, BacktestService backtest,
                                ModelTrainer trainer, ModelStore models, ImportFilesService importer,
                                TelegramBotService telegram, TradingPerformanceService performance) {
        this.mapper = mapper; this.binance = binance; this.strategies = strategies; this.universe = universe;
        this.analysis = analysis; this.backtest = backtest; this.trainer = trainer; this.models = models;
        this.importer = importer; this.telegram = telegram; this.performance = performance;
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
                print(analysis.analyze(symbol, interval, strategies.strategy(), 0));
            }
            case "backtest", "diagnose-sl", "validate-filters", "research-patterns" -> {
                String symbol = allowedSymbol(args.size() > 1 ? args.get(1) : "BTC");
                String interval = args.size() > 2 ? args.get(2) : "4h";
                int candles = args.size() > 3 ? Integer.parseInt(args.get(3)) : 3000;
                Map<String, Object> result = backtest.run(symbol, interval, candles, strategies.strategy());
                result.put("command", command); print(result);
            }
            case "train" -> {
                String symbol = allowedSymbol(args.size() > 1 ? args.get(1) : "BTC");
                String interval = args.size() > 2 ? args.get(2) : "4h";
                print(trainer.train(symbol, interval, strategies.strategy()));
            }
            case "daily-review" -> print(performance.performance("week"));
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
    private void print(Object value) throws Exception { System.out.println(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(value)); }
    private static Path repositoryRoot() {
        Path current = Path.of("").toAbsolutePath().normalize();
        if (Files.isRegularFile(current.resolve("config/strategy.json"))) return current;
        if (Files.isRegularFile(current.resolve("../config/strategy.json"))) return current.resolve("..").normalize();
        return current;
    }
}
