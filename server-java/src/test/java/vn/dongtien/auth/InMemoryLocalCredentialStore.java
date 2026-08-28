package vn.dongtien.auth;

import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Ban thay the {@link LocalCredentialStore} cho test, giu dung hai hanh vi ma
 * bang that quy dinh: khoa theo username chu thuong, va chi tra ve tai khoan dang
 * hoat dong.
 */
class InMemoryLocalCredentialStore implements LocalCredentialStore {
    private final Map<String, LocalCredential> rows = new ConcurrentHashMap<>();

    @Override
    public Optional<LocalCredential> find(String username) {
        if (username == null || username.isBlank()) return Optional.empty();
        return Optional.ofNullable(rows.get(normalize(username)));
    }

    @Override
    public List<LocalCredential> findAll() {
        return rows.values().stream()
                .sorted(Comparator.comparing(LocalCredential::role).thenComparing(LocalCredential::username))
                .toList();
    }

    @Override
    public void save(LocalCredential credential) {
        rows.put(normalize(credential.username()), credential);
    }

    @Override
    public boolean delete(String username) {
        return username != null && rows.remove(normalize(username)) != null;
    }

    @Override
    public int countActive() {
        return rows.size();
    }

    private static String normalize(String username) {
        return username.trim().toLowerCase(Locale.ROOT);
    }
}
