const express = require('express');
const { mysqlPool } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { sendNotification } = require('../services/notificationService');

const router = express.Router();

// ---- Nurse: ward / beds / patients ----
router.get('/nurse/beds', requireRole('Admin', 'Nurse'), async (req, res) => {
    const [rows] = await mysqlPool.query('SELECT b.*, u.name AS patient_name FROM BED b LEFT JOIN `USER` u ON b.patient_id=u.user_id ORDER BY b.ward_name,b.bed_number');
    res.json(rows);
});

router.get('/nurse/ward/:wardName/patients', requireRole('Admin', 'Nurse'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT b.bed_number, u.name, p.patient_id FROM BED b
         JOIN PATIENT p ON b.patient_id = p.patient_id JOIN \`USER\` u ON p.patient_id = u.user_id
         WHERE b.ward_name = ? AND b.status = 'Occupied'`, [req.params.wardName]
    );
    res.json(rows);
});

// Comprehensive assigned patients list for Nurse Portal
router.get('/nurse/assigned-patients', requireRole('Admin', 'Nurse'), async (req, res) => {
    try {
        const query = `
            SELECT 
                b.bed_id,
                b.ward_name,
                b.bed_number,
                b.status AS bed_status,
                b.patient_id,
                u.name AS patient_name,
                u.phone AS patient_phone,
                p.blood_group,
                p.allergies,
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
            FROM BED b
            JOIN PATIENT p ON b.patient_id = p.patient_id
            JOIN \`USER\` u ON p.patient_id = u.user_id
            LEFT JOIN ADMISSION adm ON adm.bed_id = b.bed_id AND adm.status = 'Admitted'
            LEFT JOIN DOCTOR doc ON adm.admitting_doctor_id = doc.doctor_id
            LEFT JOIN \`USER\` udoc ON doc.doctor_id = udoc.user_id
            LEFT JOIN EMERGENCY_CASE ec ON ec.assigned_bed_id = b.bed_id AND ec.status NOT IN ('Discharged', 'Transferred')
            LEFT JOIN DOCTOR emgdoc ON ec.assigned_doctor_id = emgdoc.doctor_id
            LEFT JOIN \`USER\` uemgdoc ON emgdoc.doctor_id = uemgdoc.user_id
            WHERE b.status = 'Occupied'
            ORDER BY b.ward_name, b.bed_number
        `;
        const [rows] = await mysqlPool.query(query);
        res.json(rows);
    } catch (err) {
        console.error('Nurse assigned patients error:', err);
        res.status(500).json({ error: 'Failed to load assigned patients' });
    }
});

// Nurse: View pending admission requests from doctors (Bed Assignment Queue)
router.get('/nurse/admission-requests', requireRole('Admin', 'Nurse'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT ar.request_id, ar.patient_id, ar.consultation_id, ar.appointment_id,
                    up.name AS patient_name, up.phone AS patient_phone,
                    p.blood_group, p.gender, TIMESTAMPDIFF(YEAR, p.dob, CURDATE()) AS age,
                    ar.doctor_id, ud.name AS doctor_name, doc.specialization,
                    ar.recommended_ward, ar.priority, ar.reason, ar.created_at, ar.status
             FROM ADMISSION_REQUEST ar
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
        let sql = "SELECT bed_id, ward_name, bed_number, status FROM BED WHERE status = 'Available'";
        const params = [];
        if (ward) {
            sql += " AND ward_name = ?";
            params.push(ward);
        }
        sql += " ORDER BY ward_name, bed_number";
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
            conn.release();
            return res.status(400).json({ error: 'Admission request not found or already processed' });
        }
        const admReq = requests[0];

        // 2. Fetch and lock bed
        const [beds] = await conn.query('SELECT * FROM BED WHERE bed_id = ? FOR UPDATE', [bed_id]);
        if (!beds.length || beds[0].status !== 'Available') {
            await conn.rollback();
            conn.release();
            return res.status(409).json({ error: 'Selected bed is no longer available' });
        }
        const bed = beds[0];

        // 3. Update BED to Occupied
        await conn.query('UPDATE BED SET status = "Occupied", patient_id = ? WHERE bed_id = ?', [admReq.patient_id, bed_id]);

        // 4. Update ADMISSION_REQUEST to Assigned
        await conn.query(
            'UPDATE ADMISSION_REQUEST SET status = "Assigned", assigned_bed_id = ?, assigned_by = ?, assigned_at = NOW() WHERE request_id = ?',
            [bed_id, req.session.user.id, request_id]
        );

        // 5. Create ADMISSION record
        await conn.query(
            'INSERT INTO ADMISSION (patient_id, admitting_doctor_id, ward_name, bed_id, admitted_at, status) VALUES (?, ?, ?, ?, NOW(), "Admitted")',
            [admReq.patient_id, admReq.doctor_id, bed.ward_name, bed_id]
        );

        await conn.commit();
        conn.release();

        // 6. Broadcast notification to Doctor and Admin
        try {
            const notifService = require('../services/notificationService');
            await notifService.broadcastToRole('Doctor', {
                title: 'Inpatient Bed Assigned',
                message: `Patient #${admReq.patient_id} assigned to ${bed.ward_name} (${bed.bed_number}) by Nurse ${req.session.user.name}.`,
                type: 'bed_assigned',
                metadata: { patient_id: admReq.patient_id, bed_id, bed_number: bed.bed_number }
            });
        } catch (notifErr) {
            console.warn('Doctor notification warning:', notifErr.message);
        }

        res.json({
            message: 'Bed assigned and patient admitted successfully',
            bed_number: bed.bed_number,
            ward_name: bed.ward_name
        });
    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error('Error assigning bed for admission request:', err);
        res.status(500).json({ error: 'Failed to assign bed' });
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

// Bed transfer request by nurse
router.post('/nurse/transfer-bed', requireRole('Admin', 'Nurse'), async (req, res) => {
    const { patient_id, current_bed_id, new_bed_id, reason } = req.body;

    if (!patient_id || !current_bed_id || !new_bed_id) {
        return res.status(400).json({ error: 'Patient, current bed, and new bed are required' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // Check new bed
        const [[newBed]] = await conn.query('SELECT * FROM BED WHERE bed_id = ? FOR UPDATE', [new_bed_id]);
        if (!newBed || newBed.status !== 'Available') {
            await conn.rollback();
            return res.status(409).json({ error: 'Target bed is not available' });
        }

        // Release old bed to Cleaning
        await conn.query("UPDATE BED SET status='Cleaning', patient_id=NULL WHERE bed_id=?", [current_bed_id]);

        // Occupy new bed
        await conn.query("UPDATE BED SET status='Occupied', patient_id=? WHERE bed_id=?", [patient_id, new_bed_id]);

        // Update ADMISSION if present
        await conn.query(
            "UPDATE ADMISSION SET bed_id=?, ward_name=? WHERE patient_id=? AND status='Admitted'",
            [new_bed_id, newBed.ward_name, patient_id]
        );

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

// Live emergency monitoring feed for nurses
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
                b.ward_name,
                (SELECT pv.spo2 FROM PATIENT_VITALS pv WHERE pv.case_id = ec.case_id ORDER BY pv.recorded_at DESC LIMIT 1) AS latest_spo2,
                (SELECT pv.heart_rate FROM PATIENT_VITALS pv WHERE pv.case_id = ec.case_id ORDER BY pv.recorded_at DESC LIMIT 1) AS latest_heart_rate,
                (SELECT CONCAT(pv.bp_systolic, '/', pv.bp_diastolic) FROM PATIENT_VITALS pv WHERE pv.case_id = ec.case_id ORDER BY pv.recorded_at DESC LIMIT 1) AS latest_bp
             FROM EMERGENCY_CASE ec
             LEFT JOIN PATIENT p ON ec.patient_id = p.patient_id
             LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
             LEFT JOIN DOCTOR doc ON ec.assigned_doctor_id = doc.doctor_id
             LEFT JOIN \`USER\` udoc ON doc.doctor_id = udoc.user_id
             LEFT JOIN BED b ON ec.assigned_bed_id = b.bed_id
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

// ---- Lab Technician: pending requests -> enter result -> generate report ----
router.get('/lab-tech/pending-requests', requireRole('Admin', 'Lab Technician'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT lr.request_id, lt.test_name, up.name AS patient_name, ud.name AS requested_by
         FROM LAB_REQUEST lr JOIN LAB_TEST lt ON lr.test_id = lt.test_id
         JOIN CONSULTATION c ON lr.consultation_id = c.consultation_id
         JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
         JOIN PATIENT p ON a.patient_id = p.patient_id JOIN \`USER\` up ON p.patient_id = up.user_id
         JOIN DOCTOR doc ON lr.requested_by = doc.doctor_id JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
         WHERE lr.status = 'Pending'`
    );
    res.json(rows);
});

router.post('/lab-tech/requests/:id/report', requireRole('Admin', 'Lab Technician'), async (req, res) => {
    const { result_summary } = req.body; // full structured result goes to MongoDB lab_reports_raw (Phase 5)
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(
            'INSERT INTO LAB_REPORT (request_id, technician_id, result_summary) VALUES (?, ?, ?)',
            [req.params.id, req.session.user.id, result_summary]
        );
        await conn.query("UPDATE LAB_REQUEST SET status='Completed' WHERE request_id=?", [req.params.id]);
        await conn.commit();
        res.status(201).json({ message: 'Report generated' });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Failed to generate report' });
    } finally {
        conn.release();
    }
});

router.get('/lab-tech/completed-reports', requireRole('Admin', 'Lab Technician'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT lr.report_id, lt.test_name, up.name AS patient_name, lr.report_date
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

router.get('/lab-tech/reports/:reportId', requireRole('Admin', 'Lab Technician'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT lr.report_id, lr.result_summary, lr.report_date,
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
    res.json(rows[0]);
});

// ---- Pharmacist: pending prescriptions -> dispense (stock auto-decrements via trg_update_stock) ----
router.get('/pharmacist/pending-prescriptions', requireRole('Admin', 'Pharmacist'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT pr.prescription_id, up.name AS patient_name, ud.name AS doctor_name, pr.prescribed_date
         FROM PRESCRIPTION pr
         JOIN PATIENT p ON pr.patient_id = p.patient_id JOIN \`USER\` up ON p.patient_id = up.user_id
         JOIN DOCTOR doc ON pr.doctor_id = doc.doctor_id JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
         WHERE pr.status = 'Pending'`
    );
    res.json(rows);
});

router.get('/pharmacist/prescription-items/:prescriptionId', requireRole('Admin', 'Pharmacist'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT pi.item_id, pi.medicine_id, m.medicine_name, pi.dosage, pi.instructions, pi.duration_days, pi.quantity,
                m.stock_qty AS current_stock,
                (SELECT SUM(x.quantity) FROM PRESCRIPTION_ITEM x WHERE x.prescription_id=pi.prescription_id AND x.medicine_id=pi.medicine_id) AS required_quantity,
                m.stock_qty - (SELECT SUM(x.quantity) FROM PRESCRIPTION_ITEM x WHERE x.prescription_id=pi.prescription_id AND x.medicine_id=pi.medicine_id) AS stock_after
         FROM PRESCRIPTION_ITEM pi JOIN MEDICINE m ON pi.medicine_id = m.medicine_id
         WHERE pi.prescription_id = ?`,
        [req.params.prescriptionId]
    );
    res.json(rows);
});

router.get('/pharmacist/inventory', requireRole('Admin', 'Pharmacist'), async (req, res) => {
    try {
        let sql = 'SELECT medicine_id, medicine_name, manufacturer, unit_price, stock_qty, expiry_date FROM MEDICINE';
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

router.post('/pharmacist/dispense/:prescriptionId', requireRole('Admin', 'Pharmacist'), async (req, res) => {
    try {
        // This single UPDATE is the whole dispense action -- trg_update_stock (Phase 4)
        // decrements MEDICINE.stock_qty for every item, and if that push crosses a
        // medicine below 20 units it chains straight into trg_low_stock_alert too.
        await mysqlPool.query("UPDATE PRESCRIPTION SET status='Dispensed' WHERE prescription_id=?", [req.params.prescriptionId]);
        res.json({ message: 'Prescription dispensed, stock updated' });
    } catch (err) {
        // SIGNAL'd by trg_update_stock when stock is short
        res.status(409).json({ error: err.sqlMessage || 'Could not dispense' });
    }
});

// ---- Receptionist: register patient, book appointment, billing ----
router.post('/receptionist/register-patient', requireRole('Receptionist'), async (req, res) => {
    const { name, email, password_hash, phone, dob, gender, blood_group, address, emergency_contact } = req.body;
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [roleRow] = await conn.query("SELECT role_id FROM ROLE WHERE role_name='Patient'");
        const [userResult] = await conn.query(
            'INSERT INTO `USER` (name, email, password_hash, phone, role_id) VALUES (?, ?, ?, ?, ?)',
            [name, email, password_hash, phone, roleRow[0].role_id]
        );
        await conn.query(
            'INSERT INTO PATIENT (patient_id, dob, gender, blood_group, address, emergency_contact) VALUES (?, ?, ?, ?, ?, ?)',
            [userResult.insertId, dob, gender, blood_group, address, emergency_contact]
        );
        await conn.commit();
        res.status(201).json({ patient_id: userResult.insertId });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Failed to register patient' });
    } finally {
        conn.release();
    }
});

router.post('/receptionist/book-appointment', requireRole('Receptionist'), async (req, res) => {
    const { patient_id, doctor_id, department_id, appointment_date, appointment_time } = req.body;
    try {
        await mysqlPool.query(
            'CALL sp_book_appointment(?, ?, ?, ?, ?, ?)',
            [patient_id, doctor_id, department_id, appointment_date, appointment_time, req.session.user.id]
        );
        res.status(201).json({ message: 'Appointment booked' });
    } catch (err) {
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
        // If bill already exists for this appointment, return it
        const [[existingBill]] = await conn.query(
            'SELECT bill_id, patient_id, appointment_id, total_amount, payment_status FROM BILL WHERE appointment_id = ? ORDER BY bill_id DESC LIMIT 1',
            [appointment_id]
        );
        if (existingBill) {
            return res.status(200).json({ message: 'Bill already exists', bill: existingBill });
        }

        await conn.query('CALL sp_generate_bill(?, ?)', [appointment_id, req.session.user.id]);
        const [[bill]] = await conn.query(
            'SELECT bill_id, patient_id, appointment_id, total_amount, payment_status FROM BILL WHERE appointment_id = ? ORDER BY bill_id DESC LIMIT 1',
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
router.get('/receptionist/appointments', requireRole('Receptionist'), async (req, res) => {
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
router.get('/pharmacist/notifications', requireRole('Pharmacist'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT notification_id, message, is_read, created_at FROM NOTIFICATION
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
        [req.session.user.id]
    );
    res.json(rows);
});

module.exports = router;
