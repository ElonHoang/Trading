package vn.dongtien.auth;

import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.util.Map;
import java.util.Set;

@RestController
public class UserProfileController {
    private static final int MAX_DISPLAY_NAME_LENGTH = 80;
    private static final int MAX_AVATAR_LENGTH = 700_000;
    private static final Set<String> ACCEPTED_IMAGE_DATA_PREFIXES = Set.of(
            "data:image/png;base64,",
            "data:image/jpeg;base64,",
            "data:image/webp;base64,",
            "data:image/gif;base64,"
    );

    private final UserProfileService profiles;

    public UserProfileController(UserProfileService profiles) {
        this.profiles = profiles;
    }

    @PatchMapping("/api/auth/profile")
    ResponseEntity<?> update(Authentication authentication, @RequestBody JsonNode body) {
        Map<String, Object> user = AuthSessionController.currentUser(authentication);
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        if (!body.isObject() || body.size() != 2 || !body.has("displayName") || !body.has("avatar")) {
            return bad("Chỉ có thể cập nhật tên hiển thị và ảnh đại diện.");
        }

        String displayName = displayName(body.get("displayName"));
        if (displayName == null) return bad("Tên hiển thị phải có từ 2 đến 80 ký tự.");

        Avatar avatar = avatar(body.get("avatar"));
        if (!avatar.valid()) return bad("Ảnh đại diện phải là ảnh PNG, JPEG, WebP, GIF dung lượng tối đa 500 KB hoặc URL HTTPS.");

        profiles.update((String) user.get("id"), displayName, avatar.value());
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(Map.of("user", profiles.apply(user)));
    }

    private static String displayName(JsonNode value) {
        if (value == null || !value.isTextual()) return null;
        String text = value.asText().trim();
        if (text.length() < 2 || text.length() > MAX_DISPLAY_NAME_LENGTH
                || text.codePoints().anyMatch(Character::isISOControl)) return null;
        return text;
    }

    private static Avatar avatar(JsonNode value) {
        if (value == null || value.isNull()) return new Avatar(true, null);
        if (!value.isTextual()) return new Avatar(false, null);

        String text = value.asText().trim();
        if (text.length() > MAX_AVATAR_LENGTH) return new Avatar(false, null);
        if (ACCEPTED_IMAGE_DATA_PREFIXES.stream().anyMatch(text::startsWith)) {
            String base64 = text.substring(text.indexOf(',') + 1);
            return new Avatar(!base64.isBlank() && base64.matches("[A-Za-z0-9+/]+={0,2}"), text);
        }
        try {
            URI uri = URI.create(text);
            return new Avatar("https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null, text);
        } catch (IllegalArgumentException exception) {
            return new Avatar(false, null);
        }
    }

    private static ResponseEntity<Map<String, String>> bad(String message) {
        return ResponseEntity.badRequest().body(Map.of("error", message));
    }

    private record Avatar(boolean valid, String value) {}
}
