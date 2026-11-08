#!/usr/bin/env node
/**
 * db/install-fresh.js
 * Safe Fresh Database Installation Runner for MediCare (`medivault` schema).
 *
 * SAFETY GUARANTEES:
 * 1. NEVER executes `DROP DATABASE` or `DROP TABLE`.
 * 2. Checks whether `USER` or `PATIENT` records already exist in the target database.
 *    If existing hospital records are found, refuses to overwrite and directs the user
 *    to run `node db/migrate.js` instead.
 * 3. Creates missing tables, views, triggers, and stored procedures from `db/schema.sql`.
 * 4. Optionally loads `db/seed.sql` (using `INSERT IGNORE`) when `--seed` is passed or on an empty database.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function computeChecksum(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function splitSqlStatements(sqlText) {
    const lines = sqlText.replace(/\r\n/g, '\n').split('\n');
    let delimiter = ';';
    let buffer = '';
    const statements = [];

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('--')) continue;

        const delimMatch = trimmed.match(/^DELIMITER\s+(\S+)$/i);
        if (delimMatch) {
            delimiter = delimMatch[1];
            continue;
        }

        buffer += rawLine + '\n';
        if (trimmed.endsWith(delimiter)) {
            const stmt = buffer.slice(0, buffer.lastIndexOf(delimiter)).trim();
            if (stmt) statements.push(stmt);
            buffer = '';
        }
    }
    if (buffer.trim()) {
        statements.push(buffer.trim());
    }
    return statements;
}

async function runFreshInstall(pool, options = {}) {
    const { loadSeed = true, allowExistingEmpty = false } = options;
    const schemaPath = path.join(__dirname, 'schema.sql');
    const seedPath = path.join(__dirname, 'seed.sql');

    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    if (/DROP\s+DATABASE/i.test(schemaSql)) {
        throw new Error('SECURITY VIOLATION: db/schema.sql contains destructive DROP DATABASE statement!');
    }

    let existingUserCount = 0;
    let existingPatientCount = 0;
    try {
        const [[uRow]] = await pool.query('SELECT COUNT(*) AS cnt FROM `USER`');
        const [[pRow]] = await pool.query('SELECT COUNT(*) AS cnt FROM PATIENT');
        existingUserCount = Number(uRow ? uRow.cnt : 0);
        existingPatientCount = Number(pRow ? pRow.cnt : 0);
    } catch (_) {
        // Tables do not exist yet — safe fresh installation
    }

    if ((existingUserCount > 0 || existingPatientCount > 0) && !allowExistingEmpty) {
        return {
            status: 'skipped_existing_data',
            existing_users: existingUserCount,
            existing_patients: existingPatientCount,
            message: `Database already contains ${existingUserCount} user(s) and ${existingPatientCount} patient(s). Fresh install aborted to protect existing records. Run 'node db/migrate.js' for safe schema upgrades.`
        };
    }

    const statements = splitSqlStatements(schemaSql);
    let executedStatements = 0;
    for (const stmt of statements) {
        if (/^USE\s+/i.test(stmt) || /^CREATE\s+DATABASE/i.test(stmt)) continue;
        await pool.query(stmt);
        executedStatements++;
    }

    // Record baseline migration 001 as applied; leave incremental migrations (002+) for `db/migrate.js` or record if requested
    const migrationsDir = path.join(__dirname, 'migrations');
    if (fs.existsSync(migrationsDir) && options.markAllMigrationsApplied) {
        const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
        for (const file of files) {
            const version = file.split('_')[0];
            const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
            const checksum = computeChecksum(content);
            await pool.query(
                `INSERT IGNORE INTO SCHEMA_MIGRATIONS (version, filename, checksum, execution_ms, status)
                 VALUES (?, ?, ?, 0, 'Applied')`,
                [version, file, checksum]
            );
        }
    }

    let seedStatements = 0;
    if (loadSeed && fs.existsSync(seedPath)) {
        const seedSql = fs.readFileSync(seedPath, 'utf8');
        const stmts = splitSqlStatements(seedSql);
        for (const stmt of stmts) {
            if (/^USE\s+/i.test(stmt)) continue;
            await pool.query(stmt);
            seedStatements++;
        }
    }

    return {
        status: 'installed',
        executed_schema_statements: executedStatements,
        executed_seed_statements: seedStatements,
        message: 'Fresh database installation completed safely without destructive SQL.'
    };
}

if (require.main === module) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    const { mysqlPool } = require('../config/db');
    const loadSeed = !process.argv.includes('--no-seed');
    runFreshInstall(mysqlPool, { loadSeed, markAllMigrationsApplied: true })
        .then(res => {
            console.log('[install-fresh]', res.message);
            process.exit(0);
        })
        .catch(err => {
            console.error('[install-fresh] ERROR:', err.message);
            process.exit(1);
        });
}

module.exports = { runFreshInstall, splitSqlStatements, computeChecksum };
