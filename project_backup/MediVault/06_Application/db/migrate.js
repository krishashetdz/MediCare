#!/usr/bin/env node
/**
 * db/migrate.js
 * Safe Incremental Database Migration Runner for MediCare (`medivault` schema).
 */
const fs = require('fs');
const path = require('path');
const { splitSqlStatements, computeChecksum } = require('./install-fresh');

async function ensureMigrationsTable(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS SCHEMA_MIGRATIONS (
            migration_id    INT AUTO_INCREMENT PRIMARY KEY,
            version         VARCHAR(40) NOT NULL UNIQUE,
            filename        VARCHAR(160) NOT NULL,
            checksum        VARCHAR(64) NOT NULL,
            applied_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            execution_ms    INT NOT NULL DEFAULT 0,
            status          VARCHAR(20) NOT NULL DEFAULT 'Applied'
                            CHECK (status IN ('Applied', 'RolledBack', 'Failed'))
        ) ENGINE=InnoDB
    `);
}

async function getMigrationStatus(pool) {
    await ensureMigrationsTable(pool);
    const [rows] = await pool.query(
        'SELECT version, filename, checksum, applied_at, execution_ms, status FROM SCHEMA_MIGRATIONS ORDER BY version ASC'
    );
    return rows;
}

async function runMigrations(pool, options = {}) {
    const migrationsDir = options.migrationsDir || path.join(__dirname, 'migrations');
    await ensureMigrationsTable(pool);

    const [appliedRows] = await pool.query(
        "SELECT version, filename, checksum, status FROM SCHEMA_MIGRATIONS WHERE status = 'Applied'"
    );
    const appliedMap = new Map(appliedRows.map(r => [String(r.version), r]));

    const files = fs.existsSync(migrationsDir)
        ? fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
        : [];

    const appliedNow = [];
    const skipped = [];

    for (const file of files) {
        const version = file.split('_')[0];
        const fullPath = path.join(migrationsDir, file);
        const sqlContent = fs.readFileSync(fullPath, 'utf8');
        const checksum = computeChecksum(sqlContent);

        if (/DROP\s+DATABASE/i.test(sqlContent)) {
            throw new Error(`Refusing destructive migration ${file}: contains DROP DATABASE`);
        }

        if (appliedMap.has(version)) {
            const existing = appliedMap.get(version);
            if (existing.checksum && existing.checksum !== checksum && !options.ignoreChecksum) {
                throw new Error(`Migration checksum mismatch for version ${version} (${file}). Expected ${existing.checksum}, got ${checksum}`);
            }
            skipped.push(file);
            continue;
        }

        const startMs = Date.now();
        const statements = splitSqlStatements(sqlContent);
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            for (const stmt of statements) {
                await conn.query(stmt);
            }
            const elapsed = Date.now() - startMs;
            await conn.query(
                `INSERT INTO SCHEMA_MIGRATIONS (version, filename, checksum, execution_ms, status)
                 VALUES (?, ?, ?, ?, 'Applied')
                 ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), execution_ms = VALUES(execution_ms), status = 'Applied', applied_at = NOW()`,
                [version, file, checksum, elapsed]
            );
            await conn.commit();
            appliedNow.push({ version, filename: file, execution_ms: elapsed });
        } catch (err) {
            await conn.rollback();
            throw new Error(`Migration ${file} failed: ${err.message}`);
        } finally {
            conn.release();
        }
    }

    return {
        status: 'ok',
        applied: appliedNow,
        skipped,
        total_tracked: appliedMap.size + appliedNow.length
    };
}

async function rollbackMigration(pool, targetVersion, options = {}) {
    const rollbacksDir = options.rollbacksDir || path.join(__dirname, 'migrations', 'rollbacks');
    await ensureMigrationsTable(pool);

    const [rows] = await pool.query(
        "SELECT * FROM SCHEMA_MIGRATIONS WHERE version = ? AND status = 'Applied'",
        [String(targetVersion)]
    );
    if (!rows.length) {
        return { status: 'not_applied', message: `Migration version ${targetVersion} is not currently applied.` };
    }

    const files = fs.existsSync(rollbacksDir)
        ? fs.readdirSync(rollbacksDir).filter(f => f.startsWith(`${targetVersion}_`) && f.endsWith('.down.sql'))
        : [];
    if (!files.length) {
        throw new Error(`No rollback script found for version ${targetVersion} in ${rollbacksDir}`);
    }

    const rollbackSql = fs.readFileSync(path.join(rollbacksDir, files[0]), 'utf8');
    const statements = splitSqlStatements(rollbackSql);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        for (const stmt of statements) {
            await conn.query(stmt);
        }
        await conn.query(
            "UPDATE SCHEMA_MIGRATIONS SET status = 'RolledBack' WHERE version = ?",
            [String(targetVersion)]
        );
        await conn.commit();
        return { status: 'rolled_back', version: String(targetVersion), file: files[0] };
    } catch (err) {
        await conn.rollback();
        throw new Error(`Rollback ${files[0]} failed: ${err.message}`);
    } finally {
        conn.release();
    }
}

if (require.main === module) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    const { mysqlPool } = require('../config/db');
    const args = process.argv.slice(2);
    (async () => {
        if (args.includes('--status')) {
            const rows = await getMigrationStatus(mysqlPool);
            console.table(rows);
            process.exit(0);
        }
        const rbIdx = args.indexOf('--rollback');
        if (rbIdx !== -1 && args[rbIdx + 1]) {
            const res = await rollbackMigration(mysqlPool, args[rbIdx + 1]);
            console.log('[migrate rollback]', res);
            process.exit(0);
        }
        const res = await runMigrations(mysqlPool);
        console.log('[migrate]', JSON.stringify(res, null, 2));
        process.exit(0);
    })().catch(err => {
        console.error('[migrate] ERROR:', err.message);
        process.exit(1);
    });
}

module.exports = { ensureMigrationsTable, getMigrationStatus, runMigrations, rollbackMigration };
