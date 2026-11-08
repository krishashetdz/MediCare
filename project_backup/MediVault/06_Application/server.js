require('dotenv').config();
// Async route errors must reach Express rather than terminate a request.
require('express-async-errors');
const express = require('express');
const session = require('express-session');
const path = require('path');
const { mysqlPool, connectMongo, checkDatabaseHealth } = require('./config/db');
const { createMySqlSessionStore } = require('./config/sessionStore');
const { reconcilePendingOutbox } = require('./services/crossDbSync');

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET === 'change-this-in-production' || SESSION_SECRET === 'medivault-dev-secret-change-in-production') {
    throw new Error('SESSION_SECRET environment variable must be set to a real secret value before starting the server.');
}

const app = express();

// Configure proxy trust for reverse-proxy / HTTPS deployments (Render, Railway, Nginx, AWS ALB)
app.set('trust proxy', process.env.TRUST_PROXY !== undefined ? Number(process.env.TRUST_PROXY) || 1 : 1);

app.use(express.json({ limit: '1mb' }));

// Browser API origin is supplied by environment, not baked into any page.
app.get('/runtime-config.js', (req, res) => res.type('application/javascript').send(
    'window.MV_API_BASE=' + JSON.stringify(process.env.REACT_APP_BACKEND_URL || '') + ';'
));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMaxAgeMs = Number(process.env.SESSION_MAX_AGE_MS) || (1000 * 60 * 60 * 8); // 8-hour shift-length session
const sessionStore = createMySqlSessionStore(session, mysqlPool, { ttlMs: sessionMaxAgeMs });
const isSecureCookie = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';

app.use(session({
    name: 'medicare.sid',
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
        httpOnly: true,
        secure: isSecureCookie ? 'auto' : false,
        sameSite: process.env.COOKIE_SAMESITE || 'lax',
        maxAge: sessionMaxAgeMs
    }
}));

// Liveness & Readiness Health Checks (Part 5.A)
app.get('/health/live', (req, res) => {
    res.status(200).json({
        status: 'alive',
        uptime_seconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

app.get('/health/ready', async (req, res) => {
    const health = await checkDatabaseHealth();
    const httpStatus = health.mysql.connected ? 200 : 503;
    res.status(httpStatus).json(health);
});

app.get('/health', async (req, res) => {
    const health = await checkDatabaseHealth();
    const httpStatus = health.mysql.connected ? 200 : 503;
    res.status(httpStatus).json(health);
});

app.post('/api/admin/reconcile-outbox', async (req, res) => {
    if (!req.session || !req.session.user || req.session.user.role !== 'Admin') {
        return res.status(403).json({ error: 'Requires role: Admin' });
    }
    const result = await reconcilePendingOutbox();
    res.json(result);
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/resources'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/doctor', require('./routes/doctor'));
app.use('/api/patient', require('./routes/patient'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/emergency', require('./routes/emergency'));

app.get('/', (req, res) => res.redirect('/login.html'));

app.use((err, req, res, next) => {
    // Handle malformed JSON payloads cleanly
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON request payload' });
    }
    // Feature-specific MySQL outage error handling (Part 5.B)
    if (err && (err.isMysqlUnavailable || err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST')) {
        console.error('[Database Service Error]:', err.message);
        return res.status(503).json({
            error: 'Relational database service (MySQL) is temporarily unavailable. Please retry shortly.',
            service: 'mysql',
            degraded: true
        });
    }
    // Never log or expose sensitive credentials, hashes, or raw SQL internals
    console.error('[Request Error]:', err && err.message ? err.message : 'Unknown error');
    res.status(500).json({ error: 'The request could not be completed. Please try again.' });
});

const PORT = process.env.PORT || 3000;

async function start() {
    try {
        await connectMongo();
        await reconcilePendingOutbox();
    } catch (err) {
        console.warn('MongoDB not reachable at startup -- notification/lab-raw routes will queue in CROSS_DB_OUTBOX:', err.message);
    }
    return app.listen(PORT, () => console.log(`MediCare server listening on :${PORT}`));
}

if (require.main === module) {
    start();
}

module.exports = { app, start, sessionStore };
