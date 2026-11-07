const express = require('express');
const bcrypt = require('bcryptjs');
const { mysqlPool, getMongo } = require('../config/db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Read-only cross-role helper routes (needed by emergency.html & staff-portal.html modals)
router.get('/doctors', requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT doc.doctor_id, u.name, u.email, dep.department_name, doc.specialization, doc.consultation_fee
         FROM DOCTOR doc JOIN \`USER\` u ON doc.doctor_id = u.user_id
         JOIN DEPARTMENT dep ON doc.department_id = dep.department_id`
    );
    res.json(rows);
});

router.get('/patients', requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist'), async (req, res) => {
    try {
        const q = req.query.q || '';
        if (q.length < 2) return res.json([]);
        const [rows] = await mysqlPool.query(
            `SELECT p.patient_id, u.name, u.email, u.phone, p.blood_group
             FROM PATIENT p JOIN \`USER\` u ON p.patient_id = u.user_id
             WHERE u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?
             LIMIT 20`,
            ['%' + q + '%', '%' + q + '%', '%' + q + '%']
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to search patients' });
    }
});

// Bed management (shared read for Admin, Doctor, Nurse, Receptionist)
router.get('/beds', requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist'), async (req, res) => {
    try {
        let sql = `SELECT v.bed_id, v.ward_id, v.ward_name, v.bed_number, v.status, v.patient_id,
                   u.name AS patient_name, u.phone AS patient_phone, p.blood_group AS patient_blood_group
                   FROM vw_bed_details v
                   LEFT JOIN PATIENT p ON v.patient_id = p.patient_id
                   LEFT JOIN \`USER\` u ON p.patient_id = u.user_id`;
        const params = [];
        if (req.query.ward) {
            sql += ' WHERE v.ward_name = ?';
            params.push(req.query.ward);
        }
        sql += ' ORDER BY v.ward_name, v.bed_number';
        const [rows] = await mysqlPool.query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch beds' });
    }
});

// All remaining /api/admin routes require Admin role (or Admin/Nurse for bed turnover)
router.get('/beds/:id', requireRole('Admin', 'Nurse'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT v.bed_id, v.ward_id, v.ward_name, v.bed_number, v.status, v.patient_id,
             u.name AS patient_name, u.phone AS patient_phone, p.blood_group AS patient_blood_group
             FROM vw_bed_details v
             LEFT JOIN PATIENT p ON v.patient_id = p.patient_id
             LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
             WHERE v.bed_id = ?`,
            [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Bed not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch bed' });
    }
});

router.patch('/beds/:id', requireRole('Admin', 'Nurse'), async (req, res) => {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const { patient_id, status, admitting_doctor_id, discharge_summary } = req.body;

        // Concurrency locking: lock the BED row first
        const [beds] = await conn.query(
            `SELECT b.*, w.ward_name, w.daily_rate
             FROM BED b JOIN WARD w ON b.ward_id = w.ward_id
             WHERE b.bed_id = ? FOR UPDATE`,
            [req.params.id]
        );
        if (!beds.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Bed not found' });
        }
        const currentBed = beds[0];

        // Find current occupant from active ADMISSION or active EMERGENCY_BED_ASSIGNMENT
        const [activeAdm] = await conn.query(
            "SELECT * FROM ADMISSION WHERE bed_id = ? AND status = 'Admitted' FOR UPDATE",
            [req.params.id]
        );
        const [activeEmg] = await conn.query(
            "SELECT eba.*, ec.patient_id FROM EMERGENCY_BED_ASSIGNMENT eba JOIN EMERGENCY_CASE ec ON eba.case_id = ec.case_id WHERE eba.bed_id = ? AND eba.is_active = TRUE FOR UPDATE",
            [req.params.id]
        );
        const currentPatientId = (activeAdm[0] && activeAdm[0].patient_id) || (activeEmg[0] && activeEmg[0].patient_id) || null;

        // Concurrency / availability check when assigning a bed to Occupied
        if (status === 'Occupied') {
            if (currentBed.status !== 'Available' && (!currentPatientId || Number(currentPatientId) !== Number(patient_id))) {
                await conn.rollback();
                return res.status(409).json({
                    error: `Concurrency conflict: Bed ${currentBed.bed_number} is currently ${currentBed.status}`
                });
            }
        }

        let newStatus = status || (patient_id ? 'Occupied' : 'Available');
        let newPatientId = null;

        if (newStatus === 'Occupied') {
            newPatientId = patient_id || currentPatientId;
            if (!newPatientId) {
                await conn.rollback();
                return res.status(400).json({ error: 'patient_id is required when marking a bed Occupied' });
            }

            await conn.query('UPDATE BED SET status = ? WHERE bed_id = ?', ['Occupied', req.params.id]);

            if (!activeAdm.length) {
                let docId = admitting_doctor_id ? Number(admitting_doctor_id) : null;
                if (!docId) {
                    const [[firstDoc]] = await conn.query('SELECT doctor_id FROM DOCTOR ORDER BY doctor_id LIMIT 1');
                    docId = firstDoc ? firstDoc.doctor_id : null;
                }
                await conn.query(
                    `INSERT INTO ADMISSION (patient_id, admitting_doctor_id, bed_id, admitted_at, status)
                     VALUES (?, ?, ?, NOW(), 'Admitted')`,
                    [newPatientId, docId, req.params.id]
                );
            }
        } else if (newStatus === 'Cleaning' || newStatus === 'Available' || newStatus === 'Maintenance' || newStatus === 'Reserved') {
            // If bed was Occupied, discharging the patient closes active ADMISSION, finalizes the bill,
            // and transitions the bed through Cleaning (or directly to Available after cleaning).
            if (activeAdm.length) {
                const adm = activeAdm[0];
                await conn.query(
                    `UPDATE ADMISSION
                     SET discharged_at = NOW(),
                         discharge_summary = COALESCE(?, discharge_summary, 'Discharged from inpatient ward'),
                         status = 'Discharged'
                     WHERE admission_id = ?`,
                    [discharge_summary || null, adm.admission_id]
                );

                // Finalize / create bill for the inpatient stay
                const days = Math.max(1, Math.ceil((Date.now() - new Date(adm.admitted_at).getTime()) / (1000 * 60 * 60 * 24)));
                const roomCharge = Number((days * Number(currentBed.daily_rate || 1000)).toFixed(2));

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
                    [billId, 'Admission', `Inpatient stay - ${currentBed.ward_name} (${currentBed.bed_number}, ${days} day(s))`, roomCharge]
                );

                // When discharging an occupied bed, release to Cleaning first unless explicitly completing cleaning
                if (currentBed.status === 'Occupied' && !req.body.skip_cleaning) {
                    newStatus = 'Cleaning';
                }
            }

            if (activeEmg.length) {
                await conn.query(
                    'UPDATE EMERGENCY_BED_ASSIGNMENT SET is_active = FALSE, released_at = NOW() WHERE bed_id = ? AND is_active = TRUE',
                    [req.params.id]
                );
            }

            await conn.query('UPDATE BED SET status = ? WHERE bed_id = ?', [newStatus, req.params.id]);
        }

        await conn.commit();

        // Audit log in MongoDB
        try {
            const mongo = getMongo();
            await mongo.collection('audit_log').insertOne({
                user_id: req.session.user.id,
                action: 'UPDATE bed allocation',
                table_affected: 'BED',
                details: {
                    bed_id: Number(req.params.id),
                    bed_number: currentBed.bed_number,
                    ward_name: currentBed.ward_name,
                    previous_status: currentBed.status,
                    previous_patient_id: currentPatientId,
                    new_status: newStatus,
                    new_patient_id: newPatientId
                },
                timestamp: new Date()
            });
        } catch (mongoErr) {
            console.warn('MongoDB audit_log write failed (non-fatal):', mongoErr.message);
        }

        res.json({
            message: 'Bed updated successfully',
            bed_id: Number(req.params.id),
            status: newStatus,
            patient_id: newPatientId
        });
    } catch (err) {
        await conn.rollback();
        console.error('Error updating bed:', err);
        res.status(500).json({ error: 'Failed to update bed' });
    } finally {
        conn.release();
    }
});

// Admin-only routes below
router.use(requireRole('Admin'));

// Stat cards -- pulls straight from the Phase 3/4 dashboard queries and views.
router.get('/dashboard', async (req, res) => {
    try {
        const [[patients]] = await mysqlPool.query('SELECT COUNT(*) AS total_patients FROM PATIENT');
        const [[doctors]] = await mysqlPool.query('SELECT COUNT(*) AS total_doctors FROM DOCTOR');
        const [[appts]] = await mysqlPool.query('SELECT COUNT(*) AS total_appointments FROM APPOINTMENT');
        const [[beds]] = await mysqlPool.query("SELECT COUNT(*) AS available_beds FROM BED WHERE status='Available'");
        const [[pendingLab]] = await mysqlPool.query("SELECT COUNT(*) AS pending_lab_reports FROM LAB_REQUEST WHERE status='Pending'");
        const [[lowStock]] = await mysqlPool.query('SELECT COUNT(*) AS low_stock_medicines FROM vw_medicine_inventory WHERE stock_qty < 20');
        const [revenue] = await mysqlPool.query('SELECT * FROM vw_monthly_revenue');
        const [occupancy] = await mysqlPool.query('SELECT * FROM vw_bed_occupancy');

        res.json({
            ...patients, ...doctors, ...appts, ...beds, ...pendingLab, ...lowStock,
            monthly_revenue: revenue, bed_occupancy: occupancy
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load dashboard' });
    }
});

router.post('/doctors', async (req, res) => {
    const { name, email, password, password_hash, department_id, specialization, qualification, consultation_fee } = req.body;
    const rawPassword = password || password_hash;
    if (!name || !email || !rawPassword || !department_id) {
        return res.status(400).json({ error: 'Name, email, password, and department_id are required' });
    }
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const hashedPassword = String(rawPassword).startsWith('$2')
            ? String(rawPassword)
            : await bcrypt.hash(String(rawPassword), 10);
        const [roleRow] = await conn.query("SELECT role_id FROM ROLE WHERE role_name='Doctor'");
        const [userResult] = await conn.query(
            'INSERT INTO `USER` (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)',
            [name.trim(), email.trim(), hashedPassword, roleRow[0].role_id]
        );
        await conn.query(
            'INSERT INTO DOCTOR (doctor_id, department_id, specialization, qualification, consultation_fee) VALUES (?, ?, ?, ?, ?)',
            [userResult.insertId, department_id, specialization || null, qualification || null, consultation_fee || 500]
        );
        await conn.commit();
        res.status(201).json({ doctor_id: userResult.insertId });
    } catch (err) {
        await conn.rollback();
        console.error(err);
        res.status(500).json({ error: 'Failed to create doctor' });
    } finally {
        conn.release();
    }
});

router.put('/doctors/:id', async (req, res) => {
    const { specialization, qualification, consultation_fee } = req.body;
    await mysqlPool.query(
        'UPDATE DOCTOR SET specialization=?, qualification=?, consultation_fee=? WHERE doctor_id=?',
        [specialization, qualification, consultation_fee, req.params.id]
    );
    res.json({ message: 'Doctor updated' });
});

router.delete('/doctors/:id', async (req, res) => {
    try {
        await mysqlPool.query('DELETE FROM `USER` WHERE user_id=?', [req.params.id]);
        res.json({ message: 'Doctor removed' });
    } catch (err) {
        res.status(409).json({ error: 'Cannot delete: this doctor has appointment/records history' });
    }
});

// Admin notifications (low stock alerts, system notices) -- written by triggers
router.get('/notifications', async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT notification_id, message, is_read, created_at FROM NOTIFICATION
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
        [req.session.user.id]
    );
    res.json(rows);
});

router.patch('/notifications/mark-all-read', async (req, res) => {
    await mysqlPool.query('UPDATE NOTIFICATION SET is_read = TRUE WHERE user_id = ?', [req.session.user.id]);
    res.json({ message: 'All notifications marked read' });
});

// Emergency cases count
router.get('/emergencies/count', async (req, res) => {
    try {
        const [[row]] = await mysqlPool.query(
            "SELECT COUNT(*) as count FROM EMERGENCY_CASE WHERE status NOT IN ('Discharged', 'Transferred')"
        );
        res.json(row);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to count emergencies' });
    }
});

// Available ambulance count
router.get('/ambulances/available', async (req, res) => {
    try {
        const [[row]] = await mysqlPool.query("SELECT COUNT(*) as count FROM AMBULANCE WHERE status='Available'");
        res.json(row);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to count ambulances' });
    }
});

// Appointments grouped by department (3NF: derived via DOCTOR -> DEPARTMENT)
router.get('/appointments/by-department', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT d.department_name, COUNT(a.appointment_id) as count
             FROM DEPARTMENT d
             LEFT JOIN DOCTOR doc ON d.department_id = doc.department_id
             LEFT JOIN APPOINTMENT a ON doc.doctor_id = a.doctor_id
             GROUP BY d.department_id, d.department_name
             ORDER BY count DESC`
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load appointments by department' });
    }
});

// Recent appointments list
router.get('/appointments', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const status = req.query.status || '';
        let sql = `SELECT a.appointment_id, up.name as patient_name, ud.name as doctor_name,
                        dep.department_name, a.appointment_date, a.appointment_time, a.status
                 FROM APPOINTMENT a
                 JOIN PATIENT p ON a.patient_id = p.patient_id JOIN \`USER\` up ON p.patient_id = up.user_id
                 JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
                 JOIN DEPARTMENT dep ON doc.department_id = dep.department_id`;
        const params = [];
        if (status) { sql += ' WHERE a.status = ?'; params.push(status); }
        sql += ' ORDER BY a.created_at DESC LIMIT ?';
        params.push(limit);
        const [rows] = await mysqlPool.query(sql, params);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load appointments' });
    }
});

// ---- All patients (for admin-patients.html; allergies derived from PATIENT_ALLERGY) ----
router.get('/patients/all', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT p.patient_id, u.name, u.email, u.phone, u.is_active,
                    p.blood_group, p.dob, p.gender, vpa.allergies
             FROM PATIENT p
             JOIN \`USER\` u ON p.patient_id = u.user_id
             LEFT JOIN vw_patient_allergies vpa ON p.patient_id = vpa.patient_id
             ORDER BY u.name`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch patients' });
    }
});

// ---- Departments with HOD name + doctor count (for admin-departments.html) ----
router.get('/departments/detail', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT d.department_id, d.department_name, d.floor_no,
                    u.name AS hod_name,
                    (SELECT COUNT(*) FROM DOCTOR doc WHERE doc.department_id = d.department_id) AS doctor_count
             FROM DEPARTMENT d
             LEFT JOIN DOCTOR hod ON d.hod_doctor_id = hod.doctor_id
             LEFT JOIN \`USER\` u ON hod.doctor_id = u.user_id
             ORDER BY d.department_name`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch departments' });
    }
});

// ---- Plain departments list (for add-doctor modal) ----
router.get('/departments', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query('SELECT department_id, department_name FROM DEPARTMENT ORDER BY department_name');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch departments' });
    }
});

// ---- Staff list with optional role filter (for admin-staff.html) ----
router.get('/staff', async (req, res) => {
    try {
        const role = req.query.role || '';
        let sql = `SELECT u.user_id, u.name, u.email, u.phone, r.role_name, u.is_active,
                          s.staff_type, s.department_id, dep.department_name, s.shift
                   FROM \`USER\` u
                   JOIN ROLE r ON u.role_id = r.role_id
                   LEFT JOIN STAFF s ON u.user_id = s.staff_id
                   LEFT JOIN DEPARTMENT dep ON s.department_id = dep.department_id
                   WHERE r.role_name IN ('Doctor','Nurse','Lab Technician','Pharmacist','Receptionist')`;
        const params = [];
        if (role) { sql += ' AND r.role_name = ?'; params.push(role); }
        sql += ' ORDER BY r.role_name, u.name';
        const [rows] = await mysqlPool.query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch staff' });
    }
});

// ---- Create Staff (Nurse, Lab Technician, Pharmacist, Receptionist) inside one transaction ----
router.post('/staff', async (req, res) => {
    const { name, email, password, password_hash, phone, role, role_name, department_id, shift } = req.body;
    const rawPassword = password || password_hash;
    const targetRole = String(role || role_name || '').trim();

    const ROLE_TO_STAFF_TYPE = {
        'Nurse': 'NURSE',
        'Lab Technician': 'LAB_TECHNICIAN',
        'Pharmacist': 'PHARMACIST',
        'Receptionist': 'RECEPTIONIST'
    };

    if (!name || !String(name).trim() || !email || !String(email).trim() || !rawPassword) {
        return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ error: 'Enter a valid email address' });
    }

    const staffType = ROLE_TO_STAFF_TYPE[targetRole];
    if (!staffType) {
        return res.status(400).json({ error: 'Role must be one of: Nurse, Lab Technician, Pharmacist, Receptionist' });
    }

    const validShifts = ['Morning', 'Evening', 'Night'];
    const targetShift = shift && validShifts.includes(shift) ? shift : 'Morning';
    const targetDeptId = department_id ? Number(department_id) : null;

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [existing] = await conn.query('SELECT user_id FROM `USER` WHERE email = ? FOR UPDATE', [normalizedEmail]);
        if (existing.length > 0) {
            await conn.rollback();
            return res.status(409).json({ error: 'A user with this email already exists' });
        }

        const [roleRows] = await conn.query('SELECT role_id FROM ROLE WHERE role_name = ?', [targetRole]);
        if (!roleRows.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'Invalid staff role' });
        }

        const hashedPassword = String(rawPassword).startsWith('$2')
            ? String(rawPassword)
            : await bcrypt.hash(String(rawPassword), 10);

        const [userResult] = await conn.query(
            'INSERT INTO `USER` (name, email, password_hash, phone, role_id) VALUES (?, ?, ?, ?, ?)',
            [String(name).trim(), normalizedEmail, hashedPassword, phone ? String(phone).trim() : null, roleRows[0].role_id]
        );

        await conn.query(
            'INSERT INTO STAFF (staff_id, staff_type, department_id, shift) VALUES (?, ?, ?, ?)',
            [userResult.insertId, staffType, targetDeptId, targetShift]
        );

        await conn.commit();

        try {
            await getMongo().collection('audit_log').insertOne({
                user_id: req.session.user.id,
                action: 'CREATE staff',
                table_affected: 'STAFF',
                details: {
                    staff_id: userResult.insertId,
                    name: String(name).trim(),
                    email: normalizedEmail,
                    role_name: targetRole,
                    staff_type: staffType,
                    department_id: targetDeptId,
                    shift: targetShift
                },
                timestamp: new Date()
            });
        } catch (_) {}

        res.status(201).json({
            staff_id: userResult.insertId,
            user_id: userResult.insertId,
            role: targetRole,
            staff_type: staffType
        });
    } catch (err) {
        await conn.rollback();
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'A user with this email already exists' });
        }
        console.error('Error creating staff:', err);
        res.status(500).json({ error: 'Failed to create staff member' });
    } finally {
        conn.release();
    }
});

// Doctor shifts management
router.get('/doctor-shifts', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT ds.shift_id, ds.doctor_id, u.name AS doctor_name, doc.specialization,
                    dept.department_name, ds.shift_date, ds.shift_type, ds.start_time, ds.end_time, ds.is_on_duty
             FROM DOCTOR_SHIFT ds
             JOIN DOCTOR doc ON ds.doctor_id = doc.doctor_id
             JOIN \`USER\` u ON doc.doctor_id = u.user_id
             JOIN DEPARTMENT dept ON doc.department_id = dept.department_id
             WHERE ds.shift_date >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)
             ORDER BY ds.shift_date ASC, ds.start_time ASC`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch doctor shifts' });
    }
});

router.post('/doctor-shifts', async (req, res) => {
    const { doctor_id, shift_date, shift_type, start_time, end_time, is_on_duty = true } = req.body;
    if (!doctor_id || !shift_date || !shift_type) {
        return res.status(400).json({ error: 'Doctor, shift date, and shift type are required' });
    }
    try {
        const [result] = await mysqlPool.query(
            `INSERT INTO DOCTOR_SHIFT (doctor_id, shift_date, shift_type, start_time, end_time, is_on_duty)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                doctor_id,
                shift_date,
                shift_type,
                start_time || '08:00:00',
                end_time || '16:00:00',
                Boolean(is_on_duty)
            ]
        );
        res.status(201).json({ message: 'Doctor shift created', shift_id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create shift: ' + err.message });
    }
});

module.exports = router;
