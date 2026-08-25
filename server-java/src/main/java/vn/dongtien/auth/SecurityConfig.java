package vn.dongtien.auth;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class SecurityConfig {
    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, OAuthSuccessHandler successHandler) throws Exception {
        http
                // The dashboard is intentionally usable without an OAuth login.  These
                // JSON endpoints replace the old same-origin Express/worker calls, so
                // they need the same CSRF-free behavior as /api/watchlist.
                .csrf(csrf -> csrf.ignoringRequestMatchers("/api/watchlist/**", "/api/analyze", "/api/backtest", "/api/train", "/api/ai/**"))
                .authorizeHttpRequests(authorize -> authorize.anyRequest().permitAll())
                .oauth2Login(oauth -> oauth
                        .loginPage("/login/")
                        .successHandler(successHandler)
                        .failureHandler((request, response, exception) ->
                                response.sendRedirect("/login/?error=oauth_failed")))
                .logout(logout -> logout
                        .logoutUrl("/auth/logout")
                        .invalidateHttpSession(true)
                        .clearAuthentication(true)
                        .deleteCookies("JSESSIONID")
                        .logoutSuccessHandler((request, response, authentication) ->
                                response.setStatus(HttpServletResponse.SC_NO_CONTENT)));
        return http.build();
    }
}
