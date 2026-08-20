package vn.dongtien.auth;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.scheduling.annotation.EnableScheduling;

import java.util.Set;

@SpringBootApplication(scanBasePackages = "vn.dongtien")
@EnableScheduling
public class AuthApplication {
    public static void main(String[] args) {
        SpringApplication application = new SpringApplication(AuthApplication.class);
        if (args.length > 0 && Set.of("analyze", "backtest", "train", "daily-review", "diagnose-sl",
                "validate-filters", "research-patterns", "import-files", "models-index", "migrate", "bot",
                "alerts-once").contains(args[0])) {
            application.setWebApplicationType(WebApplicationType.NONE);
        }
        application.run(args);
    }
}
