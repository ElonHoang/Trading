package vn.dongtien.auth;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.dao.DataAccessException;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;

import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

@Configuration
public class LocalAuthConfig {
    private static final String ADMIN_USERNAME_PROPERTY = "LOCAL_AUTH_ADMIN_USERNAME";
    private static final String ADMIN_PASSWORD_HASH_PROPERTY = "LOCAL_AUTH_ADMIN_PASSWORD_HASH";
    private static final String VIEWER_USERNAME_PROPERTY = "LOCAL_AUTH_VIEWER_USERNAME";
    private static final String VIEWER_PASSWORD_HASH_PROPERTY = "LOCAL_AUTH_VIEWER_PASSWORD_HASH";
    /** Dung chung cho ca tai khoan trong database lan tai khoan khai bang bien moi truong. */
    static final Pattern USERNAME = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$");
    private static final Pattern BCRYPT_12_HASH = Pattern.compile("^\\$2[aby]\\$12\\$[./A-Za-z0-9]{53}$");

    /** Khoang thoi gian tin vao ket qua dem tai khoan, de moi lan mo trang login khong ban mot truy van. */
    private static final long AVAILABILITY_CACHE_MS = 30_000L;

    @Bean
    LocalAuthAvailability localAuthAvailability(Environment environment, LocalCredentialStore credentials) {
        boolean fromEnvironment = !accounts(environment).isEmpty();
        CachedFlag stored = new CachedFlag(() -> credentials.countActive() > 0);
        // Tai khoan them bang CLI o tien trinh khac, nen phai hoi lai database luc chay.
        return new LocalAuthAvailability(() -> fromEnvironment || stored.get());
    }

    @Bean
    UserDetailsService localUserDetailsService(
            Environment environment,
            LocalCredentialStore credentials
    ) {
        // InMemoryUserDetailsManager normalizes lookup keys with Locale.ROOT, so local usernames
        // are intentionally case-insensitive while their configured spelling remains the display name.
        List<UserDetails> configured = accounts(environment).stream()
                .map(account -> (UserDetails) User.withUsername(account.username())
                        .password(account.passwordHash())
                        .roles(account.role())
                        .build()
                )
                .toList();
        InMemoryUserDetailsManager fromEnvironment = new InMemoryUserDetailsManager(configured);

        return username -> {
            // Loi database o day duoc de noi len: coi mot su co ket noi la "khong co tai khoan
            // nay" se bien su co thanh that bai dang nhap kho hieu.
            Optional<LocalCredentialStore.LocalCredential> stored = credentials.find(username);
            if (stored.isPresent()) {
                return User.withUsername(stored.get().username())
                        .password(stored.get().passwordHash())
                        .roles(stored.get().role())
                        .build();
            }
            return fromEnvironment.loadUserByUsername(username);
        };
    }

    /** Ket qua boolean co han su dung, dung cho cac lan hoi lien tiep tren duong render trang. */
    private static final class CachedFlag {
        private final java.util.function.BooleanSupplier source;
        private volatile boolean value;
        private volatile long readAtMs;

        private CachedFlag(java.util.function.BooleanSupplier source) {
            this.source = source;
        }

        private boolean get() {
            long now = System.currentTimeMillis();
            if (readAtMs > 0 && now - readAtMs < AVAILABILITY_CACHE_MS) return value;
            try {
                value = source.getAsBoolean();
            } catch (DataAccessException ignored) {
                // Trang login van phai hien duoc khi database tam thoi khong voi toi.
                value = false;
            }
            readAtMs = now;
            return value;
        }
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(12);
    }

    private static List<Account> accounts(Environment environment) {
        String adminUsername = property(environment, ADMIN_USERNAME_PROPERTY);
        String adminPasswordHash = property(environment, ADMIN_PASSWORD_HASH_PROPERTY);
        String viewerUsername = property(environment, VIEWER_USERNAME_PROPERTY);
        String viewerPasswordHash = property(environment, VIEWER_PASSWORD_HASH_PROPERTY);

        if (adminUsername == null && adminPasswordHash == null && viewerUsername == null && viewerPasswordHash == null) {
            return List.of();
        }
        if (adminUsername == null || adminPasswordHash == null || viewerUsername == null || viewerPasswordHash == null) {
            throw new IllegalStateException("Phải cấu hình đủ username và BCrypt hash cho cả admin lẫn viewer.");
        }
        if (!USERNAME.matcher(adminUsername).matches() || !USERNAME.matcher(viewerUsername).matches()) {
            throw new IllegalStateException("Username local chỉ được chứa chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.");
        }
        if (adminUsername.equalsIgnoreCase(viewerUsername)) {
            throw new IllegalStateException("Username admin và viewer phải khác nhau.");
        }
        if (!BCRYPT_12_HASH.matcher(adminPasswordHash).matches()
                || !BCRYPT_12_HASH.matcher(viewerPasswordHash).matches()) {
            throw new IllegalStateException("Local auth chỉ nhận BCrypt hash với cost 12.");
        }

        return List.of(
                new Account(adminUsername, adminPasswordHash, "ADMIN"),
                new Account(viewerUsername, viewerPasswordHash, "VIEWER")
        );
    }

    private static String property(Environment environment, String key) {
        String value = environment.getProperty(key);
        if (value == null || value.isBlank()) return null;
        String normalized = value.trim();
        if (normalized.length() >= 2 && ((normalized.startsWith("'") && normalized.endsWith("'"))
                || (normalized.startsWith("\"") && normalized.endsWith("\"")))) {
            normalized = normalized.substring(1, normalized.length() - 1);
        }
        return normalized.isBlank() ? null : normalized;
    }

    private record Account(String username, String passwordHash, String role) {}
}
