const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { mysqlPool, getMongo } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { sendNotification } = require('../services/notificationService');

// Base router gate: only clinical & operational staff can access Emergency routes
router.use(requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist'));

// Helper: Calculate dynamic emergency priority score
function computePriorityScore(priority, waitMinutes) {
    const baseScores = { 'P1': 1000, 'P2': 500, 'P3': 200, 'P4': 50 };
    const waitMultipliers = { 'P1': 10, 'P2': 5, 'P3': 2, 'P4': 1 };
    const base = baseScores[priority] || 100;
    const mult = waitMultipliers[priority] || 1;
    return base + (Math.max(0, waitMinutes) * mult);
}

// Helper: Resolve department_id by department_name from DEPARTMENT table (no hardcoded IDs)
async function resolveDepartmentByName(connOrPool, departmentName) {
    const [rows] = await connOrPool.query(
        'SELECT department_id, department_name FROM DEPARTMENT WHERE department_name = ? LIMIT 1',
        [departmentName]
    );
    if (rows.length) return rows[0];
    const [fallback] = await connOrPool.query(
        'SELECT department_id, department_name FROM DEPARTMENT ORDER BY department_id LIMIT 1'
    );
    return fallback[0] || { department_id: null, department_name: departmentName };
}

// Helper: Generate next EMG-YYYY-XXX concurrency-safely inside an open transaction
async function generateNextEmgNumber(conn) {
    const currentYear = new Date().getFullYear();
    await conn.query(
        'INSERT INTO EMERGENCY_SEQUENCE (seq_year, last_val) VALUES (?, 0) ON DUPLICATE KEY UPDATE last_val = last_val',
        [currentYear]
    );
    const [[seqRow]] = await conn.query(
        'SELECT last_val FROM EMERGENCY_SEQUENCE WHERE seq_year = ? FOR UPDATE',
        [currentYear]
    );
    const nextVal = Number(seqRow ? seqRow.last_val : 0) + 1;
    await conn.query(
        'UPDATE EMERGENCY_SEQUENCE SET last_val = ? WHERE seq_year = ?',
        [nextVal, currentYear]
    );
    return `EMG-${currentYear}-${String(nextVal).padStart(3, '0')}`;
}

// -----------------------------------------------------------------------------
// 1. Emergency Dashboard KPIs (Admin, Doctor, Nurse, Receptionist)
// -----------------------------------------------------------------------------
router.get('/dashboard', requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist'), async (req, res) => {
    try {
        const [[activeCases]] = await mysqlPool.query(
            "SELECT COUNT(*) AS total FROM EMERGENCY_CASE WHERE status NOT IN ('Discharged', 'Transferred')"
        );
        const [[criticalCases]] = await mysqlPool.query(
            "SELECT COUNT(*) AS total FROM EMERGENCY_CASE WHERE triage_priority = 'P1' AND status NOT IN ('Discharged', 'Transferred')"
        );
        const [[urgentCases]] = await mysqlPool.query(
            "SELECT COUNT(*) AS total FROM EMERGENCY_CASE WHERE triage_priority = 'P2' AND status NOT IN ('Discharged', 'Transferred')"
        );
        const [[waitingCases]] = await mysqlPool.query(
            "SELECT COUNT(*) AS total FROM EMERGENCY_CASE WHERE status = 'Waiting'"
        );
        const [[availEmgBeds]] = await mysqlPool.query(
            `SELECT COUNT(*) AS total
             FROM BED b JOIN WARD w ON b.ward_id = w.ward_id
             WHERE w.ward_name IN ('Emergency Ward', 'ICU') AND b.status = 'Available'`
        );
        const [[occupiedEmgBeds]] = await mysqlPool.query(
            `SELECT COUNT(*) AS total
             FROM BED b JOIN WARD w ON b.ward_id = w.ward_id
             WHERE w.ward_name = 'Emergency Ward' AND b.status = 'Occupied'`
        );
        const [[availDoctors]] = await mysqlPool.query(
            `SELECT COUNT(DISTINCT d.doctor_id) AS total
             FROM DOCTOR d
             JOIN \`USER\` u ON d.doctor_id = u.user_id
             JOIN DOCTOR_SHIFT ds ON d.doctor_id = ds.doctor_id
             WHERE u.is_active = TRUE
               AND ds.shift_date = CURDATE()
               AND ds.is_on_duty = TRUE
               AND (
                 (ds.start_time <= ds.end_time AND CURTIME() BETWEEN ds.start_time AND ds.end_time)
                 OR (ds.start_time > ds.end_time AND (CURTIME() >= ds.start_time OR CURTIME() <= ds.end_time))
               )
               AND NOT EXISTS (
                 SELECT 1 FROM DOCTOR_LEAVE dl
                 WHERE dl.doctor_id = d.doctor_id
                   AND dl.status = 'Approved'
                   AND CURDATE() BETWEEN dl.start_date AND dl.end_date
               )`
        );
        const [[ambulancesOnDuty]] = await mysqlPool.query(
            "SELECT COUNT(*) AS total FROM AMBULANCE WHERE status = 'On Duty'"
        );
        const [[recentAdmissions]] = await mysqlPool.query(
            "SELECT COUNT(*) AS total FROM ADMISSION WHERE admitted_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)"
        );

        res.json({
            active_cases: activeCases.total || 0,
            critical_cases: criticalCases.total || 0,
            urgent_cases: urgentCases.total || 0,
            waiting_patients: waitingCases.total || 0,
            available_emergency_beds: availEmgBeds.total || 0,
            occupied_emergency_beds: occupiedEmgBeds.total || 0,
            available_emergency_doctors: availDoctors.total || 0,
            ambulances_arriving: ambulancesOnDuty.total || 0,
            recent_admissions: recentAdmissions.total || 0
        });
    } catch (err) {
        console.error('Emergency dashboard error:', err);
        res.status(500).json({ error: 'Failed to load emergency dashboard statistics' });
    }
});

// -----------------------------------------------------------------------------
// 2. Emergency Queue (Priority-ordered; 3NF via assignment history tables)
// -----------------------------------------------------------------------------
router.get('/queue', requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist'), async (req, res) => {
    try {
        const query = `
            SELECT 
                ec.case_id,
                ec.emg_number,
                ec.patient_id,
                COALESCE(u.name, ec.temp_patient_name, 'Unidentified Patient') AS patient_name,
                COALESCE(p.gender, ec.temp_patient_gender, '--') AS gender,
                COALESCE(TIMESTAMPDIFF(YEAR, p.dob, CURDATE()), ec.temp_patient_age, '--') AS age,
                ec.arrival_time,
                TIMESTAMPDIFF(MINUTE, ec.arrival_time, NOW()) AS waiting_minutes,
                ec.arrival_method,
                ec.initial_complaint,
                ec.triage_priority,
                ec.status,
                eda.doctor_id AS assigned_doctor_id,
                ud.name AS assigned_doctor_name,
                doc.specialization AS doctor_specialization,
                eba.bed_id AS assigned_bed_id,
                b.bed_number,
                w.ward_name,
                ec.department_id,
                dep.department_name,
                amb.vehicle_number AS ambulance_number,
                (SELECT COUNT(*) FROM TRIAGE_ASSESSMENT ta WHERE ta.case_id = ec.case_id) AS triage_count,
                (SELECT ta.assessed_at FROM TRIAGE_ASSESSMENT ta WHERE ta.case_id = ec.case_id ORDER BY ta.assessed_at DESC LIMIT 1) AS last_triage_time
            FROM EMERGENCY_CASE ec
            LEFT JOIN PATIENT p ON ec.patient_id = p.patient_id
            LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
            LEFT JOIN EMERGENCY_DOCTOR_ASSIGNMENT eda ON ec.case_id = eda.case_id AND eda.is_active = TRUE
            LEFT JOIN DOCTOR doc ON eda.doctor_id = doc.doctor_id
            LEFT JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
            LEFT JOIN EMERGENCY_BED_ASSIGNMENT eba ON ec.case_id = eba.case_id AND eba.is_active = TRUE
            LEFT JOIN BED b ON eba.bed_id = b.bed_id
            LEFT JOIN WARD w ON b.ward_id = w.ward_id
            LEFT JOIN DEPARTMENT dep ON ec.department_id = dep.department_id
            LEFT JOIN AMBULANCE amb ON ec.ambulance_id = amb.ambulance_id
            WHERE ec.status NOT IN ('Discharged', 'Transferred')
            ORDER BY ec.arrival_time ASC
        `;

        const [rows] = await mysqlPool.query(query);

        const casesWithScores = rows.map(item => {
            const score = computePriorityScore(item.triage_priority, item.waiting_minutes);
            return {
                ...item,
                priority_score: score
            };
        });

        casesWithScores.sort((a, b) => b.priority_score - a.priority_score);

        casesWithScores.forEach((item, index) => {
            item.queue_position = index + 1;
        });

        res.json(casesWithScores);
    } catch (err) {
        console.error('Emergency queue error:', err);
        res.status(500).json({ error: 'Failed to load emergency queue' });
    }
});

// -----------------------------------------------------------------------------
// 3. Register Emergency Patient (Admin, Receptionist, Nurse)
// -----------------------------------------------------------------------------
router.post('/register', requireRole('Admin', 'Receptionist', 'Nurse'), async (req, res) => {
    const {
        patient_id,
        temp_patient_name,
        temp_patient_gender,
        temp_patient_age,
        contact_phone,
        emergency_contact,
        arrival_method = 'Walk-in',
        ambulance_id,
        initial_complaint,
        triage_priority = 'P3'
    } = req.body;

    if (!initial_complaint || !initial_complaint.trim()) {
        return res.status(400).json({ error: 'Initial complaint or presenting symptom is required' });
    }

    if (!patient_id && !temp_patient_name) {
        return res.status(400).json({ error: 'Provide either an existing Patient ID or a temporary patient name (e.g. Unknown Male)' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // Concurrency-safe sequence generation for EMG-YYYY-XXX
        const emgNumber = await generateNextEmgNumber(conn);

        // Determine target department by name (never hardcoded numbers)
        let targetDeptName = 'Emergency Medicine';
        const complaintLower = initial_complaint.toLowerCase();
        if (complaintLower.includes('chest') || complaintLower.includes('heart') || complaintLower.includes('cardiac')) {
            targetDeptName = 'Cardiology';
        } else if (complaintLower.includes('fracture') || complaintLower.includes('bone') || complaintLower.includes('fall')) {
            targetDeptName = 'Orthopedics';
        } else if (temp_patient_age && Number(temp_patient_age) < 14) {
            targetDeptName = 'Pediatrics';
        } else if (complaintLower.includes('fever') || complaintLower.includes('infect')) {
            targetDeptName = 'General Medicine';
        }

        const deptRow = await resolveDepartmentByName(conn, targetDeptName);
        const normalizedGender = temp_patient_gender
            ? (['M', 'F', 'O'].includes(temp_patient_gender) ? temp_patient_gender : 'O')
            : null;

        const [insertResult] = await conn.query(
            `INSERT INTO EMERGENCY_CASE (
                emg_number, patient_id, temp_patient_name, temp_patient_gender, temp_patient_age,
                contact_phone, emergency_contact, arrival_time, arrival_method, ambulance_id,
                initial_complaint, triage_priority, status, department_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 'Waiting', ?)`,
            [
                emgNumber,
                patient_id ? Number(patient_id) : null,
                temp_patient_name || null,
                normalizedGender,
                temp_patient_age ? Number(temp_patient_age) : null,
                contact_phone || null,
                emergency_contact || null,
                arrival_method,
                ambulance_id ? Number(ambulance_id) : null,
                initial_complaint.trim(),
                ['P1', 'P2', 'P3', 'P4'].includes(triage_priority) ? triage_priority : 'P3',
                deptRow.department_id
            ]
        );

        const newCaseId = insertResult.insertId;

        // If arrived by ambulance, link any active AMBULANCE_DISPATCH row for this ambulance
        if (ambulance_id) {
            await conn.query(
                "UPDATE AMBULANCE_DISPATCH SET case_id = COALESCE(case_id, ?) WHERE ambulance_id = ? AND status = 'In Transit'",
                [newCaseId, Number(ambulance_id)]
            );
        }

        await conn.commit();

        // Notify Emergency Doctors and Nurses
        const alertMsg = triage_priority === 'P1'
            ? `🚨 CRITICAL EMERGENCY: ${emgNumber} registered with P1 Critical priority! Complaint: ${initial_complaint.slice(0, 80)}`
            : `New Emergency Case: ${emgNumber} registered (${arrival_method}). Complaint: ${initial_complaint.slice(0, 80)}`;
        
        await sendNotification({ role_name: 'Doctor', message: alertMsg, event_type: 'emergency_registration' });
        await sendNotification({ role_name: 'Nurse', message: alertMsg, event_type: 'emergency_registration' });

        // MongoDB Audit Log
        try {
            const mongo = getMongo();
            await mongo.collection('audit_log').insertOne({
                user_id: req.session.user.id,
                action: 'REGISTER emergency patient',
                table_affected: 'EMERGENCY_CASE',
                details: {
                    case_id: newCaseId,
                    emg_number: emgNumber,
                    arrival_method,
                    priority: triage_priority
                },
                timestamp: new Date()
            });
        } catch (_) {}

        res.status(201).json({
            message: 'Emergency patient registered successfully',
            case_id: newCaseId,
            emg_number: emgNumber
        });
    } catch (err) {
        await conn.rollback();
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Failed to register emergency case: ' + err.message });
    } finally {
        conn.release();
    }
});

// -----------------------------------------------------------------------------
// 4. Single Case Details (Admin, Doctor, Nurse, Receptionist)
// -----------------------------------------------------------------------------
router.get('/cases/:id', requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist'), async (req, res) => {
    try {
        const [[caseRow]] = await mysqlPool.query(
            `SELECT 
                ec.*,
                eda.doctor_id AS assigned_doctor_id,
                eba.bed_id AS assigned_bed_id,
                COALESCE(u.name, ec.temp_patient_name, 'Unidentified Patient') AS patient_name,
                COALESCE(u.email, '--') AS patient_email,
                COALESCE(u.phone, ec.contact_phone, '--') AS phone,
                COALESCE(p.gender, ec.temp_patient_gender, '--') AS gender,
                COALESCE(p.blood_group, '--') AS blood_group,
                COALESCE(vpa.allergies, 'None documented') AS allergies,
                COALESCE(TIMESTAMPDIFF(YEAR, p.dob, CURDATE()), ec.temp_patient_age, '--') AS age,
                ud.name AS assigned_doctor_name,
                doc.specialization AS doctor_specialization,
                b.bed_number,
                w.ward_name,
                dep.department_name,
                amb.vehicle_number,
                amb.driver_name,
                TIMESTAMPDIFF(MINUTE, ec.arrival_time, NOW()) AS waiting_minutes
             FROM EMERGENCY_CASE ec
             LEFT JOIN PATIENT p ON ec.patient_id = p.patient_id
             LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
             LEFT JOIN vw_patient_allergies vpa ON p.patient_id = vpa.patient_id
             LEFT JOIN EMERGENCY_DOCTOR_ASSIGNMENT eda ON ec.case_id = eda.case_id AND eda.is_active = TRUE
             LEFT JOIN DOCTOR doc ON eda.doctor_id = doc.doctor_id
             LEFT JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
             LEFT JOIN EMERGENCY_BED_ASSIGNMENT eba ON ec.case_id = eba.case_id AND eba.is_active = TRUE
             LEFT JOIN BED b ON eba.bed_id = b.bed_id
             LEFT JOIN WARD w ON b.ward_id = w.ward_id
             LEFT JOIN DEPARTMENT dep ON ec.department_id = dep.department_id
             LEFT JOIN AMBULANCE amb ON ec.ambulance_id = amb.ambulance_id
             WHERE ec.case_id = ?`,
            [req.params.id]
        );

        if (!caseRow) {
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        const [triageHistory] = await mysqlPool.query(
            `SELECT ta.*, un.name AS nurse_name
             FROM TRIAGE_ASSESSMENT ta
             LEFT JOIN \`USER\` un ON ta.nurse_id = un.user_id
             WHERE ta.case_id = ?
             ORDER BY ta.assessed_at DESC`,
            [req.params.id]
        );

        const [treatments] = await mysqlPool.query(
            `SELECT etl.*, u.name AS doctor_name
             FROM EMERGENCY_TREATMENT_LOG etl
             LEFT JOIN \`USER\` u ON etl.doctor_id = u.user_id
             WHERE etl.case_id = ?
             ORDER BY etl.performed_at DESC`,
            [req.params.id]
        );

        const [vitals] = await mysqlPool.query(
            `SELECT pv.*, u.name AS recorded_by_name
             FROM PATIENT_VITALS pv
             LEFT JOIN \`USER\` u ON pv.recorded_by = u.user_id
             WHERE pv.case_id = ?
             ORDER BY pv.recorded_at DESC`,
            [req.params.id]
        );

        const [bloodRequests] = await mysqlPool.query(
            `SELECT br.*, u.name AS requested_by_name
             FROM BLOOD_REQUEST br
             LEFT JOIN \`USER\` u ON br.requested_by = u.user_id
             WHERE br.case_id = ?
             ORDER BY br.created_at DESC`,
            [req.params.id]
        );

        const [priorityLogs] = await mysqlPool.query(
            `SELECT epl.*, u.name AS changed_by_name
             FROM EMERGENCY_PRIORITY_LOG epl
             LEFT JOIN \`USER\` u ON epl.changed_by = u.user_id
             WHERE epl.case_id = ?
             ORDER BY epl.changed_at DESC`,
            [req.params.id]
        );

        const [doctorAssignments] = await mysqlPool.query(
            `SELECT eda.*, u.name AS doctor_name
             FROM EMERGENCY_DOCTOR_ASSIGNMENT eda
             JOIN \`USER\` u ON eda.doctor_id = u.user_id
             WHERE eda.case_id = ?
             ORDER BY eda.assigned_at DESC`,
            [req.params.id]
        );

        const [bedAssignments] = await mysqlPool.query(
            `SELECT eba.*, b.bed_number, w.ward_name
             FROM EMERGENCY_BED_ASSIGNMENT eba
             JOIN BED b ON eba.bed_id = b.bed_id
             JOIN WARD w ON b.ward_id = w.ward_id
             WHERE eba.case_id = ?
             ORDER BY eba.assigned_at DESC`,
            [req.params.id]
        );

        res.json({
            case: caseRow,
            triage_history: triageHistory,
            treatments,
            vitals,
            blood_requests: bloodRequests,
            priority_logs: priorityLogs,
            doctor_assignments: doctorAssignments,
            bed_assignments: bedAssignments
        });
    } catch (err) {
        console.error('Case detail error:', err);
        res.status(500).json({ error: 'Failed to load case details' });
    }
});

// -----------------------------------------------------------------------------
// 5. Triage Assessment (Admin, Doctor, Nurse)
// -----------------------------------------------------------------------------
router.post('/triage/:id', requireRole('Admin', 'Doctor', 'Nurse'), async (req, res) => {
    const {
        bp_systolic,
        bp_diastolic,
        heart_rate,
        spo2,
        temperature,
        respiratory_rate,
        consciousness_level = 'Alert',
        gcs_score,
        priority,
        priority_reason,
        symptoms,
        injury_details,
        assessment_notes
    } = req.body;

    if (!['P1', 'P2', 'P3', 'P4'].includes(priority)) {
        return res.status(400).json({ error: 'Valid triage priority (P1, P2, P3, P4) is required' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[ec]] = await conn.query('SELECT patient_id, emg_number FROM EMERGENCY_CASE WHERE case_id = ? FOR UPDATE', [req.params.id]);
        if (!ec) {
            await conn.rollback();
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        await conn.query(
            `INSERT INTO TRIAGE_ASSESSMENT (
                case_id, nurse_id, bp_systolic, bp_diastolic, heart_rate, spo2,
                temperature, respiratory_rate, consciousness_level, gcs_score,
                priority, priority_reason, symptoms, injury_details, assessment_notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.params.id,
                req.session.user.id,
                bp_systolic ? Number(bp_systolic) : null,
                bp_diastolic ? Number(bp_diastolic) : null,
                heart_rate ? Number(heart_rate) : null,
                spo2 ? Number(spo2) : null,
                temperature ? Number(temperature) : null,
                respiratory_rate ? Number(respiratory_rate) : null,
                consciousness_level,
                gcs_score ? Number(gcs_score) : null,
                priority,
                priority_reason || null,
                symptoms || null,
                injury_details || null,
                assessment_notes || null
            ]
        );

        await conn.query(
            `UPDATE EMERGENCY_CASE 
             SET triage_priority = ?, 
                 status = CASE WHEN status = 'Waiting' THEN 'Triage' ELSE status END
             WHERE case_id = ?`,
            [priority, req.params.id]
        );

        await conn.query(
            `INSERT INTO PATIENT_VITALS (
                patient_id, case_id, recorded_by, bp_systolic, bp_diastolic,
                heart_rate, spo2, temperature, respiratory_rate, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                ec.patient_id,
                req.params.id,
                req.session.user.id,
                bp_systolic ? Number(bp_systolic) : null,
                bp_diastolic ? Number(bp_diastolic) : null,
                heart_rate ? Number(heart_rate) : null,
                spo2 ? Number(spo2) : null,
                temperature ? Number(temperature) : null,
                respiratory_rate ? Number(respiratory_rate) : null,
                `Triage vitals recorded: Priority ${priority}`
            ]
        );

        await conn.commit();

        if (priority === 'P1') {
            await sendNotification({
                role_name: 'Doctor',
                message: `CRITICAL ALERT: Case ${ec.emg_number} classified as P1 Critical! SpO2: ${spo2 || '--'}%, HR: ${heart_rate || '--'}, BP: ${bp_systolic || '--'}/${bp_diastolic || '--'}`,
                event_type: 'p1_triage'
            });
        }

        res.status(201).json({ message: 'Triage assessment recorded successfully', priority });
    } catch (err) {
        await conn.rollback();
        console.error('Triage save error:', err);
        res.status(500).json({ error: 'Failed to record triage assessment' });
    } finally {
        conn.release();
    }
});

// -----------------------------------------------------------------------------
// 6. Manual Priority Change with Mandatory Reason (Admin, Doctor, Nurse)
// -----------------------------------------------------------------------------
router.patch('/priority/:id', requireRole('Admin', 'Doctor', 'Nurse'), async (req, res) => {
    const { new_priority, reason } = req.body;

    if (!['P1', 'P2', 'P3', 'P4'].includes(new_priority)) {
        return res.status(400).json({ error: 'Invalid priority. Choose P1, P2, P3, or P4' });
    }
    if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'A documented medical or operational reason is mandatory when changing priority' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[existing]] = await conn.query('SELECT triage_priority, emg_number FROM EMERGENCY_CASE WHERE case_id = ? FOR UPDATE', [req.params.id]);
        if (!existing) {
            await conn.rollback();
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        const oldPriority = existing.triage_priority;

        await conn.query(
            'INSERT INTO EMERGENCY_PRIORITY_LOG (case_id, old_priority, new_priority, changed_by, reason) VALUES (?, ?, ?, ?, ?)',
            [req.params.id, oldPriority, new_priority, req.session.user.id, reason.trim()]
        );

        await conn.query(
            'UPDATE EMERGENCY_CASE SET triage_priority = ? WHERE case_id = ?',
            [new_priority, req.params.id]
        );

        await conn.commit();

        await sendNotification({
            role_name: 'Doctor',
            message: `Priority reassessment for ${existing.emg_number}: Changed from ${oldPriority} to ${new_priority}. Reason: ${reason.trim()}`,
            event_type: 'priority_change'
        });

        res.json({ message: `Priority successfully updated to ${new_priority}` });
    } catch (err) {
        await conn.rollback();
        console.error('Priority update error:', err);
        res.status(500).json({ error: 'Failed to update priority' });
    } finally {
        conn.release();
    }
});

// -----------------------------------------------------------------------------
// 7. Signature Feature: Emergency Priority Engine (Admin, Doctor, Nurse)
//    - Looks up department IDs by name from DEPARTMENT (no hardcoded numbers)
//    - Excludes off-shift doctors and on-leave doctors
// -----------------------------------------------------------------------------
router.get('/priority-engine/:id', requireRole('Admin', 'Doctor', 'Nurse'), async (req, res) => {
    try {
        const [[ec]] = await mysqlPool.query(
            `SELECT 
                ec.*,
                COALESCE(u.name, ec.temp_patient_name, 'Unidentified Patient') AS patient_name,
                COALESCE(p.gender, ec.temp_patient_gender, '--') AS gender,
                COALESCE(TIMESTAMPDIFF(YEAR, p.dob, CURDATE()), ec.temp_patient_age, 35) AS age,
                TIMESTAMPDIFF(MINUTE, ec.arrival_time, NOW()) AS waiting_minutes
             FROM EMERGENCY_CASE ec
             LEFT JOIN PATIENT p ON ec.patient_id = p.patient_id
             LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
             WHERE ec.case_id = ?`,
            [req.params.id]
        );

        if (!ec) {
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        const [[latestTriage]] = await mysqlPool.query(
            'SELECT * FROM TRIAGE_ASSESSMENT WHERE case_id = ? ORDER BY assessed_at DESC LIMIT 1',
            [req.params.id]
        );

        const currentPriority = (latestTriage && latestTriage.priority) || ec.triage_priority || 'P3';
        const waitMinutes = ec.waiting_minutes || 0;
        const priorityScore = computePriorityScore(currentPriority, waitMinutes);

        const complaint = (ec.initial_complaint || '').toLowerCase();
        const symptoms = ((latestTriage && latestTriage.symptoms) || '').toLowerCase();
        const combinedText = complaint + ' ' + symptoms;

        let targetDeptName = 'Emergency Medicine';
        let deptReason = 'Primary acute emergency evaluation and stabilization';

        if (combinedText.includes('chest') || combinedText.includes('heart') || combinedText.includes('cardiac') || combinedText.includes('ecg') || combinedText.includes('infarct') || combinedText.includes('st-elevation')) {
            targetDeptName = 'Cardiology';
            deptReason = 'Acute coronary / cardiac symptom presentation requiring cardiologist expertise';
        } else if (combinedText.includes('fracture') || combinedText.includes('bone') || combinedText.includes('fall') || combinedText.includes('dislocat') || combinedText.includes('tibial') || combinedText.includes('trauma')) {
            targetDeptName = 'Orthopedics';
            deptReason = 'Musculoskeletal trauma / suspected fracture requiring orthopedic surgical evaluation';
        } else if (Number(ec.age) < 14) {
            targetDeptName = 'Pediatrics';
            deptReason = 'Pediatric age patient requiring specialized pediatric resuscitation and care';
        } else if (combinedText.includes('fever') || combinedText.includes('infect') || combinedText.includes('weakness') || combinedText.includes('dehydrat')) {
            targetDeptName = 'General Medicine';
            deptReason = 'Infectious / febrile presentation suitable for internal and general medicine';
        }

        // Look up department_id dynamically by department_name
        const deptInfo = await resolveDepartmentByName(mysqlPool, targetDeptName);
        const targetDeptId = deptInfo.department_id;
        targetDeptName = deptInfo.department_name;

        // Fetch ONLY doctors who are currently on an active shift (on duty today and within shift hours)
        // AND not on approved leave today.
        const [doctors] = await mysqlPool.query(
            `SELECT 
                d.doctor_id,
                u.name,
                u.email,
                d.specialization,
                d.department_id,
                dept.department_name,
                ds.shift_type,
                ds.start_time,
                ds.end_time,
                (SELECT COUNT(*)
                 FROM EMERGENCY_DOCTOR_ASSIGNMENT eda
                 JOIN EMERGENCY_CASE aec ON eda.case_id = aec.case_id
                 WHERE eda.doctor_id = d.doctor_id
                   AND eda.is_active = TRUE
                   AND aec.status IN ('Assigned', 'In Treatment')) AS active_emergency_cases,
                (SELECT COUNT(*)
                 FROM APPOINTMENT ap 
                 WHERE ap.doctor_id = d.doctor_id 
                   AND ap.appointment_date = CURDATE() 
                   AND ap.status IN ('Scheduled', 'Confirmed', 'Checked In')) AS today_appointments
             FROM DOCTOR d
             JOIN \`USER\` u ON d.doctor_id = u.user_id
             JOIN DEPARTMENT dept ON d.department_id = dept.department_id
             JOIN DOCTOR_SHIFT ds
               ON d.doctor_id = ds.doctor_id
              AND ds.shift_date = CURDATE()
              AND ds.is_on_duty = TRUE
              AND (
                (ds.start_time <= ds.end_time AND CURTIME() BETWEEN ds.start_time AND ds.end_time)
                OR (ds.start_time > ds.end_time AND (CURTIME() >= ds.start_time OR CURTIME() <= ds.end_time))
              )
             WHERE u.is_active = TRUE
               AND NOT EXISTS (
                   SELECT 1 FROM DOCTOR_LEAVE dl 
                   WHERE dl.doctor_id = d.doctor_id 
                     AND dl.status = 'Approved' 
                     AND CURDATE() BETWEEN dl.start_date AND dl.end_date
               )`
        );

        // Score eligible on-shift, non-leave doctors
        const scoredDoctors = doctors.map(doc => {
            let docScore = 140;
            const reasons = [`On duty (${doc.shift_type} shift ${doc.start_time}–${doc.end_time})`];

            if (doc.department_id === targetDeptId) {
                docScore += 50;
                reasons.push(`Direct specialty match (${doc.specialization})`);
            } else if (doc.department_name === 'General Medicine' || doc.department_name === 'Emergency Medicine') {
                docScore += 20;
                reasons.push('General / Emergency coverage capability');
            }

            const load = (Number(doc.active_emergency_cases) * 15) + (Number(doc.today_appointments) * 5);
            docScore -= load;
            reasons.push(`Current workload: ${doc.active_emergency_cases} emergency cases, ${doc.today_appointments} appointments`);

            return {
                ...doc,
                match_score: docScore,
                reasoning: reasons.join('; ')
            };
        });

        scoredDoctors.sort((a, b) => b.match_score - a.match_score);

        const recommendedDoctor = scoredDoctors[0] || null;

        // Bed Recommendation (normalized via BED + WARD)
        const isCriticalICU = currentPriority === 'P1' && (
            (latestTriage && latestTriage.spo2 && latestTriage.spo2 < 90) ||
            (latestTriage && latestTriage.gcs_score && latestTriage.gcs_score <= 8)
        );

        let bedQuery = `SELECT b.bed_id, b.ward_id, w.ward_name, b.bed_number, b.status
                        FROM BED b
                        JOIN WARD w ON b.ward_id = w.ward_id
                        WHERE b.status = 'Available' `;
        if (isCriticalICU) {
            bedQuery += "ORDER BY CASE WHEN w.ward_name = 'ICU' THEN 0 ELSE 1 END, b.bed_number";
        } else {
            bedQuery += "ORDER BY CASE WHEN w.ward_name = 'Emergency Ward' THEN 0 WHEN w.ward_name = 'ICU' THEN 2 ELSE 1 END, b.bed_number";
        }

        const [availableBeds] = await mysqlPool.query(bedQuery);

        let recommendedBed = null;
        let bedReason = '';

        if (availableBeds.length > 0) {
            recommendedBed = availableBeds[0];
            if (isCriticalICU && recommendedBed.ward_name === 'ICU') {
                bedReason = 'High-acuity ICU monitoring bed recommended due to severe desaturation/low GCS';
            } else {
                bedReason = `Available bed in ${recommendedBed.ward_name} suitable for acute management`;
            }
        } else {
            bedReason = 'All Emergency Ward beds currently occupied. Hospital surge protocol recommended.';
        }

        res.json({
            case_id: ec.case_id,
            emg_number: ec.emg_number,
            patient_name: ec.patient_name,
            current_priority: currentPriority,
            waiting_minutes: waitMinutes,
            calculated_priority_score: priorityScore,
            recommended_department: {
                id: targetDeptId,
                name: targetDeptName,
                reason: deptReason
            },
            recommended_doctor: recommendedDoctor ? {
                doctor_id: recommendedDoctor.doctor_id,
                name: recommendedDoctor.name,
                specialization: recommendedDoctor.specialization,
                department_name: recommendedDoctor.department_name,
                shift_type: recommendedDoctor.shift_type,
                active_workload: recommendedDoctor.active_emergency_cases,
                match_score: recommendedDoctor.match_score,
                reason: recommendedDoctor.reasoning
            } : null,
            alternative_doctors: scoredDoctors.slice(1, 4),
            recommended_bed: recommendedBed ? {
                bed_id: recommendedBed.bed_id,
                bed_number: recommendedBed.bed_number,
                ward_name: recommendedBed.ward_name,
                reason: bedReason
            } : null,
            alternative_beds: availableBeds.slice(1, 5),
            clinical_notice: 'The MediCare Priority Engine provides decision support based on triage severity, resource availability, and clinical workload. Medical staff authorization is required for final allocation.'
        });
    } catch (err) {
        console.error('Priority engine error:', err);
        res.status(500).json({ error: 'Failed to execute priority engine' });
    }
});

// -----------------------------------------------------------------------------
// 8. Confirm Doctor & Bed Allocation (Admin, Doctor, Nurse)
//    - Transactional with SELECT ... FOR UPDATE
//    - Requires target bed status === 'Available'
//    - Records history in EMERGENCY_DOCTOR_ASSIGNMENT & EMERGENCY_BED_ASSIGNMENT
// -----------------------------------------------------------------------------
router.post('/allocate/:id', requireRole('Admin', 'Doctor', 'Nurse'), async (req, res) => {
    const { doctor_id, bed_id, department_id, override_reason } = req.body;

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[ec]] = await conn.query('SELECT * FROM EMERGENCY_CASE WHERE case_id = ? FOR UPDATE', [req.params.id]);
        if (!ec) {
            await conn.rollback();
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        // Check existing active assignments
        const [[currentDocAssign]] = await conn.query(
            'SELECT * FROM EMERGENCY_DOCTOR_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE',
            [req.params.id]
        );
        const [[currentBedAssign]] = await conn.query(
            'SELECT * FROM EMERGENCY_BED_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE',
            [req.params.id]
        );

        let bedNumber = '';
        if (bed_id) {
            const [[targetBed]] = await conn.query(
                `SELECT b.*, w.ward_name
                 FROM BED b JOIN WARD w ON b.ward_id = w.ward_id
                 WHERE b.bed_id = ? FOR UPDATE`,
                [bed_id]
            );
            if (!targetBed) {
                await conn.rollback();
                return res.status(404).json({ error: 'Selected bed does not exist' });
            }

            const sameBedAsCurrent = currentBedAssign && Number(currentBedAssign.bed_id) === Number(bed_id);
            if (!sameBedAsCurrent && targetBed.status !== 'Available') {
                await conn.rollback();
                return res.status(409).json({
                    error: `Bed ${targetBed.bed_number} is not available (current status: ${targetBed.status})`
                });
            }

            bedNumber = targetBed.bed_number;

            if (!sameBedAsCurrent) {
                // Release previous bed if assigned
                if (currentBedAssign) {
                    await conn.query("UPDATE BED SET status = 'Cleaning' WHERE bed_id = ?", [currentBedAssign.bed_id]);
                    await conn.query(
                        'UPDATE EMERGENCY_BED_ASSIGNMENT SET is_active = FALSE, released_at = NOW() WHERE assignment_id = ?',
                        [currentBedAssign.assignment_id]
                    );
                }
                // Occupy new bed and insert active assignment row
                await conn.query("UPDATE BED SET status = 'Occupied' WHERE bed_id = ?", [bed_id]);
                await conn.query(
                    'INSERT INTO EMERGENCY_BED_ASSIGNMENT (case_id, bed_id, assigned_by, is_active) VALUES (?, ?, ?, TRUE)',
                    [req.params.id, Number(bed_id), req.session.user.id]
                );
            }
        }

        if (doctor_id) {
            const [[docExists]] = await conn.query('SELECT doctor_id FROM DOCTOR WHERE doctor_id = ?', [doctor_id]);
            if (!docExists) {
                await conn.rollback();
                return res.status(404).json({ error: 'Selected doctor does not exist' });
            }
            const sameDocAsCurrent = currentDocAssign && Number(currentDocAssign.doctor_id) === Number(doctor_id);
            if (!sameDocAsCurrent) {
                if (currentDocAssign) {
                    await conn.query(
                        'UPDATE EMERGENCY_DOCTOR_ASSIGNMENT SET is_active = FALSE, unassigned_at = NOW() WHERE assignment_id = ?',
                        [currentDocAssign.assignment_id]
                    );
                }
                await conn.query(
                    'INSERT INTO EMERGENCY_DOCTOR_ASSIGNMENT (case_id, doctor_id, assigned_by, override_reason, is_active) VALUES (?, ?, ?, ?, TRUE)',
                    [req.params.id, Number(doctor_id), req.session.user.id, override_reason || null]
                );
            }
        }

        // Update emergency case status and department
        await conn.query(
            `UPDATE EMERGENCY_CASE 
             SET department_id = COALESCE(?, department_id),
                 status = CASE WHEN status IN ('Waiting', 'Triage') THEN 'Assigned' ELSE status END
             WHERE case_id = ?`,
            [department_id ? Number(department_id) : null, req.params.id]
        );

        const finalDocId = doctor_id || (currentDocAssign && currentDocAssign.doctor_id) || 'Unchanged';
        let logDesc = `Allocation confirmed: Doctor ID ${finalDocId}, Bed ${bedNumber || 'Not changed'}.`;
        if (override_reason) {
            logDesc += ` [Manual Override Reason: ${override_reason}]`;
        }
        await conn.query(
            'INSERT INTO EMERGENCY_TREATMENT_LOG (case_id, doctor_id, action_type, description) VALUES (?, ?, ?, ?)',
            [req.params.id, req.session.user.id, 'Allocation', logDesc]
        );

        await conn.commit();

        if (doctor_id) {
            await sendNotification({
                user_id: Number(doctor_id),
                message: `New emergency case assigned to you: ${ec.emg_number}${bedNumber ? ' in Bed ' + bedNumber : ''}. Priority: ${ec.triage_priority}`,
                event_type: 'doctor_assigned'
            });
        }

        res.json({ message: 'Doctor and bed allocated successfully' });
    } catch (err) {
        await conn.rollback();
        console.error('Allocation error:', err);
        res.status(500).json({ error: 'Failed to allocate resources: ' + err.message });
    } finally {
        conn.release();
    }
});

// -----------------------------------------------------------------------------
// 9. Record Emergency Treatment Actions / Clinical Notes (Admin, Doctor)
//    - Enforces ownership if case is assigned to a specific doctor
// -----------------------------------------------------------------------------
router.post('/treatment/:id', requireRole('Admin', 'Doctor'), async (req, res) => {
    const { action_type = 'Observation', description, notes } = req.body;

    if (!description || !description.trim()) {
        return res.status(400).json({ error: 'Action description is required' });
    }

    try {
        const [[ec]] = await mysqlPool.query('SELECT case_id FROM EMERGENCY_CASE WHERE case_id = ?', [req.params.id]);
        if (!ec) return res.status(404).json({ error: 'Emergency case not found' });

        if (req.session.user.role === 'Doctor') {
            const [[activeDoc]] = await mysqlPool.query(
                'SELECT doctor_id FROM EMERGENCY_DOCTOR_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE LIMIT 1',
                [req.params.id]
            );
            if (activeDoc && Number(activeDoc.doctor_id) !== Number(req.session.user.id)) {
                return res.status(403).json({ error: 'Access denied: this emergency case is assigned to another doctor' });
            }
        }

        await mysqlPool.query(
            'INSERT INTO EMERGENCY_TREATMENT_LOG (case_id, doctor_id, action_type, description) VALUES (?, ?, ?, ?)',
            [req.params.id, req.session.user.id, action_type, description.trim()]
        );

        if (notes && notes.trim()) {
            await mysqlPool.query(
                `UPDATE EMERGENCY_CASE 
                 SET treatment_notes = CONCAT(COALESCE(treatment_notes, ''), '\n[', NOW(), ' ', ? ,']: ', ?),
                     status = 'In Treatment'
                 WHERE case_id = ?`,
                [req.session.user.name, notes.trim(), req.params.id]
            );
        } else {
            await mysqlPool.query(
                "UPDATE EMERGENCY_CASE SET status = 'In Treatment' WHERE case_id = ? AND status = 'Assigned'",
                [req.params.id]
            );
        }

        res.status(201).json({ message: 'Treatment recorded successfully' });
    } catch (err) {
        console.error('Treatment recording error:', err);
        res.status(500).json({ error: 'Failed to record treatment' });
    }
});

// -----------------------------------------------------------------------------
// 10. Inpatient Admission from Emergency (Admin, Doctor)
//     - Fixes PATIENT columns (dob, gender, blood_group, address, emergency_contact)
//     - Requires target bed status === 'Available' in a transaction
// -----------------------------------------------------------------------------
router.post('/admit/:id', requireRole('Admin', 'Doctor'), async (req, res) => {
    let { ward_name, bed_id, admitting_doctor_id, admission_notes } = req.body;

    if (!bed_id) {
        return res.status(400).json({ error: 'Inpatient bed selection is required' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[ec]] = await conn.query('SELECT * FROM EMERGENCY_CASE WHERE case_id = ? FOR UPDATE', [req.params.id]);
        if (!ec) {
            await conn.rollback();
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        const [[currentDocAssign]] = await conn.query(
            'SELECT * FROM EMERGENCY_DOCTOR_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE',
            [req.params.id]
        );
        if (req.session.user.role === 'Doctor' && currentDocAssign && Number(currentDocAssign.doctor_id) !== Number(req.session.user.id)) {
            await conn.rollback();
            return res.status(403).json({ error: 'Access denied: this emergency case is assigned to another doctor' });
        }

        const [[currentBedAssign]] = await conn.query(
            'SELECT * FROM EMERGENCY_BED_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE',
            [req.params.id]
        );

        // Lock target bed and verify availability
        const [[targetBed]] = await conn.query(
            `SELECT b.*, w.ward_name
             FROM BED b JOIN WARD w ON b.ward_id = w.ward_id
             WHERE b.bed_id = ? FOR UPDATE`,
            [bed_id]
        );
        if (!targetBed) {
            await conn.rollback();
            return res.status(404).json({ error: 'Selected inpatient bed does not exist' });
        }
        const sameBed = currentBedAssign && Number(currentBedAssign.bed_id) === Number(bed_id);
        if (!sameBed && targetBed.status !== 'Available') {
            await conn.rollback();
            return res.status(409).json({
                error: `Selected bed ${targetBed.bed_number} is not available (status: ${targetBed.status})`
            });
        }
        ward_name = targetBed.ward_name;

        let patientId = ec.patient_id;
        if (!patientId) {
            const patientName = ec.temp_patient_name || ('Emergency Patient ' + ec.emg_number);
            const tempHash = await bcrypt.hash('emg_temp_' + Date.now(), 10);
            const [uRes] = await conn.query(
                "INSERT INTO `USER` (name, email, password_hash, phone, role_id) VALUES (?, ?, ?, ?, (SELECT role_id FROM ROLE WHERE role_name='Patient'))",
                [patientName, 'emg_' + Date.now() + '@medicare.in', tempHash, ec.contact_phone || '9999999999']
            );
            patientId = uRes.insertId;
            const genderChar = ['M', 'F', 'O'].includes(ec.temp_patient_gender) ? ec.temp_patient_gender : 'O';
            await conn.query(
                `INSERT INTO PATIENT (patient_id, dob, gender, blood_group, address, emergency_contact)
                 VALUES (?, DATE_SUB(CURDATE(), INTERVAL ? YEAR), ?, NULL, 'Emergency Admission', ?)`,
                [patientId, ec.temp_patient_age || 30, genderChar, ec.emergency_contact || 'None']
            );
            await conn.query('UPDATE EMERGENCY_CASE SET patient_id = ? WHERE case_id = ?', [patientId, req.params.id]);
        }

        // Determine a valid admitting_doctor_id
        let validDoctorId = admitting_doctor_id ? Number(admitting_doctor_id) : null;
        if (validDoctorId) {
            const [[docCheck]] = await conn.query('SELECT doctor_id FROM DOCTOR WHERE doctor_id = ?', [validDoctorId]);
            if (!docCheck) validDoctorId = null;
        }
        if (!validDoctorId && currentDocAssign) {
            validDoctorId = currentDocAssign.doctor_id;
        }
        if (!validDoctorId) {
            const [[firstDoc]] = await conn.query('SELECT doctor_id FROM DOCTOR LIMIT 1');
            validDoctorId = firstDoc ? firstDoc.doctor_id : null;
        }

        // Release old emergency bed if different
        if (currentBedAssign) {
            if (!sameBed) {
                await conn.query("UPDATE BED SET status = 'Cleaning' WHERE bed_id = ?", [currentBedAssign.bed_id]);
            }
            await conn.query(
                'UPDATE EMERGENCY_BED_ASSIGNMENT SET is_active = FALSE, released_at = NOW() WHERE assignment_id = ?',
                [currentBedAssign.assignment_id]
            );
        }

        // Occupy target inpatient bed
        await conn.query("UPDATE BED SET status = 'Occupied' WHERE bed_id = ?", [bed_id]);

        // Insert ADMISSION record (3NF: ward derived via bed_id -> BED.ward_id)
        const [admRes] = await conn.query(
            `INSERT INTO ADMISSION (patient_id, case_id, admitting_doctor_id, bed_id, admitted_at, status)
             VALUES (?, ?, ?, ?, NOW(), 'Admitted')`,
            [patientId, req.params.id, validDoctorId, bed_id]
        );

        // Update emergency case status
        await conn.query(
            "UPDATE EMERGENCY_CASE SET status = 'Admitted' WHERE case_id = ?",
            [req.params.id]
        );

        // Treatment log
        const logUserId = validDoctorId || (req.session.user && req.session.user.id) || 1;
        await conn.query(
            'INSERT INTO EMERGENCY_TREATMENT_LOG (case_id, doctor_id, action_type, description) VALUES (?, ?, ?, ?)',
            [req.params.id, logUserId, 'Admission', `Admitted to ${ward_name} (Bed ${targetBed.bed_number}). Notes: ${admission_notes || 'None'}`]
        );

        await conn.commit();

        await sendNotification({
            role_name: 'Nurse',
            message: `Emergency patient ${ec.emg_number} admitted to ${ward_name} (${targetBed.bed_number}).`,
            event_type: 'patient_admitted'
        });

        res.json({
            message: 'Patient admitted to inpatient ward successfully',
            admission_id: admRes.insertId,
            ward_name,
            bed_id: Number(bed_id)
        });
    } catch (err) {
        await conn.rollback();
        console.error('Admission error:', err);
        res.status(500).json({ error: 'Failed to admit patient: ' + err.message });
    } finally {
        conn.release();
    }
});

// -----------------------------------------------------------------------------
// 11. Emergency Discharge with Summary & Bed Release (Admin, Doctor)
// -----------------------------------------------------------------------------
router.post('/discharge/:id', requireRole('Admin', 'Doctor'), async (req, res) => {
    const { discharge_summary, emergency_fee = 500 } = req.body;

    if (!discharge_summary || !discharge_summary.trim()) {
        return res.status(400).json({ error: 'Discharge clinical summary is required' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[ec]] = await conn.query('SELECT * FROM EMERGENCY_CASE WHERE case_id = ? FOR UPDATE', [req.params.id]);
        if (!ec) {
            await conn.rollback();
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        const [[currentDocAssign]] = await conn.query(
            'SELECT * FROM EMERGENCY_DOCTOR_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE',
            [req.params.id]
        );
        if (req.session.user.role === 'Doctor' && currentDocAssign && Number(currentDocAssign.doctor_id) !== Number(req.session.user.id)) {
            await conn.rollback();
            return res.status(403).json({ error: 'Access denied: this emergency case is assigned to another doctor' });
        }

        // Release active emergency bed assignment to Cleaning
        const [[currentBedAssign]] = await conn.query(
            'SELECT * FROM EMERGENCY_BED_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE',
            [req.params.id]
        );
        if (currentBedAssign) {
            await conn.query("UPDATE BED SET status = 'Cleaning' WHERE bed_id = ?", [currentBedAssign.bed_id]);
            await conn.query(
                'UPDATE EMERGENCY_BED_ASSIGNMENT SET is_active = FALSE, released_at = NOW() WHERE assignment_id = ?',
                [currentBedAssign.assignment_id]
            );
        }

        // Close active doctor assignment
        if (currentDocAssign) {
            await conn.query(
                'UPDATE EMERGENCY_DOCTOR_ASSIGNMENT SET is_active = FALSE, unassigned_at = NOW() WHERE assignment_id = ?',
                [currentDocAssign.assignment_id]
            );
        }

        // Update emergency case
        await conn.query(
            `UPDATE EMERGENCY_CASE 
             SET status = 'Discharged', 
                 discharge_summary = ?, 
                 discharged_at = NOW() 
             WHERE case_id = ?`,
            [discharge_summary.trim(), req.params.id]
        );

        // Auto-generate Bill if patient is registered (3NF: BILL has no total_amount/payment_status columns)
        if (ec.patient_id) {
            const [existingBills] = await conn.query(
                `SELECT b.bill_id
                 FROM BILL b
                 JOIN vw_bill_summary vbs ON b.bill_id = vbs.bill_id
                 WHERE b.patient_id = ? AND vbs.payment_status <> 'Paid'
                 ORDER BY b.bill_date DESC LIMIT 1`,
                [ec.patient_id]
            );

            let billId;
            if (existingBills.length) {
                billId = existingBills[0].bill_id;
                await conn.query('UPDATE BILL SET case_id = COALESCE(case_id, ?) WHERE bill_id = ?', [ec.case_id, billId]);
            } else {
                const [billResult] = await conn.query(
                    'INSERT INTO BILL (patient_id, case_id, bill_date, generated_by) VALUES (?, ?, NOW(), ?)',
                    [ec.patient_id, ec.case_id, req.session.user.id]
                );
                billId = billResult.insertId;
            }

            await conn.query(
                'INSERT INTO BILL_ITEM (bill_id, item_type, description, amount) VALUES (?, ?, ?, ?)',
                [billId, 'Emergency', `Emergency Ward Care & Triage (${ec.emg_number})`, Number(emergency_fee) || 500.00]
            );
        }

        // Treatment log
        await conn.query(
            'INSERT INTO EMERGENCY_TREATMENT_LOG (case_id, doctor_id, action_type, description) VALUES (?, ?, ?, ?)',
            [req.params.id, req.session.user.id, 'Discharge', `Discharged from Emergency Ward. Summary: ${discharge_summary.trim()}`]
        );

        await conn.commit();

        await sendNotification({
            role_name: 'Receptionist',
            message: `Emergency patient ${ec.emg_number} discharged. Ready for billing clearance.`,
            event_type: 'patient_discharged'
        });

        res.json({ message: 'Patient successfully discharged, bed released for cleaning' });
    } catch (err) {
        await conn.rollback();
        console.error('Discharge error:', err);
        res.status(500).json({ error: 'Failed to discharge patient: ' + err.message });
    } finally {
        conn.release();
    }
});

// -----------------------------------------------------------------------------
// 12. Supporting Rosters: Available Doctors & Beds (Admin, Doctor, Nurse, Receptionist)
// -----------------------------------------------------------------------------
router.get('/doctors', requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT 
                d.doctor_id,
                u.name,
                d.specialization,
                d.department_id,
                dept.department_name,
                COALESCE(ds.shift_type, 'Not on shift') AS shift_type,
                CASE
                    WHEN ds.shift_id IS NOT NULL
                         AND ds.is_on_duty = TRUE
                         AND (
                             (ds.start_time <= ds.end_time AND CURTIME() BETWEEN ds.start_time AND ds.end_time)
                             OR (ds.start_time > ds.end_time AND (CURTIME() >= ds.start_time OR CURTIME() <= ds.end_time))
                         )
                         AND NOT EXISTS (
                             SELECT 1 FROM DOCTOR_LEAVE dl
                             WHERE dl.doctor_id = d.doctor_id
                               AND dl.status = 'Approved'
                               AND CURDATE() BETWEEN dl.start_date AND dl.end_date
                         )
                    THEN TRUE
                    ELSE FALSE
                END AS is_on_duty,
                (SELECT COUNT(*)
                 FROM EMERGENCY_DOCTOR_ASSIGNMENT eda
                 JOIN EMERGENCY_CASE ec ON eda.case_id = ec.case_id
                 WHERE eda.doctor_id = d.doctor_id
                   AND eda.is_active = TRUE
                   AND ec.status IN ('Assigned', 'In Treatment')) AS active_cases
             FROM DOCTOR d
             JOIN \`USER\` u ON d.doctor_id = u.user_id
             JOIN DEPARTMENT dept ON d.department_id = dept.department_id
             LEFT JOIN DOCTOR_SHIFT ds ON d.doctor_id = ds.doctor_id AND ds.shift_date = CURDATE()
             WHERE u.is_active = TRUE
             ORDER BY is_on_duty DESC, active_cases ASC, u.name ASC`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load doctors' });
    }
});

router.get('/beds', requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT v.bed_id, v.ward_name, v.bed_number, v.status, v.patient_id,
                    u.name AS patient_name,
                    v.emg_number
             FROM vw_bed_details v
             LEFT JOIN PATIENT p ON v.patient_id = p.patient_id
             LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
             ORDER BY 
                CASE WHEN v.ward_name = 'Emergency Ward' THEN 1 
                     WHEN v.ward_name = 'ICU' THEN 2 
                     WHEN v.ward_name = 'General Ward' THEN 3
                     ELSE 4 END,
                v.bed_number`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load beds' });
    }
});

module.exports = router;
