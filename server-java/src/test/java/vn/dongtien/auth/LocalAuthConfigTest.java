package vn.dongtien.auth;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.userdetails.UserDetailsService;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LocalAuthConfigTest {
    private final LocalAuthConfig config = new LocalAuthConfig();

    @Test
    void localLoginStaysDisabledWhenNoAccountIsConfigured() {
        assertThat(config.localAuthAvailability(new MockEnvironment()).enabled()).isFalse();
    }

    @Test
    void localLoginRejectsPartialAccountConfiguration() {
        MockEnvironment environment = new MockEnvironment()
                .withProperty("LOCAL_AUTH_ADMIN_USERNAME", "admin");

        assertThatThrownBy(() -> config.localAuthAvailability(environment))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void localLoginRequiresBothRolesAndBcryptHashes() {
        MockEnvironment environment = new MockEnvironment()
                .withProperty("LOCAL_AUTH_ADMIN_USERNAME", "admin")
                .withProperty("LOCAL_AUTH_ADMIN_PASSWORD_HASH", "$2b$12$nGARqvlfzhfMrlcXjA9S6O7Wbpj3EJu6W89VIZRpFApjdY/Et8U/q")
                .withProperty("LOCAL_AUTH_VIEWER_USERNAME", "viewer")
                .withProperty("LOCAL_AUTH_VIEWER_PASSWORD_HASH", "$2b$12$nGARqvlfzhfMrlcXjA9S6O7Wbpj3EJu6W89VIZRpFApjdY/Et8U/q");

        LocalAuthAvailability availability = config.localAuthAvailability(environment);
        UserDetailsService users = config.localUserDetailsService(environment, availability);

        assertThat(availability.enabled()).isTrue();
        assertThat(config.passwordEncoder().matches("correct-password", users.loadUserByUsername("admin").getPassword())).isTrue();
        assertThat(users.loadUserByUsername("AdMiN").getUsername()).isEqualTo("admin");
        assertThat(users.loadUserByUsername("admin").getAuthorities())
                .extracting(GrantedAuthority::getAuthority)
                .containsExactly("ROLE_ADMIN");
        assertThat(users.loadUserByUsername("viewer").getAuthorities())
                .extracting(GrantedAuthority::getAuthority)
                .containsExactly("ROLE_VIEWER");
        assertThat(users.loadUserByUsername("ViEwEr").getUsername()).isEqualTo("viewer");
    }

    @Test
    void localLoginAcceptsHashesQuotedForDockerCompose() {
        MockEnvironment environment = new MockEnvironment()
                .withProperty("LOCAL_AUTH_ADMIN_USERNAME", "admin")
                .withProperty("LOCAL_AUTH_ADMIN_PASSWORD_HASH", "'$2b$12$nGARqvlfzhfMrlcXjA9S6O7Wbpj3EJu6W89VIZRpFApjdY/Et8U/q'")
                .withProperty("LOCAL_AUTH_VIEWER_USERNAME", "viewer")
                .withProperty("LOCAL_AUTH_VIEWER_PASSWORD_HASH", "'$2b$12$nGARqvlfzhfMrlcXjA9S6O7Wbpj3EJu6W89VIZRpFApjdY/Et8U/q'");

        assertThat(config.localAuthAvailability(environment).enabled()).isTrue();
    }
}
