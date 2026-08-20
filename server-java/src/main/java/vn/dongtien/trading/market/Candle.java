package vn.dongtien.trading.market;

public record Candle(
        long openTime,
        double open,
        double high,
        double low,
        double close,
        double volume,
        long closeTime,
        double quoteVolume,
        long trades,
        Double takerBuyVolume,
        boolean closed,
        String market
) {}
