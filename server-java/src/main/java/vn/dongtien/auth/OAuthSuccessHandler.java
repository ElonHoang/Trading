package vn.dongtien.auth;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.authentication.AuthenticationSuccessHandler;
import org.springframework.stereotype.Component;

import java.io.IOException;

@Component
public class OAuthSuccessHandler implements AuthenticationSuccessHandler {
    @Override
    public void onAuthenticationSuccess(
            HttpServletRequest request,
            HttpServletResponse response,
            Authentication authentication
    ) throws IOException, ServletException {
        HttpSession session = request.getSession(false);
        Object stored = session == null ? null : session.getAttribute(OAuthStartController.RETURN_TO_SESSION_KEY);
        if (session != null) session.removeAttribute(OAuthStartController.RETURN_TO_SESSION_KEY);
        response.sendRedirect(ReturnPath.safe(stored instanceof String path ? path : null));
    }
}
