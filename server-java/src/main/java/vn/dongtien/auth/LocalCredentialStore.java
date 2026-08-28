package vn.dongtien.auth;

import java.util.List;
import java.util.Optional;

/**
 * Tai khoan dang nhap noi bo luu trong database.
 *
 * <p>{@code passwordHash} luon la BCrypt cost 12. Khong co duong nao trong giao
 * dien nay nhan mat khau tho, de mat khau khong tinh co bi ghi vao log hay DB.</p>
 */
public interface LocalCredentialStore {
    /** Tim theo username, khong phan biet hoa thuong. */
    Optional<LocalCredential> find(String username);

    List<LocalCredential> findAll();

    /** Them moi hoac ghi de tai khoan cung username. */
    void save(LocalCredential credential);

    boolean delete(String username);

    /** So tai khoan dang hoat dong; 0 nghia la dang nhap noi bo chua san sang. */
    int countActive();

    record LocalCredential(String username, String passwordHash, String role) {}
}
