-- Migration 001: Baseline Schema Guard & SCHEMA_MIGRATIONS Tracking
CREATE TABLE IF NOT EXISTS SCHEMA_MIGRATIONS (
    migration_id    INT AUTO_INCREMENT PRIMARY KEY,
    version         VARCHAR(40) NOT NULL UNIQUE,
    filename        VARCHAR(160) NOT NULL,
    checksum        VARCHAR(64) NOT NULL,
    applied_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    execution_ms    INT NOT NULL DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'Applied'
                    CHECK (status IN ('Applied', 'RolledBack', 'Failed'))
) ENGINE=InnoDB;
