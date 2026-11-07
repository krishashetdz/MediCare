require('dotenv').config();
// Async route errors must reach Express rather than terminate a request.
require('express-async-errors');
const express = require('express');
const session = require('express-session');
const path = require('path');
const { connectMongo } = require('./config/db');

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET === 'change-this-in-production' || SESSION_SECRET === 'medivault-dev-secret-change-in-production') {
    throw new Error('SESSION_SECRET environment variable must be set to a real secret value before starting the server.');
}

const app = express();
app.use(express.json());
// Browser API origin is supplied by environment, not baked into any page.
app.get('/runtime-config.js', (req, res) => res.type('application/javascript').send(
    'window.MV_API_BASE=' + JSON.stringify(process.env.REACT_APP_BACKEND_URL || '') + ';'
));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 8 // 8-hour shift-length session
    }
}));

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
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'The request could not be completed. Please try again.' });
});

const PORT = process.env.PORT || 3000;

async function start() {
    try {
        await connectMongo();
    } catch (err) {
        console.warn('MongoDB not reachable at startup -- notification/lab-raw routes will degrade gracefully:', err.message);
    }
    return app.listen(PORT, () => console.log(`MediCare server listening on :${PORT}`));
}

if (require.main === module) {
    start();
}

module.exports = { app, start };
