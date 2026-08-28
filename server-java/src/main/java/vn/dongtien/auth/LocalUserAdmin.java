package vn.dongtien.auth;

import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.nio.CharBuffer;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Quan ly tai khoan dang nhap noi bo trong database.
 *
 * <p>Mat khau tho chi ton tai trong mang {@code char[]} do nguoi goi cap va bi
 * xoa ngay sau khi bam, nen no khong di vao log, khong vao database va khong
 * nam lai trong doi tuong tra ve.</p>
 */
@Service
public class LocalUserAdmin {
    /** Du dai de mot mat khau ngau nhien khong bi do trong khi BCrypt cost 12 van cham. */
    static final int MIN_PASSWORD_LENGTH = 10;
    private static final Set<String> ROLES = Set.of("ADMIN", "VIEWER");

    private final LocalCredentialStore store;
    private final PasswordEncoder encoder;

    public LocalUserAdmin(LocalCredentialStore store, PasswordEncoder encoder) {
        this.store = store;
        this.encoder = encoder;
    }

    /** Them tai khoan moi hoac dat lai mat khau/quyen cua tai khoan cung ten. */
    public Map<String, Object> save(String username, String role, char[] password) {
        try {
            String cleanUsername = requireUsername(username);
            String cleanRole = requireRole(role);
            requirePassword(password);
            store.save(new LocalCredentialStore.LocalCredential(
                    cleanUsername, encoder.encode(CharBuffer.wrap(password)), cleanRole));
            return ordered("username", cleanUsername, "role", cleanRole, "status", "saved");
        } finally {
            Arrays.fill(password, '\0');
        }
    }

    /** Danh sach tai khoan; khong bao gio kem theo hash. */
    public List<Map<String, Object>> list() {
        return store.findAll().stream()
                .map(row -> ordered("username", row.username(), "role", row.role()))
                .toList();
    }

    /**
     * Xoa mot tai khoan.
     *
     * <p>Tu choi xoa admin cuoi cung: lam vay se khoa tat ca moi nguoi ra ngoai va
     * chi con cach dung CLI de vao lai.</p>
     */
    public Map<String, Object> remove(String username) {
        String cleanUsername = requireUsername(username);
        List<LocalCredentialStore.LocalCredential> all = store.findAll();
        boolean isLastAdmin = all.stream()
                .filter(row -> "ADMIN".equals(row.role()))
                .allMatch(row -> row.username().equalsIgnoreCase(cleanUsername))
                && all.stream().anyMatch(row -> row.username().equalsIgnoreCase(cleanUsername)
                        && "ADMIN".equals(row.role()));
        if (isLastAdmin) {
            throw new IllegalArgumentException(
                    "Khong xoa duoc admin cuoi cung. Tao admin khac truoc roi hay xoa tai khoan nay.");
        }
        boolean removed = store.delete(cleanUsername);
        return ordered("username", cleanUsername, "status", removed ? "removed" : "not-found");
    }

    private static String requireUsername(String username) {
        String value = username == null ? "" : username.trim();
        if (!LocalAuthConfig.USERNAME.matcher(value).matches()) {
            throw new IllegalArgumentException(
                    "Username phai dai 3-64 ky tu, bat dau bang chu hoac so, chi chua chu so . _ -");
        }
        return value;
    }

    private static String requireRole(String role) {
        String value = role == null ? "" : role.trim().toUpperCase(Locale.ROOT);
        if (!ROLES.contains(value)) {
            throw new IllegalArgumentException("Role phai la admin hoac viewer.");
        }
        return value;
    }

    private static void requirePassword(char[] password) {
        if (password == null || password.length < MIN_PASSWORD_LENGTH) {
            throw new IllegalArgumentException("Mat khau phai dai it nhat " + MIN_PASSWORD_LENGTH + " ky tu.");
        }
    }

    private static Map<String, Object> ordered(String... pairs) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) result.put(pairs[index], pairs[index + 1]);
        return result;
    }
}
