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
            user_id: req.session.user.id,
            action: status === 'Confirmed' ? 'CONFIRM appointment' : 'UPDATE appointment status',
            table_affected: 'APPOINTMENT',
            details: {
                appointment_id: Number(req.params.id),
                doctor_id: req.session.user.id,
                status: status
            },
            timestamp: new Date()
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

// Patient history -- demographics/allergies, medical records, consultations, prescriptions, and lab reports for an owned patient
router.get('/patients/:patientId/history', async (req, res) => {
    const allowed = await doctorOwnsPatient(req.session.user.id, req.params.patientId);
    if (!allowed) {
        return res.status(403).json({ error: 'Access denied: you can only view history for your own patients' });
    }

    const [[patient]] = await mysqlPool.query(
        `SELECT p.patient_id, u.name, u.email, u.phone, p.dob,
                TIMESTAMPDIFF(YEAR, p.dob, CURDATE()) AS age,
                p.gender, p.blood_group, p.address, p.emergency_contact,
                COALESCE(vpa.allergies, 'None documented') AS allergies
         FROM PATIENT p
         JOIN \`USER\` u ON p.patient_id = u.user_id
         LEFT JOIN vw_patient_allergies vpa ON p.patient_id = vpa.patient_id
         WHERE p.patient_id = ?`,
        [req.params.patientId]
    );

    const [records] = await mysqlPool.query(
        `SELECT mr.*, ud.name AS doctor_name
         FROM MEDICAL_RECORD mr
         LEFT JOIN \`USER\` ud ON mr.doctor_id = ud.user_id
         WHERE mr.patient_id = ?
         ORDER BY mr.created_at DESC`,
        [req.params.patientId]
    );
    const [consultations] = await mysqlPool.query(
        `SELECT c.*, a.appointment_date, a.appointment_time, ud.name AS doctor_name
         FROM CONSULTATION c
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         LEFT JOIN \`USER\` ud ON a.doctor_id = ud.user_id
         WHERE a.patient_id = ?
         ORDER BY c.consultation_date DESC`,
        [req.params.patientId]
    );
    const [prescriptions] = await mysqlPool.query(
        `SELECT pr.prescription_id, pr.consultation_id, pr.prescribed_date, pr.status,
                m.medicine_name, pi.dosage, pi.instructions, pi.duration_days, pi.quantity
         FROM PRESCRIPTION pr
         JOIN CONSULTATION c ON pr.consultation_id = c.consultation_id
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         JOIN PRESCRIPTION_ITEM pi ON pr.prescription_id = pi.prescription_id
         JOIN MEDICINE m ON pi.medicine_id = m.medicine_id
         WHERE a.patient_id = ?
         ORDER BY pr.prescribed_date DESC, pi.item_id ASC`,
        [req.params.patientId]
    );
    const lab_reports = await fetchPatientLabReports(req.params.patientId);
    res.json({ patient: patient || null, records, consultations, prescriptions, lab_reports });
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

// Helper: validate prescription items before inserting
function validatePrescriptionItems(items) {
    if (!Array.isArray(items) || !items.length) {
        return 'At least one prescription item is required';
    }
    for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const medId = Number(it.medicine_id);
        const dur = Number(it.duration_days);
        const qty = Number(it.quantity);
        if (!Number.isInteger(medId) || medId <= 0) {
            return `Prescription item #${i + 1}: valid medicine selection is required`;
        }
        if (!it.dosage || !String(it.dosage).trim()) {
            return `Prescription item #${i + 1}: dosage is required`;
        }
        if (!Number.isInteger(dur) || dur <= 0) {
            return `Prescription item #${i + 1}: duration_days must be a positive integer`;
        }
        if (!Number.isInteger(qty) || qty <= 0) {
            return `Prescription item #${i + 1}: quantity must be a positive integer`;
        }
    }
    return null;
}

// Consultation form submit (enforces appointment ownership, transactional, retry-safe, and supports atomic prescription_items & lab_requests).
router.post('/consultations', async (req, res) => {
    const {
        appointment_id,
        symptoms,
        diagnosis,
        notes,
        recommend_admission,
        recommended_ward,
        admission_priority,
        admission_reason,
        prescription_items,
        lab_requests
    } = req.body;

    if (!appointment_id) {
        return res.status(400).json({ error: 'appointment_id is required' });
    }
    if (!symptoms || !String(symptoms).trim() || !diagnosis || !String(diagnosis).trim()) {
        return res.status(400).json({ error: 'Symptoms and diagnosis are required' });
    }

    if (Array.isArray(prescription_items) && prescription_items.length > 0) {
        const rxErr = validatePrescriptionItems(prescription_items);
        if (rxErr) {
            return res.status(400).json({ error: rxErr });
        }
    }

    const conn = await mysqlPool.getConnection();
    let consultationId = null;
    let prescriptionId = null;
    const createdLabRequestIds = [];
    let nurseAlertPayload = null;

    try {
        await conn.beginTransaction();

        // Lock appointment row to prevent duplicate concurrent consultation submissions
        const [[appt]] = await conn.query(
            'SELECT appointment_id, patient_id, doctor_id, status FROM APPOINTMENT WHERE appointment_id = ? FOR UPDATE',
            [appointment_id]
        );
        if (!appt) {
            await conn.rollback();
            return res.status(404).json({ error: 'Appointment not found' });
        }
        if (Number(appt.doctor_id) !== Number(req.session.user.id)) {
            await conn.rollback();
            return res.status(403).json({ error: 'Access denied: you can only record consultations for your own appointments' });
        }

        // Idempotent retry handling: check if consultation already exists for this appointment
        const [[existingConsult]] = await conn.query(
            'SELECT consultation_id FROM CONSULTATION WHERE appointment_id = ? FOR UPDATE',
            [appointment_id]
        );

        if (existingConsult) {
            consultationId = existingConsult.consultation_id;
            await conn.query(
                'UPDATE CONSULTATION SET symptoms = ?, diagnosis = ?, notes = ? WHERE consultation_id = ?',
                [String(symptoms).trim(), String(diagnosis).trim(), notes ? String(notes).trim() : null, consultationId]
            );
            await conn.query("UPDATE APPOINTMENT SET status = 'Completed' WHERE appointment_id = ?", [appointment_id]);
        } else {
            const [result] = await conn.query(
                'INSERT INTO CONSULTATION (appointment_id, symptoms, diagnosis, notes) VALUES (?, ?, ?, ?)',
                [appointment_id, String(symptoms).trim(), String(diagnosis).trim(), notes ? String(notes).trim() : null]
            );
            consultationId = result.insertId;
            await conn.query("UPDATE APPOINTMENT SET status = 'Completed' WHERE appointment_id = ?", [appointment_id]);

            // Sync consultation diagnosis automatically into patient's MEDICAL_RECORD
            if (appt.patient_id) {
                const summary = `${String(diagnosis).trim()} (Symptoms: ${String(symptoms).trim()})`;
                await conn.query(
                    'INSERT INTO MEDICAL_RECORD (patient_id, doctor_id, diagnosis_summary) VALUES (?, ?, ?)',
                    [appt.patient_id, req.session.user.id, summary.slice(0, 500)]
                );
            }
        }

        // Inpatient Admission Recommendation (normalized: resolves recommended_ward_id from WARD)
        if (recommend_admission && appt.patient_id) {
            const [[existingAdmReq]] = await conn.query(
                "SELECT request_id FROM ADMISSION_REQUEST WHERE consultation_id = ? AND status = 'Pending' LIMIT 1",
                [consultationId]
            );
            if (!existingAdmReq) {
                const targetWardName = recommended_ward || 'General Ward';
                const prio = ['Standard', 'Urgent', 'Critical'].includes(admission_priority) ? admission_priority : 'Urgent';
                const admReason = admission_reason || String(diagnosis).trim() || 'Doctor recommended inpatient hospitalization';

                let [[wardRow]] = await conn.query('SELECT ward_id, ward_name FROM WARD WHERE ward_name = ? LIMIT 1', [targetWardName]);
                if (!wardRow) {
                    [[wardRow]] = await conn.query('SELECT ward_id, ward_name FROM WARD ORDER BY ward_id LIMIT 1');
                }

                const [admReq] = await conn.query(
                    `INSERT INTO ADMISSION_REQUEST (patient_id, doctor_id, consultation_id, appointment_id, recommended_ward_id, priority, reason, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
                    [appt.patient_id, req.session.user.id, consultationId, appointment_id, wardRow.ward_id, prio, admReason]
                );
                nurseAlertPayload = {
                    title: 'Inpatient Admission Recommended',
                    message: `Dr. ${req.session.user.name} recommended ${wardRow.ward_name} admission (${prio}) for patient #${appt.patient_id}. Bed assignment required.`,
                    type: 'admission_request',
                    metadata: { request_id: admReq.insertId, patient_id: appt.patient_id, ward: wardRow.ward_name, priority: prio }
                };
            }
        }

        // Optional atomic prescription creation in the same transaction
        if (Array.isArray(prescription_items) && prescription_items.length > 0) {
            for (const item of prescription_items) {
                const [[med]] = await conn.query('SELECT medicine_id FROM MEDICINE WHERE medicine_id = ?', [item.medicine_id]);
                if (!med) {
                    await conn.rollback();
                    return res.status(400).json({ error: `Invalid medicine_id: ${item.medicine_id}` });
                }
            }
            const [rxRes] = await conn.query(
                'INSERT INTO PRESCRIPTION (consultation_id, status) VALUES (?, ?)',
                [consultationId, 'Pending']
            );
            prescriptionId = rxRes.insertId;
            for (const item of prescription_items) {
                await conn.query(
                    'INSERT INTO PRESCRIPTION_ITEM (prescription_id, medicine_id, dosage, instructions, duration_days, quantity) VALUES (?, ?, ?, ?, ?, ?)',
                    [
                        prescriptionId,
                        Number(item.medicine_id),
                        String(item.dosage).trim(),
                        item.instructions || item.timing || null,
                        Number(item.duration_days),
                        Number(item.quantity)
                    ]
                );
            }
        }

        // Optional atomic lab requests in the same transaction
        if (Array.isArray(lab_requests) && lab_requests.length > 0) {
            for (const lr of lab_requests) {
                if (!lr || !lr.test_id) continue;
                const [[testRow]] = await conn.query('SELECT test_id FROM LAB_TEST WHERE test_id = ?', [lr.test_id]);
                if (!testRow) {
                    await conn.rollback();
                    return res.status(400).json({ error: `Invalid lab test_id: ${lr.test_id}` });
                }
                const validPriority = ['Normal', 'Urgent', 'Emergency'].includes(lr.priority) ? lr.priority : 'Normal';
                const [lrRes] = await conn.query(
                    "INSERT INTO LAB_REQUEST (consultation_id, test_id, requested_by, priority, status) VALUES (?, ?, ?, ?, 'Pending')",
                    [consultationId, Number(lr.test_id), req.session.user.id, validPriority]
                );
                createdLabRequestIds.push(lrRes.insertId);
            }
        }

        await conn.commit();
    } catch (txErr) {
        await conn.rollback();
        console.error('Error saving consultation transaction:', txErr);
        return res.status(500).json({ error: txErr.sqlMessage || 'Failed to save consultation' });
    } finally {
        conn.release();
    }

    if (nurseAlertPayload) {
        try {
            const notifService = require('../services/notificationService');
            await notifService.broadcastToRole('Nurse', nurseAlertPayload);
        } catch (notifErr) {
            console.warn('Nurse notification warning:', notifErr.message);
        }
    }

    // MongoDB audit_log
    try {
        const mongo = getMongo();
        await mongo.collection('audit_log').insertOne({
            user_id: req.session.user.id,
            action: 'COMPLETE consultation',
            table_affected: 'CONSULTATION',
            details: {
                consultation_id: consultationId,
                appointment_id: Number(appointment_id),
                prescription_id: prescriptionId,
                lab_request_ids: createdLabRequestIds,
                doctor_id: req.session.user.id,
                doctor_name: req.session.user.name,
                diagnosis_summary: diagnosis ? String(diagnosis).slice(0, 200) : '',
                recommended_admission: !!recommend_admission,
                recommended_ward: recommend_admission ? (recommended_ward || 'General Ward') : null
            },
            timestamp: new Date()
        });
    } catch (mongoErr) {
        console.warn('MongoDB audit_log write failed (non-fatal):', mongoErr.message);
    }

    res.status(201).json({
        consultation_id: consultationId,
        prescription_id: prescriptionId,
        lab_request_ids: createdLabRequestIds
    });
});

// Prescription form submit -- header + items in one call (3NF: patient_id/doctor_id derived via consultation_id).
router.post('/prescriptions', async (req, res) => {
    const { consultation_id, items } = req.body;
    if (!consultation_id) {
        return res.status(400).json({ error: 'consultation_id is required' });
    }
    const rxErr = validatePrescriptionItems(items);
    if (rxErr) {
        return res.status(400).json({ error: rxErr });
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

        for (const item of items) {
            const [[med]] = await conn.query('SELECT medicine_id FROM MEDICINE WHERE medicine_id = ?', [item.medicine_id]);
            if (!med) {
                await conn.rollback();
                return res.status(400).json({ error: `Invalid medicine_id: ${item.medicine_id}` });
            }
        }

        const [result] = await conn.query(
            'INSERT INTO PRESCRIPTION (consultation_id, status) VALUES (?, ?)',
            [consultation_id, 'Pending']
        );
        const prescriptionId = result.insertId;
        for (const item of items) {
            await conn.query(
                'INSERT INTO PRESCRIPTION_ITEM (prescription_id, medicine_id, dosage, instructions, duration_days, quantity) VALUES (?, ?, ?, ?, ?, ?)',
                [
                    prescriptionId,
                    Number(item.medicine_id),
                    String(item.dosage).trim(),
                    item.instructions || item.timing || null,
                    Number(item.duration_days),
                    Number(item.quantity)
                ]
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
