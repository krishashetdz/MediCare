const express = require('express');
const router = express.Router();
const { mysqlPool } = require('../config/db');
const { requireRole } = require('../middleware/auth');
router.use(requireRole('Admin','Receptionist','Doctor','Patient'));

// Middleware: verify logged in
function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

/* ============================================================
   Billing routes — invoice view + items.
   Open to Admin, Receptionist, Doctor (their bills), Patient (own bills).
   ============================================================ */

router.get('/', requireAuth, async (req, res) => {
    try {
        const user = req.session.user;
        let query = `
            SELECT b.bill_id, b.patient_id, b.appointment_id, b.total_amount, b.payment_status, b.bill_date,
                   up.name AS patient_name
            FROM BILL b
            JOIN PATIENT p ON b.patient_id = p.patient_id
            JOIN \`USER\` up ON p.patient_id = up.user_id
        `;
        const params = [];
        if (user.role === 'Patient') {
            query += ' WHERE b.patient_id = ?';
            params.push(user.id);
        } else if (user.role === 'Doctor') {
            query += ' WHERE EXISTS (SELECT 1 FROM APPOINTMENT a WHERE a.appointment_id=b.appointment_id AND a.doctor_id=?)';
            params.push(user.id);
        }
        query += ' ORDER BY b.bill_date DESC LIMIT 50';
        const [rows] = await mysqlPool.query(query, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load bills' });
    }
});

router.get('/:billId', requireAuth, async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT b.bill_id, b.patient_id, b.appointment_id, b.total_amount, b.payment_status, b.bill_date,
                    up.name AS patient_name
             FROM BILL b
             JOIN PATIENT p ON b.patient_id = p.patient_id
             JOIN \`USER\` up ON p.patient_id = up.user_id
             WHERE b.bill_id = ?`,
            [req.params.billId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Bill not found' });

        const bill = rows[0];

        // Role-based access: Patient sees only own bills, staff sees all
        const user = req.session.user;
        if (user.role === 'Patient' && bill.patient_id !== user.id) {
            return res.status(404).json({ error: 'Bill not found' });
        }
        if (user.role === 'Doctor') {
            const [[allowed]]=await mysqlPool.query('SELECT appointment_id FROM APPOINTMENT WHERE appointment_id=? AND doctor_id=?',[bill.appointment_id,user.id]);
            if(!allowed) return res.status(404).json({error:'Bill not found'});
        }

        res.json(bill);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load bill' });
    }
});

router.get('/:billId/items', requireAuth, async (req, res) => {
    try {
        // Access check same as above — verify bill belongs to requester if Patient
        const [billCheck] = await mysqlPool.query('SELECT patient_id,appointment_id FROM BILL WHERE bill_id = ?', [req.params.billId]);
        if (!billCheck.length) return res.status(404).json({ error: 'Bill not found' });

        const user = req.session.user;
        if (user.role === 'Patient' && billCheck[0].patient_id !== user.id) {
            return res.status(404).json({ error: 'Bill not found' });
        }
        if (user.role === 'Doctor') {
            const [[allowed]]=await mysqlPool.query('SELECT appointment_id FROM APPOINTMENT WHERE appointment_id=? AND doctor_id=?',[billCheck[0].appointment_id,user.id]);
            if(!allowed) return res.status(404).json({error:'Bill not found'});
        }

        const [rows] = await mysqlPool.query(
            `SELECT bill_item_id, item_type, description, amount
             FROM BILL_ITEM WHERE bill_id = ?
             ORDER BY bill_item_id`,
            [req.params.billId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load bill items' });
    }
});

module.exports = router;
