const express = require('express');
const bcrypt = require('bcryptjs');
const { mysqlPool, getMongo } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { sendNotification, broadcastToRole } = require('../services/notificationService');

const router = express.Router();

// ---- Nurse: ward / beds / patients (normalized via vw_bed_details & WARD) ----
router.get('/nurse/beds', requireRole('Admin', 'Nurse'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT v.bed_id, v.ward_id, v.ward_name, v.bed_number, v.status, v.patient_id,
                u.name AS patient_name
         FROM vw_bed_details v
         LEFT JOIN \`USER\` u ON v.patient_id = u.user_id
         ORDER BY v.ward_name, v.bed_number`
    );
    res.json(rows);
});

router.get('/nurse/ward/:wardName/patients', requireRole('Admin', 'Nurse'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT v.bed_number, u.name, p.patient_id
         FROM vw_bed_details v
         JOIN PATIENT p ON v.patient_id = p.patient_id
         JOIN \`USER\` u ON p.patient_id = u.user_id
         WHERE v.ward_name = ? AND v.status = 'Occupied'`,
        [req.params.wardName]
    );
    res.json(rows);
});

// Comprehensive assigned patients list for Nurse Portal
router.get('/nurse/assigned-patients', requireRole('Admin', 'Nurse'), async (req, res) => {
    try {
        const query = `
            SELECT 
                v.bed_id,
                v.ward_name,
                v.bed_number,
                v.status AS bed_status,
                v.patient_id,
                v.admission_id,
                u.name AS patient_name,
                u.phone AS patient_phone,
                p.blood_group,
                vpa.allergies,
                TIMESTAMPDIFF(YEAR, p.dob, CURDATE()) AS age,
                p.gender,
                ec.case_id,
                ec.emg_number,
                ec.triage_priority,
                ec.initial_complaint,
                COALESCE(udoc.name, uemgdoc.name, 'Staff Doctor') AS attending_doctor_name,
                (SELECT pv.bp_systolic FROM PATIENT_VITALS pv WHERE pv.patient_id = p.patient_id ORDER BY pv.recorded_at DESC LIMIT 1) AS last_bp_systolic,
                (SELECT pv.bp_diastolic FROM PATIENT_VITALS pv WHERE pv.patient_id = p.patient_id ORDER BY pv.recorded_at DESC LIMIT 1) AS last_bp_diastolic,
                (SELECT pv.heart_rate FROM PATIENT_VITALS pv WHERE pv.patient_id = p.patient_id ORDER BY pv.recorded_at DESC LIMIT 1) AS last_heart_rate,
                (SELECT pv.spo2 FROM PATIENT_VITALS pv WHERE pv.patient_id = p.patient_id ORDER BY pv.recorded_at DESC LIMIT 1) AS last_spo2,
                (SELECT pv.temperature FROM PATIENT_VITALS pv WHERE pv.patient_id = p.patient_id ORDER BY pv.recorded_at DESC LIMIT 1) AS last_temperature,
                (SELECT pv.recorded_at FROM PATIENT_VITALS pv WHERE pv.patient_id = p.patient_id ORDER BY pv.recorded_at DESC LIMIT 1) AS last_vitals_time,
                (SELECT nn.content FROM NURSE_NOTE nn WHERE nn.patient_id = p.patient_id ORDER BY nn.created_at DESC LIMIT 1) AS latest_note,
                (SELECT nn.note_type FROM NURSE_NOTE nn WHERE nn.patient_id = p.patient_id ORDER BY nn.created_at DESC LIMIT 1) AS latest_note_type
            FROM vw_bed_details v
            JOIN PATIENT p ON v.patient_id = p.patient_id
            JOIN \`USER\` u ON p.patient_id = u.user_id
            LEFT JOIN vw_patient_allergies vpa ON p.patient_id = vpa.patient_id
            LEFT JOIN DOCTOR doc ON v.admitting_doctor_id = doc.doctor_id
            LEFT JOIN \`USER\` udoc ON doc.doctor_id = udoc.user_id
            LEFT JOIN EMERGENCY_CASE ec ON v.case_id = ec.case_id AND ec.status NOT IN ('Discharged', 'Transferred')
            LEFT JOIN EMERGENCY_DOCTOR_ASSIGNMENT eda ON ec.case_id = eda.case_id AND eda.is_active = TRUE
            LEFT JOIN DOCTOR emgdoc ON eda.doctor_id = emgdoc.doctor_id
            LEFT JOIN \`USER\` uemgdoc ON emgdoc.doctor_id = uemgdoc.user_id
            WHERE v.status = 'Occupied'
            ORDER BY v.ward_name, v.bed_number
        `;
        const [rows] = await mysqlPool.query(query);
        res.json(rows);
    } catch (err) {
        console.error('Nurse assigned patients error:', err);
        res.status(500).json({ error: 'Failed to load assigned patients' });
    }
});

// Nurse: View pending admission requests from doctors (3NF: recommended_ward derived via WARD)
router.get('/nurse/admission-requests', requireRole('Admin', 'Nurse'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT ar.request_id, ar.patient_id, ar.consultation_id, ar.appointment_id,
                    up.name AS patient_name, up.phone AS patient_phone,
                    p.blood_group, p.gender, TIMESTAMPDIFF(YEAR, p.dob, CURDATE()) AS age,
                    ar.doctor_id, ud.name AS doctor_name, doc.specialization,
                    w.ward_name AS recommended_ward, ar.priority, ar.reason, ar.created_at, ar.status
             FROM ADMISSION_REQUEST ar
             JOIN WARD w ON ar.recommended_ward_id = w.ward_id
             JOIN PATIENT p ON ar.patient_id = p.patient_id
             JOIN \`USER\` up ON p.patient_id = up.user_id
             JOIN DOCTOR doc ON ar.doctor_id = doc.doctor_id
             JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
             WHERE ar.status = 'Pending'
             ORDER BY CASE WHEN ar.priority = 'Critical' THEN 1 WHEN ar.priority = 'Urgent' THEN 2 ELSE 3 END, ar.created_at ASC`
        );
        res.json(rows);
    } catch (err) {
        console.error('Failed to load admission requests:', err);
        res.status(500).json({ error: 'Failed to load admission requests' });
    }
});

// Nurse: Available beds for admission assignment
router.get('/nurse/available-beds', requireRole('Admin', 'Nurse'), async (req, res) => {
    try {
        const ward = req.query.ward;
        let sql = `SELECT b.bed_id, w.ward_name, b.bed_number, b.status
                   FROM BED b
                   JOIN WARD w ON b.ward_id = w.ward_id
                   WHERE b.status = 'Available'`;
        const params = [];
        if (ward) {
            sql += " AND w.ward_name = ?";
            params.push(ward);
        }
        sql += " ORDER BY w.ward_name, b.bed_number";
        const [rows] = await mysqlPool.query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch available beds' });
    }
});

// Nurse: Assign bed to admission request and activate inpatient admission
router.post('/nurse/assign-admission-bed', requireRole('Admin', 'Nurse'), async (req, res) => {
    const { request_id, bed_id } = req.body;
    if (!request_id || !bed_id) {
        return res.status(400).json({ error: 'request_id and bed_id are required' });
    }
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // 1. Fetch and lock admission request
        const [requests] = await conn.query('SELECT * FROM ADMISSION_REQUEST WHERE request_id = ? FOR UPDATE', [request_id]);
        if (!requests.length || requests[0].status !== 'Pending') {
            await conn.rollback();
            return res.status(400).json({ error: 'Admission request not found or already processed' });
        }
        const admReq = requests[0];

        // 2. Fetch and lock bed (must be Available)
        const [beds] = await conn.query(
            `SELECT b.*, w.ward_name
             FROM BED b JOIN WARD w ON b.ward_id = w.ward_id
             WHERE b.bed_id = ? FOR UPDATE`,
            [bed_id]
        );
        if (!beds.length || beds[0].status !== 'Available') {
            await conn.rollback();
            return res.status(409).json({ error: 'Selected bed is no longer available' });
        }
        const bed = beds[0];

        // 3. Update BED to Occupied
        await conn.query("UPDATE BED SET status = 'Occupied' WHERE bed_id = ?", [bed_id]);

        // 4. Update ADMISSION_REQUEST to Assigned
        await conn.query(
            "UPDATE ADMISSION_REQUEST SET status = 'Assigned', assigned_bed_id = ?, assigned_by = ?, assigned_at = NOW() WHERE request_id = ?",
            [bed_id, req.session.user.id, request_id]
        );

        // 5. Create ADMISSION record (3NF: ward derived via bed_id -> BED.ward_id)
        const [admIns] = await conn.query(
            `INSERT INTO ADMISSION (patient_id, request_id, admitting_doctor_id, bed_id, admitted_at, status)
             VALUES (?, ?, ?, ?, NOW(), 'Admitted')`,
            [admReq.patient_id, admReq.request_id, admReq.doctor_id, bed_id]
        );

        await conn.commit();

        // 6. Broadcast notification to Doctor
        try {
            await broadcastToRole('Doctor', {
                title: 'Inpatient Bed Assigned',
                message: `Patient #${admReq.patient_id} assigned to ${bed.ward_name} (${bed.bed_number}) by Nurse ${req.session.user.name}.`,
                type: 'bed_assigned',
                metadata: { admission_id: admIns.insertId, patient_id: admReq.patient_id, bed_id, bed_number: bed.bed_number }
            });
        } catch (notifErr) {
            console.warn('Doctor notification warning:', notifErr.message);
        }

        res.json({
            message: 'Bed assigned and patient admitted successfully',
            admission_id: admIns.insertId,
            bed_number: bed.bed_number,
            ward_name: bed.ward_name
        });
    } catch (err) {
        await conn.rollback();
        console.error('Error assigning bed for admission request:', err);
        res.status(500).json({ error: 'Failed to assign bed' });
    } finally {
        conn.release();
    }
});

// Nurse / Admin: Normal Inpatient Discharge -> closes ADMISSION, finalizes BILL, releases BED to Cleaning
router.post('/nurse/discharge-inpatient', requireRole('Admin', 'Nurse', 'Doctor'), async (req, res) => {
    const { admission_id, bed_id, patient_id, discharge_summary, room_fee } = req.body;
    if (!admission_id && !bed_id && !patient_id) {
        return res.status(400).json({ error: 'admission_id, bed_id, or patient_id is required' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        let admQuery = `SELECT adm.*, b.bed_number, w.ward_name, w.daily_rate
                        FROM ADMISSION adm
                        JOIN BED b ON adm.bed_id = b.bed_id
                        JOIN WARD w ON b.ward_id = w.ward_id
                        WHERE adm.status = 'Admitted'`;
        const params = [];
        if (admission_id) {
            admQuery += ' AND adm.admission_id = ?';
            params.push(admission_id);
        } else if (bed_id) {
            admQuery += ' AND adm.bed_id = ?';
            params.push(bed_id);
        } else {
            admQuery += ' AND adm.patient_id = ?';
            params.push(patient_id);
        }
        admQuery += ' ORDER BY adm.admitted_at DESC LIMIT 1 FOR UPDATE';

        const [admRows] = await conn.query(admQuery, params);
        if (!admRows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Active inpatient admission not found' });
        }
        const adm = admRows[0];

        // Lock bed row
        await conn.query('SELECT * FROM BED WHERE bed_id = ? FOR UPDATE', [adm.bed_id]);

        const summaryText = (discharge_summary && discharge_summary.trim()) || 'Patient discharged from inpatient ward in stable condition.';

        // 1. Close ADMISSION
        await conn.query(
            `UPDATE ADMISSION
             SET status = 'Discharged',
                 discharged_at = NOW(),
                 discharge_summary = ?
             WHERE admission_id = ?`,
            [summaryText, adm.admission_id]
        );

        // 2. Release BED to Cleaning
        await conn.query("UPDATE BED SET status = 'Cleaning' WHERE bed_id = ?", [adm.bed_id]);

        // 3. Finalize / update BILL with inpatient admission charge
        const days = Math.max(1, Math.ceil((Date.now() - new Date(adm.admitted_at).getTime()) / (1000 * 60 * 60 * 24)));
        const chargeAmount = room_fee !== undefined && Number(room_fee) >= 0
            ? Number(room_fee)
            : Number((days * Number(adm.daily_rate || 1000)).toFixed(2));

        const [existingBills] = await conn.query(
            `SELECT b.bill_id
             FROM BILL b
             JOIN vw_bill_summary vbs ON b.bill_id = vbs.bill_id
             WHERE b.patient_id = ? AND vbs.payment_status <> 'Paid'
             ORDER BY b.bill_date DESC LIMIT 1`,
            [adm.patient_id]
        );

        let billId;
        if (existingBills.length) {
            billId = existingBills[0].bill_id;
            await conn.query('UPDATE BILL SET admission_id = COALESCE(admission_id, ?) WHERE bill_id = ?', [adm.admission_id, billId]);
        } else {
            const [billRes] = await conn.query(
                'INSERT INTO BILL (patient_id, admission_id, bill_date, generated_by) VALUES (?, ?, NOW(), ?)',
                [adm.patient_id, adm.admission_id, req.session.user.id]
            );
            billId = billRes.insertId;
        }

        await conn.query(
            'INSERT INTO BILL_ITEM (bill_id, item_type, description, amount) VALUES (?, ?, ?, ?)',
            [billId, 'Admission', `Inpatient stay - ${adm.ward_name} (${adm.bed_number}, ${days} day(s))`, chargeAmount]
        );

        // Record care note
        await conn.query(
            `INSERT INTO NURSE_NOTE (patient_id, bed_id, nurse_id, note_type, content)
             VALUES (?, ?, ?, 'Discharge', ?)`,
            [adm.patient_id, adm.bed_id, req.session.user.id, `Discharged from ${adm.ward_name} ${adm.bed_number}. Summary: ${summaryText}`]
        );

        await conn.commit();

        await sendNotification({
            role_name: 'Receptionist',
            message: `Inpatient #${adm.patient_id} discharged from ${adm.ward_name} (${adm.bed_number}). Bill #${billId} finalized for settlement.`,
            event_type: 'inpatient_discharged'
        });

        res.json({
            message: 'Patient discharged, bill finalized, and bed released to Cleaning',
            admission_id: adm.admission_id,
            bill_id: billId,
            bed_id: adm.bed_id,
            bed_status: 'Cleaning'
        });
    } catch (err) {
        await conn.rollback();
        console.error('Inpatient discharge error:', err);
        res.status(500).json({ error: 'Failed to discharge inpatient: ' + err.message });
    } finally {
        conn.release();
    }
});

// Nurse / Admin: Complete bed cleaning and mark bed Available
router.post('/nurse/beds/:id/mark-available', requireRole('Admin', 'Nurse'), async (req, res) => {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [beds] = await conn.query('SELECT * FROM BED WHERE bed_id = ? FOR UPDATE', [req.params.id]);
        if (!beds.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Bed not found' });
        }
        const bed = beds[0];
        if (bed.status === 'Occupied') {
            await conn.rollback();
            return res.status(409).json({ error: 'Cannot mark an occupied bed Available before discharging the patient' });
        }

        await conn.query("UPDATE BED SET status = 'Available' WHERE bed_id = ?", [req.params.id]);
        await conn.commit();

        res.json({ message: 'Bed cleaning completed and marked Available', bed_id: Number(req.params.id), status: 'Available' });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Failed to mark bed available' });
    } finally {
        conn.release();
    }
});

// Record patient vitals
router.post('/nurse/vitals', requireRole('Admin', 'Nurse'), async (req, res) => {
    const { patient_id, case_id, bp_systolic, bp_diastolic, heart_rate, spo2, temperature, respiratory_rate, notes } = req.body;

    if (!patient_id && !case_id) {
        return res.status(400).json({ error: 'Patient ID or Emergency Case ID is required' });
    }

    try {
        await mysqlPool.query(
            `INSERT INTO PATIENT_VITALS (
                patient_id, case_id, recorded_by, bp_systolic, bp_diastolic,
                heart_rate, spo2, temperature, respiratory_rate, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                patient_id ? Number(patient_id) : null,
                case_id ? Number(case_id) : null,
                req.session.user.id,
                bp_systolic ? Number(bp_systolic) : null,
                bp_diastolic ? Number(bp_diastolic) : null,
                heart_rate ? Number(heart_rate) : null,
                spo2 ? Number(spo2) : null,
                temperature ? Number(temperature) : null,
                respiratory_rate ? Number(respiratory_rate) : null,
                notes || null
            ]
        );

        res.status(201).json({ message: 'Vitals recorded successfully' });
    } catch (err) {
        console.error('Record vitals error:', err);
        res.status(500).json({ error: 'Failed to record vitals' });
    }
});

// Vitals history for a patient
router.get('/nurse/vitals/:patientId', requireRole('Admin', 'Nurse', 'Doctor'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT pv.*, u.name AS recorded_by_name
             FROM PATIENT_VITALS pv
             JOIN \`USER\` u ON pv.recorded_by = u.user_id
             WHERE pv.patient_id = ?
             ORDER BY pv.recorded_at DESC LIMIT 30`,
            [req.params.patientId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load vitals history' });
    }
});

// Record nursing care notes
router.post('/nurse/notes', requireRole('Admin', 'Nurse'), async (req, res) => {
    const { patient_id, case_id, bed_id, note_type = 'General', content } = req.body;

    if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Note content is required' });
    }

    try {
        await mysqlPool.query(
            `INSERT INTO NURSE_NOTE (patient_id, case_id, bed_id, nurse_id, note_type, content)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                patient_id ? Number(patient_id) : null,
                case_id ? Number(case_id) : null,
                bed_id ? Number(bed_id) : null,
                req.session.user.id,
                note_type,
                content.trim()
            ]
        );

        res.status(201).json({ message: 'Nursing note saved' });
    } catch (err) {
        console.error('Nurse note error:', err);
        res.status(500).json({ error: 'Failed to save nursing note' });
    }
});

// Care notes history for a patient
router.get('/nurse/notes/:patientId', requireRole('Admin', 'Nurse', 'Doctor'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT nn.*, u.name AS nurse_name
             FROM NURSE_NOTE nn
             JOIN \`USER\` u ON nn.nurse_id = u.user_id
             WHERE nn.patient_id = ?
             ORDER BY nn.created_at DESC LIMIT 30`,
            [req.params.patientId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load notes' });
    }
});

// Bed transfer request by nurse (3NF: updates ADMISSION.bed_id and EMERGENCY_BED_ASSIGNMENT)
router.post('/nurse/transfer-bed', requireRole('Admin', 'Nurse'), async (req, res) => {
    const { patient_id, current_bed_id, new_bed_id, reason } = req.body;

    if (!patient_id || !current_bed_id || !new_bed_id) {
        return res.status(400).json({ error: 'Patient, current bed, and new bed are required' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // Check and lock new bed
        const [[newBed]] = await conn.query(
            `SELECT b.*, w.ward_name
             FROM BED b JOIN WARD w ON b.ward_id = w.ward_id
             WHERE b.bed_id = ? FOR UPDATE`,
            [new_bed_id]
        );
        if (!newBed || newBed.status !== 'Available') {
            await conn.rollback();
            return res.status(409).json({ error: 'Target bed is not available' });
        }

        // Release old bed to Cleaning
        await conn.query("UPDATE BED SET status='Cleaning' WHERE bed_id=?", [current_bed_id]);

        // Occupy new bed
        await conn.query("UPDATE BED SET status='Occupied' WHERE bed_id=?", [new_bed_id]);

        // Update active ADMISSION if present
        await conn.query(
            "UPDATE ADMISSION SET bed_id=? WHERE patient_id=? AND status='Admitted'",
            [new_bed_id, patient_id]
        );

        // Update active EMERGENCY_BED_ASSIGNMENT if present
        const [activeEba] = await conn.query(
            'SELECT * FROM EMERGENCY_BED_ASSIGNMENT WHERE bed_id = ? AND is_active = TRUE FOR UPDATE',
            [current_bed_id]
        );
        if (activeEba.length) {
            await conn.query(
                'UPDATE EMERGENCY_BED_ASSIGNMENT SET is_active = FALSE, released_at = NOW() WHERE assignment_id = ?',
                [activeEba[0].assignment_id]
            );
            await conn.query(
                'INSERT INTO EMERGENCY_BED_ASSIGNMENT (case_id, bed_id, assigned_by, is_active) VALUES (?, ?, ?, TRUE)',
                [activeEba[0].case_id, new_bed_id, req.session.user.id]
            );
        }

        // Record care note
        await conn.query(
            `INSERT INTO NURSE_NOTE (patient_id, bed_id, nurse_id, note_type, content)
             VALUES (?, ?, ?, 'Transfer', ?)`,
            [patient_id, new_bed_id, req.session.user.id, `Patient transferred to ${newBed.ward_name} ${newBed.bed_number}. Reason: ${reason || 'Clinical transfer'}`]
        );

        await conn.commit();

        res.json({ message: `Patient successfully transferred to ${newBed.ward_name} ${newBed.bed_number}` });
    } catch (err) {
        await conn.rollback();
        console.error('Bed transfer error:', err);
        res.status(500).json({ error: 'Failed to transfer bed' });
    } finally {
        conn.release();
    }
});

// Live emergency monitoring feed for nurses (3NF: uses EMERGENCY_DOCTOR_ASSIGNMENT & EMERGENCY_BED_ASSIGNMENT)
router.get('/nurse/emergency-monitor', requireRole('Admin', 'Nurse'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT 
                ec.case_id,
                ec.emg_number,
                COALESCE(u.name, ec.temp_patient_name, 'Unidentified') AS patient_name,
                ec.triage_priority,
                ec.status,
                ec.arrival_time,
                TIMESTAMPDIFF(MINUTE, ec.arrival_time, NOW()) AS wait_minutes,
                ec.initial_complaint,
                udoc.name AS doctor_name,
                b.bed_number,
                w.ward_name,
                (SELECT pv.spo2 FROM PATIENT_VITALS pv WHERE pv.case_id = ec.case_id ORDER BY pv.recorded_at DESC LIMIT 1) AS latest_spo2,
                (SELECT pv.heart_rate FROM PATIENT_VITALS pv WHERE pv.case_id = ec.case_id ORDER BY pv.recorded_at DESC LIMIT 1) AS latest_heart_rate,
                (SELECT CONCAT(pv.bp_systolic, '/', pv.bp_diastolic) FROM PATIENT_VITALS pv WHERE pv.case_id = ec.case_id ORDER BY pv.recorded_at DESC LIMIT 1) AS latest_bp
             FROM EMERGENCY_CASE ec
             LEFT JOIN PATIENT p ON ec.patient_id = p.patient_id
             LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
             LEFT JOIN EMERGENCY_DOCTOR_ASSIGNMENT eda ON ec.case_id = eda.case_id AND eda.is_active = TRUE
             LEFT JOIN DOCTOR doc ON eda.doctor_id = doc.doctor_id
             LEFT JOIN \`USER\` udoc ON doc.doctor_id = udoc.user_id
             LEFT JOIN EMERGENCY_BED_ASSIGNMENT eba ON ec.case_id = eba.case_id AND eba.is_active = TRUE
             LEFT JOIN BED b ON eba.bed_id = b.bed_id
             LEFT JOIN WARD w ON b.ward_id = w.ward_id
             WHERE ec.status NOT IN ('Discharged', 'Transferred')
             ORDER BY 
                CASE WHEN ec.triage_priority = 'P1' THEN 1 
                     WHEN ec.triage_priority = 'P2' THEN 2 
                     WHEN ec.triage_priority = 'P3' THEN 3 
                     ELSE 4 END,
                ec.arrival_time ASC`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load emergency monitoring feed' });
    }
});

// Nurse notifications
router.get('/nurse/notifications', requireRole('Admin', 'Nurse'), async (req, res) => {
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

// ---- Lab Technician: pending requests -> enter result -> generate report (MySQL + MongoDB lab_reports_raw) ----
router.get('/lab-tech/pending-requests', requireRole('Admin', 'Lab Technician'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT lr.request_id, lr.priority, lt.test_name, lt.test_category,
                a.patient_id, up.name AS patient_name, ud.name AS requested_by
         FROM LAB_REQUEST lr JOIN LAB_TEST lt ON lr.test_id = lt.test_id
         JOIN CONSULTATION c ON lr.consultation_id = c.consultation_id
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         JOIN PATIENT p ON a.patient_id = p.patient_id JOIN \`USER\` up ON p.patient_id = up.user_id
         JOIN DOCTOR doc ON lr.requested_by = doc.doctor_id JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
         WHERE lr.status = 'Pending'
         ORDER BY CASE WHEN lr.priority = 'Emergency' THEN 1 WHEN lr.priority = 'Urgent' THEN 2 ELSE 3 END, lr.request_date ASC`
    );
    res.json(rows);
});

router.post('/lab-tech/requests/:id/report', requireRole('Admin', 'Lab Technician'), async (req, res) => {
    const { result_summary, parameters, findings, image_ref, data } = req.body;
    if (!result_summary || !String(result_summary).trim()) {
        return res.status(400).json({ error: 'Result summary is required' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[reqMeta]] = await conn.query(
            `SELECT lr.request_id, lr.test_id, lr.requested_by, lr.status,
                    lt.test_name, lt.test_category, a.patient_id
             FROM LAB_REQUEST lr
             JOIN LAB_TEST lt ON lr.test_id = lt.test_id
             JOIN CONSULTATION c ON lr.consultation_id = c.consultation_id
             JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
             WHERE lr.request_id = ? FOR UPDATE`,
            [req.params.id]
        );
        if (!reqMeta) {
            await conn.rollback();
            return res.status(404).json({ error: 'Lab request not found' });
        }
        if (reqMeta.status === 'Completed') {
            await conn.rollback();
            return res.status(409).json({ error: 'Lab report has already been submitted for this request' });
        }

        // Ensure technician exists in STAFF (if Admin is submitting, fallback to lab tech staff_id or create record)
        let techId = req.session.user.id;
        const [[staffRow]] = await conn.query('SELECT staff_id FROM STAFF WHERE staff_id = ?', [techId]);
        if (!staffRow) {
            const [[anyTech]] = await conn.query("SELECT staff_id FROM STAFF WHERE staff_type = 'LAB_TECHNICIAN' LIMIT 1");
            techId = anyTech ? anyTech.staff_id : techId;
        }

        const [repIns] = await conn.query(
            'INSERT INTO LAB_REPORT (request_id, technician_id, result_summary) VALUES (?, ?, ?)',
            [req.params.id, techId, result_summary.trim()]
        );
        await conn.query("UPDATE LAB_REQUEST SET status='Completed' WHERE request_id=?", [req.params.id]);
        await conn.commit();

        // Write structured report to MongoDB lab_reports_raw
        const rawDoc = {
            request_id: Number(req.params.id),
            report_id: repIns.insertId,
            patient_id: reqMeta.patient_id,
            test_name: reqMeta.test_name,
            test_category: reqMeta.test_category,
            technician_id: techId,
            result_summary: result_summary.trim(),
            parameters: Array.isArray(parameters) ? parameters : undefined,
            findings: findings || result_summary.trim(),
            image_ref: image_ref || undefined,
            data: data || (Array.isArray(parameters) ? { parameters } : { summary: result_summary.trim() }),
            report_date: new Date()
        };
        // Remove undefined keys
        Object.keys(rawDoc).forEach(k => rawDoc[k] === undefined && delete rawDoc[k]);

        try {
            const mongo = getMongo();
            await mongo.collection('lab_reports_raw').updateOne(
                { request_id: Number(req.params.id) },
                { $set: rawDoc },
                { upsert: true }
            );
            await mongo.collection('audit_log').insertOne({
                user_id: req.session.user.id,
                action: 'INSERT lab report',
                table_affected: 'LAB_REPORT',
                details: { request_id: Number(req.params.id), report_id: repIns.insertId, test_name: reqMeta.test_name },
                timestamp: new Date()
            });
        } catch (mongoErr) {
            console.warn('MongoDB lab_reports_raw write failed (non-fatal):', mongoErr.message);
        }

        // Notify requesting doctor & patient
        await sendNotification({
            user_id: reqMeta.requested_by,
            message: `Lab report ready for ${reqMeta.test_name} (Request #${reqMeta.request_id}): ${result_summary.trim().slice(0, 120)}`,
            event_type: 'lab_report_ready'
        });
        await sendNotification({
            user_id: reqMeta.patient_id,
            message: `Your lab report for ${reqMeta.test_name} is ready.`,
            event_type: 'lab_report_ready'
        });

        res.status(201).json({
            message: 'Report generated',
            report_id: repIns.insertId,
            request_id: Number(req.params.id)
        });
    } catch (err) {
        await conn.rollback();
        console.error('Lab report error:', err);
        res.status(500).json({ error: 'Failed to generate report' });
    } finally {
        conn.release();
    }
});

router.get('/lab-tech/completed-reports', requireRole('Admin', 'Lab Technician', 'Doctor'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT lr.report_id, lr.request_id, lt.test_name, up.name AS patient_name, lr.report_date, lr.result_summary
         FROM LAB_REPORT lr
         JOIN LAB_REQUEST lreq ON lr.request_id = lreq.request_id
         JOIN LAB_TEST lt ON lreq.test_id = lt.test_id
         JOIN CONSULTATION c ON lreq.consultation_id = c.consultation_id
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         JOIN PATIENT p ON a.patient_id = p.patient_id
         JOIN \`USER\` up ON p.patient_id = up.user_id
         ORDER BY lr.report_date DESC
         LIMIT 50`
    );
    res.json(rows);
});

router.get('/lab-tech/reports/:reportId', requireRole('Admin', 'Lab Technician', 'Doctor'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT lr.report_id, lr.request_id, lr.result_summary, lr.report_date,
                lt.test_name, up.name AS patient_name, ut.name AS technician_name
         FROM LAB_REPORT lr
         JOIN LAB_REQUEST lreq ON lr.request_id = lreq.request_id
         JOIN LAB_TEST lt ON lreq.test_id = lt.test_id
         JOIN STAFF s ON lr.technician_id = s.staff_id
         JOIN \`USER\` ut ON s.staff_id = ut.user_id
         JOIN CONSULTATION c ON lreq.consultation_id = c.consultation_id
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         JOIN PATIENT p ON a.patient_id = p.patient_id
         JOIN \`USER\` up ON p.patient_id = up.user_id
         WHERE lr.report_id = ?`,
        [req.params.reportId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Report not found' });
    const report = rows[0];
    try {
        const raw = await getMongo().collection('lab_reports_raw').findOne(
            { request_id: report.request_id },
            { projection: { _id: 0 } }
        );
        report.raw = raw || null;
    } catch (_) {
        report.raw = null;
    }
    res.json(report);
});

// ---- Pharmacist: pending prescriptions -> dispense (transactional batch FEFO + dispensing record) ----
router.get('/pharmacist/pending-prescriptions', requireRole('Admin', 'Pharmacist'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT pr.prescription_id, up.name AS patient_name, ud.name AS doctor_name, pr.prescribed_date
         FROM PRESCRIPTION pr
         JOIN CONSULTATION c ON pr.consultation_id = c.consultation_id
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         JOIN PATIENT p ON a.patient_id = p.patient_id JOIN \`USER\` up ON p.patient_id = up.user_id
         JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
         WHERE pr.status = 'Pending'
         ORDER BY pr.prescribed_date ASC`
    );
    res.json(rows);
});

router.get('/pharmacist/prescription-items/:prescriptionId', requireRole('Admin', 'Pharmacist'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT pi.item_id, pi.medicine_id, m.medicine_name, pi.dosage, pi.instructions, pi.duration_days, pi.quantity,
                m.stock_qty AS current_stock,
                (SELECT SUM(x.quantity) FROM PRESCRIPTION_ITEM x WHERE x.prescription_id=pi.prescription_id AND x.medicine_id=pi.medicine_id) AS required_quantity,
                m.stock_qty - (SELECT SUM(x.quantity) FROM PRESCRIPTION_ITEM x WHERE x.prescription_id=pi.prescription_id AND x.medicine_id=pi.medicine_id) AS stock_after
         FROM PRESCRIPTION_ITEM pi
         JOIN vw_medicine_inventory m ON pi.medicine_id = m.medicine_id
         WHERE pi.prescription_id = ?`,
        [req.params.prescriptionId]
    );
    res.json(rows);
});

router.get('/pharmacist/inventory', requireRole('Admin', 'Pharmacist'), async (req, res) => {
    try {
        let sql = 'SELECT medicine_id, medicine_name, manufacturer, unit_price, stock_qty, expiry_date FROM vw_medicine_inventory';
        const params = [];
        if (req.query.q) {
            sql += ' WHERE medicine_name LIKE ?';
            params.push('%' + req.query.q + '%');
        }
        sql += ' ORDER BY medicine_name';
        const [rows] = await mysqlPool.query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load inventory' });
    }
});

// Transactional Dispensing: checks non-expired MEDICINE_BATCH rows, deducts stock in FEFO order,
// writes DISPENSING_RECORD + DISPENSING_ITEM rows, and marks PRESCRIPTION Dispensed in the same transaction.
router.post('/pharmacist/dispense/:prescriptionId', requireRole('Admin', 'Pharmacist'), async (req, res) => {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // 1. Lock the prescription row
        const [prescRows] = await conn.query(
            'SELECT * FROM PRESCRIPTION WHERE prescription_id = ? FOR UPDATE',
            [req.params.prescriptionId]
        );
        if (!prescRows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Prescription not found' });
        }
        if (prescRows[0].status === 'Dispensed') {
            await conn.rollback();
            return res.status(409).json({ error: 'Prescription has already been dispensed' });
        }

        // 2. Fetch prescription items
        const [items] = await conn.query(
            `SELECT pi.item_id, pi.medicine_id, pi.quantity, m.medicine_name
             FROM PRESCRIPTION_ITEM pi
             JOIN MEDICINE m ON pi.medicine_id = m.medicine_id
             WHERE pi.prescription_id = ?
             ORDER BY pi.item_id ASC`,
            [req.params.prescriptionId]
        );
        if (!items.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'Prescription has no medicine items to dispense' });
        }

        // 3. Create DISPENSING_RECORD first (so trg_update_stock sees it and does not double-deduct)
        const [dispRes] = await conn.query(
            'INSERT INTO DISPENSING_RECORD (prescription_id, pharmacist_id, dispensed_at, notes) VALUES (?, ?, NOW(), ?)',
            [req.params.prescriptionId, req.session.user.id, req.body.notes || 'Dispensed via pharmacy queue']
        );
        const dispensingId = dispRes.insertId;

        // 4. For each item, lock non-expired MEDICINE_BATCH rows in FEFO order, verify sufficient stock, and deduct
        const batchDeductions = [];
        for (const item of items) {
            const [batches] = await conn.query(
                `SELECT batch_id, batch_number, expiry_date, available_qty
                 FROM MEDICINE_BATCH
                 WHERE medicine_id = ? AND available_qty > 0 AND expiry_date >= CURDATE()
                 ORDER BY expiry_date ASC, batch_id ASC
                 FOR UPDATE`,
                [item.medicine_id]
            );

            const totalAvailable = batches.reduce((acc, b) => acc + Number(b.available_qty), 0);
            if (totalAvailable < Number(item.quantity)) {
                await conn.rollback();
                return res.status(409).json({
                    error: `Cannot dispense: insufficient non-expired stock for ${item.medicine_name} (required ${item.quantity}, available ${totalAvailable})`
                });
            }

            let remainingToDeduct = Number(item.quantity);
            for (const batch of batches) {
                if (remainingToDeduct <= 0) break;
                const deduct = Math.min(remainingToDeduct, Number(batch.available_qty));
                await conn.query(
                    'UPDATE MEDICINE_BATCH SET available_qty = available_qty - ? WHERE batch_id = ?',
                    [deduct, batch.batch_id]
                );
                await conn.query(
                    `INSERT INTO DISPENSING_ITEM (dispensing_id, prescription_item_id, batch_id, quantity_dispensed)
                     VALUES (?, ?, ?, ?)`,
                    [dispensingId, item.item_id, batch.batch_id, deduct]
                );
                batchDeductions.push({
                    medicine_id: item.medicine_id,
                    medicine_name: item.medicine_name,
                    batch_id: batch.batch_id,
                    batch_number: batch.batch_number,
                    quantity_dispensed: deduct
                });
                remainingToDeduct -= deduct;
            }
        }

        // 5. Mark prescription Dispensed
        await conn.query(
            "UPDATE PRESCRIPTION SET status = 'Dispensed' WHERE prescription_id = ?",
            [req.params.prescriptionId]
        );

        await conn.commit();

        // Audit log in MongoDB
        try {
            await getMongo().collection('audit_log').insertOne({
                user_id: req.session.user.id,
                action: 'DISPENSE prescription',
                table_affected: 'PRESCRIPTION',
                details: {
                    prescription_id: Number(req.params.prescriptionId),
                    dispensing_id: dispensingId,
                    deductions: batchDeductions
                },
                timestamp: new Date()
            });
        } catch (_) {}

        res.json({
            message: 'Prescription dispensed, stock updated',
            dispensing_id: dispensingId,
            deductions: batchDeductions
        });
    } catch (err) {
        await conn.rollback();
        res.status(409).json({ error: err.sqlMessage || err.message || 'Could not dispense' });
    } finally {
        conn.release();
    }
});

// ---- Receptionist: register patient, book appointment, billing ----
router.post('/receptionist/register-patient', requireRole('Receptionist', 'Admin'), async (req, res) => {
    const { name, email, password, password_hash, phone, dob, gender, blood_group, address, emergency_contact, allergies } = req.body;
    const rawPassword = password || password_hash;
    if (!name || !email || !rawPassword) {
        return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const hashedPassword = String(rawPassword).startsWith('$2')
            ? String(rawPassword)
            : await bcrypt.hash(String(rawPassword), 10);

        const [roleRow] = await conn.query("SELECT role_id FROM ROLE WHERE role_name='Patient'");
        const [userResult] = await conn.query(
            'INSERT INTO `USER` (name, email, password_hash, phone, role_id) VALUES (?, ?, ?, ?, ?)',
            [name.trim(), email.trim(), hashedPassword, phone || null, roleRow[0].role_id]
        );

        const normalizedGender = ['M', 'F', 'O'].includes(gender) ? gender : (gender === 'Other' ? 'O' : 'O');
        await conn.query(
            'INSERT INTO PATIENT (patient_id, dob, gender, blood_group, address, emergency_contact) VALUES (?, ?, ?, ?, ?, ?)',
            [userResult.insertId, dob || null, normalizedGender, blood_group || null, address || null, emergency_contact || null]
        );

        // If allergies were supplied, insert atomic rows into PATIENT_ALLERGY
        if (allergies) {
            const list = Array.isArray(allergies)
                ? allergies
                : String(allergies).split(',').map(s => s.trim()).filter(Boolean);
            for (const alg of list) {
                await conn.query(
                    'INSERT IGNORE INTO PATIENT_ALLERGY (patient_id, allergy_name) VALUES (?, ?)',
                    [userResult.insertId, alg]
                );
            }
        }

        await conn.commit();
        res.status(201).json({ patient_id: userResult.insertId });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Failed to register patient: ' + err.message });
    } finally {
        conn.release();
    }
});

router.post('/receptionist/book-appointment', requireRole('Receptionist', 'Admin'), async (req, res) => {
    const { patient_id, doctor_id, department_id, appointment_date, appointment_time } = req.body;
    try {
        await mysqlPool.query(
            'CALL sp_book_appointment(?, ?, ?, ?, ?, ?)',
            [patient_id, doctor_id, department_id || null, appointment_date, appointment_time, req.session.user.id]
        );
        res.status(201).json({ message: 'Appointment booked' });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Selected slot is already booked for this doctor' });
        }
        res.status(409).json({ error: err.sqlMessage || 'Could not book appointment' });
    }
});

router.post('/receptionist/generate-bill', requireRole('Receptionist', 'Admin'), async (req, res) => {
    const { appointment_id } = req.body;
    if (!Number.isSafeInteger(Number(appointment_id)) || Number(appointment_id) < 1) {
        return res.status(400).json({ error: 'Choose a valid appointment' });
    }
    const conn = await mysqlPool.getConnection();
    try {
        const [[existingBill]] = await conn.query(
            'SELECT bill_id, patient_id, appointment_id, total_amount, paid_amount, balance_due, payment_status FROM vw_bill_summary WHERE appointment_id = ? ORDER BY bill_id DESC LIMIT 1',
            [appointment_id]
        );
        if (existingBill) {
            return res.status(200).json({ message: 'Bill already exists', bill: existingBill });
        }

        await conn.query('CALL sp_generate_bill(?, ?)', [appointment_id, req.session.user.id]);
        const [[bill]] = await conn.query(
            'SELECT bill_id, patient_id, appointment_id, total_amount, paid_amount, balance_due, payment_status FROM vw_bill_summary WHERE appointment_id = ? ORDER BY bill_id DESC LIMIT 1',
            [appointment_id]
        );
        res.status(201).json({ message: 'Bill generated', bill });
    } catch (err) {
        res.status(409).json({ error: err.sqlMessage || 'Could not generate bill' });
    } finally {
        conn.release();
    }
});

// Receptionist appointment context for the procedure-backed billing action.
router.get('/receptionist/appointments', requireRole('Receptionist', 'Admin'), async (req, res) => {
    const [rows] = await mysqlPool.query(`
        SELECT a.appointment_id, a.patient_id, up.name AS patient_name,
               ud.name AS doctor_name, a.appointment_date, a.appointment_time,
               a.status, c.consultation_id,
               (SELECT MAX(b.bill_id) FROM BILL b WHERE b.appointment_id=a.appointment_id) AS bill_id
        FROM APPOINTMENT a JOIN \`USER\` up ON up.user_id=a.patient_id
        JOIN \`USER\` ud ON ud.user_id=a.doctor_id
        LEFT JOIN CONSULTATION c ON c.appointment_id=a.appointment_id
        ORDER BY a.appointment_date DESC, a.appointment_time DESC`);
    res.json(rows);
});

// Pharmacist notifications (low stock alerts) -- written by trg_low_stock_alert
router.get('/pharmacist/notifications', requireRole('Pharmacist', 'Admin'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT notification_id, message, is_read, created_at FROM NOTIFICATION
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
        [req.session.user.id]
    );
    res.json(rows);
});

module.exports = router;
