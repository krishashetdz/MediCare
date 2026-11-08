const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { mysqlPool, getMongo } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { sendNotification } = require('../services/notificationService');
const { validateTriagePayload } = require('../config/triageLimits');
const { recordCrossDbOperation } = require('../services/crossDbSync');

// Base router gate: only clinical & operational staff can access Emergency routes
router.use(requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist'));

// Helper: Calculate dynamic emergency priority score
// Unassessed cases do NOT receive an invented P3 score; they receive a separate pending score (120 + wait)
function computePriorityScore(priority, waitMinutes, isAssessed = true) {
    if (!isAssessed || !priority || priority === 'UNASSESSED') {
        return 120 + (Math.max(0, waitMinutes) * 2);
    }
    const baseScores = { 'P1': 1000, 'P2': 500, 'P3': 200, 'P4': 50 };
    const waitMultipliers = { 'P1': 10, 'P2': 5, 'P3': 2, 'P4': 1 };
    const base = baseScores[priority] || 100;
    const mult = waitMultipliers[priority] || 1;
    return base + (Math.max(0, waitMinutes) * mult);
}

// Helper: Resolve department_id by department_name from DEPARTMENT table.
// NEVER silently falls back to the first unrelated department!
async function resolveDepartmentByName(connOrPool, departmentName) {
    if (!departmentName || typeof departmentName !== 'string' || !departmentName.trim()) {
        return { matched: false, department_id: null, department_name: null, error: 'Department name is required' };
    }
    const cleanName = departmentName.trim();
    const [rows] = await connOrPool.query(
        'SELECT department_id, department_name FROM DEPARTMENT WHERE LOWER(department_name) = LOWER(?) LIMIT 1',
        [cleanName]
    );
    if (rows.length) {
        return { matched: true, department_id: rows[0].department_id, department_name: rows[0].department_name };
    }
    return {
        matched: false,
        department_id: null,
        department_name: cleanName,
        error: `No matching department found for '${cleanName}'. Please select a valid hospital department manually.`
    };
}

// Helper: Infer intended department name from complaint/symptoms & patient age
function inferTargetDepartment(complaintText, age, requestedDepartmentName = null) {
    if (requestedDepartmentName && String(requestedDepartmentName).trim()) {
        return {
            targetDeptName: String(requestedDepartmentName).trim(),
            deptReason: `Explicitly requested department: ${String(requestedDepartmentName).trim()}`
        };
    }
    const combined = String(complaintText || '').toLowerCase();
    if (combined.includes('chest') || combined.includes('heart') || combined.includes('cardiac') || combined.includes('ecg') || combined.includes('infarct') || combined.includes('st-elevation')) {
        return {
            targetDeptName: 'Cardiology',
            deptReason: 'Acute coronary / cardiac symptom presentation requiring cardiologist expertise'
        };
    }
    if (combined.includes('fracture') || combined.includes('bone') || combined.includes('fall') || combined.includes('dislocat') || combined.includes('tibial') || combined.includes('trauma')) {
        return {
            targetDeptName: 'Orthopedics',
            deptReason: 'Musculoskeletal trauma / suspected fracture requiring orthopedic surgical evaluation'
        };
    }
    if (age !== null && age !== undefined && age !== '--' && Number.isFinite(Number(age)) && Number(age) < 14) {
        return {
            targetDeptName: 'Pediatrics',
            deptReason: 'Pediatric age patient requiring specialized pediatric resuscitation and care'
        };
    }
    if (combined.includes('fever') || combined.includes('infect') || combined.includes('weakness') || combined.includes('dehydrat')) {
        return {
            targetDeptName: 'General Medicine',
            deptReason: 'Infectious / febrile presentation suitable for internal and general medicine'
        };
    }
    return {
        targetDeptName: 'Emergency Medicine',
        deptReason: 'Primary acute emergency evaluation and stabilization'
    };
}

// Helper: Evaluate all doctors and beds for a case (used by both GET /priority-engine/:id and POST /allocate/:id)
async function evaluateEmergencyResources(connOrPool, ec, latestTriage, requestedDeptName = null) {
    const complaint = (ec.initial_complaint || '').toLowerCase();
    const symptoms = ((latestTriage && latestTriage.symptoms) || '').toLowerCase();
    const combinedText = `${complaint} ${symptoms}`.trim();

    let { targetDeptName, deptReason } = inferTargetDepartment(combinedText, ec.age, requestedDeptName);
    let deptLookup = await resolveDepartmentByName(connOrPool, targetDeptName);

    // If an explicitly requested department was not provided and the inferred specialty department
    // does not exist, check Emergency Medicine only if Emergency Medicine itself was intended.
    // Never silently assign an unrelated department (e.g., Cardiology when Neurology was requested).
    const allDepartments = (await connOrPool.query('SELECT department_id, department_name FROM DEPARTMENT ORDER BY department_name'))[0];

    // Evaluate all doctors in the hospital so we can produce both eligible recommendations AND factual exclusion reasons
    const [allDoctors] = await connOrPool.query(
        `SELECT 
            d.doctor_id,
            u.name,
            u.email,
            u.is_active,
            d.specialization,
            d.department_id,
            dept.department_name,
            (SELECT ds.shift_type FROM DOCTOR_SHIFT ds
             WHERE ds.doctor_id = d.doctor_id
               AND ds.shift_date = CURDATE()
               AND ds.is_on_duty = TRUE
               AND (
                 (ds.start_time <= ds.end_time AND CURTIME() BETWEEN ds.start_time AND ds.end_time)
                 OR (ds.start_time > ds.end_time AND (CURTIME() >= ds.start_time OR CURTIME() <= ds.end_time))
               )
             LIMIT 1) AS active_shift_type,
            (SELECT ds.start_time FROM DOCTOR_SHIFT ds
             WHERE ds.doctor_id = d.doctor_id
               AND ds.shift_date = CURDATE()
               AND ds.is_on_duty = TRUE
               AND (
                 (ds.start_time <= ds.end_time AND CURTIME() BETWEEN ds.start_time AND ds.end_time)
                 OR (ds.start_time > ds.end_time AND (CURTIME() >= ds.start_time OR CURTIME() <= ds.end_time))
               )
             LIMIT 1) AS active_shift_start,
            (SELECT ds.end_time FROM DOCTOR_SHIFT ds
             WHERE ds.doctor_id = d.doctor_id
               AND ds.shift_date = CURDATE()
               AND ds.is_on_duty = TRUE
               AND (
                 (ds.start_time <= ds.end_time AND CURTIME() BETWEEN ds.start_time AND ds.end_time)
                 OR (ds.start_time > ds.end_time AND (CURTIME() >= ds.start_time OR CURTIME() <= ds.end_time))
               )
             LIMIT 1) AS active_shift_end,
            (SELECT dl.reason FROM DOCTOR_LEAVE dl
             WHERE dl.doctor_id = d.doctor_id
               AND dl.status = 'Approved'
               AND CURDATE() BETWEEN dl.start_date AND dl.end_date
             LIMIT 1) AS active_leave_reason,
            (SELECT COUNT(*) FROM DOCTOR_LEAVE dl
             WHERE dl.doctor_id = d.doctor_id
               AND dl.status = 'Approved'
               AND CURDATE() BETWEEN dl.start_date AND dl.end_date) AS is_on_leave,
            (SELECT COUNT(*)
             FROM EMERGENCY_DOCTOR_ASSIGNMENT eda
             JOIN EMERGENCY_CASE aec ON eda.case_id = aec.case_id
             WHERE eda.doctor_id = d.doctor_id
               AND eda.is_active = TRUE
               AND aec.case_id <> ?
               AND aec.status IN ('Assigned', 'In Treatment')) AS active_emergency_cases,
            (SELECT COUNT(*)
             FROM EMERGENCY_DOCTOR_ASSIGNMENT eda
             JOIN EMERGENCY_CASE aec ON eda.case_id = aec.case_id
             WHERE eda.doctor_id = d.doctor_id
               AND eda.is_active = TRUE
               AND aec.case_id <> ?
               AND aec.triage_priority = 'P1'
               AND aec.status = 'In Treatment') AS active_p1_cases,
            (SELECT COUNT(*)
             FROM APPOINTMENT ap 
             WHERE ap.doctor_id = d.doctor_id 
               AND ap.appointment_date = CURDATE() 
               AND ap.status IN ('Scheduled', 'Confirmed', 'Checked In')) AS today_appointments
         FROM DOCTOR d
         JOIN \`USER\` u ON d.doctor_id = u.user_id
         JOIN DEPARTMENT dept ON d.department_id = dept.department_id
         ORDER BY d.doctor_id ASC`,
        [ec.case_id, ec.case_id]
    );

    const eligibleDoctors = [];
    const excludedDoctors = [];
    const maxEmergencyWorkload = Number(process.env.MAX_DOCTOR_EMERGENCY_LOAD) || 4;

    for (const doc of allDoctors) {
        const exclusionReasons = [];
        if (!doc.is_active) {
            exclusionReasons.push('Doctor account is inactive');
        }
        if (Number(doc.is_on_leave) > 0) {
            exclusionReasons.push(`Doctor excluded because the doctor is on approved leave today${doc.active_leave_reason ? ' (' + doc.active_leave_reason + ')' : ''}`);
        }
        if (!doc.active_shift_type) {
            exclusionReasons.push('Doctor excluded because the doctor is outside the current working shift');
        }
        if (Number(doc.active_emergency_cases) >= maxEmergencyWorkload) {
            exclusionReasons.push(`Doctor excluded because active emergency workload (${doc.active_emergency_cases}) reached capacity limit (${maxEmergencyWorkload})`);
        }

        if (exclusionReasons.length > 0) {
            excludedDoctors.push({
                doctor_id: doc.doctor_id,
                name: doc.name,
                specialization: doc.specialization,
                department_name: doc.department_name,
                excluded_reason: exclusionReasons.join('; ')
            });
            continue;
        }

        let docScore = 140;
        const reasons = [];

        if (deptLookup.matched && Number(doc.department_id) === Number(deptLookup.department_id)) {
            docScore += 50;
            reasons.push(`Doctor recommended because specialization (${doc.specialization}) matches ${deptLookup.department_name} and the doctor is available on ${doc.active_shift_type} shift (${doc.active_shift_start}–${doc.active_shift_end})`);
        } else if (doc.department_name === 'Emergency Medicine' || doc.department_name === 'General Medicine') {
            docScore += 20;
            reasons.push(`Available on ${doc.active_shift_type} shift (${doc.active_shift_start}–${doc.active_shift_end}) with General/Emergency coverage capability (${doc.specialization})`);
        } else {
            reasons.push(`Available on ${doc.active_shift_type} shift (${doc.active_shift_start}–${doc.active_shift_end}) in ${doc.department_name}`);
        }

        const loadPenalty = (Number(doc.active_emergency_cases) * 15) + (Number(doc.today_appointments) * 5);
        docScore -= loadPenalty;
        reasons.push(`Current workload: ${doc.active_emergency_cases} active emergency case(s), ${doc.today_appointments} today appointment(s)`);

        eligibleDoctors.push({
            doctor_id: doc.doctor_id,
            name: doc.name,
            email: doc.email,
            specialization: doc.specialization,
            department_id: doc.department_id,
            department_name: doc.department_name,
            shift_type: doc.active_shift_type,
            start_time: doc.active_shift_start,
            end_time: doc.active_shift_end,
            active_emergency_cases: Number(doc.active_emergency_cases),
            today_appointments: Number(doc.today_appointments),
            match_score: docScore,
            reasoning: reasons.join('; ')
        });
    }

    eligibleDoctors.sort((a, b) => b.match_score - a.match_score);

    // Evaluate all beds for suitability and availability
    const currentPriority = (latestTriage && latestTriage.priority) || ec.triage_priority;
    const isCriticalICU = currentPriority === 'P1' && (
        (latestTriage && latestTriage.spo2 && Number(latestTriage.spo2) < 90) ||
        (latestTriage && latestTriage.gcs_score && Number(latestTriage.gcs_score) <= 8)
    );
    const requestedWardCategory = isCriticalICU ? 'ICU' : 'Emergency Ward';

    const [allBeds] = await connOrPool.query(
        `SELECT b.bed_id, b.ward_id, w.ward_name, w.ward_type, b.bed_number, b.status,
                (SELECT COUNT(*) FROM ADMISSION adm WHERE adm.bed_id = b.bed_id AND adm.status = 'Admitted') AS active_admissions,
                (SELECT COUNT(*) FROM EMERGENCY_BED_ASSIGNMENT eba WHERE eba.bed_id = b.bed_id AND eba.is_active = TRUE AND eba.case_id <> ?) AS active_emg_assignments
         FROM BED b
         JOIN WARD w ON b.ward_id = w.ward_id
         ORDER BY 
            CASE WHEN w.ward_name = ? THEN 0
                 WHEN w.ward_name = 'Emergency Ward' THEN 1
                 WHEN w.ward_name = 'ICU' THEN 2
                 ELSE 3 END,
            b.bed_number ASC`,
        [ec.case_id, requestedWardCategory]
    );

    const availableBeds = [];
    const excludedBeds = [];

    for (const bed of allBeds) {
        if (bed.status !== 'Available' || Number(bed.active_admissions) > 0 || Number(bed.active_emg_assignments) > 0) {
            const why = bed.status !== 'Available'
                ? `Resource not recommended because Bed ${bed.bed_number} (${bed.ward_name}) has status '${bed.status}'`
                : `Resource not recommended because Bed ${bed.bed_number} (${bed.ward_name}) already has an active assignment`;
            excludedBeds.push({
                bed_id: bed.bed_id,
                bed_number: bed.bed_number,
                ward_name: bed.ward_name,
                status: bed.status,
                excluded_reason: why
            });
            continue;
        }

        let bedReason = '';
        if (bed.ward_name === requestedWardCategory) {
            bedReason = isCriticalICU
                ? `Bed recommended because it is available and matches the requested ${bed.ward_name} category for critical resuscitation/monitoring`
                : `Bed recommended because it is available and matches the requested ${bed.ward_name} category for acute emergency care`;
        } else {
            bedReason = `Bed available in ${bed.ward_name} as overflow/secondary option (primary category: ${requestedWardCategory})`;
        }

        availableBeds.push({
            bed_id: bed.bed_id,
            ward_id: bed.ward_id,
            ward_name: bed.ward_name,
            ward_type: bed.ward_type,
            bed_number: bed.bed_number,
            status: bed.status,
            reason: bedReason
        });
    }

    return {
        deptLookup,
        deptReason,
        allDepartments,
        eligibleDoctors,
        excludedDoctors,
        recommendedDoctor: eligibleDoctors[0] || null,
        availableBeds,
        excludedBeds,
        recommendedBed: availableBeds[0] || null,
        requestedWardCategory
    };
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
        const [[pendingTriageCases]] = await mysqlPool.query(
            `SELECT COUNT(*) AS total
             FROM EMERGENCY_CASE ec
             WHERE ec.status NOT IN ('Discharged', 'Transferred')
               AND (ec.assessment_status = 'Pending_Triage' OR NOT EXISTS (SELECT 1 FROM TRIAGE_ASSESSMENT ta WHERE ta.case_id = ec.case_id))`
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
            pending_triage_cases: pendingTriageCases.total || 0,
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
// 2. Emergency Queue (Priority-ordered; explicitly distinguishes unassessed cases)
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
                ec.assessment_status,
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
            const isAssessed = Number(item.triage_count) > 0 && item.assessment_status !== 'Pending_Triage';
            const effectivePriority = isAssessed ? (item.triage_priority || 'P3') : 'UNASSESSED';
            const assessmentStatus = isAssessed ? 'Assessed' : 'Pending_Triage';
            const score = computePriorityScore(effectivePriority, item.waiting_minutes, isAssessed);
            return {
                ...item,
                triage_priority: isAssessed ? item.triage_priority : 'UNASSESSED',
                preliminary_priority: !isAssessed && ['P1', 'P2', 'P3', 'P4'].includes(item.triage_priority) ? item.triage_priority : null,
                assessment_status: assessmentStatus,
                triage_pending: !isAssessed,
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
//    - Does NOT silently mark an unassessed patient as an assessed P3 case
//    - Records assessment_status = 'Pending_Triage' and triage_priority = 'UNASSESSED'
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
        triage_priority,
        department_name
    } = req.body;

    if (!initial_complaint || typeof initial_complaint !== 'string' || !initial_complaint.trim()) {
        return res.status(400).json({ error: 'Initial complaint or presenting symptom is required' });
    }

    if (!patient_id && (!temp_patient_name || !String(temp_patient_name).trim())) {
        return res.status(400).json({ error: 'Provide either an existing Patient ID or a temporary patient name (e.g. Unknown Male)' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // If an explicit department_name was passed, validate that it exists instead of silently picking a fallback
        let targetDeptId = null;
        if (department_name && String(department_name).trim()) {
            const explicitDept = await resolveDepartmentByName(conn, department_name);
            if (!explicitDept.matched) {
                await conn.rollback();
                return res.status(400).json({
                    error: explicitDept.error,
                    requested_department: department_name,
                    matched: false
                });
            }
            targetDeptId = explicitDept.department_id;
        } else {
            const { targetDeptName } = inferTargetDepartment(initial_complaint, temp_patient_age);
            const inferredDept = await resolveDepartmentByName(conn, targetDeptName);
            targetDeptId = inferredDept.matched ? inferredDept.department_id : null;
        }

        // Concurrency-safe sequence generation for EMG-YYYY-XXX
        const emgNumber = await generateNextEmgNumber(conn);

        const normalizedGender = temp_patient_gender
            ? (['M', 'F', 'O'].includes(temp_patient_gender) ? temp_patient_gender : 'O')
            : null;

        // Unassessed intake case is explicitly stored with assessment_status = 'Pending_Triage'
        // and triage_priority = 'UNASSESSED' (not silently invented as P3)
        const [insertResult] = await conn.query(
            `INSERT INTO EMERGENCY_CASE (
                emg_number, patient_id, temp_patient_name, temp_patient_gender, temp_patient_age,
                contact_phone, emergency_contact, arrival_time, arrival_method, ambulance_id,
                initial_complaint, triage_priority, assessment_status, status, department_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, 'UNASSESSED', 'Pending_Triage', 'Waiting', ?)`,
            [
                emgNumber,
                patient_id ? Number(patient_id) : null,
                temp_patient_name ? String(temp_patient_name).trim() : null,
                normalizedGender,
                temp_patient_age ? Number(temp_patient_age) : null,
                contact_phone || null,
                emergency_contact || null,
                arrival_method,
                ambulance_id ? Number(ambulance_id) : null,
                initial_complaint.trim(),
                targetDeptId
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
        const isCriticalHint = triage_priority === 'P1';
        const alertMsg = isCriticalHint
            ? `🚨 CRITICAL ARRIVAL (Triage Pending): ${emgNumber} registered (${arrival_method}). Immediate triage assessment required! Complaint: ${initial_complaint.slice(0, 80)}`
            : `New Emergency Case (Triage Pending): ${emgNumber} registered (${arrival_method}). Complaint: ${initial_complaint.slice(0, 80)}`;

        await sendNotification({ role_name: 'Doctor', message: alertMsg, event_type: 'emergency_registration' });
        await sendNotification({ role_name: 'Nurse', message: alertMsg, event_type: 'emergency_registration' });

        await recordCrossDbOperation({
            idempotency_key: `AUDIT-EMG-REG-${newCaseId}`,
            collection_name: 'audit_log',
            operation_type: 'insert',
            payload: {
                user_id: req.session.user.id,
                action: 'REGISTER emergency patient',
                table_affected: 'EMERGENCY_CASE',
                details: {
                    case_id: newCaseId,
                    emg_number: emgNumber,
                    arrival_method,
                    assessment_status: 'Pending_Triage',
                    triage_priority: 'UNASSESSED'
                },
                timestamp: new Date()
            }
        });

        res.status(201).json({
            message: 'Emergency patient registered successfully (Pending Triage Assessment)',
            case_id: newCaseId,
            emg_number: emgNumber,
            assessment_status: 'Pending_Triage',
            triage_priority: 'UNASSESSED'
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

        const isAssessed = triageHistory.length > 0 && caseRow.assessment_status !== 'Pending_Triage';
        caseRow.assessment_status = isAssessed ? 'Assessed' : 'Pending_Triage';
        caseRow.triage_pending = !isAssessed;
        if (!isAssessed) {
            caseRow.triage_priority = 'UNASSESSED';
        }

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
            `SELECT eda.*, u.name AS doctor_name, urec.name AS recommended_doctor_name, uby.name AS assigned_by_name
             FROM EMERGENCY_DOCTOR_ASSIGNMENT eda
             JOIN \`USER\` u ON eda.doctor_id = u.user_id
             LEFT JOIN \`USER\` urec ON eda.recommended_doctor_id = urec.user_id
             LEFT JOIN \`USER\` uby ON eda.assigned_by = uby.user_id
             WHERE eda.case_id = ?
             ORDER BY eda.assigned_at DESC`,
            [req.params.id]
        );

        const [bedAssignments] = await mysqlPool.query(
            `SELECT eba.*, b.bed_number, w.ward_name, rb.bed_number AS recommended_bed_number, uby.name AS assigned_by_name
             FROM EMERGENCY_BED_ASSIGNMENT eba
             JOIN BED b ON eba.bed_id = b.bed_id
             JOIN WARD w ON b.ward_id = w.ward_id
             LEFT JOIN BED rb ON eba.recommended_bed_id = rb.bed_id
             LEFT JOIN \`USER\` uby ON eba.assigned_by = uby.user_id
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
//    - Validates all vital sign & observation inputs against configurable technical bounds
//    - Preserves raw_payload and assessment history
//    - Transitions assessment_status -> 'Assessed'
// -----------------------------------------------------------------------------
router.post('/triage/:id', requireRole('Admin', 'Doctor', 'Nurse'), async (req, res) => {
    const validation = validateTriagePayload(req.body, { requireTriageFields: true });
    if (!validation.valid) {
        return res.status(400).json({
            error: validation.errors[0],
            validation_errors: validation.errors,
            technical_notice: 'Values were rejected by configurable technical input validation limits (not clinical diagnostic thresholds).'
        });
    }

    const v = validation.normalized;
    const rawPayloadJson = JSON.stringify(req.body || {});

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[ec]] = await conn.query(
            'SELECT patient_id, emg_number, triage_priority, assessment_status FROM EMERGENCY_CASE WHERE case_id = ? FOR UPDATE',
            [req.params.id]
        );
        if (!ec) {
            await conn.rollback();
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        const [triageIns] = await conn.query(
            `INSERT INTO TRIAGE_ASSESSMENT (
                case_id, nurse_id, bp_systolic, bp_diastolic, heart_rate, spo2,
                temperature, temperature_unit, respiratory_rate, consciousness_level, gcs_score,
                priority, priority_reason, symptoms, injury_details, assessment_notes, raw_payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.params.id,
                req.session.user.id,
                v.bp_systolic,
                v.bp_diastolic,
                v.heart_rate,
                v.spo2,
                v.temperature,
                v.temperature_unit,
                v.respiratory_rate,
                v.consciousness_level,
                v.gcs_score,
                v.priority,
                v.priority_reason,
                v.symptoms,
                v.injury_details,
                v.assessment_notes,
                rawPayloadJson
            ]
        );

        await conn.query(
            `UPDATE EMERGENCY_CASE 
             SET triage_priority = ?, 
                 assessment_status = 'Assessed',
                 status = CASE WHEN status = 'Waiting' THEN 'Triage' ELSE status END
             WHERE case_id = ?`,
            [v.priority, req.params.id]
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
                v.bp_systolic,
                v.bp_diastolic,
                v.heart_rate,
                v.spo2,
                v.temperature,
                v.respiratory_rate,
                `Triage vitals recorded: Priority ${v.priority}`
            ]
        );

        await conn.commit();

        if (v.priority === 'P1') {
            await sendNotification({
                role_name: 'Doctor',
                message: `CRITICAL ALERT: Case ${ec.emg_number} classified as P1 Critical! SpO2: ${v.spo2 || '--'}%, HR: ${v.heart_rate || '--'}, BP: ${v.bp_systolic || '--'}/${v.bp_diastolic || '--'}`,
                event_type: 'p1_triage'
            });
        }

        res.status(201).json({
            message: 'Triage assessment recorded successfully',
            assessment_id: triageIns.insertId,
            priority: v.priority,
            assessment_status: 'Assessed'
        });
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
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
        return res.status(400).json({ error: 'A documented medical or operational reason is mandatory when changing priority' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[existing]] = await conn.query('SELECT triage_priority, assessment_status, emg_number FROM EMERGENCY_CASE WHERE case_id = ? FOR UPDATE', [req.params.id]);
        if (!existing) {
            await conn.rollback();
            return res.status(404).json({ error: 'Emergency case not found' });
        }

        const oldPriority = existing.triage_priority || 'UNASSESSED';

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
//    - Requires an authorized triage assessment before generating normal recommendations
//    - Never silently assigns an unrelated fallback department
//    - Provides factual explanations for recommended AND excluded doctors and beds
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

        const isAssessed = Boolean(latestTriage) && ec.assessment_status !== 'Pending_Triage';
        const waitMinutes = ec.waiting_minutes || 0;

        // Requirement 3.A: Do NOT generate normal priority-based recommendations using an invented default assessment.
        // Require an authorized triage assessment before the normal recommendation workflow, while still returning
        // available rosters so emergency staff can proceed with manual emergency handling if needed.
        if (!isAssessed) {
            const evalData = await evaluateEmergencyResources(mysqlPool, ec, null, req.query.department);
            return res.status(200).json({
                case_id: ec.case_id,
                emg_number: ec.emg_number,
                patient_name: ec.patient_name,
                assessment_status: 'Pending_Triage',
                triage_pending: true,
                current_priority: 'UNASSESSED',
                waiting_minutes: waitMinutes,
                calculated_priority_score: null,
                triage_required_message: 'Triage Assessment Pending: An authorized clinical triage assessment is required before normal priority-based recommendations can be generated. Emergency staff may record triage now or proceed with manual emergency allocation with an override reason.',
                recommended_department: evalData.deptLookup.matched ? {
                    id: evalData.deptLookup.department_id,
                    name: evalData.deptLookup.department_name,
                    matched: true,
                    reason: evalData.deptReason
                } : {
                    id: null,
                    name: evalData.deptLookup.department_name,
                    matched: false,
                    error: evalData.deptLookup.error
                },
                available_departments: evalData.allDepartments,
                recommended_doctor: null,
                alternative_doctors: evalData.eligibleDoctors,
                excluded_doctors: evalData.excludedDoctors,
                recommended_bed: null,
                alternative_beds: evalData.availableBeds,
                excluded_beds: evalData.excludedBeds,
                clinical_notice: 'Triage information is pending. Automated recommendations are withheld until triage vitals and acuity are recorded by authorized staff.'
            });
        }

        const currentPriority = latestTriage.priority || ec.triage_priority;
        const priorityScore = computePriorityScore(currentPriority, waitMinutes, true);

        const evalData = await evaluateEmergencyResources(mysqlPool, ec, latestTriage, req.query.department);

        // If an explicit department was requested in query and could not be matched, return clear no-match status
        if (req.query.department && !evalData.deptLookup.matched) {
            return res.status(404).json({
                error: evalData.deptLookup.error,
                matched: false,
                requested_department: req.query.department,
                available_departments: evalData.allDepartments
            });
        }

        const recommendedDoctor = evalData.recommendedDoctor;
        const recommendedBed = evalData.recommendedBed;

        res.json({
            case_id: ec.case_id,
            emg_number: ec.emg_number,
            patient_name: ec.patient_name,
            assessment_status: 'Assessed',
            triage_pending: false,
            current_priority: currentPriority,
            waiting_minutes: waitMinutes,
            calculated_priority_score: priorityScore,
            recommended_department: evalData.deptLookup.matched ? {
                id: evalData.deptLookup.department_id,
                name: evalData.deptLookup.department_name,
                matched: true,
                reason: evalData.deptReason
            } : {
                id: null,
                name: evalData.deptLookup.department_name,
                matched: false,
                error: evalData.deptLookup.error
            },
            available_departments: evalData.allDepartments,
            recommended_doctor: recommendedDoctor ? {
                doctor_id: recommendedDoctor.doctor_id,
                name: recommendedDoctor.name,
                specialization: recommendedDoctor.specialization,
                department_id: recommendedDoctor.department_id,
                department_name: recommendedDoctor.department_name,
                shift_type: recommendedDoctor.shift_type,
                active_workload: recommendedDoctor.active_emergency_cases,
                match_score: recommendedDoctor.match_score,
                reason: recommendedDoctor.reasoning
            } : null,
            no_doctor_explanation: !recommendedDoctor
                ? (evalData.excludedDoctors.length
                    ? `No on-duty doctor is currently available (${evalData.excludedDoctors.map(d => d.name + ': ' + d.excluded_reason).join(' | ')})`
                    : 'No doctors registered in target department')
                : null,
            alternative_doctors: evalData.eligibleDoctors.slice(1, 6),
            excluded_doctors: evalData.excludedDoctors,
            recommended_bed: recommendedBed ? {
                bed_id: recommendedBed.bed_id,
                bed_number: recommendedBed.bed_number,
                ward_name: recommendedBed.ward_name,
                reason: recommendedBed.reason
            } : null,
            no_bed_explanation: !recommendedBed
                ? `All hospital beds are currently unavailable (${evalData.excludedBeds.length} bed(s) occupied/cleaning). Surge protocol required.`
                : null,
            alternative_beds: evalData.availableBeds.slice(1, 6),
            excluded_beds: evalData.excludedBeds,
            clinical_notice: 'The MediCare Priority Engine provides decision support based on triage severity, resource availability, and clinical workload. Medical staff authorization is required for final allocation.'
        });
    } catch (err) {
        console.error('Priority engine error:', err);
        res.status(500).json({ error: 'Failed to execute priority engine' });
    }
});

// -----------------------------------------------------------------------------
// 8. Confirm Doctor & Bed Allocation (Admin, Doctor, Nurse)
//    - Repeats ALL doctor and bed availability checks inside a transaction
//    - Enforces manual override reason when selecting non-recommended resources
//      or when allocating for an unassessed emergency case
//    - Records original recommended resource, selected resource, override_reason,
//      assigned_by, and timestamp in EMERGENCY_DOCTOR_ASSIGNMENT & EMERGENCY_BED_ASSIGNMENT
// -----------------------------------------------------------------------------
router.post('/allocate/:id', requireRole('Admin', 'Doctor', 'Nurse'), async (req, res) => {
    const {
        doctor_id,
        bed_id,
        department_id,
        department_name,
        override_reason,
        recommended_doctor_id: clientRecDocId,
        recommended_bed_id: clientRecBedId
    } = req.body;

    if (!doctor_id && !bed_id && !department_id && !department_name) {
        return res.status(400).json({ error: 'At least one resource (doctor_id, bed_id, or department) must be specified for allocation' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[ec]] = await conn.query(
            `SELECT ec.*,
                    COALESCE(TIMESTAMPDIFF(YEAR, p.dob, CURDATE()), ec.temp_patient_age, 35) AS age
             FROM EMERGENCY_CASE ec
             LEFT JOIN PATIENT p ON ec.patient_id = p.patient_id
             WHERE ec.case_id = ? FOR UPDATE`,
            [req.params.id]
        );
        if (!ec) {
            await conn.rollback();
            return res.status(404).json({ error: 'Emergency case not found' });
        }
        if (ec.status === 'Discharged' || ec.status === 'Transferred') {
            await conn.rollback();
            return res.status(409).json({ error: `Cannot allocate resources to a ${ec.status.toLowerCase()} emergency case` });
        }

        const [[latestTriage]] = await conn.query(
            'SELECT * FROM TRIAGE_ASSESSMENT WHERE case_id = ? ORDER BY assessed_at DESC LIMIT 1',
            [req.params.id]
        );
        const isAssessed = Boolean(latestTriage) && ec.assessment_status !== 'Pending_Triage';

        // Re-evaluate live recommendations inside the transaction
        const liveEval = await evaluateEmergencyResources(conn, ec, latestTriage, department_name);
        const liveRecDocId = liveEval.recommendedDoctor ? Number(liveEval.recommendedDoctor.doctor_id) : (clientRecDocId ? Number(clientRecDocId) : null);
        const liveRecBedId = liveEval.recommendedBed ? Number(liveEval.recommendedBed.bed_id) : (clientRecBedId ? Number(clientRecBedId) : null);

        // Validate department if specified
        let resolvedDeptId = ec.department_id;
        if (department_name && String(department_name).trim()) {
            const deptMatch = await resolveDepartmentByName(conn, department_name);
            if (!deptMatch.matched) {
                await conn.rollback();
                return res.status(400).json({
                    error: deptMatch.error,
                    matched: false,
                    available_departments: liveEval.allDepartments
                });
            }
            resolvedDeptId = deptMatch.department_id;
        } else if (department_id !== undefined && department_id !== null && department_id !== '') {
            const [[deptRow]] = await conn.query('SELECT department_id FROM DEPARTMENT WHERE department_id = ?', [Number(department_id)]);
            if (!deptRow) {
                await conn.rollback();
                return res.status(400).json({
                    error: `Invalid department_id (${department_id}). No matching department exists.`,
                    matched: false,
                    available_departments: liveEval.allDepartments
                });
            }
            resolvedDeptId = deptRow.department_id;
        }

        // Check existing active assignments with FOR UPDATE
        const [[currentDocAssign]] = await conn.query(
            'SELECT * FROM EMERGENCY_DOCTOR_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE',
            [req.params.id]
        );
        const [[currentBedAssign]] = await conn.query(
            'SELECT * FROM EMERGENCY_BED_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE',
            [req.params.id]
        );

        // Determine if this allocation constitutes a manual override
        const isDocOverride = Boolean(
            doctor_id &&
            liveRecDocId &&
            Number(doctor_id) !== Number(liveRecDocId)
        );
        const isBedOverride = Boolean(
            bed_id &&
            liveRecBedId &&
            Number(bed_id) !== Number(liveRecBedId)
        );
        const isUnassessedManualProceed = !isAssessed;

        const cleanOverrideReason = override_reason && typeof override_reason === 'string' ? override_reason.trim() : '';

        if ((isDocOverride || isBedOverride) && !cleanOverrideReason) {
            await conn.rollback();
            return res.status(400).json({
                error: 'Manual override reason is required when selecting a doctor or bed different from the Priority Engine recommendation.',
                override_required: true,
                recommended_doctor_id: liveRecDocId,
                recommended_bed_id: liveRecBedId
            });
        }

        // Verify Doctor availability from scratch inside the transaction
        let verifiedDoctor = null;
        if (doctor_id) {
            const [[docRow]] = await conn.query(
                `SELECT d.doctor_id, d.department_id, d.specialization, u.name, u.is_active, dept.department_name
                 FROM DOCTOR d
                 JOIN \`USER\` u ON d.doctor_id = u.user_id
                 JOIN DEPARTMENT dept ON d.department_id = dept.department_id
                 WHERE d.doctor_id = ? FOR UPDATE`,
                [Number(doctor_id)]
            );
            if (!docRow) {
                await conn.rollback();
                return res.status(404).json({ error: 'Selected doctor does not exist' });
            }
            if (!docRow.is_active) {
                await conn.rollback();
                return res.status(409).json({
                    error: `Doctor ${docRow.name} is inactive and cannot be assigned`,
                    refreshed_recommendations: {
                        recommended_doctor: liveEval.recommendedDoctor,
                        alternative_doctors: liveEval.eligibleDoctors
                    }
                });
            }

            // Check approved leave today
            const [[leaveRow]] = await conn.query(
                `SELECT leave_id, reason FROM DOCTOR_LEAVE
                 WHERE doctor_id = ? AND status = 'Approved' AND CURDATE() BETWEEN start_date AND end_date
                 LIMIT 1`,
                [Number(doctor_id)]
            );
            if (leaveRow) {
                await conn.rollback();
                return res.status(409).json({
                    error: `Doctor ${docRow.name} is on approved leave today${leaveRow.reason ? ' (' + leaveRow.reason + ')' : ''} and cannot be assigned`,
                    refreshed_recommendations: {
                        recommended_doctor: liveEval.recommendedDoctor,
                        alternative_doctors: liveEval.eligibleDoctors
                    }
                });
            }

            // Check active shift today
            const [[shiftRow]] = await conn.query(
                `SELECT shift_id, shift_type, start_time, end_time FROM DOCTOR_SHIFT
                 WHERE doctor_id = ?
                   AND shift_date = CURDATE()
                   AND is_on_duty = TRUE
                   AND (
                     (start_time <= end_time AND CURTIME() BETWEEN start_time AND end_time)
                     OR (start_time > end_time AND (CURTIME() >= start_time OR CURTIME() <= end_time))
                   )
                 LIMIT 1`,
                [Number(doctor_id)]
            );
            if (!shiftRow) {
                await conn.rollback();
                return res.status(409).json({
                    error: `Doctor ${docRow.name} is currently off-shift or not on duty and cannot be assigned`,
                    refreshed_recommendations: {
                        recommended_doctor: liveEval.recommendedDoctor,
                        alternative_doctors: liveEval.eligibleDoctors
                    }
                });
            }

            // Check workload limit
            const maxEmergencyWorkload = Number(process.env.MAX_DOCTOR_EMERGENCY_LOAD) || 4;
            const [[loadRow]] = await conn.query(
                `SELECT COUNT(*) AS active_count
                 FROM EMERGENCY_DOCTOR_ASSIGNMENT eda
                 JOIN EMERGENCY_CASE aec ON eda.case_id = aec.case_id
                 WHERE eda.doctor_id = ?
                   AND eda.is_active = TRUE
                   AND aec.case_id <> ?
                   AND aec.status IN ('Assigned', 'In Treatment')
                 FOR UPDATE`,
                [Number(doctor_id), Number(req.params.id)]
            );
            if (loadRow && Number(loadRow.active_count) >= maxEmergencyWorkload) {
                await conn.rollback();
                return res.status(409).json({
                    error: `Doctor ${docRow.name} already has ${loadRow.active_count} active emergency cases (maximum workload ${maxEmergencyWorkload})`,
                    refreshed_recommendations: {
                        recommended_doctor: liveEval.recommendedDoctor,
                        alternative_doctors: liveEval.eligibleDoctors
                    }
                });
            }

            verifiedDoctor = docRow;
        }

        // Verify Bed availability and lock row inside transaction
        let bedNumber = '';
        let verifiedBed = null;
        if (bed_id) {
            const [[targetBed]] = await conn.query(
                `SELECT b.*, w.ward_name
                 FROM BED b JOIN WARD w ON b.ward_id = w.ward_id
                 WHERE b.bed_id = ? FOR UPDATE`,
                [Number(bed_id)]
            );
            if (!targetBed) {
                await conn.rollback();
                return res.status(404).json({ error: 'Selected bed does not exist' });
            }

            const sameBedAsCurrent = currentBedAssign && Number(currentBedAssign.bed_id) === Number(bed_id);
            if (!sameBedAsCurrent) {
                // Also check no other active emergency assignment or inpatient admission holds this bed
                const [[otherEmgBed]] = await conn.query(
                    'SELECT assignment_id, case_id FROM EMERGENCY_BED_ASSIGNMENT WHERE bed_id = ? AND is_active = TRUE AND case_id <> ? FOR UPDATE',
                    [Number(bed_id), Number(req.params.id)]
                );
                const [[otherAdmBed]] = await conn.query(
                    "SELECT admission_id FROM ADMISSION WHERE bed_id = ? AND status = 'Admitted' FOR UPDATE",
                    [Number(bed_id)]
                );

                if (targetBed.status !== 'Available' || otherEmgBed || otherAdmBed) {
                    await conn.rollback();
                    return res.status(409).json({
                        error: `Bed ${targetBed.bed_number} is not available (current status: ${targetBed.status})`,
                        refreshed_recommendations: {
                            recommended_bed: liveEval.recommendedBed,
                            alternative_beds: liveEval.availableBeds
                        }
                    });
                }
            }

            bedNumber = targetBed.bed_number;
            verifiedBed = targetBed;

            if (!sameBedAsCurrent) {
                if (currentBedAssign) {
                    await conn.query("UPDATE BED SET status = 'Cleaning' WHERE bed_id = ?", [currentBedAssign.bed_id]);
                    await conn.query(
                        'UPDATE EMERGENCY_BED_ASSIGNMENT SET is_active = FALSE, released_at = NOW() WHERE assignment_id = ?',
                        [currentBedAssign.assignment_id]
                    );
                }
                await conn.query("UPDATE BED SET status = 'Occupied' WHERE bed_id = ?", [Number(bed_id)]);
                await conn.query(
                    `INSERT INTO EMERGENCY_BED_ASSIGNMENT (case_id, bed_id, recommended_bed_id, assigned_by, override_reason, is_active)
                     VALUES (?, ?, ?, ?, ?, TRUE)`,
                    [req.params.id, Number(bed_id), liveRecBedId, req.session.user.id, cleanOverrideReason || null]
                );
            }
        }

        if (verifiedDoctor) {
            const sameDocAsCurrent = currentDocAssign && Number(currentDocAssign.doctor_id) === Number(doctor_id);
            if (!sameDocAsCurrent) {
                if (currentDocAssign) {
                    await conn.query(
                        'UPDATE EMERGENCY_DOCTOR_ASSIGNMENT SET is_active = FALSE, unassigned_at = NOW() WHERE assignment_id = ?',
                        [currentDocAssign.assignment_id]
                    );
                }
                await conn.query(
                    `INSERT INTO EMERGENCY_DOCTOR_ASSIGNMENT (case_id, doctor_id, recommended_doctor_id, assigned_by, override_reason, is_active)
                     VALUES (?, ?, ?, ?, ?, TRUE)`,
                    [req.params.id, Number(doctor_id), liveRecDocId, req.session.user.id, cleanOverrideReason || null]
                );
            } else if (cleanOverrideReason && currentDocAssign) {
                await conn.query(
                    'UPDATE EMERGENCY_DOCTOR_ASSIGNMENT SET override_reason = ? WHERE assignment_id = ?',
                    [cleanOverrideReason, currentDocAssign.assignment_id]
                );
            }
        }

        // Update emergency case status and department
        await conn.query(
            `UPDATE EMERGENCY_CASE 
             SET department_id = COALESCE(?, department_id),
                 status = CASE WHEN status IN ('Waiting', 'Triage') THEN 'Assigned' ELSE status END
             WHERE case_id = ?`,
            [resolvedDeptId ? Number(resolvedDeptId) : null, req.params.id]
        );

        const finalDocId = doctor_id || (currentDocAssign && currentDocAssign.doctor_id) || 'Unchanged';
        let logDesc = `Allocation confirmed: Doctor ID ${finalDocId} (Recommended: ${liveRecDocId || 'None'}), Bed ${bedNumber || 'Not changed'} (Recommended Bed ID: ${liveRecBedId || 'None'}).`;
        if (cleanOverrideReason) {
            logDesc += ` [Manual Override Reason: ${cleanOverrideReason}]`;
        } else if (isUnassessedManualProceed) {
            logDesc += ' [Manual Emergency Allocation Prior to Triage]';
        }
        await conn.query(
            'INSERT INTO EMERGENCY_TREATMENT_LOG (case_id, doctor_id, action_type, description) VALUES (?, ?, ?, ?)',
            [req.params.id, req.session.user.id, 'Allocation', logDesc]
        );

        await conn.commit();

        if (doctor_id) {
            await sendNotification({
                user_id: Number(doctor_id),
                message: `New emergency case assigned to you: ${ec.emg_number}${bedNumber ? ' in Bed ' + bedNumber : ''}. Priority: ${ec.triage_priority || 'UNASSESSED'}`,
                event_type: 'doctor_assigned'
            });
        }

        await recordCrossDbOperation({
            idempotency_key: `AUDIT-EMG-ALLOC-${req.params.id}-${Date.now()}`,
            collection_name: 'audit_log',
            operation_type: 'insert',
            payload: {
                user_id: req.session.user.id,
                action: (isDocOverride || isBedOverride) ? 'OVERRIDE emergency allocation' : 'ALLOCATE emergency resources',
                table_affected: 'EMERGENCY_CASE',
                details: {
                    case_id: Number(req.params.id),
                    emg_number: ec.emg_number,
                    selected_doctor_id: doctor_id ? Number(doctor_id) : null,
                    recommended_doctor_id: liveRecDocId,
                    selected_bed_id: bed_id ? Number(bed_id) : null,
                    recommended_bed_id: liveRecBedId,
                    override_reason: cleanOverrideReason || null,
                    assigned_by: req.session.user.id
                },
                timestamp: new Date()
            }
        });

        res.json({
            message: 'Doctor and bed allocated successfully',
            case_id: Number(req.params.id),
            doctor_id: doctor_id ? Number(doctor_id) : (currentDocAssign ? currentDocAssign.doctor_id : null),
            bed_id: bed_id ? Number(bed_id) : (currentBedAssign ? currentBedAssign.bed_id : null),
            recommended_doctor_id: liveRecDocId,
            recommended_bed_id: liveRecBedId,
            override_recorded: Boolean(cleanOverrideReason)
        });
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

    if (!description || typeof description !== 'string' || !description.trim()) {
        return res.status(400).json({ error: 'Action description is required' });
    }

    try {
        const [[ec]] = await mysqlPool.query('SELECT case_id, status FROM EMERGENCY_CASE WHERE case_id = ?', [req.params.id]);
        if (!ec) return res.status(404).json({ error: 'Emergency case not found' });
        if (ec.status === 'Discharged' || ec.status === 'Transferred') {
            return res.status(409).json({ error: `Cannot record treatment for a ${ec.status.toLowerCase()} emergency case` });
        }

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
                "UPDATE EMERGENCY_CASE SET status = 'In Treatment' WHERE case_id = ? AND status IN ('Waiting', 'Triage', 'Assigned')",
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
//     - Prevents duplicate admissions for the same emergency case or patient
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

        if (ec.status === 'Discharged' || ec.status === 'Transferred') {
            await conn.rollback();
            return res.status(409).json({ error: `Cannot admit a patient from a ${ec.status.toLowerCase()} emergency case` });
        }

        // Prevent duplicate admission for the same emergency case
        const [[existingCaseAdm]] = await conn.query(
            "SELECT admission_id, bed_id FROM ADMISSION WHERE case_id = ? AND status = 'Admitted' FOR UPDATE",
            [req.params.id]
        );
        if (existingCaseAdm || ec.status === 'Admitted') {
            await conn.rollback();
            return res.status(409).json({
                error: 'This emergency case has already been admitted to an inpatient ward',
                admission_id: existingCaseAdm ? existingCaseAdm.admission_id : null
            });
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
        if (!patientId && ec.temp_patient_name) {
            const [[matchedPt]] = await conn.query(
                `SELECT p.patient_id FROM PATIENT p JOIN \`USER\` u ON p.patient_id = u.user_id
                 WHERE u.name = ? AND (? IS NULL OR u.phone = ?) LIMIT 1`,
                [ec.temp_patient_name, ec.contact_phone || null, ec.contact_phone || null]
            );
            if (matchedPt) {
                patientId = matchedPt.patient_id;
                await conn.query('UPDATE EMERGENCY_CASE SET patient_id = ? WHERE case_id = ?', [patientId, req.params.id]);
            }
        }
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

        // Prevent duplicate active admission for the same patient
        const [[existingPatientAdm]] = await conn.query(
            "SELECT admission_id, bed_id FROM ADMISSION WHERE patient_id = ? AND status = 'Admitted' FOR UPDATE",
            [patientId]
        );
        if (existingPatientAdm) {
            await conn.rollback();
            return res.status(409).json({
                error: 'Patient already has an active inpatient admission',
                admission_id: existingPatientAdm.admission_id
            });
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
// 11. Emergency Discharge with Summary, Idempotency & Bed Release (Admin, Doctor)
//     - Prevents duplicate discharge processing (409 Conflict if already Discharged)
//     - Prevents duplicate Emergency BILL_ITEM via unique reference_key ('EMG-DISCHARGE-<case_id>')
//     - Marks released bed as 'Cleaning' (never directly 'Available')
//     - Records discharged_at and discharged_by
// -----------------------------------------------------------------------------
router.post('/discharge/:id', requireRole('Admin', 'Doctor'), async (req, res) => {
    const { discharge_summary, emergency_fee = 500 } = req.body;

    if (!discharge_summary || typeof discharge_summary !== 'string' || !discharge_summary.trim()) {
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

        // Prevent duplicate discharge processing
        if (ec.status === 'Discharged') {
            await conn.rollback();
            return res.status(409).json({
                error: `Emergency case ${ec.emg_number} has already been discharged`,
                already_discharged: true,
                discharged_at: ec.discharged_at
            });
        }
        if (ec.status === 'Admitted') {
            await conn.rollback();
            return res.status(409).json({
                error: `Emergency case ${ec.emg_number} was admitted to an inpatient ward. Please use the inpatient discharge workflow.`
            });
        }
        if (ec.status === 'Transferred') {
            await conn.rollback();
            return res.status(409).json({
                error: `Emergency case ${ec.emg_number} has already been transferred.`
            });
        }

        const [[currentDocAssign]] = await conn.query(
            'SELECT * FROM EMERGENCY_DOCTOR_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE',
            [req.params.id]
        );
        if (req.session.user.role === 'Doctor' && currentDocAssign && Number(currentDocAssign.doctor_id) !== Number(req.session.user.id)) {
            await conn.rollback();
            return res.status(403).json({ error: 'Access denied: this emergency case is assigned to another doctor' });
        }

        // Release active emergency bed assignment to Cleaning (never directly Available)
        const [[currentBedAssign]] = await conn.query(
            'SELECT * FROM EMERGENCY_BED_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE',
            [req.params.id]
        );
        let releasedBedId = null;
        if (currentBedAssign) {
            await conn.query('SELECT * FROM BED WHERE bed_id = ? FOR UPDATE', [currentBedAssign.bed_id]);
            await conn.query("UPDATE BED SET status = 'Cleaning' WHERE bed_id = ?", [currentBedAssign.bed_id]);
            await conn.query(
                'UPDATE EMERGENCY_BED_ASSIGNMENT SET is_active = FALSE, released_at = NOW() WHERE assignment_id = ?',
                [currentBedAssign.assignment_id]
            );
            releasedBedId = currentBedAssign.bed_id;
        }

        // Close active doctor assignment
        if (currentDocAssign) {
            await conn.query(
                'UPDATE EMERGENCY_DOCTOR_ASSIGNMENT SET is_active = FALSE, unassigned_at = NOW() WHERE assignment_id = ?',
                [currentDocAssign.assignment_id]
            );
        }

        // Update emergency case with discharged_at and discharged_by
        await conn.query(
            `UPDATE EMERGENCY_CASE 
             SET status = 'Discharged', 
                 discharge_summary = ?, 
                 discharged_at = NOW(),
                 discharged_by = ?
             WHERE case_id = ?`,
            [discharge_summary.trim(), req.session.user.id, req.params.id]
        );

        // Auto-generate Bill if patient is registered, with unique reference_key to prevent duplicate charges
        let billId = null;
        const chargeRefKey = `EMG-DISCHARGE-${ec.case_id}`;
        if (ec.patient_id) {
            const [[existingCharge]] = await conn.query(
                'SELECT bill_item_id, bill_id FROM BILL_ITEM WHERE reference_key = ? LIMIT 1',
                [chargeRefKey]
            );
            if (existingCharge) {
                billId = existingCharge.bill_id;
            } else {
                const [existingBills] = await conn.query(
                    `SELECT b.bill_id
                     FROM BILL b
                     JOIN vw_bill_summary vbs ON b.bill_id = vbs.bill_id
                     WHERE b.patient_id = ? AND vbs.payment_status <> 'Paid'
                     ORDER BY b.bill_date DESC LIMIT 1 FOR UPDATE`,
                    [ec.patient_id]
                );

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
                    'INSERT INTO BILL_ITEM (bill_id, item_type, description, amount, reference_key) VALUES (?, ?, ?, ?, ?)',
                    [
                        billId,
                        'Emergency',
                        `Emergency Ward Care & Triage (${ec.emg_number})`,
                        Number(emergency_fee) >= 0 ? Number(emergency_fee) : 500.00,
                        chargeRefKey
                    ]
                );
            }
        }

        // Treatment log
        await conn.query(
            'INSERT INTO EMERGENCY_TREATMENT_LOG (case_id, doctor_id, action_type, description) VALUES (?, ?, ?, ?)',
            [req.params.id, req.session.user.id, 'Discharge', `Discharged from Emergency Ward by ${req.session.user.name}. Summary: ${discharge_summary.trim()}`]
        );

        await conn.commit();

        await sendNotification({
            role_name: 'Receptionist',
            message: `Emergency patient ${ec.emg_number} discharged. Ready for billing clearance.`,
            event_type: 'patient_discharged'
        });

        await recordCrossDbOperation({
            idempotency_key: `AUDIT-EMG-DISCHARGE-${ec.case_id}`,
            collection_name: 'audit_log',
            operation_type: 'insert',
            payload: {
                user_id: req.session.user.id,
                action: 'DISCHARGE emergency patient',
                table_affected: 'EMERGENCY_CASE',
                details: {
                    case_id: ec.case_id,
                    emg_number: ec.emg_number,
                    discharged_by: req.session.user.id,
                    released_bed_id: releasedBedId,
                    bill_id: billId
                },
                timestamp: new Date()
            }
        });

        res.json({
            message: 'Patient successfully discharged, bed released for cleaning',
            case_id: ec.case_id,
            bill_id: billId,
            released_bed_id: releasedBedId,
            bed_status: releasedBedId ? 'Cleaning' : null,
            discharged_by: req.session.user.id
        });
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
                 FROM DOCTOR_LEAVE dl
                 WHERE dl.doctor_id = d.doctor_id
                   AND dl.status = 'Approved'
                   AND CURDATE() BETWEEN dl.start_date AND dl.end_date) AS is_on_leave,
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
