const express = require('express');
const { mysqlPool, getMongo } = require('../config/db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('Patient'));

// Portal home: next appointment, records count, pending bills, unread alert count.
router.get('/summary', async (req, res) => {
    const [rows] = await mysqlPool.query(
        'SELECT * FROM vw_patient_portal_summary WHERE patient_id = ?', [req.session.user.id]
    );
    res.json(rows[0] || {});
});

// Booking flow: department -> doctor -> date -> time -> confirm.
router.post('/book-appointment', async (req, res) => {
    const { doctor_id, department_id, appointment_date, appointment_time } = req.body;
    try {
        await mysqlPool.query(
            'CALL sp_book_appointment(?, ?, ?, ?, ?, ?)',
            [req.session.user.id, doctor_id, department_id || null, appointment_date, appointment_time, req.session.user.id]
        );

        // MongoDB audit_log
        try {
            const mongo = getMongo();
            await mongo.collection('audit_log').insertOne({
                event: 'appointment_booked',
                patient_id: req.session.user.id,
                patient_name: req.session.user.name,
                doctor_id: Number(doctor_id),
                department_id: department_id ? Number(department_id) : null,
                appointment_date,
                appointment_time,
                booked_at: new Date()
            });
        } catch (mongoErr) {
            console.warn('MongoDB audit_log write failed (non-fatal):', mongoErr.message);
        }

        res.status(201).json({ message: 'Appointment booked' });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Selected slot is already booked for this doctor' });
        }
        res.status(409).json({ error: err.sqlMessage || 'Could not book appointment' });
    }
});

// Get all appointments for logged-in patient (3NF: department derived via DOCTOR -> DEPARTMENT)
router.get('/appointments', async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT a.appointment_id, a.doctor_id, ud.name AS doctor_name, doc.specialization,
                dept.department_name, a.appointment_date, a.appointment_time, a.status, a.created_at
         FROM APPOINTMENT a
         JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id
         JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
         JOIN DEPARTMENT dept ON doc.department_id = dept.department_id
         WHERE a.patient_id = ?
         ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
        [req.session.user.id]
    );
    res.json(rows);
});

// Cancel appointment by patient
router.post('/appointments/:id/cancel', async (req, res) => {
    const [result] = await mysqlPool.query(
        "UPDATE APPOINTMENT SET status = 'Cancelled' WHERE appointment_id = ? AND patient_id = ? AND status IN ('Scheduled', 'Confirmed')",
        [req.params.id, req.session.user.id]
    );
    if (result.affectedRows === 0) {
        return res.status(400).json({ error: 'Appointment cannot be cancelled' });
    }
    res.json({ message: 'Appointment cancelled successfully' });
});

// Doctor consultation reports for patient (3NF: department derived via DOCTOR -> DEPARTMENT)
router.get('/doctor-reports', async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT c.consultation_id, c.appointment_id, c.symptoms, c.diagnosis, c.notes, c.consultation_date,
                ud.name AS doctor_name, doc.specialization, dept.department_name,
                a.appointment_date, a.appointment_time
         FROM CONSULTATION c
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id
         JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
         JOIN DEPARTMENT dept ON doc.department_id = dept.department_id
         WHERE a.patient_id = ?
         ORDER BY c.consultation_date DESC`,
        [req.session.user.id]
    );
    res.json(rows);
});

router.get('/records', async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT mr.record_id, mr.patient_id, mr.doctor_id, mr.diagnosis_summary, mr.created_at,
                COALESCE(ud.name, 'Attending Physician') AS doctor_name,
                COALESCE(doc.specialization, 'General Medicine') AS specialization
         FROM MEDICAL_RECORD mr
         LEFT JOIN DOCTOR doc ON mr.doctor_id = doc.doctor_id
         LEFT JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
         WHERE mr.patient_id = ?
         ORDER BY mr.created_at DESC`,
        [req.session.user.id]
    );
    res.json(rows);
});

// Bills for patient (3NF: computed via vw_bill_summary)
router.get('/bills', async (req, res) => {
    const [rows] = await mysqlPool.query(
        'SELECT * FROM vw_bill_summary WHERE patient_id = ? ORDER BY bill_date DESC',
        [req.session.user.id]
    );
    res.json(rows);
});

// Lab reports -- one line summary from MySQL, full structured result from MongoDB
router.get('/lab-reports', async (req, res) => {
    const [summaries] = await mysqlPool.query(
        `SELECT lr.report_id, lr.request_id, lt.test_name, lr.result_summary, lr.report_date
         FROM LAB_REPORT lr
         JOIN LAB_REQUEST rq ON lr.request_id = rq.request_id
         JOIN LAB_TEST lt ON rq.test_id = lt.test_id
         JOIN CONSULTATION c ON rq.consultation_id = c.consultation_id
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         WHERE a.patient_id = ?`, [req.session.user.id]
    );
    try {
        const mongo = getMongo();
        const requestIds = summaries.map(s => s.request_id);
        const raw = requestIds.length
            ? await mongo.collection('lab_reports_raw').find({ request_id: { $in: requestIds } }, { projection: { _id: 0 } }).toArray()
            : [];
        const merged = summaries.map(s => ({ ...s, raw: raw.find(r => r.request_id === s.request_id) || null }));
        res.json(merged);
    } catch (mongoErr) {
        res.json(summaries.map(s => ({ ...s, raw: null })));
    }
});

// Notifications -- MySQL
router.get('/notifications', async (req, res) => {
    const [rows] = await mysqlPool.query(
        'SELECT notification_id, message, is_read, created_at FROM NOTIFICATION WHERE user_id = ? ORDER BY created_at DESC',
        [req.session.user.id]
    );
    res.json(rows);
});

router.patch('/notifications/:id/read', async (req, res) => {
    await mysqlPool.query('UPDATE NOTIFICATION SET is_read = TRUE WHERE notification_id = ? AND user_id = ?',
        [req.params.id, req.session.user.id]);
    res.json({ message: 'Marked read' });
});

// Departments list for booking wizard step 1
router.get('/departments', async (req, res) => {
    const [rows] = await mysqlPool.query('SELECT department_id, department_name FROM DEPARTMENT ORDER BY department_name');
    res.json(rows);
});

// Doctors by department for booking wizard step 2
router.get('/doctors', async (req, res) => {
    const deptId = req.query.department_id;
    const [rows] = await mysqlPool.query(
        `SELECT d.doctor_id, u.name AS doctor_name, d.specialization
         FROM DOCTOR d JOIN \`USER\` u ON d.doctor_id = u.user_id
         WHERE d.department_id = ? ORDER BY u.name`,
        [deptId]
    );
    res.json(rows);
});

// Available time slots for booking wizard step 4
router.get('/available-slots', async (req, res) => {
    const { doctor_id, appointment_date } = req.query;
    const allSlots = [];
    for (let h = 9; h < 17; h++) {
        allSlots.push(String(h).padStart(2,'0') + ':00:00');
        allSlots.push(String(h).padStart(2,'0') + ':30:00');
    }
    const [booked] = await mysqlPool.query(
        "SELECT appointment_time FROM APPOINTMENT WHERE doctor_id=? AND appointment_date=? AND status IN ('Scheduled', 'Confirmed', 'Checked In')",
        [doctor_id, appointment_date]
    );
    const bookedTimes = booked.map(b => b.appointment_time);
    const available = allSlots.filter(s => !bookedTimes.includes(s));
    res.json(available);
});

// Prescriptions for patient (3NF: derived via CONSULTATION -> APPOINTMENT)
router.get('/prescriptions', async (req, res) => {
    const [headers] = await mysqlPool.query(
        `SELECT p.prescription_id, p.prescribed_date, p.status, u.name AS doctor_name
         FROM PRESCRIPTION p
         JOIN CONSULTATION c ON p.consultation_id = c.consultation_id
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         JOIN DOCTOR d ON a.doctor_id = d.doctor_id
         JOIN \`USER\` u ON d.doctor_id = u.user_id
         WHERE a.patient_id = ?
         ORDER BY p.prescribed_date DESC`,
        [req.session.user.id]
    );
    res.json(headers);
});

// Prescription items detail
router.get('/prescriptions/:id/items', async (req, res) => {
    const [items] = await mysqlPool.query(
        `SELECT pi.*, m.medicine_name
         FROM PRESCRIPTION_ITEM pi
         JOIN MEDICINE m ON pi.medicine_id = m.medicine_id
         JOIN PRESCRIPTION pr ON pi.prescription_id = pr.prescription_id
         JOIN CONSULTATION c ON pr.consultation_id = c.consultation_id
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         WHERE pi.prescription_id = ? AND a.patient_id = ?`,
        [req.params.id, req.session.user.id]
    );
    res.json(items);
});

module.exports = router;
