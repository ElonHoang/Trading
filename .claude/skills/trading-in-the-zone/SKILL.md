---
name: trading-in-the-zone
description: Lớp kỷ luật thực thi và quản trị rủi ro cho phân tích/call crypto. Dùng sau chi-bao và tin-tuc-tokenomics khi cần chuyển setup thành quyết định, diễn giải chuỗi SL, hoặc trả lời về tâm lý giao dịch. Không tạo chỉ báo, không cộng điểm, không dự đoán chắc chắn.
---

# Kĩ năng 3 — Trading in the Zone cho crypto

Kĩ năng này áp dụng tư duy xác suất và kỷ luật thực thi vào bot crypto. Nó không phải là chỉ báo kỹ thuật và không thay thế hai kĩ năng trước.

## Nguyên tắc bắt buộc

- Mỗi lệnh là một biến cố độc lập trong một chuỗi có lợi thế thống kê; một lệnh thắng hay thua không chứng minh setup luôn đúng hoặc luôn sai.
- Chỉ dùng 7 nhóm dữ liệu đã được phép trong `chi-bao`. Không biến tâm lý, niềm tin hay cảm xúc thành điểm, trọng số, hoặc tín hiệu dự đoán giá.
- Chỉ cân nhắc vào lệnh khi `buildSetup()` đã có hướng, entry, stop loss, mục tiêu và điều kiện mất hiệu lực rõ ràng. Hướng `none` hoặc bị chặn nghĩa là đứng ngoài.
- Không dùng các từ khẳng định như “chắc thắng”, không FOMO đuổi giá, không gồng lỗ, không trả thù thị trường sau SL.
- Không tự đề xuất khối lượng, đòn bẩy hay số tiền rủi ro nếu chưa có vốn tài khoản và mức rủi ro người dùng chấp nhận cho mỗi lệnh.
- Không đổi chiến lược chỉ vì một vài lệnh thua. Mọi thay đổi cần được kiểm chứng theo thời gian và có đủ mẫu.

## Quy trình áp dụng

1. Dùng Kĩ năng 1 để đọc dữ liệu và tạo setup; dùng Kĩ năng 2 để xác nhận hoặc phủ quyết theo bối cảnh.
2. Xem setup là giả thuyết có điều kiện: nêu hướng, điểm vào, SL, TP, R:R và invalidation. Nếu các dữ liệu xung đột hoặc cổng chất lượng vào lệnh không đạt, ưu tiên không giao dịch.
3. Sau một SL, ghi nhận kết quả nhưng không suy diễn nguyên nhân từ một mẫu đơn lẻ. Giữ nguyên quy tắc đã xác định cho lệnh tiếp theo.
4. Khi có 3 SL liên tiếp, để cơ chế `autoRetune` kiểm chứng thay vì chỉnh tay theo cảm xúc. Nếu không có candidate vượt toàn bộ điều kiện an toàn, giữ nguyên cấu hình.
5. Diễn đạt cho người dùng bằng xác suất, điều kiện vô hiệu và hành động có kỷ luật; luôn nhắc đây không phải lời khuyên đầu tư.

## Liên kết với bot

`src/analysis/auto-retune.js` lưu bằng chứng kỹ thuật tại thời điểm call. Khi đạt chuỗi SL theo `autoRetune.stopLossStreak` (mặc định 3), bot chia dữ liệu lịch sử theo thời gian 75% để chọn và 25% mới hơn để xác nhận. Bot chỉ áp dụng candidate nếu mọi cặp đang xét đều có đủ lệnh, PF tối thiểu, expectancy dương và drawdown giảm theo `config/strategy.json`; cấu hình cũ được sao lưu trước khi đổi.

Việc này là kiểm soát rủi ro dựa trên dữ liệu, không phải lời giải thích chắc chắn rằng một nhóm tín hiệu là nguyên nhân gây SL. Các nhóm không có lịch sử nến để backtest không bị tự đổi trọng số.

## Giới hạn

- Bot không biết số dư, vị thế thực tế, lệnh đã khớp, phí, trượt giá hay giới hạn đòn bẩy trên sàn của người dùng.
- Vì vậy skill này không ra lệnh giao dịch thật, không quyết định size vị thế và không hứa lợi nhuận.
- Luôn khởi động bot bằng `npm run bot` sau khi cập nhật mã nguồn để quy tắc mới có hiệu lực cho các call tạo sau đó.
