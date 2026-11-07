const express = require('express');
const { mysqlPool, getMongo } = require('../config/db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('Doctor'));

// Helper: verify whether logged-in doctor has a care relationship with a patient
async function doctorOwnsPatient(doctorId, patientId) {
    const [[apptMatch]] = await mysqlPool.query(
        'SELECT 1 AS ok FROM APPOINTMENT WHERE doctor_id = ? AND patient_id = ? LIMIT 1',
        [doctorId, patientId]
    );
    if (apptMatch) return true;

    const [[mrMatch]] = await mysqlPool.query(
        'SELECT 1 AS ok FROM MEDICAL_RECORD WHERE doctor_id = ? AND patient_id = ? LIMIT 1',
        [doctorId, patientId]
    );
    if (mrMatch) return true;

    const [[admMatch]] = await mysqlPool.query(
        'SELECT 1 AS ok FROM ADMISSION WHERE admitting_doctor_id = ? AND patient_id = ? LIMIT 1',
        [doctorId, patientId]
    );
    if (admMatch) return true;

    const [[emgMatch]] = await mysqlPool.query(
        `SELECT 1 AS ok
         FROM EMERGENCY_DOCTOR_ASSIGNMENT eda
         JOIN EMERGENCY_CASE ec ON eda.case_id = ec.case_id
         WHERE eda.doctor_id = ? AND ec.patient_id = ? LIMIT 1`,
        [doctorId, patientId]
    );
    return Boolean(emgMatch);
}

// Today's schedule -- filtered to the logged-in doctor.
router.get('/schedule', async (req, res) => {
    const { date } = req.query; // optional ?date=YYYY-MM-DD
    if (date) {
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
             OR (a.appointment_date >= CURDATE() AND a.appointment_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) AND a.status IN ('Scheduled', 'Confirmed', 'Checked In'))
           )
         ORDER BY a.appointment_date, a.appointment_time`,
        [req.session.user.id]
    );
    res.json(rows);
});

// Update appointment status (Accept -> Confirmed, Check In -> Checked In, Decline -> Cancelled)
router.patch('/appointments/:id/status', async (req, res) => {
    const { status } = req.body;
    if (!['Confirmed', 'Checked In', 'Cancelled', 'Scheduled'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    const [result] = await mysqlPool.query(
        'UPDATE APPOINTMENT SET status = ? WHERE appointment_id = ? AND doctor_id = ?',
        [status, req.params.id, req.session.user.id]
    );
    if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Appointment not found or not owned by you' });
    }

    // Audit log
    try {
        const mongo = getMongo();
        await mongo.collection('audit_log').insertOne({
            event: status === 'Confirmed' ? 'appointment_confirmed_by_doctor' : 'appointment_status_updated_by_doctor',
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

// Helper to fetch lab reports (MySQL summary + MongoDB lab_reports_raw) for a patient
async function fetchPatientLabReports(patientId) {
    const [summaries] = await mysqlPool.query(
        `SELECT lr.report_id, lr.request_id, rq.priority, rq.status,
                lt.test_name, lt.test_category, lr.result_summary, lr.report_date,
                ud.name AS requested_by_name, ut.name AS technician_name
         FROM LAB_REPORT lr
         JOIN LAB_REQUEST rq ON lr.request_id = rq.request_id
         JOIN LAB_TEST lt ON rq.test_id = lt.test_id
         JOIN CONSULTATION c ON rq.consultation_id = c.consultation_id
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         LEFT JOIN \`USER\` ud ON rq.requested_by = ud.user_id
         LEFT JOIN \`USER\` ut ON lr.technician_id = ut.user_id
         WHERE a.patient_id = ?
         ORDER BY lr.report_date DESC`,
        [patientId]
    );
    try {
        const mongo = getMongo();
        const requestIds = summaries.map(s => s.request_id);
        const raw = requestIds.length
            ? await mongo.collection('lab_reports_raw').find({ request_id: { $in: requestIds } }, { projection: { _id: 0 } }).toArray()
            : [];
        return summaries.map(s => ({ ...s, raw: raw.find(r => r.request_id === s.request_id) || null }));
    } catch (_) {
        return summaries.map(s => ({ ...s, raw: null }));
    }
}

// Patient history -- medical records, consultations, and lab reports for an owned patient
router.get('/patients/:patientId/history', async (req, res) => {
    const allowed = await doctorOwnsPatient(req.session.user.id, req.params.patientId);
    if (!allowed) {
        return res.status(403).json({ error: 'Access denied: you can only view history for your own patients' });
    }

    const [records] = await mysqlPool.query(
        'SELECT * FROM MEDICAL_RECORD WHERE patient_id = ? ORDER BY created_at DESC',
        [req.params.patientId]
    );
    const [consultations] = await mysqlPool.query(
        `SELECT c.* FROM CONSULTATION c
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         WHERE a.patient_id = ? ORDER BY c.consultation_date DESC`,
        [req.params.patientId]
    );
    const lab_reports = await fetchPatientLabReports(req.params.patientId);
    res.json({ records, consultations, lab_reports });
});

// Dedicated endpoint for doctor to view lab reports (for a specific patient or all patients requested by this doctor)
router.get('/lab-reports', async (req, res) => {
    const { patient_id } = req.query;
    if (patient_id) {
        const allowed = await doctorOwnsPatient(req.session.user.id, patient_id);
        if (!allowed) {
            return res.status(403).json({ error: 'Access denied: you can only view lab reports for your own patients' });
        }
        const reports = await fetchPatientLabReports(patient_id);
        return res.json(reports);
    }

    const [summaries] = await mysqlPool.query(
        `SELECT lr.report_id, lr.request_id, rq.priority, rq.status,
                a.patient_id, up.name AS patient_name,
                lt.test_name, lt.test_category, lr.result_summary, lr.report_date,
                ut.name AS technician_name
         FROM LAB_REPORT lr
         JOIN LAB_REQUEST rq ON lr.request_id = rq.request_id
         JOIN LAB_TEST lt ON rq.test_id = lt.test_id
         JOIN CONSULTATION c ON rq.consultation_id = c.consultation_id
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         JOIN \`USER\` up ON a.patient_id = up.user_id
         LEFT JOIN \`USER\` ut ON lr.technician_id = ut.user_id
         WHERE rq.requested_by = ? OR a.doctor_id = ?
         ORDER BY lr.report_date DESC`,
        [req.session.user.id, req.session.user.id]
    );
    try {
        const mongo = getMongo();
        const requestIds = summaries.map(s => s.request_id);
        const raw = requestIds.length
            ? await mongo.collection('lab_reports_raw').find({ request_id: { $in: requestIds } }, { projection: { _id: 0 } }).toArray()
            : [];
        return res.json(summaries.map(s => ({ ...s, raw: raw.find(r => r.request_id === s.request_id) || null })));
    } catch (_) {
        return res.json(summaries.map(s => ({ ...s, raw: null })));
    }
});

router.get('/patients/:patientId/lab-reports', async (req, res) => {
    const allowed = await doctorOwnsPatient(req.session.user.id, req.params.patientId);
    if (!allowed) {
        return res.status(403).json({ error: 'Access denied: you can only view lab reports for your own patients' });
    }
    const reports = await fetchPatientLabReports(req.params.patientId);
    res.json(reports);
});

// Consultation form submit (enforces appointment ownership).
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

    // Verify ownership: appointment must exist and belong to the logged-in doctor
    const [[appt]] = await mysqlPool.query(
        'SELECT appointment_id, patient_id, doctor_id, status FROM APPOINTMENT WHERE appointment_id = ?',
        [appointment_id]
    );
    if (!appt) {
        return res.status(404).json({ error: 'Appointment not found' });
    }
    if (Number(appt.doctor_id) !== Number(req.session.user.id)) {
        return res.status(403).json({ error: 'Access denied: you can only record consultations for your own appointments' });
    }

    const [result] = await mysqlPool.query(
        'INSERT INTO CONSULTATION (appointment_id, symptoms, diagnosis, notes) VALUES (?, ?, ?, ?)',
        [appointment_id, symptoms, diagnosis, notes]
    );
    await mysqlPool.query("UPDATE APPOINTMENT SET status='Completed' WHERE appointment_id=?", [appointment_id]);

    // Sync consultation diagnosis automatically into patient's MEDICAL_RECORD
    try {
        if (appt && appt.patient_id) {
            const summary = diagnosis ? `${diagnosis}${symptoms ? ' (Symptoms: ' + symptoms + ')' : ''}` : (symptoms || 'Clinical consultation');
            await mysqlPool.query(
                'INSERT INTO MEDICAL_RECORD (patient_id, doctor_id, diagnosis_summary) VALUES (?, ?, ?)',
                [appt.patient_id, req.session.user.id, summary.slice(0, 500)]
            );

            // Inpatient Admission Recommendation (normalized: resolves recommended_ward_id from WARD)
            if (recommend_admission) {
                const targetWardName = recommended_ward || 'General Ward';
                const prio = ['Standard', 'Urgent', 'Critical'].includes(admission_priority) ? admission_priority : 'Urgent';
                const admReason = admission_reason || diagnosis || 'Doctor recommended inpatient hospitalization';

                let [[wardRow]] = await mysqlPool.query('SELECT ward_id, ward_name FROM WARD WHERE ward_name = ? LIMIT 1', [targetWardName]);
                if (!wardRow) {
                    [[wardRow]] = await mysqlPool.query('SELECT ward_id, ward_name FROM WARD ORDER BY ward_id LIMIT 1');
                }

                const [admReq] = await mysqlPool.query(
                    `INSERT INTO ADMISSION_REQUEST (patient_id, doctor_id, consultation_id, appointment_id, recommended_ward_id, priority, reason, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
                    [appt.patient_id, req.session.user.id, result.insertId, appointment_id, wardRow.ward_id, prio, admReason]
                );

                // Broadcast notification to Nurses
                try {
                    const notifService = require('../services/notificationService');
                    await notifService.broadcastToRole('Nurse', {
                        title: 'Inpatient Admission Recommended',
                        message: `Dr. ${req.session.user.name} recommended ${wardRow.ward_name} admission (${prio}) for patient #${appt.patient_id}. Bed assignment required.`,
                        type: 'admission_request',
                        metadata: { request_id: admReq.insertId, patient_id: appt.patient_id, ward: wardRow.ward_name, priority: prio }
                    });
                } catch (notifErr) {
                    console.warn('Nurse notification warning:', notifErr.message);
                }
            }
        }
    } catch (mrErr) {
        console.warn('Medical record / admission request warning:', mrErr.message);
    }

    // MongoDB audit_log
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

// Prescription form submit -- header + items in one call (3NF: patient_id/doctor_id derived via consultation_id).
router.post('/prescriptions', async (req, res) => {
    const { consultation_id, items } = req.body;
    if (!consultation_id || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'consultation_id and at least one prescription item are required' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // Ownership check: verify consultation belongs to an appointment of this doctor
        const [[consult]] = await conn.query(
            `SELECT c.consultation_id, a.doctor_id, a.patient_id
             FROM CONSULTATION c
             JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
             WHERE c.consultation_id = ?`,
            [consultation_id]
        );
        if (!consult) {
            await conn.rollback();
            return res.status(404).json({ error: 'Consultation not found' });
        }
        if (Number(consult.doctor_id) !== Number(req.session.user.id)) {
            await conn.rollback();
            return res.status(403).json({ error: 'Access denied: you can only write prescriptions for your own consultations' });
        }

        const [result] = await conn.query(
            'INSERT INTO PRESCRIPTION (consultation_id, status) VALUES (?, ?)',
            [consultation_id, 'Pending']
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

// Lab request form submit (enforces consultation ownership).
router.post('/lab-requests', async (req, res) => {
    const { consultation_id, test_id, priority } = req.body;
    const [[consult]] = await mysqlPool.query(
        `SELECT c.consultation_id, a.doctor_id
         FROM CONSULTATION c
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         WHERE c.consultation_id = ?`,
        [consultation_id]
    );
    if (!consult) {
        return res.status(404).json({ error: 'Consultation not found' });
    }
    if (Number(consult.doctor_id) !== Number(req.session.user.id)) {
        return res.status(403).json({ error: 'Access denied: you can only order lab tests for your own consultations' });
    }

    const validPriority = ['Normal', 'Urgent', 'Emergency'].includes(priority) ? priority : 'Normal';
    const [result] = await mysqlPool.query(
        "INSERT INTO LAB_REQUEST (consultation_id, test_id, requested_by, priority, status) VALUES (?, ?, ?, ?, 'Pending')",
        [consultation_id, test_id, req.session.user.id, validPriority]
    );
    res.status(201).json({ request_id: result.insertId });
});

// Search medicines for prescription autocomplete (via normalized vw_medicine_inventory)
router.get('/medicines/search', async (req, res) => {
    const q = req.query.q || '';
    const [rows] = await mysqlPool.query(
        'SELECT medicine_id, medicine_name, stock_qty FROM vw_medicine_inventory WHERE medicine_name LIKE ? AND stock_qty > 0 ORDER BY medicine_name LIMIT 20',
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

// Active emergency cases assigned to logged-in doctor (3NF: uses EMERGENCY_DOCTOR_ASSIGNMENT & EMERGENCY_BED_ASSIGNMENT)
router.get('/emergency-cases', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT ec.*,
                    eda.doctor_id AS assigned_doctor_id,
                    eba.bed_id AS assigned_bed_id,
                    COALESCE(u.name, ec.temp_patient_name, 'Unidentified') AS patient_name,
                    p.blood_group,
                    vpa.allergies,
                    b.bed_number,
                    w.ward_name,
                    TIMESTAMPDIFF(MINUTE, ec.arrival_time, NOW()) AS wait_minutes
             FROM EMERGENCY_CASE ec
             JOIN EMERGENCY_DOCTOR_ASSIGNMENT eda ON ec.case_id = eda.case_id AND eda.is_active = TRUE
             LEFT JOIN EMERGENCY_BED_ASSIGNMENT eba ON ec.case_id = eba.case_id AND eba.is_active = TRUE
             LEFT JOIN BED b ON eba.bed_id = b.bed_id
             LEFT JOIN WARD w ON b.ward_id = w.ward_id
             LEFT JOIN PATIENT p ON ec.patient_id = p.patient_id
             LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
             LEFT JOIN vw_patient_allergies vpa ON p.patient_id = vpa.patient_id
             WHERE eda.doctor_id = ?
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
