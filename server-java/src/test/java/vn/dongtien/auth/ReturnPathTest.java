package vn.dongtien.auth;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ReturnPathTest {
    @Test
    void onlyAllowsLocalAbsolutePaths() {
        assertThat(ReturnPath.safe("/?symbol=BTC")).isEqualTo("/?symbol=BTC");
        assertThat(ReturnPath.safe("/realtime/")).isEqualTo("/realtime/");
        assertThat(ReturnPath.safe("https://example.com")).isEqualTo("/");
        assertThat(ReturnPath.safe("//example.com")).isEqualTo("/");
        assertThat(ReturnPath.safe("/\\example.com")).isEqualTo("/");
        assertThat(ReturnPath.safe("/\nexample.com")).isEqualTo("/");
        assertThat(ReturnPath.safe(null)).isEqualTo("/");
    }
}
