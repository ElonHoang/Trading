package vn.dongtien.auth;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.ActiveProfiles;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.forwardedUrl;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:mysql://localhost:1/test",
        "spring.datasource.username=test",
        "spring.datasource.password=test",
        "spring.flyway.enabled=false",
        "spring.datasource.hikari.initialization-fail-timeout=-1",
        "LOCAL_AUTH_ADMIN_USERNAME=admin",
        "LOCAL_AUTH_ADMIN_PASSWORD_HASH=$2b$12$nGARqvlfzhfMrlcXjA9S6O7Wbpj3EJu6W89VIZRpFApjdY/Et8U/q",
        "LOCAL_AUTH_VIEWER_USERNAME=viewer",
        "LOCAL_AUTH_VIEWER_PASSWORD_HASH=$2b$12$nGARqvlfzhfMrlcXjA9S6O7Wbpj3EJu6W89VIZRpFApjdY/Et8U/q"
})
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(AuthSessionControllerTest.DatabaseTestConfiguration.class)
class AuthSessionControllerTest {
    @Autowired
    private MockMvc mockMvc;

    @Test
    void anonymousSessionOnlyReturnsPublicAuthState() throws Exception {
        mockMvc.perform(get("/api/auth/session"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.user").doesNotExist())
                .andExpect(jsonPath("$.providers.google").isBoolean())
                .andExpect(jsonPath("$.providers.github").isBoolean())
                .andExpect(jsonPath("$.providers.password").value(true))
                .andExpect(jsonPath("$.csrf.headerName").isString())
                .andExpect(jsonPath("$.csrf.parameterName").isString())
                .andExpect(jsonPath("$.csrf.token").isString());
    }

    @Test
    void healthEndpointAnswersPlatformProbesWithoutLogin() throws Exception {
        mockMvc.perform(get("/healthz"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"));
    }

    @Test
    void usernamePasswordLoginRedirectsToSafeReturnPath() throws Exception {
        MvcResult login = mockMvc.perform(post("/auth/login")
                        .with(csrf())
                        .param("username", "admin")
                        .param("password", "correct-password")
                        .param("returnTo", "/realtime/"))
                .andExpect(status().is3xxRedirection())
                .andExpect(header().string("Location", "/realtime/"))
                .andReturn();

        MockHttpSession session = (MockHttpSession) login.getRequest().getSession(false);
        assertThat(session).isNotNull();
        mockMvc.perform(get("/api/auth/session").session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.user.provider").value("password"))
                .andExpect(jsonPath("$.user.name").value("admin"))
                .andExpect(jsonPath("$.user.canWrite").value(true))
                .andExpect(jsonPath("$.user.roles[0]").value("ROLE_ADMIN"));
    }

    @Test
    void usernamePasswordLoginRequiresCsrfToken() throws Exception {
        mockMvc.perform(post("/auth/login")
                        .param("username", "admin")
                        .param("password", "correct-password"))
                .andExpect(status().isForbidden());
    }

    @Test
    void usernamePasswordLoginRejectsInvalidCredentialsWithoutLeakingDetails() throws Exception {
        mockMvc.perform(post("/auth/login")
                        .with(csrf())
                        .param("username", "admin")
                        .param("password", "wrong-password")
                        .param("returnTo", "/realtime/"))
                .andExpect(status().is3xxRedirection())
                .andExpect(header().string("Location", "/login/?error=invalid_credentials&returnTo=%2Frealtime%2F"));
    }

    @Test
    void usernamePasswordLoginRejectsExternalReturnPath() throws Exception {
        mockMvc.perform(post("/auth/login")
                        .with(csrf())
                        .param("username", "admin")
                        .param("password", "correct-password")
                        .param("returnTo", "/\\evil.example"))
                .andExpect(status().is3xxRedirection())
                .andExpect(header().string("Location", "/"));
    }

    @Test
    void anonymousProtectedRoutesRedirectToLogin() throws Exception {
        mockMvc.perform(get("/"))
                .andExpect(status().is3xxRedirection());
        mockMvc.perform(get("/api/intervals"))
                .andExpect(status().is3xxRedirection());
    }

    @Test
    void viewerCanReadButCannotModifyWatchlist() throws Exception {
        MockHttpSession session = login("viewer");

        mockMvc.perform(get("/api/auth/session").session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.user.canWrite").value(false))
                .andExpect(jsonPath("$.user.roles[0]").value("ROLE_VIEWER"));
        mockMvc.perform(get("/api/intervals").session(session))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/watchlist")
                        .session(session)
                        .with(csrf())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"symbol\":\"BTCUSDT\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void everyAuthenticatedUserCanUpdateOnlyTheirOwnDisplayNameAndAvatar() throws Exception {
        mockMvc.perform(patch("/api/auth/profile")
                        .with(user("viewer").roles("VIEWER"))
                        .with(csrf())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"Trader Troc\",\"avatar\":null}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.user.name").value("Trader Troc"))
                .andExpect(jsonPath("$.user.avatar").doesNotExist());
    }

    @Test
    void profileUpdateRejectsAnyFieldOutsideDisplayNameAndAvatar() throws Exception {
        mockMvc.perform(patch("/api/auth/profile")
                        .with(user("admin").roles("ADMIN"))
                        .with(csrf())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"Admin Yii\",\"avatar\":null,\"email\":\"x@example.com\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void adminRequiresCsrfAndCanModifyAndDeleteWatchlist() throws Exception {
        MockHttpSession session = login("admin");

        mockMvc.perform(post("/api/watchlist")
                        .session(session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"symbol\":\"BTCUSDT\"}"))
                .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/watchlist")
                        .session(session)
                        .with(csrf())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"symbol\":\"BTCUSDT\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0]").value("BTCUSDT"));
        mockMvc.perform(delete("/api/watchlist/BTCUSDT").session(session).with(csrf()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isEmpty());
    }

    @Test
    void loginRouteForwardsToThePackagedPage() throws Exception {
        mockMvc.perform(get("/login/"))
                .andExpect(status().isOk())
                .andExpect(forwardedUrl("/login/index.html"));
    }

    @Test
    void logoutRequiresAndAcceptsCsrfToken() throws Exception {
        mockMvc.perform(post("/auth/logout").with(user("admin").roles("ADMIN")).with(csrf()))
                .andExpect(status().isNoContent());
    }

    @Test
    void tradingPerformanceRejectsUnknownRange() throws Exception {
        mockMvc.perform(get("/api/trading-performance").param("range", "quarter")
                        .with(user("viewer").roles("VIEWER")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("range chỉ nhận week, month hoặc year"));
    }

    private MockHttpSession login(String username) throws Exception {
        MvcResult result = mockMvc.perform(post("/auth/login")
                        .with(csrf())
                        .param("username", username)
                        .param("password", "correct-password"))
                .andExpect(status().is3xxRedirection())
                .andReturn();
        MockHttpSession session = (MockHttpSession) result.getRequest().getSession(false);
        assertThat(session).isNotNull();
        return session;
    }

    @TestConfiguration
    static class DatabaseTestConfiguration {
        /** Khong co tai khoan trong database: cac test o day dung tai khoan khai bang bien moi truong. */
        @Bean
        LocalCredentialStore localCredentialStore() {
            return new InMemoryLocalCredentialStore();
        }

        @Bean
        DocumentStore documentStore(ObjectMapper mapper) {
            Map<String, JsonNode> values = new ConcurrentHashMap<>();
            values.put("config:strategy", mapper.valueToTree(Map.of(
                    "alerts", Map.of("tradeSymbols", List.of("BTCUSDT"))
            )));
            return new DocumentStore() {
                @Override
                public Optional<JsonNode> find(String key) {
                    return Optional.ofNullable(values.get(key));
                }

                @Override
                public List<StoredDocument> findByPrefix(String prefix) {
                    return values.entrySet().stream()
                            .filter(entry -> entry.getKey().startsWith(prefix))
                            .map(entry -> new StoredDocument(entry.getKey(), entry.getValue()))
                            .sorted(Comparator.comparing(StoredDocument::key))
                            .toList();
                }

                @Override
                public void put(String key, JsonNode value) {
                    values.put(key, value);
                }

                @Override
                public boolean delete(String key) {
                    return values.remove(key) != null;
                }
            };
        }
    }
}
