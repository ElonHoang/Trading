package vn.dongtien.auth;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.security.config.oauth2.client.CommonOAuth2Provider;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.registration.InMemoryClientRegistrationRepository;

@Configuration
public class OAuthClientConfig {
    private static final String REDIRECT_URI = "{baseUrl}/login/oauth2/code/{registrationId}";

    @Bean
    OAuthAvailability oauthAvailability(Environment environment) {
        return new OAuthAvailability(
                configured(environment, "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
                configured(environment, "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET")
        );
    }

    @Bean
    ClientRegistrationRepository clientRegistrationRepository(Environment environment) {
        String googleId = valueOrPlaceholder(environment, "GOOGLE_CLIENT_ID");
        String googleSecret = valueOrPlaceholder(environment, "GOOGLE_CLIENT_SECRET");
        String githubId = valueOrPlaceholder(environment, "GITHUB_CLIENT_ID");
        String githubSecret = valueOrPlaceholder(environment, "GITHUB_CLIENT_SECRET");

        ClientRegistration google = CommonOAuth2Provider.GOOGLE.getBuilder("google")
                .clientId(googleId)
                .clientSecret(googleSecret)
                .scope("openid", "profile", "email")
                .redirectUri(REDIRECT_URI)
                .clientName("Google")
                .build();

        ClientRegistration github = CommonOAuth2Provider.GITHUB.getBuilder("github")
                .clientId(githubId)
                .clientSecret(githubSecret)
                .scope("read:user", "user:email")
                .redirectUri(REDIRECT_URI)
                .clientName("GitHub")
                .build();

        return new InMemoryClientRegistrationRepository(google, github);
    }

    private static boolean configured(Environment environment, String clientId, String clientSecret) {
        return hasText(environment.getProperty(clientId)) && hasText(environment.getProperty(clientSecret));
    }

    private static String valueOrPlaceholder(Environment environment, String key) {
        String value = environment.getProperty(key);
        return hasText(value) ? value.trim() : "not-configured";
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }
}
