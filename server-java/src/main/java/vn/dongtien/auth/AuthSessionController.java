package vn.dongtien.auth;

import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
public class AuthSessionController {
    private final OAuthAvailability availability;

    public AuthSessionController(OAuthAvailability availability) {
        this.availability = availability;
    }

    @GetMapping("/api/auth/session")
    ResponseEntity<Map<String, Object>> session(Authentication authentication, CsrfToken csrfToken) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("user", user(authentication));
        body.put("providers", Map.of(
                "google", availability.google(),
                "github", availability.github()
        ));
        body.put("csrf", Map.of(
                "headerName", csrfToken.getHeaderName(),
                "token", csrfToken.getToken()
        ));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }

    private static Map<String, Object> user(Authentication authentication) {
        if (!(authentication instanceof OAuth2AuthenticationToken oauth)) return null;
        OAuth2User principal = oauth.getPrincipal();
        String provider = oauth.getAuthorizedClientRegistrationId();
        Map<String, Object> attributes = principal.getAttributes();

        String rawId = text(attributes.get(provider.equals("google") ? "sub" : "id"));
        String name = firstText(attributes.get("name"), attributes.get("login"), attributes.get("email"));
        String email = text(attributes.get("email"));
        String avatar = text(attributes.get(provider.equals("google") ? "picture" : "avatar_url"));

        Map<String, Object> user = new LinkedHashMap<>();
        user.put("id", provider + ":" + rawId);
        user.put("provider", provider);
        user.put("name", name == null ? "Người dùng " + provider : name);
        user.put("email", email);
        user.put("avatar", avatar);
        return user;
    }

    private static String firstText(Object... values) {
        for (Object value : values) {
            String text = text(value);
            if (text != null) return text;
        }
        return null;
    }

    private static String text(Object value) {
        if (value == null) return null;
        String text = value.toString().trim();
        return text.isEmpty() ? null : text;
    }
}
