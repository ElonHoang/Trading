-- Idempotent migration from the transitional app_documents table.

-- Earlier application builds used an unqualified table name. Once the
-- `trading` schema existed PostgreSQL's default "$user", public search path
-- could therefore create trading.app_documents. Consolidate that data before
-- reading the canonical public table.
DO $migration$
BEGIN
  IF TO_REGCLASS('trading.app_documents') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.app_documents (document_key, document_value, updated_at)
      SELECT document_key, document_value, updated_at
      FROM trading.app_documents
      ON CONFLICT (document_key) DO UPDATE
        SET document_value = EXCLUDED.document_value,
            updated_at = GREATEST(public.app_documents.updated_at, EXCLUDED.updated_at)
      WHERE public.app_documents.updated_at <= EXCLUDED.updated_at
    $sql$;
  END IF;
END
$migration$;

-- Active strategy and prompt
INSERT INTO trading.strategy_version (config, source, reason, activated_at, is_active)
SELECT document_value, 'initial-import', 'Imported from app_documents/config:strategy', NOW(), TRUE
FROM public.app_documents
WHERE document_key = 'config:strategy'
  AND jsonb_typeof(document_value) = 'object'
  AND NOT EXISTS (SELECT 1 FROM trading.strategy_version WHERE is_active);

INSERT INTO trading.prompt_version (prompt_text, activated_at, is_active)
SELECT CASE
         WHEN jsonb_typeof(document_value) = 'string' THEN document_value #>> '{}'
         ELSE document_value ->> 'text'
       END,
       NOW(), TRUE
FROM public.app_documents
WHERE document_key = 'config:prompt'
  AND COALESCE(CASE
        WHEN jsonb_typeof(document_value) = 'string' THEN document_value #>> '{}'
        ELSE document_value ->> 'text'
      END, '') <> ''
  AND NOT EXISTS (SELECT 1 FROM trading.prompt_version WHERE is_active);

-- Watchlist and Telegram subscribers
INSERT INTO trading.watchlist_symbol (symbol, sort_order)
SELECT UPPER(item.value), (item.ordinality - 1)::INTEGER
FROM public.app_documents d
CROSS JOIN LATERAL jsonb_array_elements_text(d.document_value) WITH ORDINALITY AS item(value, ordinality)
WHERE d.document_key = 'data:watchlist'
  AND UPPER(item.value) ~ '^[A-Z0-9]{2,20}USDT$'
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO trading.telegram_subscriber (chat_id)
SELECT item.value::BIGINT
FROM public.app_documents d
CROSS JOIN LATERAL jsonb_array_elements_text(d.document_value) AS item(value)
WHERE d.document_key = 'data:subscribers'
  AND item.value ~ '^-?[0-9]+$'
ON CONFLICT (chat_id) DO NOTHING;

-- ML models
INSERT INTO trading.ml_model (
  symbol, interval, trained_at, sample_count,
  test_auc, test_accuracy, walk_forward_auc, payload, is_active
)
SELECT
  UPPER(document_value ->> 'symbol'),
  document_value ->> 'interval',
  (document_value ->> 'trainedAt')::TIMESTAMPTZ,
  NULLIF(document_value #>> '{dataset,samples}', '')::INTEGER,
  NULLIF(document_value #>> '{metrics,test,auc}', '')::NUMERIC,
  NULLIF(document_value #>> '{metrics,test,accuracy}', '')::NUMERIC,
  NULLIF(document_value #>> '{metrics,walkForward,meanAuc}', '')::NUMERIC,
  document_value,
  TRUE
FROM public.app_documents
WHERE document_key LIKE 'model:%'
  AND jsonb_typeof(document_value) = 'object'
  AND COALESCE(document_value ->> 'symbol', '') ~ '^[A-Za-z0-9]{2,20}USDT$'
  AND COALESCE(document_value ->> 'interval', '') ~ '^[0-9]+[mhdwM]$'
  AND COALESCE(document_value ->> 'trainedAt', '') <> ''
ON CONFLICT (symbol, interval) WHERE is_active DO NOTHING;

-- Open trade calls
WITH open_source AS (
  SELECT pair.key AS symbol_key, pair.value AS call
  FROM public.app_documents d
  CROSS JOIN LATERAL jsonb_each(d.document_value) AS pair(key, value)
  WHERE d.document_key = 'data:open-calls'
    AND jsonb_typeof(d.document_value) = 'object'
)
INSERT INTO trading.trade_call (
  legacy_id, symbol, interval, side, status,
  entry_price, initial_stop_loss, opened_candle_ms, opened_at,
  stop_moved_to_entry, evidence, result_payload
)
SELECT
  'open:' || UPPER(COALESCE(call ->> 'symbol', symbol_key)),
  UPPER(COALESCE(call ->> 'symbol', symbol_key)),
  call ->> 'interval',
  call ->> 'side',
  'open',
  (call ->> 'entry')::NUMERIC,
  (call ->> 'stopLoss')::NUMERIC,
  (call ->> 'openedAtCandle')::BIGINT,
  COALESCE(NULLIF(call ->> 'openedAt', '')::TIMESTAMPTZ,
           TO_TIMESTAMP((call ->> 'openedAtCandle')::DOUBLE PRECISION / 1000.0)),
  COALESCE((call ->> 'slMovedToEntry')::BOOLEAN, FALSE),
  call -> 'evidence',
  call
FROM open_source
WHERE UPPER(COALESCE(call ->> 'symbol', symbol_key)) ~ '^[A-Z0-9]{2,20}USDT$'
  AND COALESCE(call ->> 'interval', '') ~ '^[0-9]+[mhdwM]$'
  AND call ->> 'side' IN ('long', 'short')
  AND COALESCE(call ->> 'entry', '') ~ '^[0-9]+([.][0-9]+)?$'
  AND COALESCE(call ->> 'stopLoss', '') ~ '^[0-9]+([.][0-9]+)?$'
  AND COALESCE(call ->> 'openedAtCandle', '') ~ '^[0-9]+$'
  AND (
    (call ->> 'side' = 'long' AND (call ->> 'stopLoss')::NUMERIC < (call ->> 'entry')::NUMERIC)
    OR (call ->> 'side' = 'short' AND (call ->> 'stopLoss')::NUMERIC > (call ->> 'entry')::NUMERIC)
  )
ON CONFLICT (legacy_id) DO NOTHING;

WITH open_source AS (
  SELECT pair.key AS symbol_key, pair.value AS call
  FROM public.app_documents d
  CROSS JOIN LATERAL jsonb_each(d.document_value) AS pair(key, value)
  WHERE d.document_key = 'data:open-calls'
), targets AS (
  SELECT
    'open:' || UPPER(COALESCE(call ->> 'symbol', symbol_key)) AS legacy_id,
    target.value AS target,
    target.ordinality::SMALLINT AS position,
    call
  FROM open_source
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(call -> 'targets', '[]'::jsonb))
    WITH ORDINALITY AS target(value, ordinality)
)
INSERT INTO trading.trade_target (trade_call_id, position, label, target_price, is_hit)
SELECT
  c.id, t.position, t.target ->> 'label', (t.target ->> 'price')::NUMERIC,
  COALESCE(t.call -> 'tpHit', '[]'::jsonb) ? (t.target ->> 'label')
FROM targets t
JOIN trading.trade_call c ON c.legacy_id = t.legacy_id
WHERE COALESCE(t.target ->> 'label', '') <> ''
  AND COALESCE(t.target ->> 'price', '') ~ '^[0-9]+([.][0-9]+)?$'
ON CONFLICT (trade_call_id, position) DO NOTHING;

WITH open_source AS (
  SELECT pair.key AS symbol_key, pair.value AS call
  FROM public.app_documents d
  CROSS JOIN LATERAL jsonb_each(d.document_value) AS pair(key, value)
  WHERE d.document_key = 'data:open-calls'
), messages AS (
  SELECT
    'open:' || UPPER(COALESCE(call ->> 'symbol', symbol_key)) AS legacy_id,
    message.key AS chat_id,
    message.value AS message_id
  FROM open_source
  CROSS JOIN LATERAL jsonb_each_text(COALESCE(call -> 'messages', '{}'::jsonb)) AS message(key, value)
)
INSERT INTO trading.trade_message (trade_call_id, chat_id, message_id)
SELECT c.id, m.chat_id::BIGINT, m.message_id::BIGINT
FROM messages m
JOIN trading.trade_call c ON c.legacy_id = m.legacy_id
WHERE m.chat_id ~ '^-?[0-9]+$' AND m.message_id ~ '^[0-9]+$'
ON CONFLICT (trade_call_id, chat_id) DO NOTHING;

-- Closed trades from auto-retune history. Invalid legacy rows remain available in
-- app_documents for manual repair instead of weakening relational constraints.
WITH state AS (
  SELECT document_value
  FROM public.app_documents
  WHERE document_key = 'data:auto-retune'
), closed_source AS (
  SELECT trade.value AS trade
  FROM state
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(document_value -> 'trades', '[]'::jsonb)) AS trade(value)
)
INSERT INTO trading.trade_call (
  legacy_id, symbol, interval, side, status,
  entry_price, initial_stop_loss, exit_price,
  opened_candle_ms, opened_at, closed_at, bars_held,
  stop_moved_to_entry, evidence, result_payload
)
SELECT
  COALESCE(NULLIF(trade ->> 'id', ''), 'closed:' || MD5(trade::TEXT)),
  UPPER(trade ->> 'symbol'),
  trade ->> 'interval',
  trade ->> 'side',
  trade #>> '{result,status}',
  (trade ->> 'entry')::NUMERIC,
  (trade ->> 'stopLoss')::NUMERIC,
  NULLIF(trade #>> '{result,lastPrice}', '')::NUMERIC,
  COALESCE(
    NULLIF(trade ->> 'openedAtCandle', '')::BIGINT,
    FLOOR(EXTRACT(EPOCH FROM COALESCE(
      NULLIF(trade ->> 'openedAt', '')::TIMESTAMPTZ,
      (trade ->> 'closedAt')::TIMESTAMPTZ
    )) * 1000)::BIGINT
  ),
  COALESCE(NULLIF(trade ->> 'openedAt', '')::TIMESTAMPTZ,
           (trade ->> 'closedAt')::TIMESTAMPTZ),
  (trade ->> 'closedAt')::TIMESTAMPTZ,
  NULLIF(trade #>> '{result,bars}', '')::INTEGER,
  COALESCE((trade #>> '{result,slMovedToEntry}')::BOOLEAN, FALSE),
  trade -> 'evidence',
  trade -> 'result'
FROM closed_source
WHERE UPPER(COALESCE(trade ->> 'symbol', '')) ~ '^[A-Z0-9]{2,20}USDT$'
  AND COALESCE(trade ->> 'interval', '') ~ '^[0-9]+[mhdwM]$'
  AND trade ->> 'side' IN ('long', 'short')
  AND trade #>> '{result,status}' IN ('stopped', 'breakeven', 'target', 'expired', 'cancelled')
  AND COALESCE(trade ->> 'closedAt', '') <> ''
  AND COALESCE(trade ->> 'entry', '') ~ '^[0-9]+([.][0-9]+)?$'
  AND COALESCE(trade ->> 'stopLoss', '') ~ '^[0-9]+([.][0-9]+)?$'
  AND (
    (trade ->> 'side' = 'long' AND (trade ->> 'stopLoss')::NUMERIC < (trade ->> 'entry')::NUMERIC)
    OR (trade ->> 'side' = 'short' AND (trade ->> 'stopLoss')::NUMERIC > (trade ->> 'entry')::NUMERIC)
  )
ON CONFLICT (legacy_id) DO NOTHING;

WITH state AS (
  SELECT document_value FROM public.app_documents WHERE document_key = 'data:auto-retune'
), closed_source AS (
  SELECT trade.value AS trade
  FROM state
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(document_value -> 'trades', '[]'::jsonb)) AS trade(value)
), targets AS (
  SELECT
    COALESCE(NULLIF(trade ->> 'id', ''), 'closed:' || MD5(trade::TEXT)) AS legacy_id,
    target.value AS target,
    target.ordinality::SMALLINT AS position,
    trade
  FROM closed_source
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(trade -> 'targets', '[]'::jsonb))
    WITH ORDINALITY AS target(value, ordinality)
)
INSERT INTO trading.trade_target (trade_call_id, position, label, target_price, is_hit)
SELECT
  c.id, t.position, t.target ->> 'label', (t.target ->> 'price')::NUMERIC,
  COALESCE(t.trade #> '{result,hitTps}', '[]'::jsonb) ? (t.target ->> 'label')
FROM targets t
JOIN trading.trade_call c ON c.legacy_id = t.legacy_id
WHERE COALESCE(t.target ->> 'label', '') <> ''
  AND COALESCE(t.target ->> 'price', '') ~ '^[0-9]+([.][0-9]+)?$'
ON CONFLICT (trade_call_id, position) DO NOTHING;

-- Monitor checkpoints
WITH monitor_source AS (
  SELECT checkpoint.key AS checkpoint_key, checkpoint.value AS payload
  FROM public.app_documents d
  CROSS JOIN LATERAL jsonb_each(d.document_value) AS checkpoint(key, value)
  WHERE d.document_key = 'data:monitor-state'
    AND jsonb_typeof(d.document_value) = 'object'
)
INSERT INTO trading.monitor_checkpoint (
  worker_key, symbol, interval, last_candle_ms, last_signal, payload
)
SELECT
  'telegram-monitor',
  UPPER(SPLIT_PART(checkpoint_key, '|', 1)),
  SPLIT_PART(checkpoint_key, '|', 2),
  CASE
    WHEN COALESCE(payload ->> 'lastCandleTime', '') ~ '^[0-9]+$'
      THEN (payload ->> 'lastCandleTime')::BIGINT
    ELSE NULL
  END,
  NULLIF(payload ->> 'lastSignal', ''),
  payload
FROM monitor_source
WHERE UPPER(SPLIT_PART(checkpoint_key, '|', 1)) ~ '^[A-Z0-9]{2,20}USDT$'
  AND SPLIT_PART(checkpoint_key, '|', 2) ~ '^([0-9]+[mhdwM]|auto)$'
ON CONFLICT (worker_key, symbol, interval) DO NOTHING;

-- Auto-retune runtime, attempts, reviews and daily loss logs
WITH state AS (
  SELECT document_value AS value
  FROM public.app_documents
  WHERE document_key = 'data:auto-retune'
)
INSERT INTO trading.tuning_runtime (
  singleton_id, active_source, active_changes, active_applied_at,
  last_handled_trade_legacy_id, last_applied_at, last_review_at, loss_log_week
)
SELECT
  1,
  value #>> '{activeTuning,source}',
  COALESCE(value #> '{activeTuning,changes}', '{}'::jsonb),
  NULLIF(value #>> '{activeTuning,appliedAt}', '')::TIMESTAMPTZ,
  NULLIF(value ->> 'lastHandledTriggerId', ''),
  NULLIF(value ->> 'lastAppliedAt', '')::TIMESTAMPTZ,
  NULLIF(value ->> 'lastReviewAt', '')::TIMESTAMPTZ,
  NULLIF(value ->> 'lossLogWeek', '')
FROM state
ON CONFLICT (singleton_id) DO NOTHING;

WITH state AS (
  SELECT document_value AS value FROM public.app_documents WHERE document_key = 'data:auto-retune'
), attempts AS (
  SELECT attempt.value AS attempt
  FROM state
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(value -> 'attempts', '[]'::jsonb)) AS attempt(value)
)
INSERT INTO trading.retune_attempt (
  trigger_trade_call_id, status, streak, selected_candidate_id, applied, report, created_at
)
SELECT
  c.id,
  COALESCE(NULLIF(attempt ->> 'status', ''), 'unknown'),
  NULLIF(attempt ->> 'streak', '')::INTEGER,
  attempt #>> '{selected,id}',
  COALESCE((attempt ->> 'applied')::BOOLEAN, attempt ->> 'status' = 'applied', FALSE),
  attempt,
  COALESCE(NULLIF(attempt ->> 'at', '')::TIMESTAMPTZ, NOW())
FROM attempts
LEFT JOIN trading.trade_call c ON c.legacy_id = attempt ->> 'triggerTradeId'
WHERE NOT EXISTS (
  SELECT 1 FROM trading.retune_attempt existing
  WHERE existing.report = attempt
);

WITH state AS (
  SELECT document_value AS value FROM public.app_documents WHERE document_key = 'data:auto-retune'
), reviews AS (
  SELECT review.value AS review
  FROM state
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(value -> 'reviews', '[]'::jsonb)) AS review(value)
)
INSERT INTO trading.daily_review (
  review_status, window_start, window_end, summary, comparison, report, created_at
)
SELECT
  COALESCE(NULLIF(review ->> 'status', ''), 'unknown'),
  NULLIF(review #>> '{window,since}', '')::TIMESTAMPTZ,
  NULLIF(review #>> '{window,until}', '')::TIMESTAMPTZ,
  review -> 'summary',
  review -> 'comparison',
  review,
  COALESCE(NULLIF(review ->> 'at', '')::TIMESTAMPTZ, NOW())
FROM reviews
WHERE NOT EXISTS (
  SELECT 1 FROM trading.daily_review existing
  WHERE existing.report = review
);

WITH state AS (
  SELECT document_value AS value FROM public.app_documents WHERE document_key = 'data:auto-retune'
), logs AS (
  SELECT log.value AS log
  FROM state
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(value -> 'lossLogs', '[]'::jsonb)) AS log(value)
)
INSERT INTO trading.daily_loss_log (log_date, week_key, payload)
SELECT (log ->> 'date')::DATE, NULLIF(log ->> 'week', ''), log
FROM logs
WHERE COALESCE(log ->> 'date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
ON CONFLICT (log_date) DO NOTHING;

-- Learning logs and strategy backups
INSERT INTO trading.learning_log (
  review_date, schema_version, generated_at, record, formatted_text
)
SELECT
  SUBSTRING(document_key FROM 'learning:loss:([0-9]{4}-[0-9]{2}-[0-9]{2})')::DATE,
  COALESCE(NULLIF(document_value #>> '{record,schemaVersion}', '')::INTEGER, 1),
  COALESCE(NULLIF(document_value #>> '{record,generatedAt}', '')::TIMESTAMPTZ, updated_at),
  document_value -> 'record',
  COALESCE(document_value ->> 'text', '')
FROM public.app_documents
WHERE document_key ~ '^learning:loss:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND jsonb_typeof(document_value -> 'record') = 'object'
ON CONFLICT (review_date) DO NOTHING;

INSERT INTO trading.strategy_version (config, source, reason, report, created_at, is_active)
SELECT
  document_value -> 'strategy',
  'rollback',
  'Imported legacy strategy backup ' || document_key,
  document_value -> 'report',
  updated_at,
  FALSE
FROM public.app_documents
WHERE document_key LIKE 'backup:strategy:%'
  AND jsonb_typeof(document_value -> 'strategy') = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM trading.strategy_version s
    WHERE s.reason = 'Imported legacy strategy backup ' || document_key
  );
