const express = require('express');
const bcrypt = require('bcryptjs');
const { mysqlPool } = require('../config/db');

const router = express.Router();

// One login page, one endpoint, for every role -- ROLE lookup decides where
// the frontend redirects to next. Passwords must be verified against bcrypt hashes.
router.post('/login', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Invalid login payload' });
    }
    const { email, password } = req.body;
    // Strict string type check prevents NoSQL / object injection payloads like { email: { $ne: null } }
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Email and password must be non-empty strings' });
    }
    try {
        const [rows] = await mysqlPool.query(
            `SELECT u.user_id, u.name, u.email, u.password_hash, r.role_name
             FROM \`USER\` u JOIN ROLE r ON u.role_id = r.role_id
             WHERE u.email = ? AND u.is_active = TRUE`,
            [email.trim()]
        );
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        const user = rows[0];
        let match = false;
        try {
            if (user.password_hash && user.password_hash.startsWith('$2')) {
                match = await bcrypt.compare(password, user.password_hash);
            }
        } catch (e) {
            match = false;
        }
        if (!match) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // For STAFF logins, also fetch the sub-role (Nurse/Lab Tech/Pharmacist/Receptionist)
        let staffType = null;
        if (user.role_name !== 'Admin' && user.role_name !== 'Doctor' && user.role_name !== 'Patient') {
            const [staffRows] = await mysqlPool.query(
                'SELECT staff_type FROM STAFF WHERE staff_id = ?', [user.user_id]
            );
            staffType = staffRows[0] ? staffRows[0].staff_type : null;
        }

        const userSessionPayload = {
            id: user.user_id,
            name: user.name,
            email: user.email,
            role: user.role_name,
            staffType,
            loginAt: Date.now()
        };

        const redirectMap = {
            Admin: '/admin-dashboard.html',
            Doctor: '/doctor-dashboard.html',
            Patient: '/patient-portal.html',
            Nurse: '/staff-portal.html',
            'Lab Technician': '/staff-portal.html',
            Pharmacist: '/staff-portal.html',
            Receptionist: '/staff-portal.html'
        };

        // Regenerate session ID after successful login to prevent session fixation (Part 6.7)
        if (typeof req.session.regenerate === 'function') {
            return req.session.regenerate((regenErr) => {
                if (regenErr) {
                    return res.status(500).json({ error: 'Could not establish session' });
                }
                req.session.user = userSessionPayload;
                req.session.save(() => {
                    res.json({
                        message: 'Login successful',
                        user: req.session.user,
                        redirect: redirectMap[user.role_name] || '/'
                    });
                });
            });
        }

        req.session.user = userSessionPayload;
        res.json({
            message: 'Login successful',
            user: req.session.user,
            redirect: redirectMap[user.role_name] || '/'
        });
    } catch (err) {
        if (err && (err.isMysqlUnavailable || err.code === 'ECONNREFUSED')) {
            return res.status(503).json({ error: 'Authentication database is temporarily unavailable' });
        }
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Server error during login' });
    }
});

router.post('/logout', (req, res) => {
    if (!req.session) {
        res.clearCookie('medicare.sid');
        res.clearCookie('connect.sid');
        return res.json({ message: 'Logged out' });
    }
    req.session.destroy(() => {
        res.clearCookie('medicare.sid');
        res.clearCookie('connect.sid');
        res.json({ message: 'Logged out' });
    });
});

router.get('/me', async (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (!req.session.user.email) {
        try {
            const [rows] = await mysqlPool.query('SELECT email FROM `USER` WHERE user_id = ?', [req.session.user.id]);
            if (rows.length) req.session.user.email = rows[0].email;
        } catch (e) {}
    }
    res.json(req.session.user);
});

module.exports = router;
