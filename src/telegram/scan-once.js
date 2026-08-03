// Entry point cho GitHub Actions: quét đúng một lượt rồi thoát.
// Dùng file riêng thay vì cú pháp gán biến môi trường của shell để script cũng
// chạy được trên Windows khi cần kiểm tra thủ công.

process.env.BOT_SCAN_ONCE = '1';
await import('./bot.js');
