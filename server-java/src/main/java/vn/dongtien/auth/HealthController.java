package vn.dongtien.auth;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Liveness probe cho platform (Render health check) truoc khi dinh tuyen traffic.
 *
 * <p>Endpoint nay khong yeu cau dang nhap nen chi duoc tra ve hang so; khong lo
 * phien ban, cau hinh, trang thai database hay bat ky secret nao.</p>
 */
@RestController
public class HealthController {
    @GetMapping(value = "/healthz", produces = MediaType.APPLICATION_JSON_VALUE)
    Map<String, String> health() {
        return Map.of("status", "ok");
    }
}
