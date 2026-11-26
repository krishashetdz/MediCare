const express = require('express');
const bcrypt = require('bcryptjs');
const { mysqlPool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Get full profile details for the signed-in user
router.get('/', async (req, res) => {
    const userId = req.session.user.id;
    try {
        const [[user]] = await mysqlPool.query(
            `SELECT u.user_id, u.name, u.email, u.phone, r.role_name
             FROM \`USER\` u
             JOIN ROLE r ON u.role_id = r.role_id
             WHERE u.user_id = ?`,
            [userId]
        );
        if (!user) return res.status(404).json({ error: 'User not found' });

        const profile = {
            id: user.user_id,
            name: user.name,
            email: user.email,
            phone: user.phone || null,
            role: user.role_name
        };

        if (user.role_name === 'Patient') {
            const [[p]] = await mysqlPool.query(
                'SELECT blood_group, dob, gender, address, emergency_contact FROM PATIENT WHERE patient_id = ?',
                [userId]
            );
            if (p) Object.assign(profile, p);
        } else if (user.role_name === 'Doctor') {
            const [[d]] = await mysqlPool.query(
                `SELECT d.specialization, d.qualification, d.consultation_fee, dept.department_name
                 FROM DOCTOR d
                 JOIN DEPARTMENT dept ON d.department_id = dept.department_id
                 WHERE d.doctor_id = ?`,
                [userId]
            );
            if (d) Object.assign(profile, d);
        } else if (user.role_name !== 'Admin') {
            const [[s]] = await mysqlPool.query(
                `SELECT s.staff_type, s.shift, dept.department_name
                 FROM STAFF s
                 LEFT JOIN DEPARTMENT dept ON s.department_id = dept.department_id
                 WHERE s.staff_id = ?`,
                [userId]
            );
            if (s) Object.assign(profile, s);
        }

        res.json(profile);
    } catch (err) {
        res.status(500).json({ error: 'Could not load profile details' });
    }
});

// Update self-service contact details
router.put('/', async (req, res) => {
    const userId = req.session.user.id;
    const role = req.session.user.role;
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : null;
    if (phone !== null && phone.length > 0 && !/^[0-9+\-\s()]{7,15}$/.test(phone)) {
        return res.status(400).json({ error: 'Enter a valid phone number (7-15 digits)' });
    }
    try {
        if (phone !== null) {
            await mysqlPool.query('UPDATE `USER` SET phone = ? WHERE user_id = ?', [phone || null, userId]);
        }
        if (role === 'Patient') {
            const address = typeof req.body.address === 'string' ? req.body.address.trim() : null;
            const emergencyContact = typeof req.body.emergency_contact === 'string' ? req.body.emergency_contact.trim() : null;
            await mysqlPool.query(
                'UPDATE PATIENT SET address = ?, emergency_contact = ? WHERE patient_id = ?',
                [address || null, emergencyContact || null, userId]
            );
        }
        res.json({ message: 'Contact details updated' });
    } catch (err) {
        res.status(500).json({ error: 'Could not update profile details' });
    }
});

// Change password
router.post('/change-password', async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || typeof current_password !== 'string' || !new_password || typeof new_password !== 'string' || new_password.length < 4) {
        return res.status(400).json({ error: 'Current password and a valid new password (min 4 characters) are required' });
    }
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
        res.status(500).json({ error: 'Could not update password' });
    }
});

module.exports = router;
