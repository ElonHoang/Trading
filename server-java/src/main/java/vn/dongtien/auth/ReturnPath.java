package vn.dongtien.auth;

final class ReturnPath {
    private ReturnPath() {}

    static String safe(String value) {
        return value != null && value.startsWith("/") && !value.startsWith("//") && !value.contains("\\")
                && value.chars().noneMatch(Character::isISOControl)
                ? value
                : "/";
    }
}
