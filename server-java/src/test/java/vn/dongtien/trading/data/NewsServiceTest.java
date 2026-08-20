package vn.dongtien.trading.data;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class NewsServiceTest {
    @Test
    void parsesCdataAndTruncatesDescriptionsLikeTheFormerRssReader() {
        String xml = "<rss><channel><item><title><![CDATA[Solana listing]]></title>"
                + "<link>https://example.test/item</link><pubDate>today</pubDate>"
                + "<description><![CDATA[<b>Useful</b> context]]></description></item></channel></rss>";

        List<Map<String, Object>> items = NewsService.parseItems(xml, "Test feed");

        assertEquals(1, items.size());
        assertEquals("Solana listing", items.get(0).get("title"));
        assertEquals("Useful context", items.get(0).get("desc"));
        assertEquals("Test feed", items.get(0).get("source"));
    }
}
