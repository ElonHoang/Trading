package vn.dongtien.auth;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class PageController {
    @GetMapping({"/login", "/login/"})
    String login() {
        return "forward:/login/index.html";
    }

    @GetMapping({"/realtime", "/realtime/"})
    String realtime() {
        return "forward:/realtime/index.html";
    }
}
