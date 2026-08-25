package vn.dongtien.auth;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import static org.assertj.core.api.Assertions.assertThat;

class OAuthClientConfigTest {
    private final OAuthClientConfig config = new OAuthClientConfig();

    @Test
    void configuredProvidersAreAvailable() {
        assertThat(config.oauthAvailability(configuredProviders()))
                .isEqualTo(new OAuthAvailability(true, true));
    }

    @Test
    void missingCredentialsKeepOAuthUnavailable() {
        assertThat(config.oauthAvailability(new MockEnvironment()))
                .isEqualTo(new OAuthAvailability(false, false));
    }

    private static MockEnvironment configuredProviders() {
        return new MockEnvironment()
                .withProperty("GOOGLE_CLIENT_ID", "google-id")
                .withProperty("GOOGLE_CLIENT_SECRET", "google-secret")
                .withProperty("GITHUB_CLIENT_ID", "github-id")
                .withProperty("GITHUB_CLIENT_SECRET", "github-secret");
    }
}
