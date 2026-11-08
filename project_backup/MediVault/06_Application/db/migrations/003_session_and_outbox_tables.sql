-- Migration 003: Persistent Express Session Store & Cross-Database Outbox Table
CREATE TABLE IF NOT EXISTS USER_SESSION (
    session_id      VARCHAR(128) PRIMARY KEY,
    user_id         INT NULL,
    expires_at      BIGINT NOT NULL,
    session_data    TEXT NOT NULL,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_session_expires (expires_at),
    CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES `USER`(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS CROSS_DB_OUTBOX (
    outbox_id       INT AUTO_INCREMENT PRIMARY KEY,
    idempotency_key VARCHAR(120) NOT NULL UNIQUE,
    collection_name VARCHAR(60) NOT NULL,
    operation_type  VARCHAR(20) NOT NULL DEFAULT 'upsert' CHECK (operation_type IN ('insert','upsert','update')),
    filter_json     TEXT NULL,
    payload_json    TEXT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Synced','Failed')),
    retry_count     INT NOT NULL DEFAULT 0,
    last_error      VARCHAR(500) NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    synced_at       DATETIME NULL,
    INDEX idx_outbox_status (status, retry_count)
) ENGINE=InnoDB;
