-- Hai tai khoan khoi tao cho dang nhap noi bo.
--
-- Ly do can migration: khi local_credential rong, ca trang login chi hien
-- "Dang nhap bang tai khoan noi bo chua duoc bat tren may chu" va khong ai vao
-- duoc. Render goi free lai khong co Shell nen khong chay duoc `local-user set`
-- ngay tren may chu; seed o day la duong duy nhat mo khoa ma khong can Shell.
--
-- CANH BAO: hai hash duoi day nam trong Git, ai doc duoc repo deu mang di thu
-- pha offline duoc. Day la mat khau khoi tao, phai doi ngay sau lan dang nhap
-- dau bang:
--   java -jar dong-tien-ai.jar local-user set hoangnv --role=admin
-- Lenh do chi ghi de dong trong bang, khong dung toi file migration nay.
--
-- INSERT IGNORE: database nao da co san username nay thi giu nguyen mat khau
-- dang dung. Mot migration khong duoc phep dat lai mat khau cua nguoi khac.
INSERT IGNORE INTO local_credential (username, password_hash, role, status) VALUES
  ('hoangnv', '$2a$12$1774oi6JxgoQePqkaG6vpuLvBUbTgWSUX3P89310kx/lFGaZJ9iBe', 'ADMIN', 'active'),
  ('viewer', '$2a$12$Y1NSSrJEeNEBPAMdZz/1MukRL50r1dSHBlyLGrjSupEcXNmGJlTTq', 'VIEWER', 'active');
