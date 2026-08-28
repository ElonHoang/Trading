package vn.dongtien.auth;

import java.util.function.BooleanSupplier;

/**
 * Cho biet dang nhap noi bo co dung duoc khong.
 *
 * <p>Tai khoan nam trong database va duoc them bang CLI o tien trinh khac, nen
 * cau tra loi phai duoc tinh lai luc chay chu khong chot mot lan luc khoi dong.</p>
 */
public class LocalAuthAvailability {
    private final BooleanSupplier source;

    public LocalAuthAvailability(boolean enabled) {
        this(() -> enabled);
    }

    public LocalAuthAvailability(BooleanSupplier source) {
        this.source = source;
    }

    public boolean enabled() {
        return source.getAsBoolean();
    }
}
