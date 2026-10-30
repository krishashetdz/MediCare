const express = require('express');
const bcrypt = require('bcryptjs');
const { mysqlPool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Change password
router.post('/change-password', async (req, res) => {
    const { current_password, new_password } = req.body;
    const userId = req.session.user.id;

    try {
        const [[user]] = await mysqlPool.query('SELECT password_hash FROM `USER` WHERE user_id = ?', [userId]);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const valid = await bcrypt.compare(current_password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Current password incorrect' });
        }

        const newHash = await bcrypt.hash(new_password, 10);
        await mysqlPool.query('UPDATE `USER` SET password_hash = ? WHERE user_id = ?', [newHash, userId]);

        res.json({ message: 'Password updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
