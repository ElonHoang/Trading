-- TiDB/MySQL normalized application schema.
--
-- The connected TiDB database is the application's namespace. PostgreSQL
-- schemas (public and trading) are intentionally not used here.
-- Timestamps are stored as UTC DATETIME(6); configure the JDBC connection
-- time zone as UTC so Instant values retain their original meaning.

-- OAuth users and identities
CREATE TABLE IF NOT EXISTS app_user (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  display_name VARCHAR(255),
  email VARCHAR(320),
  email_normalized VARCHAR(320)
    GENERATED ALWAYS AS (LOWER(email)) VIRTUAL,
  avatar_url TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  last_login_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY app_user_email_uq (email_normalized),
  CONSTRAINT app_user_status_check
    CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS auth_identity (
  provider VARCHAR(24) NOT NULL,
  provider_subject VARCHAR(255) NOT NULL,
  user_id CHAR(36) NOT NULL,
  provider_login VARCHAR(255),
  provider_email VARCHAR(320),
  attributes JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (provider, provider_subject),
  KEY auth_identity_user_idx (user_id),
  CONSTRAINT auth_identity_provider_check
    CHECK (provider IN ('google', 'github')),
  CONSTRAINT auth_identity_attributes_object_check
    CHECK (JSON_TYPE(attributes) = 'OBJECT'),
  CONSTRAINT fk_auth_identity_user
    FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE
);

-- Telegram and watchlist
CREATE TABLE IF NOT EXISTS telegram_subscriber (
  chat_id BIGINT NOT NULL,
  user_id CHAR(36),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (chat_id),
  KEY telegram_subscriber_user_idx (user_id),
  CONSTRAINT fk_telegram_subscriber_user
    FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS watchlist_symbol (
  symbol VARCHAR(24) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  added_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (symbol),
  KEY watchlist_enabled_order_idx (enabled, sort_order, symbol),
  KEY watchlist_added_by_idx (added_by),
  CONSTRAINT watchlist_symbol_sort_order_check
    CHECK (sort_order >= 0),
  CONSTRAINT watchlist_symbol_format_check
    CHECK (symbol REGEXP '^[A-Z0-9]{2,20}USDT$'),
  CONSTRAINT fk_watchlist_symbol_added_by
    FOREIGN KEY (added_by) REFERENCES app_user (id) ON DELETE SET NULL
);

-- Versioned strategy configuration and prompt. The generated active_slot
-- replaces PostgreSQL partial unique indexes; a unique key permits many NULLs
-- but exactly one active row.
CREATE TABLE IF NOT EXISTS strategy_version (
  id BIGINT NOT NULL AUTO_INCREMENT,
  config JSON NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'manual',
  reason TEXT,
  report JSON,
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  activated_at DATETIME(6),
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  active_slot TINYINT
    GENERATED ALWAYS AS (
      CASE WHEN is_active = 1 THEN 1 ELSE NULL END
    ) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY strategy_one_active_uq (active_slot),
  KEY strategy_created_idx (created_at),
  KEY strategy_created_by_idx (created_by),
  CONSTRAINT strategy_version_config_object_check
    CHECK (JSON_TYPE(config) = 'OBJECT'),
  CONSTRAINT strategy_version_source_check
    CHECK (source IN ('initial-import', 'manual', 'auto-retune', 'daily-review', 'rollback')),
  CONSTRAINT fk_strategy_version_created_by
    FOREIGN KEY (created_by) REFERENCES app_user (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS prompt_version (
  id BIGINT NOT NULL AUTO_INCREMENT,
  prompt_text TEXT NOT NULL,
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  activated_at DATETIME(6),
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  active_slot TINYINT
    GENERATED ALWAYS AS (
      CASE WHEN is_active = 1 THEN 1 ELSE NULL END
    ) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY prompt_one_active_uq (active_slot),
  KEY prompt_created_by_idx (created_by),
  CONSTRAINT prompt_version_text_check
    CHECK (CHAR_LENGTH(prompt_text) >= 1),
  CONSTRAINT fk_prompt_version_created_by
    FOREIGN KEY (created_by) REFERENCES app_user (id) ON DELETE SET NULL
);

-- Model metadata stays relational while the model itself remains JSON.
CREATE TABLE IF NOT EXISTS ml_model (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  symbol VARCHAR(24) NOT NULL,
  `interval` VARCHAR(8) NOT NULL,
  trained_at DATETIME(6) NOT NULL,
  sample_count INT,
  test_auc DECIMAL(9, 8),
  test_accuracy DECIMAL(9, 8),
  walk_forward_auc DECIMAL(9, 8),
  payload JSON NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  active_symbol VARCHAR(24)
    GENERATED ALWAYS AS (
      CASE WHEN is_active = 1 THEN symbol ELSE NULL END
    ) VIRTUAL,
  active_interval VARCHAR(8)
    GENERATED ALWAYS AS (
      CASE WHEN is_active = 1 THEN `interval` ELSE NULL END
    ) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY ml_model_one_active_pair_uq (active_symbol, active_interval),
  KEY ml_model_trained_idx (trained_at),
  CONSTRAINT ml_model_sample_count_check
    CHECK (sample_count IS NULL OR sample_count >= 0),
  CONSTRAINT ml_model_payload_object_check
    CHECK (JSON_TYPE(payload) = 'OBJECT'),
  CONSTRAINT ml_model_symbol_format_check
    CHECK (symbol REGEXP '^[A-Z0-9]{2,20}USDT$'),
  CONSTRAINT ml_model_interval_format_check
    CHECK (`interval` REGEXP '^[0-9]+[mhdwM]$'),
  CONSTRAINT ml_model_auc_range_check
    CHECK (
      (test_auc IS NULL OR test_auc BETWEEN 0 AND 1)
      AND (test_accuracy IS NULL OR test_accuracy BETWEEN 0 AND 1)
      AND (walk_forward_auc IS NULL OR walk_forward_auc BETWEEN 0 AND 1)
    )
);

-- One trade_call row covers a trade's complete lifecycle. open_symbol replaces
-- the old partial unique index and only receives a value for OPEN calls.
CREATE TABLE IF NOT EXISTS trade_call (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  legacy_id VARCHAR(255),
  symbol VARCHAR(24) NOT NULL,
  `interval` VARCHAR(8) NOT NULL,
  side VARCHAR(8) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  entry_price DECIMAL(30, 12) NOT NULL,
  initial_stop_loss DECIMAL(30, 12) NOT NULL,
  exit_price DECIMAL(30, 12),
  opened_candle_ms BIGINT NOT NULL,
  opened_at DATETIME(6) NOT NULL,
  closed_at DATETIME(6),
  bars_held INT,
  stop_moved_to_entry BOOLEAN NOT NULL DEFAULT FALSE,
  evidence JSON,
  analysis_snapshot JSON,
  result_payload JSON,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  open_symbol VARCHAR(24)
    GENERATED ALWAYS AS (
      CASE WHEN status = 'open' THEN symbol ELSE NULL END
    ) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY trade_call_legacy_id_uq (legacy_id),
  UNIQUE KEY trade_call_one_open_symbol_uq (open_symbol),
  KEY trade_call_closed_idx (status, closed_at),
  KEY trade_call_symbol_history_idx (symbol, opened_at),
  KEY trade_call_status_idx (status, opened_at),
  CONSTRAINT trade_call_side_check
    CHECK (side IN ('long', 'short')),
  CONSTRAINT trade_call_status_check
    CHECK (status IN ('open', 'stopped', 'breakeven', 'target', 'expired', 'cancelled')),
  CONSTRAINT trade_call_entry_price_check
    CHECK (entry_price > 0),
  CONSTRAINT trade_call_initial_stop_loss_check
    CHECK (initial_stop_loss > 0),
  CONSTRAINT trade_call_exit_price_check
    CHECK (exit_price IS NULL OR exit_price > 0),
  CONSTRAINT trade_call_opened_candle_check
    CHECK (opened_candle_ms >= 0),
  CONSTRAINT trade_call_bars_held_check
    CHECK (bars_held IS NULL OR bars_held >= 0),
  CONSTRAINT trade_call_symbol_format_check
    CHECK (symbol REGEXP '^[A-Z0-9]{2,20}USDT$'),
  CONSTRAINT trade_call_interval_format_check
    CHECK (`interval` REGEXP '^[0-9]+[mhdwM]$'),
  CONSTRAINT trade_call_lifecycle_check
    CHECK (
      (status = 'open' AND closed_at IS NULL)
      OR (status <> 'open' AND closed_at IS NOT NULL)
    ),
  CONSTRAINT trade_call_price_direction_check
    CHECK (
      (side = 'long' AND initial_stop_loss < entry_price)
      OR (side = 'short' AND initial_stop_loss > entry_price)
    )
);

CREATE TABLE IF NOT EXISTS trade_target (
  id BIGINT NOT NULL AUTO_INCREMENT,
  trade_call_id CHAR(36) NOT NULL,
  `position` SMALLINT NOT NULL,
  label VARCHAR(24) NOT NULL,
  target_price DECIMAL(30, 12) NOT NULL,
  is_hit BOOLEAN NOT NULL DEFAULT FALSE,
  hit_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY trade_target_call_position_uq (trade_call_id, `position`),
  UNIQUE KEY trade_target_call_label_uq (trade_call_id, label),
  KEY trade_target_call_idx (trade_call_id, `position`),
  CONSTRAINT trade_target_position_check
    CHECK (`position` >= 1),
  CONSTRAINT trade_target_price_check
    CHECK (target_price > 0),
  CONSTRAINT trade_target_hit_time_check
    CHECK (is_hit = 1 OR hit_at IS NULL),
  CONSTRAINT fk_trade_target_call
    FOREIGN KEY (trade_call_id) REFERENCES trade_call (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trade_message (
  trade_call_id CHAR(36) NOT NULL,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  sent_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (trade_call_id, chat_id),
  UNIQUE KEY trade_message_chat_message_uq (chat_id, message_id),
  CONSTRAINT trade_message_id_check
    CHECK (message_id > 0),
  CONSTRAINT fk_trade_message_call
    FOREIGN KEY (trade_call_id) REFERENCES trade_call (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trade_event (
  id BIGINT NOT NULL AUTO_INCREMENT,
  trade_call_id CHAR(36) NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  event_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  candle_open_ms BIGINT,
  price DECIMAL(30, 12),
  payload JSON,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY trade_event_call_time_idx (trade_call_id, event_at, id),
  CONSTRAINT trade_event_type_check
    CHECK (event_type IN ('opened', 'tp_hit', 'stop_moved', 'closed', 'expired', 'cancelled', 'note')),
  CONSTRAINT trade_event_candle_open_check
    CHECK (candle_open_ms IS NULL OR candle_open_ms >= 0),
  CONSTRAINT trade_event_price_check
    CHECK (price IS NULL OR price > 0),
  CONSTRAINT fk_trade_event_call
    FOREIGN KEY (trade_call_id) REFERENCES trade_call (id) ON DELETE CASCADE
);

-- Monitor checkpoints prevent duplicate delivery for a worker/symbol/interval.
CREATE TABLE IF NOT EXISTS monitor_checkpoint (
  worker_key VARCHAR(64) NOT NULL DEFAULT 'telegram-monitor',
  symbol VARCHAR(24) NOT NULL,
  `interval` VARCHAR(8) NOT NULL,
  last_candle_ms BIGINT,
  last_signal VARCHAR(16),
  payload JSON NOT NULL DEFAULT (JSON_OBJECT()),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (worker_key, symbol, `interval`),
  KEY monitor_checkpoint_updated_idx (updated_at),
  CONSTRAINT monitor_checkpoint_last_candle_check
    CHECK (last_candle_ms IS NULL OR last_candle_ms >= 0),
  CONSTRAINT monitor_checkpoint_payload_object_check
    CHECK (JSON_TYPE(payload) = 'OBJECT')
);

-- Runtime state and history for automatic strategy tuning.
CREATE TABLE IF NOT EXISTS tuning_runtime (
  singleton_id SMALLINT NOT NULL DEFAULT 1,
  active_source VARCHAR(32),
  active_changes JSON NOT NULL DEFAULT (JSON_OBJECT()),
  active_applied_at DATETIME(6),
  last_handled_trade_legacy_id VARCHAR(255),
  last_applied_at DATETIME(6),
  last_review_at DATETIME(6),
  loss_log_week VARCHAR(16),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (singleton_id),
  CONSTRAINT tuning_runtime_singleton_check
    CHECK (singleton_id = 1),
  CONSTRAINT tuning_runtime_active_changes_object_check
    CHECK (JSON_TYPE(active_changes) = 'OBJECT')
);

CREATE TABLE IF NOT EXISTS retune_attempt (
  id BIGINT NOT NULL AUTO_INCREMENT,
  trigger_trade_call_id CHAR(36),
  status VARCHAR(32) NOT NULL,
  streak INT,
  selected_candidate_id VARCHAR(255),
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  report JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY retune_attempt_created_idx (created_at),
  KEY retune_attempt_trigger_idx (trigger_trade_call_id),
  CONSTRAINT retune_attempt_streak_check
    CHECK (streak IS NULL OR streak >= 0),
  CONSTRAINT retune_attempt_report_object_check
    CHECK (JSON_TYPE(report) = 'OBJECT'),
  CONSTRAINT fk_retune_attempt_trigger
    FOREIGN KEY (trigger_trade_call_id) REFERENCES trade_call (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS daily_review (
  id BIGINT NOT NULL AUTO_INCREMENT,
  review_status VARCHAR(32) NOT NULL,
  window_start DATETIME(6),
  window_end DATETIME(6),
  summary JSON,
  comparison JSON,
  report JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY daily_review_created_idx (created_at),
  CONSTRAINT daily_review_report_object_check
    CHECK (JSON_TYPE(report) = 'OBJECT')
);

CREATE TABLE IF NOT EXISTS daily_loss_log (
  log_date DATE NOT NULL,
  week_key VARCHAR(16),
  payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (log_date),
  CONSTRAINT daily_loss_log_payload_object_check
    CHECK (JSON_TYPE(payload) = 'OBJECT')
);

CREATE TABLE IF NOT EXISTS learning_log (
  review_date DATE NOT NULL,
  schema_version INT NOT NULL DEFAULT 1,
  generated_at DATETIME(6) NOT NULL,
  `record` JSON NOT NULL,
  formatted_text MEDIUMTEXT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (review_date),
  CONSTRAINT learning_log_schema_version_check
    CHECK (schema_version >= 1),
  CONSTRAINT learning_log_record_object_check
    CHECK (JSON_TYPE(`record`) = 'OBJECT')
);

-- Audit records for future configuration and administration changes.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  actor_user_id CHAR(36),
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(255),
  before_value JSON,
  after_value JSON,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY audit_log_entity_idx (entity_type, entity_id, created_at),
  KEY audit_log_actor_idx (actor_user_id),
  CONSTRAINT fk_audit_log_actor
    FOREIGN KEY (actor_user_id) REFERENCES app_user (id) ON DELETE SET NULL
);

-- Compact reporting view. PnL calculations remain in the application service.
CREATE OR REPLACE VIEW v_closed_trade_performance AS
SELECT
  c.id,
  c.legacy_id,
  c.symbol,
  c.`interval`,
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
    SELECT 1
    FROM trade_target t
    WHERE t.trade_call_id = c.id
      AND t.`position` = 1
      AND t.is_hit = 1
  ) AS reached_tp1,
  (
    SELECT t.target_price
    FROM trade_target t
    WHERE t.trade_call_id = c.id
      AND t.`position` = 1
  ) AS tp1_price
FROM trade_call c
WHERE c.status <> 'open';
