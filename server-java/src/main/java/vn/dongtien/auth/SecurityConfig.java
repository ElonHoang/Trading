package vn.dongtien.auth;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpMethod;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter;
import org.springframework.security.web.SecurityFilterChain;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;

@Configuration
public class SecurityConfig {
    @Bean
    SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            OAuthSuccessHandler successHandler,
            OAuthAvailability oauthAvailability
    ) throws Exception {
        http
                // Browser state-changing requests use the CSRF token from /api/auth/session.
                .authorizeHttpRequests(authorize -> authorize
                        .requestMatchers("/login", "/login/", "/login/**", "/oauth2/**", "/login/oauth2/**", "/error", "/favicon.ico").permitAll()
                        .requestMatchers(HttpMethod.GET, "/auth/google", "/auth/github").permitAll()
                        .requestMatchers(HttpMethod.POST, "/auth/login").permitAll()
                        .requestMatchers(HttpMethod.POST, "/auth/logout").authenticated()
                        .requestMatchers(HttpMethod.GET, "/api/auth/session").permitAll()
                        .requestMatchers(HttpMethod.PATCH, "/api/auth/profile").authenticated()
                        .requestMatchers(HttpMethod.POST, "/api/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.PUT, "/api/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.PATCH, "/api/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.DELETE, "/api/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.GET, "/api/**").hasAnyRole("ADMIN", "VIEWER")
                        .requestMatchers("/", "/index.html", "/web/**", "/realtime", "/realtime/**")
                        .hasAnyRole("ADMIN", "VIEWER")
                        .anyRequest().denyAll())
                .sessionManagement(session -> session
                        .sessionFixation(fixation -> fixation.migrateSession()))
                .headers(headers -> headers
                        .contentSecurityPolicy(policy -> policy.policyDirectives(
                                "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"))
                        .frameOptions(frame -> frame.deny())
                        .referrerPolicy(referrer -> referrer.policy(
                                ReferrerPolicyHeaderWriter.ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN)))
                .formLogin(form -> form
                        .loginPage("/login/")
                        .loginProcessingUrl("/auth/login")
                        .successHandler((request, response, authentication) ->
                                response.sendRedirect(ReturnPath.safe(request.getParameter("returnTo"))))
                        .failureHandler((request, response, exception) ->
                                response.sendRedirect(loginFailureUrl(request.getParameter("returnTo"))))
                        .permitAll())
                .logout(logout -> logout
                        .logoutUrl("/auth/logout")
                        .invalidateHttpSession(true)
                        .clearAuthentication(true)
                        .deleteCookies("JSESSIONID")
                        .logoutSuccessHandler((request, response, authentication) ->
                                response.setStatus(HttpServletResponse.SC_NO_CONTENT)));
        if (oauthAvailability.enabled()) {
            http.oauth2Login(oauth -> oauth
                    .loginPage("/login/")
                    .userInfoEndpoint(userInfo -> userInfo.userAuthoritiesMapper(authorities -> {
                        Set<GrantedAuthority> mapped = new LinkedHashSet<>(authorities);
                        mapped.add(new SimpleGrantedAuthority("ROLE_VIEWER"));
                        return mapped;
                    }))
                    .successHandler(successHandler)
                    .failureHandler((request, response, exception) ->
                            response.sendRedirect("/login/?error=oauth_failed")));
        }
        return http.build();
    }

    private static String loginFailureUrl(String returnTo) {
        return "/login/?error=invalid_credentials&returnTo="
                + URLEncoder.encode(ReturnPath.safe(returnTo), StandardCharsets.UTF_8);
    }
}
