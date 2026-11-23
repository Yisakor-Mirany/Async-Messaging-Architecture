-- =============================================================================
-- 001_initial_schema.sql
-- Durable job status store, transactional outbox, and job audit trail.
--
-- Applied by api/src/migrate.js (the one-shot `migrate` Compose service).
-- Each migration file runs inside a single transaction and is recorded in
-- schema_migrations, so it is applied exactly once per database volume.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- jobs: one row per report-generation request. This table is the source of
-- truth for job state; RabbitMQ messages only carry the job ID.
-- -----------------------------------------------------------------------------
CREATE TABLE jobs (
    id                UUID         PRIMARY KEY,
    report_type       TEXT         NOT NULL,
    payload           JSONB        NOT NULL,            -- validated request body
    status            TEXT         NOT NULL DEFAULT 'queued',
    progress          SMALLINT     NOT NULL DEFAULT 0,  -- 0..100, updated by the worker
    attempts          INTEGER      NOT NULL DEFAULT 0,  -- incremented on every claim
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    started_at        TIMESTAMPTZ,                      -- first time a worker claimed it
    completed_at      TIMESTAMPTZ,                      -- set only on success
    failed_at         TIMESTAMPTZ,                      -- set only on terminal failure
    last_enqueued_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    error_details     JSONB,                            -- last error (kept for audit)
    result            JSONB,                            -- report output metadata
    locked_by         TEXT,                             -- worker instance holding the lease
    lease_expires_at  TIMESTAMPTZ,                      -- processing lease (crash detection)

    CONSTRAINT jobs_status_chk
        CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    CONSTRAINT jobs_report_type_chk
        CHECK (report_type IN ('sales_summary', 'inventory_snapshot', 'user_activity', 'financial_statement')),
    CONSTRAINT jobs_progress_chk     CHECK (progress BETWEEN 0 AND 100),
    CONSTRAINT jobs_attempts_chk     CHECK (attempts >= 0),
    -- Timestamps must agree with the status (no "completed" job without a completion time).
    CONSTRAINT jobs_completed_at_chk CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CONSTRAINT jobs_failed_at_chk    CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
    CONSTRAINT jobs_started_at_chk   CHECK (status = 'queued' OR started_at IS NOT NULL),
    -- A processing job always has an owner and a lease; nothing else may have one.
    CONSTRAINT jobs_lease_chk
        CHECK ((status = 'processing') = (locked_by IS NOT NULL AND lease_expires_at IS NOT NULL)),
    -- Only completed jobs carry a result.
    CONSTRAINT jobs_result_chk       CHECK (status = 'completed' OR result IS NULL)
);

CREATE INDEX jobs_created_at_idx       ON jobs (created_at DESC);
CREATE INDEX jobs_status_updated_idx   ON jobs (status, updated_at);

-- -----------------------------------------------------------------------------
-- outbox: messages that must be published to RabbitMQ. Written in the SAME
-- transaction as the job row, then relayed by the outbox-publisher service.
-- -----------------------------------------------------------------------------
CREATE TABLE outbox (
    id                BIGSERIAL    PRIMARY KEY,
    message_id        UUID         NOT NULL UNIQUE,     -- becomes AMQP message_id
    job_id            UUID         NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    routing_key       TEXT         NOT NULL,
    payload           JSONB        NOT NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    published_at      TIMESTAMPTZ,                      -- NULL = not yet confirmed by broker
    publish_attempts  INTEGER      NOT NULL DEFAULT 0,
    last_error        TEXT,

    CONSTRAINT outbox_publish_attempts_chk CHECK (publish_attempts >= 0)
);

-- Small partial index: the relay only ever scans unpublished rows.
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX outbox_job_id_idx      ON outbox (job_id);

-- -----------------------------------------------------------------------------
-- job_events: append-only audit trail of every state transition. Used by the
-- QA suite to prove sequential processing, retries and idempotency.
-- -----------------------------------------------------------------------------
CREATE TABLE job_events (
    id          BIGSERIAL    PRIMARY KEY,
    job_id      UUID         NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    event_type  TEXT         NOT NULL,
    attempt     INTEGER,
    worker_id   TEXT,
    message_id  UUID,
    details     JSONB,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT job_events_type_chk CHECK (event_type IN (
        'created', 'published', 'claimed', 'retry_scheduled', 'completed', 'failed',
        'duplicate_ignored', 'deferred', 'lease_lost', 'reconciled'))
);

CREATE INDEX job_events_job_id_idx ON job_events (job_id, id);

-- Database-level idempotency guarantee: a job can be completed (or failed)
-- at most once, no matter how many times its message is delivered.
CREATE UNIQUE INDEX job_events_single_completion_idx ON job_events (job_id) WHERE event_type = 'completed';
CREATE UNIQUE INDEX job_events_single_failure_idx    ON job_events (job_id) WHERE event_type = 'failed';
