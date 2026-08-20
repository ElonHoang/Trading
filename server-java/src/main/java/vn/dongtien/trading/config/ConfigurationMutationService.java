package vn.dongtien.trading.config;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/**
 * Safe runtime mutations for the strategy document and the LLM system prompt.
 *
 * <p>The former Node {@code config.js} accepted a dotted key from Telegram and
 * changed only keys which already existed.  Keeping that rule is important:
 * a typo must not silently create an unused configuration branch.  Every
 * strategy write starts with a deep copy, so callers holding the old JSON tree
 * cannot observe a partly-mutated document.</p>
 */
@Service
public class ConfigurationMutationService {
    private static final String STRATEGY_FILE = "strategy.json";
    private static final String PROMPT_FILE = "prompt.md";

    private final StrategyService strategies;
    private final ObjectMapper mapper;
    private final Path configDirectory;

    /** Runtime constructor; the directory works both from the repository root and server-java/. */
    @Autowired
    public ConfigurationMutationService(StrategyService strategies, ObjectMapper mapper) {
        this(strategies, mapper, defaultConfigDirectory());
    }

    /** Visible to package tests and embedders that keep configuration elsewhere. */
    ConfigurationMutationService(StrategyService strategies, ObjectMapper mapper, Path configDirectory) {
        this.strategies = Objects.requireNonNull(strategies, "strategies");
        this.mapper = Objects.requireNonNull(mapper, "mapper");
        this.configDirectory = Objects.requireNonNull(configDirectory, "configDirectory").toAbsolutePath().normalize();
    }

    /**
     * Changes one existing leaf in the persisted strategy document.
     * Numeric and boolean leaves are parsed according to their current type;
     * strings stay strings. Arrays retain the Node command's comma-separated
     * input format (numeric-looking entries become numbers).
     */
    public synchronized StrategyChange setStrategyValue(String dottedPath, String rawValue) {
        List<String> parts = splitPath(dottedPath);
        Objects.requireNonNull(rawValue, "Giá trị cấu hình không được là null");

        JsonNode current = strategies.strategy();
        if (!current.isObject()) {
            throw new IllegalStateException("Cấu hình strategy hiện tại phải là một JSON object.");
        }
        ObjectNode nextStrategy = ((ObjectNode) current).deepCopy();
        ObjectNode parent = nextStrategy;
        for (int index = 0; index < parts.size() - 1; index++) {
            String segment = parts.get(index);
            JsonNode child = parent.get(segment);
            if (child == null || !child.isObject()) {
                throw new IllegalArgumentException("Không tìm thấy nhóm cấu hình \""
                        + String.join(".", parts.subList(0, index + 1)) + "\".");
            }
            parent = (ObjectNode) child;
        }

        String leaf = parts.get(parts.size() - 1);
        JsonNode oldValue = parent.get(leaf);
        if (oldValue == null) {
            throw new IllegalArgumentException("Không có khoá \"" + dottedPath
                    + "\". Hãy xem danh sách cấu hình hợp lệ trước khi sửa.");
        }
        if (oldValue.isObject()) {
            throw new IllegalArgumentException("\"" + dottedPath
                    + "\" là một nhóm cấu hình; hãy sửa một khoá cụ thể bên trong nhóm đó.");
        }

        JsonNode newValue = coerceValue(oldValue, rawValue, dottedPath);
        parent.set(leaf, newValue);
        strategies.saveStrategy(nextStrategy);
        return new StrategyChange(dottedPath, oldValue.deepCopy(), newValue.deepCopy());
    }

    /** Replaces the prompt directly, returning lengths suitable for a chat acknowledgement. */
    public synchronized PromptChange setPrompt(String text) {
        Objects.requireNonNull(text, "System prompt không được là null");
        String oldPrompt = strategies.prompt();
        strategies.savePrompt(text);
        return new PromptChange(oldPrompt.length(), text.length());
    }

    /** Returns editable leaves while omitting explanatory _note fields. */
    public synchronized List<Setting> listEditableSettings() {
        List<Setting> result = new ArrayList<>();
        flatten(strategies.strategy(), "", result);
        return List.copyOf(result);
    }

    /**
     * Restores the strategy from {@code config/strategy.json}.  Expected input
     * errors are returned as a message so a Telegram command can reply without
     * exposing a stack trace or leaving the persisted document altered.
     */
    public synchronized ResetResult resetStrategyFromConfigFile() {
        Path source = configDirectory.resolve(STRATEGY_FILE);
        try {
            if (!Files.isRegularFile(source)) return missing("strategy", source);
            JsonNode value = mapper.readTree(Files.readString(source, StandardCharsets.UTF_8));
            if (value == null || !value.isObject()) {
                return failed("strategy", source, "Tệp strategy.json phải chứa một JSON object.");
            }
            strategies.saveStrategy(value.deepCopy());
            return restored("strategy", source);
        } catch (IOException error) {
            return failed("strategy", source, "Không đọc được strategy.json: " + concise(error));
        }
    }

    /** Restores the system prompt from {@code config/prompt.md}. */
    public synchronized ResetResult resetPromptFromConfigFile() {
        Path source = configDirectory.resolve(PROMPT_FILE);
        try {
            if (!Files.isRegularFile(source)) return missing("prompt", source);
            String value = Files.readString(source, StandardCharsets.UTF_8);
            if (value.isBlank()) return failed("prompt", source, "Tệp prompt.md đang trống, không có gì để khôi phục.");
            strategies.savePrompt(value);
            return restored("prompt", source);
        } catch (IOException error) {
            return failed("prompt", source, "Không đọc được prompt.md: " + concise(error));
        }
    }

    public Path configDirectory() {
        return configDirectory;
    }

    private JsonNode coerceValue(JsonNode oldValue, String rawValue, String path) {
        if (oldValue.isBoolean()) return mapper.valueToTree(parseBoolean(rawValue, path));
        if (oldValue.isNumber()) return decimalNode(rawValue, path);
        if (oldValue.isArray()) return commaSeparatedArray(rawValue);
        // The Node implementation treats text and null leaves as a raw string.
        return mapper.valueToTree(rawValue);
    }

    private JsonNode decimalNode(String rawValue, String path) {
        String normalized = rawValue.trim();
        if (normalized.isEmpty()) throw new IllegalArgumentException("\"" + rawValue + "\" không phải là số cho " + path + ".");
        try {
            BigDecimal number = new BigDecimal(normalized);
            if (!Double.isFinite(number.doubleValue())) {
                throw new NumberFormatException("not finite");
            }
            return mapper.valueToTree(number);
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("\"" + rawValue + "\" không phải là số hữu hạn cho " + path + ".");
        }
    }

    private boolean parseBoolean(String rawValue, String path) {
        return switch (rawValue.trim().toLowerCase(Locale.ROOT)) {
            case "true", "1", "on" -> true;
            case "false", "0", "off" -> false;
            default -> throw new IllegalArgumentException("\"" + rawValue + "\" không phải true/false cho " + path + ".");
        };
    }

    private ArrayNode commaSeparatedArray(String rawValue) {
        ArrayNode result = mapper.createArrayNode();
        for (String segment : rawValue.split(",", -1)) {
            String value = segment.trim();
            result.add(numberOrText(value));
        }
        return result;
    }

    private JsonNode numberOrText(String value) {
        // JavaScript Number("") is zero; retain that small compatibility detail.
        if (value.isEmpty()) return mapper.valueToTree(BigDecimal.ZERO);
        try {
            BigDecimal number = new BigDecimal(value);
            return Double.isFinite(number.doubleValue()) ? mapper.valueToTree(number) : mapper.valueToTree(value);
        } catch (NumberFormatException ignored) {
            return mapper.valueToTree(value);
        }
    }

    private static List<String> splitPath(String dottedPath) {
        if (dottedPath == null || dottedPath.isBlank()) throw new IllegalArgumentException("Đường dẫn cấu hình đang trống.");
        String[] parts = dottedPath.trim().split("\\.", -1);
        List<String> result = new ArrayList<>(parts.length);
        for (String part : parts) {
            String segment = part.trim();
            if (segment.isEmpty()) throw new IllegalArgumentException("Đường dẫn cấu hình không được có đoạn trống.");
            result.add(segment);
        }
        return result;
    }

    private static void flatten(JsonNode node, String prefix, List<Setting> result) {
        if (node == null || !node.isObject()) return;
        node.properties().forEach(entry -> {
            if (entry.getKey().startsWith("_")) return;
            String path = prefix.isEmpty() ? entry.getKey() : prefix + "." + entry.getKey();
            if (entry.getValue().isObject()) flatten(entry.getValue(), path, result);
            else result.add(new Setting(path, entry.getValue().deepCopy()));
        });
    }

    private static Path defaultConfigDirectory() {
        String configured = System.getProperty("dongtien.config-dir", "").trim();
        if (!configured.isEmpty()) return Path.of(configured);
        Path cwd = Path.of("").toAbsolutePath().normalize();
        Path local = cwd.resolve("config");
        if (Files.isDirectory(local)) return local;
        Path parent = cwd.resolve("..").normalize().resolve("config");
        return Files.isDirectory(parent) ? parent : local;
    }

    private static ResetResult restored(String target, Path source) {
        return new ResetResult(true, target, source.toAbsolutePath().normalize(),
                "Đã khôi phục " + target + " từ " + source.getFileName() + ".");
    }

    private static ResetResult missing(String target, Path source) {
        return failed(target, source, "Không tìm thấy tệp cấu hình " + source.toAbsolutePath().normalize() + ".");
    }

    private static ResetResult failed(String target, Path source, String message) {
        return new ResetResult(false, target, source.toAbsolutePath().normalize(), message);
    }

    private static String concise(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    public record StrategyChange(String path, JsonNode oldValue, JsonNode newValue) {}
    public record PromptChange(int oldLength, int newLength) {}
    public record Setting(String path, JsonNode value) {}
    public record ResetResult(boolean restored, String target, Path source, String message) {}
}
