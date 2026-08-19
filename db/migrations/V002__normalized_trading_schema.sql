CREATE SCHEMA IF NOT EXISTS trading;

-- Người dùng và danh tính OAuth
CREATE TABLE IF NOT EXISTS trading.app_user (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT,
  email TEXT,
  avatar_url TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_uq
  ON trading.app_user (LOWER(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS trading.auth_identity (
  provider VARCHAR(24) NOT NULL CHECK (provider IN ('google', 'github')),
  provider_subject TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES trading.app_user(id) ON DELETE CASCADE,
  provider_login TEXT,
  provider_email TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(attributes) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS auth_identity_user_idx
  ON trading.auth_identity (user_id);

-- Telegram và danh sách theo dõi
CREATE TABLE IF NOT EXISTS trading.telegram_subscriber (
  chat_id BIGINT PRIMARY KEY,
  user_id UUID REFERENCES trading.app_user(id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trading.watchlist_symbol (
  symbol VARCHAR(24) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  added_by UUID REFERENCES trading.app_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT watchlist_symbol_format CHECK (symbol ~ '^[A-Z0-9]{2,20}USDT$')
);

CREATE INDEX IF NOT EXISTS watchlist_enabled_order_idx
  ON trading.watchlist_symbol (sort_order, symbol) WHERE enabled;

-- Cấu hình có version; chỉ một version active tại một thời điểm.
CREATE TABLE IF NOT EXISTS trading.strategy_version (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  source VARCHAR(32) NOT NULL DEFAULT 'manual'
    CHECK (source IN ('initial-import', 'manual', 'auto-retune', 'daily-review', 'rollback')),
  reason TEXT,
  report JSONB,
  created_by UUID REFERENCES trading.app_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS strategy_one_active_uq
  ON trading.strategy_version (is_active) WHERE is_active;

CREATE INDEX IF NOT EXISTS strategy_created_idx
  ON trading.strategy_version (created_at DESC);

CREATE TABLE IF NOT EXISTS trading.prompt_version (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prompt_text TEXT NOT NULL CHECK (LENGTH(prompt_text) >= 1),
  created_by UUID REFERENCES trading.app_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS prompt_one_active_uq
  ON trading.prompt_version (is_active) WHERE is_active;

-- Model giữ payload JSONB vì cấu trúc cây thay đổi theo thuật toán, còn metadata
-- quan trọng được tách cột để lọc và hiển thị mà không đọc toàn bộ payload.
CREATE TABLE IF NOT EXISTS trading.ml_model (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(24) NOT NULL,
  interval VARCHAR(8) NOT NULL,
  trained_at TIMESTAMPTZ NOT NULL,
  sample_count INTEGER CHECK (sample_count IS NULL OR sample_count >= 0),
  test_auc NUMERIC(9, 8),
  test_accuracy NUMERIC(9, 8),
  walk_forward_auc NUMERIC(9, 8),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ml_model_symbol_format CHECK (symbol ~ '^[A-Z0-9]{2,20}USDT$'),
  CONSTRAINT ml_model_interval_format CHECK (interval ~ '^[0-9]+[mhdwM]$'),
  CONSTRAINT ml_model_auc_range CHECK (
    (test_auc IS NULL OR test_auc BETWEEN 0 AND 1)
    AND (test_accuracy IS NULL OR test_accuracy BETWEEN 0 AND 1)
    AND (walk_forward_auc IS NULL OR walk_forward_auc BETWEEN 0 AND 1)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ml_model_one_active_pair_uq
  ON trading.ml_model (symbol, interval) WHERE is_active;

CREATE INDEX IF NOT EXISTS ml_model_trained_idx
  ON trading.ml_model (trained_at DESC);

-- Một hàng trade_call đi từ lúc mở tới lúc đóng. Chỉ một kèo OPEN cho mỗi symbol.
CREATE TABLE IF NOT EXISTS trading.trade_call (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id TEXT UNIQUE,
  symbol VARCHAR(24) NOT NULL,
  interval VARCHAR(8) NOT NULL,
  side VARCHAR(8) NOT NULL CHECK (side IN ('long', 'short')),
  status VARCHAR(16) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'stopped', 'breakeven', 'target', 'expired', 'cancelled')),
  entry_price NUMERIC(30, 12) NOT NULL CHECK (entry_price > 0),
  initial_stop_loss NUMERIC(30, 12) NOT NULL CHECK (initial_stop_loss > 0),
  exit_price NUMERIC(30, 12) CHECK (exit_price IS NULL OR exit_price > 0),
  opened_candle_ms BIGINT NOT NULL CHECK (opened_candle_ms >= 0),
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  bars_held INTEGER CHECK (bars_held IS NULL OR bars_held >= 0),
  stop_moved_to_entry BOOLEAN NOT NULL DEFAULT FALSE,
  evidence JSONB,
  analysis_snapshot JSONB,
  result_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trade_call_symbol_format CHECK (symbol ~ '^[A-Z0-9]{2,20}USDT$'),
  CONSTRAINT trade_call_interval_format CHECK (interval ~ '^[0-9]+[mhdwM]$'),
  CONSTRAINT trade_call_lifecycle CHECK (
    (status = 'open' AND closed_at IS NULL)
    OR (status <> 'open' AND closed_at IS NOT NULL)
  ),
  CONSTRAINT trade_call_price_direction CHECK (
    (side = 'long' AND initial_stop_loss < entry_price)
    OR (side = 'short' AND initial_stop_loss > entry_price)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS trade_call_one_open_symbol_uq
  ON trading.trade_call (symbol) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS trade_call_closed_idx
  ON trading.trade_call (closed_at DESC) WHERE status <> 'open';

CREATE INDEX IF NOT EXISTS trade_call_symbol_history_idx
  ON trading.trade_call (symbol, opened_at DESC);

CREATE INDEX IF NOT EXISTS trade_call_status_idx
  ON trading.trade_call (status, opened_at DESC);

CREATE TABLE IF NOT EXISTS trading.trade_target (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trade_call_id UUID NOT NULL REFERENCES trading.trade_call(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL CHECK (position >= 1),
  label VARCHAR(24) NOT NULL,
  target_price NUMERIC(30, 12) NOT NULL CHECK (target_price > 0),
  is_hit BOOLEAN NOT NULL DEFAULT FALSE,
  hit_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trade_call_id, position),
  UNIQUE (trade_call_id, label),
  CONSTRAINT trade_target_hit_time CHECK (is_hit OR hit_at IS NULL)
);

CREATE INDEX IF NOT EXISTS trade_target_call_idx
  ON trading.trade_target (trade_call_id, position);

CREATE TABLE IF NOT EXISTS trading.trade_message (
  trade_call_id UUID NOT NULL REFERENCES trading.trade_call(id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL CHECK (message_id > 0),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trade_call_id, chat_id),
  UNIQUE (chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS trading.trade_event (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trade_call_id UUID NOT NULL REFERENCES trading.trade_call(id) ON DELETE CASCADE,
  event_type VARCHAR(24) NOT NULL
    CHECK (event_type IN ('opened', 'tp_hit', 'stop_moved', 'closed', 'expired', 'cancelled', 'note')),
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  candle_open_ms BIGINT CHECK (candle_open_ms IS NULL OR candle_open_ms >= 0),
  price NUMERIC(30, 12) CHECK (price IS NULL OR price > 0),
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trade_event_call_time_idx
  ON trading.trade_event (trade_call_id, event_at, id);

-- Checkpoint chống gửi trùng theo worker/symbol/interval.
CREATE TABLE IF NOT EXISTS trading.monitor_checkpoint (
  worker_key VARCHAR(64) NOT NULL DEFAULT 'telegram-monitor',
  symbol VARCHAR(24) NOT NULL,
  interval VARCHAR(8) NOT NULL,
  last_candle_ms BIGINT CHECK (last_candle_ms IS NULL OR last_candle_ms >= 0),
  last_signal VARCHAR(16),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (worker_key, symbol, interval)
);

CREATE INDEX IF NOT EXISTS monitor_checkpoint_updated_idx
  ON trading.monitor_checkpoint (updated_at DESC);

-- Trạng thái và lịch sử tự tinh chỉnh.
CREATE TABLE IF NOT EXISTS trading.tuning_runtime (
  singleton_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  active_source VARCHAR(32),
  active_changes JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(active_changes) = 'object'),
  active_applied_at TIMESTAMPTZ,
  last_handled_trade_legacy_id TEXT,
  last_applied_at TIMESTAMPTZ,
  last_review_at TIMESTAMPTZ,
  loss_log_week VARCHAR(16),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trading.retune_attempt (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger_trade_call_id UUID REFERENCES trading.trade_call(id) ON DELETE SET NULL,
  status VARCHAR(32) NOT NULL,
  streak INTEGER CHECK (streak IS NULL OR streak >= 0),
  selected_candidate_id TEXT,
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS retune_attempt_created_idx
  ON trading.retune_attempt (created_at DESC);

CREATE TABLE IF NOT EXISTS trading.daily_review (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_status VARCHAR(32) NOT NULL,
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  summary JSONB,
  comparison JSONB,
  report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS daily_review_created_idx
  ON trading.daily_review (created_at DESC);

CREATE TABLE IF NOT EXISTS trading.daily_loss_log (
  log_date DATE PRIMARY KEY,
  week_key VARCHAR(16),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trading.learning_log (
  review_date DATE PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  generated_at TIMESTAMPTZ NOT NULL,
  record JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  formatted_text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit dùng cho mọi thay đổi cấu hình hoặc thao tác quản trị sau này.
CREATE TABLE IF NOT EXISTS trading.audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id UUID REFERENCES trading.app_user(id) ON DELETE SET NULL,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id TEXT,
  before_value JSONB,
  after_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx
  ON trading.audit_log (entity_type, entity_id, created_at DESC);

-- View gọn cho dashboard; công thức PnL vẫn nằm ở service để dùng đúng strategy version.
CREATE OR REPLACE VIEW trading.v_closed_trade_performance AS
SELECT
  c.id,
  c.legacy_id,
  c.symbol,
  c.interval,
  c.side,
  c.status,
  c.entry_price,
  c.initial_stop_loss,
  c.exit_price,
  c.opened_at,
  c.closed_at,
  c.bars_held,
  c.stop_moved_to_entry,
  EXISTS (
    SELECT 1 FROM trading.trade_target t
    WHERE t.trade_call_id = c.id AND t.position = 1 AND t.is_hit
  ) AS reached_tp1,
  (
    SELECT t.target_price FROM trading.trade_target t
    WHERE t.trade_call_id = c.id AND t.position = 1
  ) AS tp1_price
FROM trading.trade_call c
WHERE c.status <> 'open';
