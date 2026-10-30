const express = require('express');
const router = express.Router();
const { mysqlPool, getMongo } = require('../config/db');
const { requireRole, requireAuth } = require('../middleware/auth');
const { sendNotification } = require('../services/notificationService');

// Allow Admin, Doctor, Nurse, Receptionist access to Emergency routes
router.use(requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist'));

// Helper: Calculate dynamic emergency priority score
function computePriorityScore(priority, waitMinutes) {
    const baseScores = { 'P1': 1000, 'P2': 500, 'P3': 200, 'P4': 50 };
    const waitMultipliers = { 'P1': 10, 'P2': 5, 'P3': 2, 'P4': 1 };
    const base = baseScores[priority] || 100;
    const mult = waitMultipliers[priority] || 1;
    return base + (Math.max(0, waitMinutes) * mult);
}

// -----------------------------------------------------------------------------
// 1. Emergency Dashboard KPIs
// -----------------------------------------------------------------------------
router.get('/dashboard', async (req, res) => {
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
            "SELECT COUNT(*) AS total FROM BED WHERE ward_name IN ('Emergency Ward', 'ICU') AND status = 'Available'"
        );
        const [[occupiedEmgBeds]] = await mysqlPool.query(
            "SELECT COUNT(*) AS total FROM BED WHERE ward_name = 'Emergency Ward' AND status = 'Occupied'"
        );
        const [[availDoctors]] = await mysqlPool.query(
            `SELECT COUNT(DISTINCT d.doctor_id) AS total FROM DOCTOR d
             JOIN DOCTOR_SHIFT ds ON d.doctor_id = ds.doctor_id
             WHERE ds.shift_date = CURDATE() AND ds.is_on_duty = TRUE`
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
// 2. Emergency Queue (Priority-ordered)
// -----------------------------------------------------------------------------
router.get('/queue', async (req, res) => {
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
                ec.assigned_doctor_id,
                ud.name AS assigned_doctor_name,
                doc.specialization AS doctor_specialization,
                ec.assigned_bed_id,
                b.bed_number,
                b.ward_name,
                ec.department_id,
                dep.department_name,
                amb.vehicle_number AS ambulance_number,
                (SELECT COUNT(*) FROM TRIAGE_ASSESSMENT ta WHERE ta.case_id = ec.case_id) AS triage_count,
                (SELECT ta.assessed_at FROM TRIAGE_ASSESSMENT ta WHERE ta.case_id = ec.case_id ORDER BY ta.assessed_at DESC LIMIT 1) AS last_triage_time
            FROM EMERGENCY_CASE ec
            LEFT JOIN PATIENT p ON ec.patient_id = p.patient_id
            LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
            LEFT JOIN DOCTOR doc ON ec.assigned_doctor_id = doc.doctor_id
            LEFT JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
            LEFT JOIN BED b ON ec.assigned_bed_id = b.bed_id
            LEFT JOIN DEPARTMENT dep ON ec.department_id = dep.department_id
            LEFT JOIN AMBULANCE amb ON ec.ambulance_id = amb.ambulance_id
            WHERE ec.status NOT IN ('Discharged', 'Transferred')
            ORDER BY ec.arrival_time ASC
        `;

        const [rows] = await mysqlPool.query(query);

        // Compute dynamic priority scores and sort
        const casesWithScores = rows.map(item => {
            const score = computePriorityScore(item.triage_priority, item.waiting_minutes);
            return {
                ...item,
                priority_score: score
            };
        });

        // Priority Sort: P1 > P2 > P3 > P4, then highest score/longest wait
        casesWithScores.sort((a, b) => b.priority_score - a.priority_score);

        // Assign queue position numbers
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
// 3. Register Emergency Patient (Supports both registered & temporary/unconscious)
// -----------------------------------------------------------------------------
router.post('/register', async (req, res) => {
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

        // Generate next Emergency ID: EMG-YYYY-XXX
        const currentYear = new Date().getFullYear();
        const [[countRow]] = await conn.query(
            "SELECT COUNT(*) AS total FROM EMERGENCY_CASE WHERE YEAR(arrival_time) = ?",
            [currentYear]
        );
        const sequence = String((countRow.total || 0) + 1).padStart(3, '0');
        const emgNumber = `EMG-${currentYear}-${sequence}`;

        // Default initial department
        let departmentId = 6; // Emergency Medicine
        const complaintLower = initial_complaint.toLowerCase();
        if (complaintLower.includes('chest') || complaintLower.includes('heart') || complaintLower.includes('cardiac')) {
            departmentId = 1; // Cardiology
        } else if (complaintLower.includes('fracture') || complaintLower.includes('bone') || complaintLower.includes('fall')) {
            departmentId = 2; // Orthopedics
        } else if (temp_patient_age && Number(temp_patient_age) < 14) {
            departmentId = 4; // Pediatrics
        }

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
                temp_patient_gender || null,
                temp_patient_age ? Number(temp_patient_age) : null,
                contact_phone || null,
                emergency_contact || null,
                arrival_method,
                ambulance_id ? Number(ambulance_id) : null,
                initial_complaint.trim(),
                triage_priority,
                departmentId
            ]
        );

        const newCaseId = insertResult.insertId;

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
                event: 'emergency_patient_registered',
                case_id: newCaseId,
                emg_number: emgNumber,
                registered_by: req.session.user.id,
                arrival_method,
                priority: triage_priority,
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
// 4. Single Case Details
// -----------------------------------------------------------------------------
router.get('/cases/:id', async (req, res) => {
    try {
        const [[caseRow]] = await mysqlPool.query(
            `SELECT 
                ec.*,
                COALESCE(u.name, ec.temp_patient_name, 'Unidentified Patient') AS patient_name,
                COALESCE(u.email, '--') AS patient_email,
                COALESCE(u.phone, ec.contact_phone, '--') AS phone,
                COALESCE(p.gender, ec.temp_patient_gender, '--') AS gender,
                COALESCE(p.blood_group, '--') AS blood_group,
                COALESCE(p.allergies, 'None documented') AS allergies,
                COALESCE(TIMESTAMPDIFF(YEAR, p.dob, CURDATE()), ec.temp_patient_age, '--') AS age,
                ud.name AS assigned_doctor_name,
                doc.specialization AS doctor_specialization,
                b.bed_number,
                b.ward_name,
                dep.department_name,
                amb.vehicle_number,
                amb.driver_name,
                TIMESTAMPDIFF(MINUTE, ec.arrival_time, NOW()) AS waiting_minutes
             FROM EMERGENCY_CASE ec
             LEFT JOIN PATIENT p ON ec.patient_id = p.patient_id
             LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
             LEFT JOIN DOCTOR doc ON ec.assigned_doctor_id = doc.doctor_id
             LEFT JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
             LEFT JOIN BED b ON ec.assigned_bed_id = b.bed_id
             LEFT JOIN DEPARTMENT dep ON ec.department_id = dep.department_id
             LEFT JOIN AMBULANCE amb ON ec.ambulance_id = amb.ambulance_id
             WHERE ec.case_id = ?`,
            [req.params.id]
        );

        if (!caseRow) {
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        // Triage history
        const [triageHistory] = await mysqlPool.query(
            `SELECT ta.*, un.name AS nurse_name
             FROM TRIAGE_ASSESSMENT ta
             LEFT JOIN \`USER\` un ON ta.nurse_id = un.user_id
             WHERE ta.case_id = ?
             ORDER BY ta.assessed_at DESC`,
            [req.params.id]
        );

        // Treatment and clinical notes
        const [treatments] = await mysqlPool.query(
            `SELECT etl.*, u.name AS doctor_name
             FROM EMERGENCY_TREATMENT_LOG etl
             LEFT JOIN \`USER\` u ON etl.doctor_id = u.user_id
             WHERE etl.case_id = ?
             ORDER BY etl.performed_at DESC`,
            [req.params.id]
        );

        // Vitals recordings
        const [vitals] = await mysqlPool.query(
            `SELECT pv.*, u.name AS recorded_by_name
             FROM PATIENT_VITALS pv
             LEFT JOIN \`USER\` u ON pv.recorded_by = u.user_id
             WHERE pv.case_id = ?
             ORDER BY pv.recorded_at DESC`,
            [req.params.id]
        );

        // Blood requests
        const [bloodRequests] = await mysqlPool.query(
            `SELECT br.*, u.name AS requested_by_name
             FROM BLOOD_REQUEST br
             LEFT JOIN \`USER\` u ON br.requested_by = u.user_id
             WHERE br.case_id = ?
             ORDER BY br.created_at DESC`,
            [req.params.id]
        );

        // Priority audit history
        const [priorityLogs] = await mysqlPool.query(
            `SELECT epl.*, u.name AS changed_by_name
             FROM EMERGENCY_PRIORITY_LOG epl
             LEFT JOIN \`USER\` u ON epl.changed_by = u.user_id
             WHERE epl.case_id = ?
             ORDER BY epl.changed_at DESC`,
            [req.params.id]
        );

        res.json({
            case: caseRow,
            triage_history: triageHistory,
            treatments,
            vitals,
            blood_requests: bloodRequests,
            priority_logs: priorityLogs
        });
    } catch (err) {
        console.error('Case detail error:', err);
        res.status(500).json({ error: 'Failed to load case details' });
    }
});

// -----------------------------------------------------------------------------
// 5. Triage Assessment (Nurses & Doctors)
// -----------------------------------------------------------------------------
router.post('/triage/:id', async (req, res) => {
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

        // Insert assessment
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

        // Update emergency case priority and status
        await conn.query(
            `UPDATE EMERGENCY_CASE 
             SET triage_priority = ?, 
                 status = CASE WHEN status = 'Waiting' THEN 'Triage' ELSE status END
             WHERE case_id = ?`,
            [priority, req.params.id]
        );

        // Also record in PATIENT_VITALS
        const [[ec]] = await conn.query('SELECT patient_id, emg_number FROM EMERGENCY_CASE WHERE case_id = ?', [req.params.id]);
        if (ec) {
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
        }

        await conn.commit();

        // Broadcast notifications
        if (priority === 'P1') {
            await sendNotification({
                role_name: 'Doctor',
                message: `CRITICAL ALERT: Case ${ec ? ec.emg_number : req.params.id} classified as P1 Critical! SpO2: ${spo2 || '--'}%, HR: ${heart_rate || '--'}, BP: ${bp_systolic || '--'}/${bp_diastolic || '--'}`,
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
// 6. Manual Priority Change with Mandatory Reason
// -----------------------------------------------------------------------------
router.patch('/priority/:id', async (req, res) => {
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

        const [[existing]] = await conn.query('SELECT triage_priority, emg_number FROM EMERGENCY_CASE WHERE case_id = ?', [req.params.id]);
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
// 7. Signature Feature: Emergency Priority Engine
// -----------------------------------------------------------------------------
router.get('/priority-engine/:id', async (req, res) => {
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

        // Get latest triage
        const [[latestTriage]] = await mysqlPool.query(
            'SELECT * FROM TRIAGE_ASSESSMENT WHERE case_id = ? ORDER BY assessed_at DESC LIMIT 1',
            [req.params.id]
        );

        const currentPriority = (latestTriage && latestTriage.priority) || ec.triage_priority || 'P3';
        const waitMinutes = ec.waiting_minutes || 0;
        const priorityScore = computePriorityScore(currentPriority, waitMinutes);

        // Determine clinical symptoms keyword cluster
        const complaint = (ec.initial_complaint || '').toLowerCase();
        const symptoms = ((latestTriage && latestTriage.symptoms) || '').toLowerCase();
        const combinedText = complaint + ' ' + symptoms;

        let targetDeptId = 6; // Emergency Medicine default
        let targetDeptName = 'Emergency Medicine';
        let deptReason = 'Primary acute emergency evaluation and stabilization';

        if (combinedText.includes('chest') || combinedText.includes('heart') || combinedText.includes('cardiac') || combinedText.includes('ecg') || combinedText.includes('infarct') || combinedText.includes('st-elevation')) {
            targetDeptId = 1;
            targetDeptName = 'Cardiology';
            deptReason = 'Acute coronary / cardiac symptom presentation requiring cardiologist expertise';
        } else if (combinedText.includes('fracture') || combinedText.includes('bone') || combinedText.includes('fall') || combinedText.includes('dislocat') || combinedText.includes('tibial') || combinedText.includes('trauma')) {
            targetDeptId = 2;
            targetDeptName = 'Orthopedics';
            deptReason = 'Musculoskeletal trauma / suspected fracture requiring orthopedic surgical evaluation';
        } else if (Number(ec.age) < 14) {
            targetDeptId = 4;
            targetDeptName = 'Pediatrics';
            deptReason = 'Pediatric age patient requiring specialized pediatric resuscitation and care';
        } else if (combinedText.includes('fever') || combinedText.includes('infect') || combinedText.includes('weakness') || combinedText.includes('dehydrat')) {
            targetDeptId = 3;
            targetDeptName = 'General Medicine';
            deptReason = 'Infectious / febrile presentation suitable for internal and general medicine';
        }

        // Fetch doctors with active shifts and calculate their real current emergency workload
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
                (SELECT COUNT(*) FROM EMERGENCY_CASE aec 
                 WHERE aec.assigned_doctor_id = d.doctor_id 
                 AND aec.status IN ('Assigned', 'In Treatment')) AS active_emergency_cases,
                (SELECT COUNT(*) FROM APPOINTMENT ap 
                 WHERE ap.doctor_id = d.doctor_id 
                 AND ap.appointment_date = CURDATE() 
                 AND ap.status IN ('Scheduled', 'Confirmed')) AS today_appointments
             FROM DOCTOR d
             JOIN \`USER\` u ON d.doctor_id = u.user_id
             JOIN DEPARTMENT dept ON d.department_id = dept.department_id
             LEFT JOIN DOCTOR_SHIFT ds ON d.doctor_id = ds.doctor_id AND ds.shift_date = CURDATE() AND ds.is_on_duty = TRUE
             WHERE u.is_active = TRUE
               AND NOT EXISTS (
                   SELECT 1 FROM DOCTOR_LEAVE dl 
                   WHERE dl.doctor_id = d.doctor_id 
                   AND dl.status = 'Approved' 
                   AND CURDATE() BETWEEN dl.start_date AND dl.end_date
               )`
        );

        // Score doctors for recommendation
        const scoredDoctors = doctors.map(doc => {
            let docScore = 100;
            const reasons = [];

            // On duty today
            if (doc.shift_type) {
                docScore += 40;
                reasons.push(`On duty (${doc.shift_type} shift)`);
            } else {
                reasons.push('Off active shift schedule');
            }

            // Department / specialization match
            if (doc.department_id === targetDeptId) {
                docScore += 50;
                reasons.push(`Direct specialty match (${doc.specialization})`);
            } else if (doc.department_name === 'General Medicine' || doc.department_name === 'Emergency Medicine') {
                docScore += 20;
                reasons.push('General / Emergency coverage capability');
            }

            // Workload penalty
            const load = (doc.active_emergency_cases * 15) + (doc.today_appointments * 5);
            docScore -= load;
            reasons.push(`Current workload: ${doc.active_emergency_cases} emergency cases, ${doc.today_appointments} appointments`);

            return {
                ...doc,
                match_score: docScore,
                reasoning: reasons.join('; ')
            };
        });

        // Sort doctors descending by score
        scoredDoctors.sort((a, b) => b.match_score - a.match_score);

        const recommendedDoctor = scoredDoctors[0] || null;

        // Bed Recommendation:
        // P1 with severe hypoxia or low GCS gets ICU bed recommendation if available, otherwise Emergency Ward bed
        const isCriticalICU = currentPriority === 'P1' && (
            (latestTriage && latestTriage.spo2 && latestTriage.spo2 < 90) ||
            (latestTriage && latestTriage.gcs_score && latestTriage.gcs_score <= 8)
        );

        let bedQuery = "SELECT * FROM BED WHERE status = 'Available' ";
        if (isCriticalICU) {
            bedQuery += "ORDER BY CASE WHEN ward_name = 'ICU' THEN 0 ELSE 1 END, bed_number";
        } else {
            bedQuery += "ORDER BY CASE WHEN ward_name = 'Emergency Ward' THEN 0 WHEN ward_name = 'ICU' THEN 2 ELSE 1 END, bed_number";
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
                shift_type: recommendedDoctor.shift_type || 'On Call',
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
// 8. Confirm Doctor & Bed Allocation
// -----------------------------------------------------------------------------
router.post('/allocate/:id', async (req, res) => {
    const { doctor_id, bed_id, department_id, override_reason } = req.body;

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[ec]] = await conn.query('SELECT * FROM EMERGENCY_CASE WHERE case_id = ?', [req.params.id]);
        if (!ec) {
            await conn.rollback();
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        // If previously assigned to a different bed, release old bed
        if (ec.assigned_bed_id && bed_id && ec.assigned_bed_id !== Number(bed_id)) {
            await conn.query("UPDATE BED SET status='Cleaning', patient_id=NULL WHERE bed_id=?", [ec.assigned_bed_id]);
        }

        // Reserve new bed
        let bedNumber = '';
        if (bed_id) {
            const [[targetBed]] = await conn.query('SELECT * FROM BED WHERE bed_id = ? FOR UPDATE', [bed_id]);
            if (!targetBed) {
                await conn.rollback();
                return res.status(404).json({ error: 'Selected bed does not exist' });
            }
            if (targetBed.status === 'Occupied' && targetBed.bed_id !== ec.assigned_bed_id) {
                await conn.rollback();
                return res.status(409).json({ error: `Bed ${targetBed.bed_number} is already occupied` });
            }
            bedNumber = targetBed.bed_number;
            await conn.query("UPDATE BED SET status='Occupied', patient_id=? WHERE bed_id=?", [ec.patient_id, bed_id]);
        }

        // Update emergency case
        await conn.query(
            `UPDATE EMERGENCY_CASE 
             SET assigned_doctor_id = COALESCE(?, assigned_doctor_id),
                 assigned_bed_id = COALESCE(?, assigned_bed_id),
                 department_id = COALESCE(?, department_id),
                 status = CASE WHEN status = 'Waiting' OR status = 'Triage' THEN 'Assigned' ELSE status END
             WHERE case_id = ?`,
            [doctor_id ? Number(doctor_id) : null, bed_id ? Number(bed_id) : null, department_id ? Number(department_id) : null, req.params.id]
        );

        // Record treatment action log
        let logDesc = `Allocation confirmed: Doctor ID ${doctor_id || ec.assigned_doctor_id}, Bed ${bedNumber || 'Not changed'}.`;
        if (override_reason) {
            logDesc += ` [Manual Override Reason: ${override_reason}]`;
        }
        await conn.query(
            'INSERT INTO EMERGENCY_TREATMENT_LOG (case_id, doctor_id, action_type, description) VALUES (?, ?, ?, ?)',
            [req.params.id, req.session.user.id, 'Allocation', logDesc]
        );

        await conn.commit();

        // Notify assigned doctor
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
// 9. Record Emergency Treatment Actions / Clinical Notes
// -----------------------------------------------------------------------------
router.post('/treatment/:id', async (req, res) => {
    const { action_type = 'Observation', description, notes } = req.body;

    if (!description || !description.trim()) {
        return res.status(400).json({ error: 'Action description is required' });
    }

    try {
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
// 10. Inpatient Admission from Emergency
// -----------------------------------------------------------------------------
router.post('/admit/:id', async (req, res) => {
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

        // Auto-detect ward_name from bed if missing
        if (!ward_name) {
            const [[bInfo]] = await conn.query('SELECT ward_name FROM BED WHERE bed_id = ?', [bed_id]);
            if (bInfo) ward_name = bInfo.ward_name;
            else ward_name = 'General Ward';
        }

        let patientId = ec.patient_id;
        if (!patientId) {
            const patientName = ec.temp_patient_name || ('Emergency Patient ' + ec.emg_number);
            const [uRes] = await conn.query(
                "INSERT INTO `USER` (name, email, password_hash, role_id) VALUES (?, ?, 'temp_hash', (SELECT role_id FROM ROLE WHERE role_name='Patient'))",
                [patientName, 'emg_' + Date.now() + '@medicare.in']
            );
            patientId = uRes.insertId;
            await conn.query(
                "INSERT INTO PATIENT (patient_id, date_of_birth, gender, contact_number, emergency_contact) VALUES (?, DATE_SUB(CURDATE(), INTERVAL ? YEAR), ?, ?, ?)",
                [patientId, ec.temp_patient_age || 30, ec.temp_patient_gender || 'Other', ec.contact_phone || '9999999999', ec.emergency_contact || 'None']
            );
            await conn.query('UPDATE EMERGENCY_CASE SET patient_id = ? WHERE case_id = ?', [patientId, req.params.id]);
        }

        // Determine a valid doctor_id (must exist in DOCTOR table due to FK)
        let validDoctorId = admitting_doctor_id ? Number(admitting_doctor_id) : null;
        if (validDoctorId) {
            const [[docCheck]] = await conn.query('SELECT doctor_id FROM DOCTOR WHERE doctor_id = ?', [validDoctorId]);
            if (!docCheck) validDoctorId = null;
        }
        if (!validDoctorId && ec.assigned_doctor_id) {
            const [[docCheck]] = await conn.query('SELECT doctor_id FROM DOCTOR WHERE doctor_id = ?', [ec.assigned_doctor_id]);
            if (docCheck) validDoctorId = ec.assigned_doctor_id;
        }
        if (!validDoctorId) {
            const [[firstDoc]] = await conn.query('SELECT doctor_id FROM DOCTOR LIMIT 1');
            validDoctorId = firstDoc ? firstDoc.doctor_id : null;
        }

        // Release old emergency bed if different
        if (ec.assigned_bed_id && ec.assigned_bed_id !== Number(bed_id)) {
            await conn.query("UPDATE BED SET status='Cleaning', patient_id=NULL WHERE bed_id=?", [ec.assigned_bed_id]);
        }

        // Occupy target inpatient bed
        await conn.query("UPDATE BED SET status='Occupied', patient_id=? WHERE bed_id=?", [patientId, bed_id]);

        // Insert admission record
        await conn.query(
            `INSERT INTO ADMISSION (patient_id, case_id, admitting_doctor_id, ward_name, bed_id, admitted_at, status)
             VALUES (?, ?, ?, ?, ?, NOW(), 'Admitted')`,
            [
                patientId,
                req.params.id,
                validDoctorId,
                ward_name,
                bed_id
            ]
        );

        // Update emergency case status
        await conn.query(
            "UPDATE EMERGENCY_CASE SET status = 'Admitted', assigned_bed_id = ? WHERE case_id = ?",
            [bed_id, req.params.id]
        );

        // Treatment log
        const logUserId = validDoctorId || (req.session.user && req.session.user.id) || 1;
        await conn.query(
            'INSERT INTO EMERGENCY_TREATMENT_LOG (case_id, doctor_id, action_type, description) VALUES (?, ?, ?, ?)',
            [req.params.id, logUserId, 'Admission', `Admitted to ${ward_name} (Bed ID ${bed_id}). Notes: ${admission_notes || 'None'}`]
        );

        await conn.commit();

        await sendNotification({
            role_name: 'Nurse',
            message: `Emergency patient ${ec.emg_number} admitted to ${ward_name}.`,
            event_type: 'patient_admitted'
        });

        res.json({ message: 'Patient admitted to inpatient ward successfully' });
    } catch (err) {
        await conn.rollback();
        console.error('Admission error:', err);
        res.status(500).json({ error: 'Failed to admit patient: ' + err.message });
    } finally {
        conn.release();
    }
});

// -----------------------------------------------------------------------------
// 11. Emergency Discharge with Summary & Bed Release
// -----------------------------------------------------------------------------
router.post('/discharge/:id', async (req, res) => {
    const { discharge_summary, emergency_fee = 500 } = req.body;

    if (!discharge_summary || !discharge_summary.trim()) {
        return res.status(400).json({ error: 'Discharge clinical summary is required' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[ec]] = await conn.query('SELECT * FROM EMERGENCY_CASE WHERE case_id = ?', [req.params.id]);
        if (!ec) {
            await conn.rollback();
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        // Release bed
        if (ec.assigned_bed_id) {
            await conn.query("UPDATE BED SET status='Cleaning', patient_id=NULL WHERE bed_id=?", [ec.assigned_bed_id]);
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

        // Auto-generate Bill if patient is registered
        if (ec.patient_id) {
            // Find existing unpaid bill or create new bill
            const [existingBills] = await conn.query(
                "SELECT bill_id FROM BILL WHERE patient_id = ? AND payment_status = 'Unpaid' ORDER BY bill_date DESC LIMIT 1",
                [ec.patient_id]
            );

            let billId;
            if (existingBills.length) {
                billId = existingBills[0].bill_id;
            } else {
                const [billResult] = await conn.query(
                    'INSERT INTO BILL (patient_id, total_amount, payment_status, bill_date) VALUES (?, ?, ?, NOW())',
                    [ec.patient_id, 0.00, 'Unpaid']
                );
                billId = billResult.insertId;
            }

            // Insert emergency bill item
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
// 12. Supporting Rosters: Available Doctors & Beds
// -----------------------------------------------------------------------------
router.get('/doctors', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT 
                d.doctor_id,
                u.name,
                d.specialization,
                d.department_id,
                dept.department_name,
                COALESCE(ds.shift_type, 'Not on shift') AS shift_type,
                COALESCE(ds.is_on_duty, FALSE) AS is_on_duty,
                (SELECT COUNT(*) FROM EMERGENCY_CASE ec WHERE ec.assigned_doctor_id = d.doctor_id AND ec.status IN ('Assigned', 'In Treatment')) AS active_cases
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

router.get('/beds', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT b.bed_id, b.ward_name, b.bed_number, b.status, b.patient_id,
                    u.name AS patient_name,
                    ec.emg_number
             FROM BED b
             LEFT JOIN PATIENT p ON b.patient_id = p.patient_id
             LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
             LEFT JOIN EMERGENCY_CASE ec ON ec.assigned_bed_id = b.bed_id AND ec.status NOT IN ('Discharged', 'Transferred')
             ORDER BY 
                CASE WHEN b.ward_name = 'Emergency Ward' THEN 1 
                     WHEN b.ward_name = 'ICU' THEN 2 
                     WHEN b.ward_name = 'General Ward' THEN 3
                     ELSE 4 END,
                b.bed_number`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load beds' });
    }
});

module.exports = router;

