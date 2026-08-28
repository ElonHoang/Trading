package vn.dongtien.auth;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LocalAuthConfigTest {
    private static final String BCRYPT_12 = "$2b$12$nGARqvlfzhfMrlcXjA9S6O7Wbpj3EJu6W89VIZRpFApjdY/Et8U/q";

    private final LocalAuthConfig config = new LocalAuthConfig();
    private final InMemoryLocalCredentialStore credentials = new InMemoryLocalCredentialStore();

    private static MockEnvironment bothRolesConfigured(String hash) {
        return new MockEnvironment()
                .withProperty("LOCAL_AUTH_ADMIN_USERNAME", "admin")
                .withProperty("LOCAL_AUTH_ADMIN_PASSWORD_HASH", hash)
                .withProperty("LOCAL_AUTH_VIEWER_USERNAME", "viewer")
                .withProperty("LOCAL_AUTH_VIEWER_PASSWORD_HASH", hash);
    }

    @Test
    void localLoginStaysDisabledWhenNoAccountExistsAnywhere() {
        assertThat(config.localAuthAvailability(new MockEnvironment(), credentials).enabled()).isFalse();
    }

    @Test
    void localLoginTurnsOnWhenTheDatabaseHasAnAccount() {
        credentials.save(new LocalCredentialStore.LocalCredential("hoangnv", BCRYPT_12, "ADMIN"));

        assertThat(config.localAuthAvailability(new MockEnvironment(), credentials).enabled()).isTrue();
    }

    @Test
    void databaseAccountsSignInAndKeepTheirRole() {
        credentials.save(new LocalCredentialStore.LocalCredential("hoangnv", BCRYPT_12, "ADMIN"));
        UserDetailsService users = config.localUserDetailsService(new MockEnvironment(), credentials);

        assertThat(config.passwordEncoder().matches("correct-password",
                users.loadUserByUsername("hoangnv").getPassword())).isTrue();
        assertThat(users.loadUserByUsername("hoangnv").getAuthorities())
                .extracting(GrantedAuthority::getAuthority)
                .containsExactly("ROLE_ADMIN");
    }

    @Test
    void databaseAccountsAreFoundWhateverTheTypedCase() {
        credentials.save(new LocalCredentialStore.LocalCredential("hoangnv", BCRYPT_12, "VIEWER"));
        UserDetailsService users = config.localUserDetailsService(new MockEnvironment(), credentials);

        assertThat(users.loadUserByUsername("HoAnGnV").getUsername()).isEqualTo("hoangnv");
    }

    @Test
    void unknownUsernameIsRejectedRatherThanSilentlyAccepted() {
        credentials.save(new LocalCredentialStore.LocalCredential("hoangnv", BCRYPT_12, "ADMIN"));
        UserDetailsService users = config.localUserDetailsService(new MockEnvironment(), credentials);

        assertThatThrownBy(() -> users.loadUserByUsername("nguoila"))
                .isInstanceOf(UsernameNotFoundException.class);
    }

    @Test
    void aDatabaseAccountWinsOverAnEnvironmentAccountOfTheSameName() {
        credentials.save(new LocalCredentialStore.LocalCredential("admin", BCRYPT_12, "VIEWER"));
        UserDetailsService users = config.localUserDetailsService(bothRolesConfigured(BCRYPT_12), credentials);

        // The environment declares admin as ROLE_ADMIN; the stored row is the one that counts.
        assertThat(users.loadUserByUsername("admin").getAuthorities())
                .extracting(GrantedAuthority::getAuthority)
                .containsExactly("ROLE_VIEWER");
    }

    @Test
    void environmentAccountsKeepWorkingForDeploymentsThatAlreadyUseThem() {
        MockEnvironment environment = bothRolesConfigured(BCRYPT_12);

        LocalAuthAvailability availability = config.localAuthAvailability(environment, credentials);
        UserDetailsService users = config.localUserDetailsService(environment, credentials);

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
    void localLoginRejectsPartialAccountConfiguration() {
        MockEnvironment environment = new MockEnvironment()
                .withProperty("LOCAL_AUTH_ADMIN_USERNAME", "admin");

        assertThatThrownBy(() -> config.localAuthAvailability(environment, credentials))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void localLoginAcceptsHashesQuotedForDockerCompose() {
        assertThat(config.localAuthAvailability(bothRolesConfigured("'" + BCRYPT_12 + "'"), credentials).enabled()).isTrue();
    }

    @Test
    void localLoginStaysOffWithoutBlowingUpWhenTheDatabaseIsUnreachable() {
        assertThat(config.localAuthAvailability(new MockEnvironment(), unreachable()).enabled()).isFalse();
    }

    @Test
    void environmentAccountsKeepWorkingWhileTheDatabaseIsUnreachable() {
        assertThat(config.localAuthAvailability(bothRolesConfigured(BCRYPT_12), unreachable()).enabled()).isTrue();
    }

    /** Cua hang tra loi nhu TiDB Cloud luc mat ket noi: nem loi thay vi tra ve 0. */
    private static LocalCredentialStore unreachable() {
        return new InMemoryLocalCredentialStore() {
            @Override
            public int countActive() {
                throw new DataAccessResourceFailureException("TiDB Cloud khong phan hoi");
            }
        };
    }
}
