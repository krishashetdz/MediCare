require('dotenv').config();
// Async route errors must reach Express rather than terminate a request.
require('express-async-errors');
const express = require('express');
const session = require('express-session');
const path = require('path');
const { connectMongo } = require('./config/db');

const app = express();
app.use(express.json());
// Browser API origin is supplied by environment, not baked into any page.
app.get('/runtime-config.js', (req, res) => res.type('application/javascript').send(
    'window.MV_API_BASE=' + JSON.stringify(process.env.REACT_APP_BACKEND_URL || '') + ';'
));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'medivault-dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8-hour shift-length session
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
    app.listen(PORT, () => console.log(`MediCare server listening on :${PORT}`));
}

start();
