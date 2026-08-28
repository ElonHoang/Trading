package vn.dongtien.auth;

import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * Doc/ghi bang {@code local_credential} tren TiDB Cloud.
 *
 * <p>Cot {@code username_normalized} do database sinh ra, nen moi truy van deu
 * so sanh tren ban chu thuong va khong the lech voi rang buoc UNIQUE.</p>
 */
@Repository
@Profile("!test & !demo")
public class TidbLocalCredentialStore implements LocalCredentialStore {
    private final JdbcTemplate jdbc;

    public TidbLocalCredentialStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public Optional<LocalCredential> find(String username) {
        if (username == null || username.isBlank()) return Optional.empty();
        return jdbc.query("""
                        SELECT username, password_hash, role
                        FROM local_credential
                        WHERE username_normalized = ? AND status = 'active'
                        """,
                (result, row) -> new LocalCredential(result.getString(1), result.getString(2), result.getString(3)),
                normalize(username)).stream().findFirst();
    }

    @Override
    public List<LocalCredential> findAll() {
        return jdbc.query("""
                        SELECT username, password_hash, role
                        FROM local_credential
                        WHERE status = 'active'
                        ORDER BY role ASC, username_normalized ASC
                        """,
                (result, row) -> new LocalCredential(result.getString(1), result.getString(2), result.getString(3)));
    }

    @Override
    public void save(LocalCredential credential) {
        jdbc.update("""
                INSERT INTO local_credential (username, password_hash, role, status)
                VALUES (?, ?, ?, 'active')
                ON DUPLICATE KEY UPDATE
                  password_hash = ?, role = ?, status = 'active',
                  updated_at = CURRENT_TIMESTAMP(6)
                """,
                credential.username(), credential.passwordHash(), credential.role(),
                credential.passwordHash(), credential.role());
    }

    @Override
    public boolean delete(String username) {
        if (username == null || username.isBlank()) return false;
        return jdbc.update("DELETE FROM local_credential WHERE username_normalized = ?", normalize(username)) > 0;
    }

    @Override
    public int countActive() {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM local_credential WHERE status = 'active'", Integer.class);
        return count == null ? 0 : count;
    }

    private static String normalize(String username) {
        return username.trim().toLowerCase(Locale.ROOT);
    }
}
