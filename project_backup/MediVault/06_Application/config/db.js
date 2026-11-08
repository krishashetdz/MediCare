let mysql = null;
let MongoClient = null;
try {
    mysql = require('mysql2/promise');
} catch (_) {}
try {
    ({ MongoClient } = require('mongodb'));
} catch (_) {}

// Runtime state & health tracking
let activeMysqlPool = null;
let mongoClient = null;
let mongoDb = null;
let mongoConnected = false;
let mysqlForcedDown = false;
let mongoForcedDown = false;
const dbFailureLog = [];

function logDbEvent(database, event, message) {
    const entry = {
        database,
        event,
        message: String(message || ''),
        timestamp: new Date().toISOString()
    };
    dbFailureLog.push(entry);
    if (dbFailureLog.length > 200) dbFailureLog.shift();
}

function createRealMysqlPool() {
    if (!mysql) return null;
    return mysql.createPool({
        socketPath: process.env.MYSQL_SOCKET || undefined,
        host: process.env.MYSQL_HOST || 'localhost',
        port: process.env.MYSQL_PORT || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || 'medivault',
        dateStrings: ['DATE'],
        waitForConnections: true,
        connectionLimit: 10
    });
}

activeMysqlPool = createRealMysqlPool();

// Proxy wrapper around activeMysqlPool so tests or reconnection logic can swap or fault-inject cleanly
const mysqlPool = {
    async query(sql, params) {
        if (mysqlForcedDown || !activeMysqlPool) {
            const err = new Error('MySQL relational database service is currently unavailable');
            err.code = 'ECONNREFUSED';
            err.isMysqlUnavailable = true;
            logDbEvent('mysql', 'query_failed', err.message);
            throw err;
        }
        try {
            return await activeMysqlPool.query(sql, params);
        } catch (err) {
            if (err && (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ER_CON_COUNT_ERROR')) {
                logDbEvent('mysql', 'connection_error', err.message);
            }
            throw err;
        }
    },
    async getConnection() {
        if (mysqlForcedDown || !activeMysqlPool) {
            const err = new Error('MySQL relational database service is currently unavailable');
            err.code = 'ECONNREFUSED';
            err.isMysqlUnavailable = true;
            logDbEvent('mysql', 'connection_failed', err.message);
            throw err;
        }
        return activeMysqlPool.getConnection();
    },
    async end() {
        if (activeMysqlPool && typeof activeMysqlPool.end === 'function') {
            return activeMysqlPool.end();
        }
    }
};

// MongoDB: audit_log / lab_reports_raw / ambulance_dispatch_log / notification_log
async function connectMongo() {
    if (mongoForcedDown) {
        mongoConnected = false;
        const err = new Error('MongoDB connection unavailable (simulated or offline)');
        logDbEvent('mongodb', 'connect_failed', err.message);
        throw err;
    }
    if (mongoDb && mongoConnected) {
        return mongoDb;
    }
    const uri = process.env.MONGO_URL || process.env.MONGO_URI;
    if (!uri) {
        mongoConnected = false;
        const err = new Error('MONGO_URL or MONGO_URI must be configured');
        logDbEvent('mongodb', 'config_missing', err.message);
        throw err;
    }
    if (!MongoClient) {
        mongoConnected = false;
        const err = new Error('MongoDB driver not installed');
        logDbEvent('mongodb', 'driver_missing', err.message);
        throw err;
    }
    try {
        mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
        await mongoClient.connect();
        mongoDb = mongoClient.db(process.env.MONGO_DATABASE || 'medivault');
        mongoConnected = true;
        logDbEvent('mongodb', 'connected', 'MongoDB connected successfully');
        console.log('MongoDB connected');
        return mongoDb;
    } catch (err) {
        mongoConnected = false;
        logDbEvent('mongodb', 'connect_failed', err.message);
        throw err;
    }
}

function isMongoAvailable() {
    return Boolean(mongoDb && mongoConnected && !mongoForcedDown);
}

function getMongo() {
    if (mongoForcedDown || !mongoDb || !mongoConnected) {
        const err = new Error('MongoDB not connected yet');
        err.code = 'MONGO_UNAVAILABLE';
        logDbEvent('mongodb', 'access_when_disconnected', err.message);
        throw err;
    }
    return mongoDb;
}

async function checkDatabaseHealth() {
    let mysqlHealthy = false;
    let mysqlError = null;
    let mysqlLatencyMs = null;

    const t0 = Date.now();
    try {
        await mysqlPool.query('SELECT 1 AS ok');
        mysqlHealthy = true;
        mysqlLatencyMs = Date.now() - t0;
    } catch (err) {
        mysqlHealthy = false;
        mysqlError = err.message || 'MySQL unreachable';
    }

    let mongoHealthy = false;
    let mongoError = null;
    let mongoLatencyMs = null;

    const t1 = Date.now();
    if (isMongoAvailable()) {
        try {
            if (typeof mongoDb.command === 'function') {
                await mongoDb.command({ ping: 1 });
            }
            mongoHealthy = true;
            mongoLatencyMs = Date.now() - t1;
        } catch (err) {
            mongoHealthy = false;
            mongoConnected = false;
            mongoError = err.message || 'MongoDB ping failed';
            logDbEvent('mongodb', 'ping_failed', mongoError);
        }
    } else {
        mongoHealthy = false;
        mongoError = mongoForcedDown ? 'MongoDB disconnected' : 'MongoDB not connected';
    }

    // Attempt background MongoDB reconnection if disconnected and not intentionally forced down
    if (!mongoHealthy && !mongoForcedDown && (process.env.MONGO_URL || process.env.MONGO_URI) && MongoClient) {
        try {
            await connectMongo();
            mongoHealthy = true;
            mongoError = null;
        } catch (_) {}
    }

    const overallStatus = !mysqlHealthy
        ? 'unavailable'
        : (mongoHealthy ? 'ok' : 'degraded');

    return {
        status: overallStatus,
        liveness: 'alive',
        readiness: mysqlHealthy ? (mongoHealthy ? 'ready' : 'degraded_mongo_offline') : 'not_ready_mysql_offline',
        mysql: {
            connected: mysqlHealthy,
            latency_ms: mysqlLatencyMs,
            error: mysqlError,
            required_for: ['authentication', 'patients', 'appointments', 'consultations', 'prescriptions', 'pharmacy', 'emergency', 'admissions', 'billing', 'blood_bank', 'ambulances']
        },
        mongodb: {
            connected: mongoHealthy,
            latency_ms: mongoLatencyMs,
            error: mongoError,
            required_for: ['lab_reports_raw_parameters', 'immutable_audit_log', 'ambulance_dispatch_telemetry', 'notification_log'],
            fallback_mode: mongoHealthy ? 'none' : 'durable_mysql_outbox_queued'
        },
        recent_failures: dbFailureLog.slice(-10)
    };
}

// Adapter injection hooks for isolated test environments & fault-injection testing
function __setTestAdapters({ customMysqlPool, customMongoDb }) {
    if (customMysqlPool !== undefined) activeMysqlPool = customMysqlPool;
    if (customMongoDb !== undefined) {
        mongoDb = customMongoDb;
        mongoConnected = Boolean(customMongoDb);
    }
}

function __setSimulatedOutage({ mysqlDown, mongoDown }) {
    if (typeof mysqlDown === 'boolean') {
        mysqlForcedDown = mysqlDown;
        logDbEvent('mysql', mysqlDown ? 'simulated_disconnect' : 'simulated_reconnect', mysqlDown ? 'MySQL simulated outage enabled' : 'MySQL connection restored');
    }
    if (typeof mongoDown === 'boolean') {
        mongoForcedDown = mongoDown;
        logDbEvent('mongodb', mongoDown ? 'simulated_disconnect' : 'simulated_reconnect', mongoDown ? 'MongoDB simulated outage enabled' : 'MongoDB connection restored');
    }
}

module.exports = {
    mysqlPool,
    connectMongo,
    getMongo,
    isMongoAvailable,
    checkDatabaseHealth,
    logDbEvent,
    __setTestAdapters,
    __setSimulatedOutage
};
