package vn.dongtien.auth;

public record OAuthAvailability(boolean google, boolean github) {
    public boolean supports(String provider) {
        return switch (provider) {
            case "google" -> google;
            case "github" -> github;
            default -> false;
        };
    }
}
