package vn.dongtien.auth;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.context.ActiveProfiles;
import tools.jackson.databind.JsonNode;

import java.util.List;
import java.util.Optional;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.forwardedUrl;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:postgresql://localhost:1/test",
        "spring.datasource.username=test",
        "spring.datasource.password=test"
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
                .andExpect(jsonPath("$.csrf.headerName").isString())
                .andExpect(jsonPath("$.csrf.token").isString());
    }

    @Test
    void loginRouteForwardsToThePackagedPage() throws Exception {
        mockMvc.perform(get("/login/"))
                .andExpect(status().isOk())
                .andExpect(forwardedUrl("/login/index.html"));
    }

    @Test
    void logoutRequiresAndAcceptsCsrfToken() throws Exception {
        mockMvc.perform(post("/auth/logout").with(csrf()))
                .andExpect(status().isNoContent());
    }

    @Test
    void tradingPerformanceRejectsUnknownRange() throws Exception {
        mockMvc.perform(get("/api/trading-performance").param("range", "quarter"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("range chỉ nhận week, month hoặc year"));
    }

    @TestConfiguration
    static class DatabaseTestConfiguration {
        @Bean
        DocumentStore documentStore() {
            return new DocumentStore() {
                @Override
                public Optional<JsonNode> find(String key) {
                    return Optional.empty();
                }

                @Override
                public List<StoredDocument> findByPrefix(String prefix) {
                    return List.of();
                }

                @Override
                public void put(String key, JsonNode value) {}

                @Override
                public boolean delete(String key) {
                    return false;
                }
            };
        }
    }
}
