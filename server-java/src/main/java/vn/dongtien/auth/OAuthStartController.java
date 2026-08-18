package vn.dongtien.auth;

import jakarta.servlet.http.HttpSession;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.servlet.view.RedirectView;

@Controller
public class OAuthStartController {
    static final String RETURN_TO_SESSION_KEY = "oauth.returnTo";

    private final OAuthAvailability availability;

    public OAuthStartController(OAuthAvailability availability) {
        this.availability = availability;
    }

    @GetMapping("/auth/{provider}")
    RedirectView start(
            @PathVariable String provider,
            @RequestParam(required = false) String returnTo,
            HttpSession session
    ) {
        if (!availability.supports(provider)) {
            return new RedirectView("/login/?error=provider_not_configured&provider=" + provider);
        }
        session.setAttribute(RETURN_TO_SESSION_KEY, ReturnPath.safe(returnTo));
        return new RedirectView("/oauth2/authorization/" + provider);
    }
}
