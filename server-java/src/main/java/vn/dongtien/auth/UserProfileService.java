package vn.dongtien.auth;

import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;

@Service
public class UserProfileService {
    private final DocumentStore documents;
    private final ObjectMapper mapper;

    public UserProfileService(DocumentStore documents, ObjectMapper mapper) {
        this.documents = documents;
        this.mapper = mapper;
    }

    public Map<String, Object> apply(Map<String, Object> user) {
        if (user == null || !(user.get("id") instanceof String userId) || userId.isBlank()) return user;

        Map<String, Object> result = new LinkedHashMap<>(user);
        documents.find(profileKey(userId)).ifPresent(profile -> applyProfile(result, profile));
        return result;
    }

    public void update(String userId, String displayName, String avatar) {
        ObjectNode profile = mapper.createObjectNode();
        profile.put("displayName", displayName);
        if (avatar == null) profile.putNull("avatar");
        else profile.put("avatar", avatar);
        documents.put(profileKey(userId), profile);
    }

    private static void applyProfile(Map<String, Object> user, JsonNode profile) {
        String displayName = text(profile.get("displayName"));
        if (displayName != null) user.put("name", displayName);

        JsonNode avatar = profile.get("avatar");
        if (avatar != null && (avatar.isNull() || avatar.isTextual())) {
            user.put("avatar", avatar.isNull() ? null : text(avatar));
        }
    }

    private static String profileKey(String userId) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(userId.getBytes(StandardCharsets.UTF_8));
            return "profile:" + java.util.HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private static String text(JsonNode value) {
        if (value == null || !value.isTextual()) return null;
        String text = value.asText().trim();
        return text.isEmpty() ? null : text;
    }
}
