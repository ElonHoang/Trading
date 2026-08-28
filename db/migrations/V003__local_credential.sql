-- Tai khoan dang nhap noi bo (username + mat khau) luu trong database.
--
-- Khong dung auth_identity cho viec nay: bang do khoa theo subject cua nha cung
-- cap ben ngoai va CHECK cua no chi nhan 'google' voi 'github'.
--
-- Chi luu BCrypt hash cost 12, khong bao gio luu mat khau tho. Tao va doi mat
-- khau bang lenh CLI `local-user`, khong qua bien moi truong.
CREATE TABLE IF NOT EXISTS local_credential (
  username VARCHAR(64) NOT NULL,
  username_normalized VARCHAR(64)
    GENERATED ALWAYS AS (LOWER(username)) VIRTUAL,
  password_hash VARCHAR(72) NOT NULL,
  role VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (username),
  -- Dang nhap khong phan biet hoa thuong, nhung giu nguyen cach viet de hien thi.
  UNIQUE KEY local_credential_username_uq (username_normalized),
  CONSTRAINT local_credential_role_check
    CHECK (role IN ('ADMIN', 'VIEWER')),
  CONSTRAINT local_credential_status_check
    CHECK (status IN ('active', 'disabled'))
);
