const express = require('express');
const { mysqlPool, getMongo } = require('../config/db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('Doctor'));

// Today's schedule -- straight off the RBAC view, filtered to the logged-in doctor.
// Also includes upcoming scheduled appointments so newly booked ones are always visible.
router.get('/schedule', async (req, res) => {
    const { date } = req.query; // optional ?date=YYYY-MM-DD
    if (date) {
        // Specific date requested
        const [rows] = await mysqlPool.query(
            `SELECT a.appointment_id, a.doctor_id, ud.name AS doctor_name,
                    up.name AS patient_name, up.email AS patient_email, up.phone AS patient_phone,
                    a.appointment_date, a.appointment_time, a.status,
                    a.patient_id
             FROM APPOINTMENT a
             JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id
             JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
             JOIN PATIENT p ON a.patient_id = p.patient_id
             JOIN \`USER\` up ON p.patient_id = up.user_id
             WHERE a.doctor_id = ? AND a.appointment_date = ?
             ORDER BY a.appointment_time`,
            [req.session.user.id, date]
        );
        return res.json(rows);
    }
    // Default: today + upcoming scheduled (next 30 days)
    const [rows] = await mysqlPool.query(
        `SELECT a.appointment_id, a.doctor_id, ud.name AS doctor_name,
                up.name AS patient_name, up.email AS patient_email, up.phone AS patient_phone,
                a.appointment_date, a.appointment_time, a.status,
                a.patient_id
         FROM APPOINTMENT a
         JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id
         JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
         JOIN PATIENT p ON a.patient_id = p.patient_id
         JOIN \`USER\` up ON p.patient_id = up.user_id
         WHERE a.doctor_id = ?
           AND (
             a.appointment_date = CURDATE()
             OR (a.appointment_date >= CURDATE() AND a.appointment_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) AND a.status IN ('Scheduled', 'Confirmed'))
           )
         ORDER BY a.appointment_date, a.appointment_time`,
        [req.session.user.id]
    );
    res.json(rows);
});

// Update appointment status (Accept -> Confirmed, Decline -> Cancelled)
router.patch('/appointments/:id/status', async (req, res) => {
    const { status } = req.body;
    if (!['Confirmed', 'Cancelled', 'Scheduled'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    const [result] = await mysqlPool.query(
        'UPDATE APPOINTMENT SET status = ? WHERE appointment_id = ? AND doctor_id = ?',
        [status, req.params.id, req.session.user.id]
    );
    if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Appointment not found' });
    }

    // Audit log
    try {
        const mongo = getMongo();
        await mongo.collection('audit_log').insertOne({
            event: status === 'Confirmed' ? 'appointment_confirmed_by_doctor' : 'appointment_cancelled_by_doctor',
            appointment_id: Number(req.params.id),
            doctor_id: req.session.user.id,
            status: status,
            updated_at: new Date()
        });
    } catch (_) {}

    res.json({ message: `Appointment ${status.toLowerCase()} successfully` });
});

// All-time patient list for this doctor (doctor-patients.html)
router.get('/my-patients', async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT DISTINCT
                a.appointment_id, a.appointment_date, a.appointment_time, a.status,
                up.name AS patient_name, up.email AS patient_email, up.phone AS patient_phone,
                a.patient_id
         FROM APPOINTMENT a
         JOIN PATIENT p ON a.patient_id = p.patient_id
         JOIN \`USER\` up ON p.patient_id = up.user_id
         WHERE a.doctor_id = ?
         ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
        [req.session.user.id]
    );
    res.json(rows);
});

// Patient history -- every past medical record + consultation for a given patient.
router.get('/patients/:patientId/history', async (req, res) => {
    const [records] = await mysqlPool.query(
        'SELECT * FROM MEDICAL_RECORD WHERE patient_id = ? ORDER BY created_at DESC', [req.params.patientId]
    );
    const [consultations] = await mysqlPool.query(
        `SELECT c.* FROM CONSULTATION c JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         WHERE a.patient_id = ? ORDER BY c.consultation_date DESC`, [req.params.patientId]
    );
    res.json({ records, consultations });
});

// Consultation form submit.
router.post('/consultations', async (req, res) => {
    const {
        appointment_id,
        symptoms,
        diagnosis,
        notes,
        recommend_admission,
        recommended_ward,
        admission_priority,
        admission_reason
    } = req.body;

    const [result] = await mysqlPool.query(
        'INSERT INTO CONSULTATION (appointment_id, symptoms, diagnosis, notes) VALUES (?, ?, ?, ?)',
        [appointment_id, symptoms, diagnosis, notes]
    );
    await mysqlPool.query("UPDATE APPOINTMENT SET status='Completed' WHERE appointment_id=?", [appointment_id]);

    // Bug 4 fix: Sync consultation diagnosis automatically into patient's MEDICAL_RECORD
    try {
        const [[appt]] = await mysqlPool.query('SELECT patient_id FROM APPOINTMENT WHERE appointment_id = ?', [appointment_id]);
        if (appt && appt.patient_id) {
            const summary = diagnosis ? `${diagnosis}${symptoms ? ' (Symptoms: ' + symptoms + ')' : ''}` : (symptoms || 'Clinical consultation');
            await mysqlPool.query(
                'INSERT INTO MEDICAL_RECORD (patient_id, doctor_id, diagnosis_summary) VALUES (?, ?, ?)',
                [appt.patient_id, req.session.user.id, summary.slice(0, 500)]
            );

            // Inpatient Admission Recommendation (transfers care request to Nurse for bed assignment)
            if (recommend_admission) {
                const targetWard = recommended_ward || 'General Ward';
                const prio = admission_priority || 'Urgent';
                const admReason = admission_reason || diagnosis || 'Doctor recommended inpatient hospitalization';

                const [admReq] = await mysqlPool.query(
                    'INSERT INTO ADMISSION_REQUEST (patient_id, doctor_id, consultation_id, appointment_id, recommended_ward, priority, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?, "Pending")',
                    [appt.patient_id, req.session.user.id, result.insertId, appointment_id, targetWard, prio, admReason]
                );

                // Broadcast notification to Nurses
                try {
                    const notifService = require('../services/notificationService');
                    await notifService.broadcastToRole('Nurse', {
                        title: 'Inpatient Admission Recommended',
                        message: `Dr. ${req.session.user.name} recommended ${targetWard} admission (${prio}) for patient #${appt.patient_id}. Bed assignment required.`,
                        type: 'admission_request',
                        metadata: { request_id: admReq.insertId, patient_id: appt.patient_id, ward: targetWard, priority: prio }
                    });
                } catch (notifErr) {
                    console.warn('Nurse notification warning:', notifErr.message);
                }
            }
        }
    } catch (mrErr) {
        console.warn('Medical record / admission request warning:', mrErr.message);
    }

    // MongoDB audit_log -- Phase 5: clinical audit trail
    try {
        const mongo = getMongo();
        await mongo.collection('audit_log').insertOne({
            event: 'consultation_completed',
            consultation_id: result.insertId,
            appointment_id: Number(appointment_id),
            doctor_id: req.session.user.id,
            doctor_name: req.session.user.name,
            diagnosis_summary: diagnosis ? diagnosis.slice(0, 200) : '',
            recommended_admission: !!recommend_admission,
            recommended_ward: recommend_admission ? (recommended_ward || 'General Ward') : null,
            completed_at: new Date()
        });
    } catch (mongoErr) {
        console.warn('MongoDB audit_log write failed (non-fatal):', mongoErr.message);
    }

    res.status(201).json({ consultation_id: result.insertId });
});

// Prescription form submit -- header + items in one call.
router.post('/prescriptions', async (req, res) => {
    const { consultation_id, patient_id, items } = req.body; // items: [{medicine_id, dosage, instructions, duration_days, quantity}]
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query(
            'INSERT INTO PRESCRIPTION (consultation_id, patient_id, doctor_id, status) VALUES (?, ?, ?, ?)',
            [consultation_id, patient_id, req.session.user.id, 'Pending']
        );
        const prescriptionId = result.insertId;
        for (const item of items) {
            await conn.query(
                'INSERT INTO PRESCRIPTION_ITEM (prescription_id, medicine_id, dosage, instructions, duration_days, quantity) VALUES (?, ?, ?, ?, ?, ?)',
                [prescriptionId, item.medicine_id, item.dosage, item.instructions || item.timing || null, item.duration_days, item.quantity]
            );
        }
        await conn.commit();
        res.status(201).json({ prescription_id: prescriptionId });
    } catch (err) {
        await conn.rollback();
        console.error('Error saving prescription:', err);
        res.status(500).json({ error: 'Failed to save prescription' });
    } finally {
        conn.release();
    }
});

// Lab request form submit.
router.post('/lab-requests', async (req, res) => {
    const { consultation_id, test_id, priority } = req.body;
    const [result] = await mysqlPool.query(
        "INSERT INTO LAB_REQUEST (consultation_id, test_id, requested_by, priority, status) VALUES (?, ?, ?, ?, 'Pending')",
        [consultation_id, test_id, req.session.user.id, priority || 'Normal']
    );
    res.status(201).json({ request_id: result.insertId });
});

// Search medicines for prescription autocomplete
router.get('/medicines/search', async (req, res) => {
    const q = req.query.q || '';
    const [rows] = await mysqlPool.query(
        'SELECT medicine_id, medicine_name, stock_qty FROM MEDICINE WHERE medicine_name LIKE ? AND stock_qty > 0 ORDER BY medicine_name LIMIT 20',
        ['%' + q + '%']
    );
    res.json(rows);
});

// Lab tests list for lab request modal
router.get('/lab-tests', async (req, res) => {
    const [rows] = await mysqlPool.query('SELECT test_id, test_name FROM LAB_TEST ORDER BY test_name');
    res.json(rows);
});

// Doctor notifications
router.get('/notifications', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT notification_id, message, is_read, created_at FROM NOTIFICATION
             WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
            [req.session.user.id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

router.patch('/notifications/mark-all-read', async (req, res) => {
    try {
        await mysqlPool.query('UPDATE NOTIFICATION SET is_read = TRUE WHERE user_id = ?', [req.session.user.id]);
        res.json({ message: 'All notifications marked read' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update notifications' });
    }
});

// Active emergency cases assigned to logged-in doctor
router.get('/emergency-cases', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT ec.*,
                    COALESCE(u.name, ec.temp_patient_name, 'Unidentified') AS patient_name,
                    p.blood_group, p.allergies,
                    b.bed_number, b.ward_name,
                    TIMESTAMPDIFF(MINUTE, ec.arrival_time, NOW()) AS wait_minutes
             FROM EMERGENCY_CASE ec
             LEFT JOIN PATIENT p ON ec.patient_id = p.patient_id
             LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
             LEFT JOIN BED b ON ec.assigned_bed_id = b.bed_id
             WHERE ec.assigned_doctor_id = ?
               AND ec.status NOT IN ('Discharged', 'Transferred')
             ORDER BY 
                CASE WHEN ec.triage_priority = 'P1' THEN 1
                     WHEN ec.triage_priority = 'P2' THEN 2
                     WHEN ec.triage_priority = 'P3' THEN 3
                     ELSE 4 END,
                ec.arrival_time ASC`,
            [req.session.user.id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load emergency cases' });
    }
});

// Doctor shifts schedule
router.get('/shifts', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT shift_id, shift_date, shift_type, start_time, end_time, is_on_duty
             FROM DOCTOR_SHIFT
             WHERE doctor_id = ? AND shift_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
             ORDER BY shift_date DESC`,
            [req.session.user.id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load shifts' });
    }
});

module.exports = router;
