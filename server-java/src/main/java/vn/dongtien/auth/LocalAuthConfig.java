package vn.dongtien.auth;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;

import java.util.List;
import java.util.regex.Pattern;

@Configuration
public class LocalAuthConfig {
    private static final String ADMIN_USERNAME_PROPERTY = "LOCAL_AUTH_ADMIN_USERNAME";
    private static final String ADMIN_PASSWORD_HASH_PROPERTY = "LOCAL_AUTH_ADMIN_PASSWORD_HASH";
    private static final String VIEWER_USERNAME_PROPERTY = "LOCAL_AUTH_VIEWER_USERNAME";
    private static final String VIEWER_PASSWORD_HASH_PROPERTY = "LOCAL_AUTH_VIEWER_PASSWORD_HASH";
    private static final Pattern USERNAME = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$");
    private static final Pattern BCRYPT_12_HASH = Pattern.compile("^\\$2[aby]\\$12\\$[./A-Za-z0-9]{53}$");

    @Bean
    LocalAuthAvailability localAuthAvailability(Environment environment) {
        return new LocalAuthAvailability(!accounts(environment).isEmpty());
    }

    @Bean
    UserDetailsService localUserDetailsService(
            Environment environment,
            LocalAuthAvailability availability
    ) {
        if (!availability.enabled()) {
            return new InMemoryUserDetailsManager();
        }

        // InMemoryUserDetailsManager normalizes lookup keys with Locale.ROOT, so local usernames
        // are intentionally case-insensitive while their configured spelling remains the display name.
        List<UserDetails> users = accounts(environment).stream()
                .map(account -> User.withUsername(account.username())
                        .password(account.passwordHash())
                        .roles(account.role())
                        .build()
                )
                .toList();
        return new InMemoryUserDetailsManager(users);
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
