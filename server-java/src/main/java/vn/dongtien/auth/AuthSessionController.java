package vn.dongtien.auth;

import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
public class AuthSessionController {
    private final OAuthAvailability availability;
    private final LocalAuthAvailability localAuthAvailability;
    private final UserProfileService profiles;

    public AuthSessionController(
            OAuthAvailability availability,
            LocalAuthAvailability localAuthAvailability,
            UserProfileService profiles
    ) {
        this.availability = availability;
        this.localAuthAvailability = localAuthAvailability;
        this.profiles = profiles;
    }

    @GetMapping("/api/auth/session")
    ResponseEntity<Map<String, Object>> session(Authentication authentication, CsrfToken csrfToken) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("user", profiles.apply(currentUser(authentication)));
        body.put("providers", Map.of(
                "google", availability.google(),
                "github", availability.github(),
                "password", localAuthAvailability.enabled()
        ));
        body.put("csrf", Map.of(
                "headerName", csrfToken.getHeaderName(),
                "parameterName", csrfToken.getParameterName(),
                "token", csrfToken.getToken()
        ));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }

    static Map<String, Object> currentUser(Authentication authentication) {
        if (authentication instanceof UsernamePasswordAuthenticationToken local && local.isAuthenticated()) {
            String username = text(local.getName());
            if (username == null) return null;

            Map<String, Object> user = new LinkedHashMap<>();
            user.put("id", "password:" + username);
            user.put("provider", "password");
            user.put("name", username);
            user.put("email", null);
            user.put("avatar", null);
            appendAccess(user, authentication);
            return user;
        }

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
        appendAccess(user, authentication);
        return user;
    }

    private static void appendAccess(Map<String, Object> user, Authentication authentication) {
        List<String> roles = authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .filter(authority -> authority.startsWith("ROLE_"))
                .sorted()
                .toList();
        user.put("roles", roles);
        user.put("canWrite", roles.contains("ROLE_ADMIN"));
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
