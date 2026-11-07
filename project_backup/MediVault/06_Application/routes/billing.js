const express = require('express');
const router = express.Router();
const { mysqlPool, getMongo } = require('../config/db');
const { requireRole, requireAuth } = require('../middleware/auth');
const { sendNotification } = require('../services/notificationService');

router.use(requireRole('Admin', 'Receptionist', 'Doctor', 'Patient'));

// Helper: verify whether a user is authorized to view a specific bill
async function canAccessBill(user, bill) {
    if (!user || !bill) return false;
    if (user.role === 'Admin' || user.role === 'Receptionist') return true;
    if (user.role === 'Patient') return Number(bill.patient_id) === Number(user.id);
    if (user.role === 'Doctor') {
        if (bill.appointment_id) {
            const [[allowedAppt]] = await mysqlPool.query(
                'SELECT appointment_id FROM APPOINTMENT WHERE appointment_id = ? AND doctor_id = ?',
                [bill.appointment_id, user.id]
            );
            if (allowedAppt) return true;
        }
        if (bill.admission_id) {
            const [[allowedAdm]] = await mysqlPool.query(
                'SELECT admission_id FROM ADMISSION WHERE admission_id = ? AND admitting_doctor_id = ?',
                [bill.admission_id, user.id]
            );
            if (allowedAdm) return true;
        }
        if (bill.case_id) {
            const [[allowedEmg]] = await mysqlPool.query(
                'SELECT assignment_id FROM EMERGENCY_DOCTOR_ASSIGNMENT WHERE case_id = ? AND doctor_id = ?',
                [bill.case_id, user.id]
            );
            if (allowedEmg) return true;
        }
        return false;
    }
    return false;
}

/* ============================================================
   Billing routes — invoice view + items + payment & receipt recording.
   Open to Admin, Receptionist, Doctor (their bills), Patient (own bills).
   ============================================================ */

router.get('/', requireAuth, async (req, res) => {
    try {
        const user = req.session.user;
        let query = `
            SELECT b.bill_id, b.patient_id, b.appointment_id, b.admission_id, b.case_id,
                   b.total_amount, b.paid_amount, b.balance_due, b.payment_status, b.bill_date,
                   up.name AS patient_name
            FROM vw_bill_summary b
            JOIN PATIENT p ON b.patient_id = p.patient_id
            JOIN \`USER\` up ON p.patient_id = up.user_id
        `;
        const params = [];
        if (user.role === 'Patient') {
            query += ' WHERE b.patient_id = ?';
            params.push(user.id);
        } else if (user.role === 'Doctor') {
            query += ` WHERE (
                EXISTS (SELECT 1 FROM APPOINTMENT a WHERE a.appointment_id = b.appointment_id AND a.doctor_id = ?)
                OR EXISTS (SELECT 1 FROM ADMISSION adm WHERE adm.admission_id = b.admission_id AND adm.admitting_doctor_id = ?)
                OR EXISTS (SELECT 1 FROM EMERGENCY_DOCTOR_ASSIGNMENT eda WHERE eda.case_id = b.case_id AND eda.doctor_id = ?)
            )`;
            params.push(user.id, user.id, user.id);
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
            `SELECT b.bill_id, b.patient_id, b.appointment_id, b.admission_id, b.case_id,
                    b.total_amount, b.paid_amount, b.balance_due, b.payment_status, b.bill_date,
                    up.name AS patient_name
             FROM vw_bill_summary b
             JOIN PATIENT p ON b.patient_id = p.patient_id
             JOIN \`USER\` up ON p.patient_id = up.user_id
             WHERE b.bill_id = ?`,
            [req.params.billId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Bill not found' });

        const bill = rows[0];
        const allowed = await canAccessBill(req.session.user, bill);
        if (!allowed) return res.status(404).json({ error: 'Bill not found' });

        // Also include payments/receipts history on the bill detail payload
        const [payments] = await mysqlPool.query(
            `SELECT pm.payment_id, pm.bill_id, pm.amount_paid, pm.payment_method,
                    pm.reference_no, pm.receipt_number, pm.paid_at, pm.received_by,
                    COALESCE(u.name, 'System') AS received_by_name
             FROM PAYMENT pm
             LEFT JOIN \`USER\` u ON pm.received_by = u.user_id
             WHERE pm.bill_id = ?
             ORDER BY pm.paid_at ASC, pm.payment_id ASC`,
            [req.params.billId]
        );
        bill.payments = payments;

        res.json(bill);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load bill' });
    }
});

router.get('/:billId/items', requireAuth, async (req, res) => {
    try {
        const [billCheck] = await mysqlPool.query(
            'SELECT bill_id, patient_id, appointment_id, admission_id, case_id FROM vw_bill_summary WHERE bill_id = ?',
            [req.params.billId]
        );
        if (!billCheck.length) return res.status(404).json({ error: 'Bill not found' });

        const allowed = await canAccessBill(req.session.user, billCheck[0]);
        if (!allowed) return res.status(404).json({ error: 'Bill not found' });

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

// List payments / receipts for an invoice
router.get('/:billId/payments', requireAuth, async (req, res) => {
    try {
        const [billCheck] = await mysqlPool.query(
            'SELECT bill_id, patient_id, appointment_id, admission_id, case_id FROM vw_bill_summary WHERE bill_id = ?',
            [req.params.billId]
        );
        if (!billCheck.length) return res.status(404).json({ error: 'Bill not found' });

        const allowed = await canAccessBill(req.session.user, billCheck[0]);
        if (!allowed) return res.status(404).json({ error: 'Bill not found' });

        const [payments] = await mysqlPool.query(
            `SELECT pm.payment_id, pm.bill_id, pm.amount_paid, pm.payment_method,
                    pm.reference_no, pm.receipt_number, pm.paid_at, pm.received_by,
                    COALESCE(u.name, 'System') AS received_by_name
             FROM PAYMENT pm
             LEFT JOIN \`USER\` u ON pm.received_by = u.user_id
             WHERE pm.bill_id = ?
             ORDER BY pm.paid_at ASC, pm.payment_id ASC`,
            [req.params.billId]
        );
        res.json(payments);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load payments' });
    }
});

// Record a payment (Partial or Full/Paid) and generate a receipt
router.post('/:billId/payments', requireRole('Admin', 'Receptionist'), async (req, res) => {
    const { amount_paid, amount, payment_method = 'Cash', reference_no = null } = req.body;
    const payAmount = Number(amount_paid !== undefined ? amount_paid : amount);

    if (!Number.isFinite(payAmount) || payAmount <= 0) {
        return res.status(400).json({ error: 'Valid positive payment amount is required' });
    }

    const validMethods = ['Cash', 'Card', 'UPI', 'Bank Transfer', 'Insurance'];
    const method = validMethods.includes(payment_method) ? payment_method : 'Cash';

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // Lock BILL row to prevent concurrent overpayments
        const [rawBill] = await conn.query('SELECT * FROM BILL WHERE bill_id = ? FOR UPDATE', [req.params.billId]);
        if (!rawBill.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Bill not found' });
        }

        const [[summary]] = await conn.query(
            'SELECT * FROM vw_bill_summary WHERE bill_id = ?',
            [req.params.billId]
        );

        const totalAmount = Number(summary.total_amount || 0);
        const alreadyPaid = Number(summary.paid_amount || 0);
        const balanceDue = Number(summary.balance_due || 0);

        if (summary.payment_status === 'Paid' || balanceDue <= 0) {
            await conn.rollback();
            return res.status(409).json({ error: 'This invoice is already Paid in full' });
        }

        if (payAmount > balanceDue + 0.009) {
            await conn.rollback();
            return res.status(400).json({
                error: `Payment amount (₹${payAmount.toFixed(2)}) exceeds remaining balance due (₹${balanceDue.toFixed(2)})`
            });
        }

        const [[maxRow]] = await conn.query('SELECT COALESCE(MAX(payment_id), 0) AS max_id FROM PAYMENT FOR UPDATE');
        const nextId = Number(maxRow.max_id) + 1;
        const year = new Date().getFullYear();
        const receiptNumber = `RCP-${year}-${String(nextId).padStart(6, '0')}`;

        const [ins] = await conn.query(
            `INSERT INTO PAYMENT (bill_id, amount_paid, payment_method, reference_no, receipt_number, paid_at, received_by)
             VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
            [req.params.billId, payAmount.toFixed(2), method, reference_no || null, receiptNumber, req.session.user.id]
        );

        const [[updatedBill]] = await conn.query(
            `SELECT b.*, up.name AS patient_name
             FROM vw_bill_summary b
             JOIN \`USER\` up ON b.patient_id = up.user_id
             WHERE b.bill_id = ?`,
            [req.params.billId]
        );

        const [[receipt]] = await conn.query(
            `SELECT pm.*, COALESCE(u.name, 'Staff') AS received_by_name
             FROM PAYMENT pm
             LEFT JOIN \`USER\` u ON pm.received_by = u.user_id
             WHERE pm.payment_id = ?`,
            [ins.insertId]
        );

        await conn.commit();

        // Notify patient of payment & receipt
        await sendNotification({
            user_id: updatedBill.patient_id,
            message: `Payment of ₹${payAmount.toFixed(2)} received for Bill #${updatedBill.bill_id} (Receipt ${receiptNumber}). Status: ${updatedBill.payment_status}.`,
            event_type: 'payment_received'
        });

        // Audit log in MongoDB
        try {
            const mongo = getMongo();
            await mongo.collection('audit_log').insertOne({
                user_id: req.session.user.id,
                action: 'RECORD payment',
                table_affected: 'PAYMENT',
                details: {
                    payment_id: ins.insertId,
                    bill_id: Number(req.params.billId),
                    receipt_number: receiptNumber,
                    amount_paid: Number(payAmount.toFixed(2)),
                    payment_method: method,
                    new_payment_status: updatedBill.payment_status,
                    balance_due: Number(updatedBill.balance_due)
                },
                timestamp: new Date()
            });
        } catch (_) {}

        res.status(201).json({
            message: `Payment recorded (${updatedBill.payment_status}). Receipt ${receiptNumber} generated.`,
            receipt: {
                payment_id: receipt.payment_id,
                receipt_number: receipt.receipt_number,
                bill_id: Number(req.params.billId),
                invoice_number: 'INV-' + String(req.params.billId).padStart(6, '0'),
                patient_id: updatedBill.patient_id,
                patient_name: updatedBill.patient_name,
                amount_paid: Number(receipt.amount_paid),
                payment_method: receipt.payment_method,
                reference_no: receipt.reference_no,
                paid_at: receipt.paid_at,
                received_by_name: receipt.received_by_name,
                invoice_total: Number(updatedBill.total_amount),
                total_paid_to_date: Number(updatedBill.paid_amount),
                balance_due: Number(updatedBill.balance_due),
                payment_status: updatedBill.payment_status
            },
            bill: updatedBill
        });
    } catch (err) {
        await conn.rollback();
        console.error('Payment recording error:', err);
        res.status(500).json({ error: 'Failed to record payment: ' + err.message });
    } finally {
        conn.release();
    }
});

module.exports = router;
