/**
 * tests/start-test-server.js
 * Starts the MediCare Express server on a local port backed by the seeded test database
 * so headless Chromium (Selenium) can run full browser E2E verification (TEST K).
 */
const http = require('http');
const Module = require('module');
const vendorDeps = require('./harness/vendor_deps');
const { createInMemoryMysqlPool, createInMemoryMongoDb } = require('./harness/test_db_engine');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'express') return vendorDeps.express;
    if (request === 'express-session') return vendorDeps.expressSession;
    if (request === 'bcryptjs') return vendorDeps.bcryptjs;
    if (request === 'dotenv') return vendorDeps.dotenv;
    if (request === 'express-async-errors') return {};
    return origLoad.apply(this, arguments);
};

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'medicare_test_secret_key_2026';

const testMysqlPool = createInMemoryMysqlPool();
const testMongoDb = createInMemoryMongoDb();
const dbModule = require('../config/db');
dbModule.__setTestAdapters({ customMysqlPool: testMysqlPool, customMongoDb: testMongoDb });

const { runFreshInstall } = require('../db/install-fresh');
const { app } = require('../server');

async function start() {
    await runFreshInstall(testMysqlPool, { loadSeed: true, markAllMigrationsApplied: true });
    // Also register one unassessed emergency case so browser tests can see both Triage Pending & Assessed cases
    await testMysqlPool.query(
        'INSERT INTO EMERGENCY_CASE (patient_id, registered_by, arrival_mode, initial_complaint, current_priority, assessment_status, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [6, 11, 'Walk-In', 'Acute migraine and photophobia', null, 'Pending_Triage', 'Registered']
    );

    const port = Number(process.env.PORT || 3456);
    const server = http.createServer(app);
    server.listen(port, '127.0.0.1', () => {
        console.log(`BROWSER_TEST_SERVER_READY:${port}`);
    });
}

start().catch(err => {
    console.error('Failed to start browser test server:', err);
    process.exit(1);
});
