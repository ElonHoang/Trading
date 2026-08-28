package vn.dongtien.auth;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LocalUserAdminTest {
    // Cost 4 giu test nhanh; cost that cua ung dung do LocalAuthConfig.passwordEncoder quyet dinh.
    private final PasswordEncoder encoder = new BCryptPasswordEncoder(4);
    private final InMemoryLocalCredentialStore store = new InMemoryLocalCredentialStore();
    private final LocalUserAdmin admin = new LocalUserAdmin(store, encoder);

    private static char[] password(String value) {
        return value.toCharArray();
    }

    @Test
    void storesOnlyAHashAndNeverTheTypedPassword() {
        admin.save("hoangnv", "admin", password("mat-khau-du-dai"));

        LocalCredentialStore.LocalCredential stored = store.find("hoangnv").orElseThrow();
        assertThat(stored.passwordHash()).isNotEqualTo("mat-khau-du-dai").startsWith("$2");
        assertThat(encoder.matches("mat-khau-du-dai", stored.passwordHash())).isTrue();
        assertThat(stored.role()).isEqualTo("ADMIN");
    }

    @Test
    void wipesTheCallerPasswordBufferOnceItIsHashed() {
        char[] buffer = password("mat-khau-du-dai");

        admin.save("hoangnv", "admin", buffer);

        assertThat(buffer).containsOnly('\0');
    }

    @Test
    void wipesThePasswordBufferEvenWhenTheAccountIsRejected() {
        char[] buffer = password("mat-khau-du-dai");

        assertThatThrownBy(() -> admin.save("x", "admin", buffer))
                .isInstanceOf(IllegalArgumentException.class);

        assertThat(buffer).containsOnly('\0');
    }

    @Test
    void listNeverExposesPasswordHashes() {
        admin.save("hoangnv", "admin", password("mat-khau-du-dai"));

        assertThat(admin.list()).singleElement().satisfies(row -> {
            assertThat(row).containsOnlyKeys("username", "role");
            assertThat(row).containsEntry("username", "hoangnv");
        });
    }

    @Test
    void savingAnExistingUsernameReplacesThePasswordInsteadOfAddingARow() {
        admin.save("hoangnv", "admin", password("mat-khau-cu-dai"));
        admin.save("hoangnv", "admin", password("mat-khau-moi-dai"));

        assertThat(store.countActive()).isEqualTo(1);
        assertThat(encoder.matches("mat-khau-moi-dai", store.find("hoangnv").orElseThrow().passwordHash())).isTrue();
    }

    @Test
    void refusesPasswordsShortEnoughToGuess() {
        assertThatThrownBy(() -> admin.save("hoangnv", "admin", password("ngan")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining(String.valueOf(LocalUserAdmin.MIN_PASSWORD_LENGTH));
    }

    @Test
    void refusesUsernamesTheLoginTableCannotHold() {
        assertThatThrownBy(() -> admin.save("co khoang trang", "admin", password("mat-khau-du-dai")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> admin.save("ab", "admin", password("mat-khau-du-dai")))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void refusesRolesOutsideTheTableConstraint() {
        assertThatThrownBy(() -> admin.save("hoangnv", "superuser", password("mat-khau-du-dai")))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void refusesToRemoveTheLastAdminSoNobodyIsLockedOut() {
        admin.save("hoangnv", "admin", password("mat-khau-du-dai"));
        admin.save("nguoixem", "viewer", password("mat-khau-du-dai"));

        assertThatThrownBy(() -> admin.remove("hoangnv"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("admin cuoi cung");
        assertThat(store.find("hoangnv")).isPresent();
    }

    @Test
    void removesAnAdminOnceAnotherAdminExists() {
        admin.save("hoangnv", "admin", password("mat-khau-du-dai"));
        admin.save("duphong", "admin", password("mat-khau-du-dai"));

        assertThat(admin.remove("hoangnv")).containsEntry("status", "removed");
        assertThat(store.find("hoangnv")).isEmpty();
    }

    @Test
    void removingAViewerIsAlwaysAllowed() {
        admin.save("hoangnv", "admin", password("mat-khau-du-dai"));
        admin.save("nguoixem", "viewer", password("mat-khau-du-dai"));

        assertThat(admin.remove("nguoixem")).containsEntry("status", "removed");
    }

    @Test
    void reportsWhenThereWasNothingToRemove() {
        admin.save("hoangnv", "admin", password("mat-khau-du-dai"));

        assertThat(admin.remove("khongtontai")).containsEntry("status", "not-found");
    }
}
