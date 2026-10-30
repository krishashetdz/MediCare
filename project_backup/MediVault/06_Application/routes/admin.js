const express = require('express');
const { mysqlPool } = require('../config/db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('Admin'));

// Stat cards -- pulls straight from the Phase 3/4 dashboard queries and views.
router.get('/dashboard', async (req, res) => {
    try {
        const [[patients]] = await mysqlPool.query('SELECT COUNT(*) AS total_patients FROM PATIENT');
        const [[doctors]] = await mysqlPool.query('SELECT COUNT(*) AS total_doctors FROM DOCTOR');
        const [[appts]] = await mysqlPool.query('SELECT COUNT(*) AS total_appointments FROM APPOINTMENT');
        const [[beds]] = await mysqlPool.query("SELECT COUNT(*) AS available_beds FROM BED WHERE status='Available'");
        const [[pendingLab]] = await mysqlPool.query("SELECT COUNT(*) AS pending_lab_reports FROM LAB_REQUEST WHERE status='Pending'");
        const [[lowStock]] = await mysqlPool.query('SELECT COUNT(*) AS low_stock_medicines FROM MEDICINE WHERE stock_qty < 20');
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

// ---- CRUD template: Doctors. Departments/Beds/Pharmacy/Billing/Ambulance/
// Blood Bank management all follow this exact same list/create/update/delete
// shape against their own table -- shown once here rather than 6x repeated. ----

router.get('/doctors', async (req, res) => {
    const [rows] = await mysqlPool.query(
        `SELECT doc.doctor_id, u.name, u.email, dep.department_name, doc.specialization, doc.consultation_fee
         FROM DOCTOR doc JOIN \`USER\` u ON doc.doctor_id = u.user_id
         JOIN DEPARTMENT dep ON doc.department_id = dep.department_id`
    );
    res.json(rows);
});

router.post('/doctors', async (req, res) => {
    const { name, email, password_hash, department_id, specialization, qualification, consultation_fee } = req.body;
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [roleRow] = await conn.query("SELECT role_id FROM ROLE WHERE role_name='Doctor'");
        const [userResult] = await conn.query(
            'INSERT INTO `USER` (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)',
            [name, email, password_hash, roleRow[0].role_id]
        );
        await conn.query(
            'INSERT INTO DOCTOR (doctor_id, department_id, specialization, qualification, consultation_fee) VALUES (?, ?, ?, ?, ?)',
            [userResult.insertId, department_id, specialization, qualification, consultation_fee]
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
        // deleting the USER row cascades to DOCTOR (ON DELETE CASCADE, Phase 2)
        await mysqlPool.query('DELETE FROM `USER` WHERE user_id=?', [req.params.id]);
        res.json({ message: 'Doctor removed' });
    } catch (err) {
        // e.g. FK RESTRICT from APPOINTMENT/PRESCRIPTION/etc if this doctor has history
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

// Emergency cases count -- pulls real active emergency cases from EMERGENCY_CASE
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

// Patient search for bed assignment
router.get('/patients', requireRole('Admin'), async (req, res) => {
    try {
        const q = req.query.q || '';
        if (q.length < 2) return res.json([]);
        const [rows] = await mysqlPool.query(
            `SELECT p.patient_id, u.name, u.email, u.phone, p.blood_group
             FROM PATIENT p JOIN \`USER\` u ON p.patient_id = u.user_id
             WHERE u.name LIKE ? OR u.email LIKE ?
             LIMIT 20`,
            ['%' + q + '%', '%' + q + '%']
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to search patients' });
    }
});

// Bed management
router.get('/beds', requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist', 'Staff'), async (req, res) => {
    try {
        let sql = `SELECT b.bed_id, b.ward_name, b.bed_number, b.status,
                   u.name AS patient_name, u.phone AS patient_phone, p.blood_group AS patient_blood_group
                   FROM BED b
                   LEFT JOIN PATIENT p ON b.patient_id = p.patient_id
                   LEFT JOIN \`USER\` u ON p.patient_id = u.user_id`;
        const params = [];
        if (req.query.ward) {
            sql += ' WHERE b.ward_name = ?';
            params.push(req.query.ward);
        }
        sql += ' ORDER BY b.ward_name, b.bed_number';
        const [rows] = await mysqlPool.query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch beds' });
    }
});

router.get('/beds/:id', requireRole('Admin'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT b.bed_id, b.ward_name, b.bed_number, b.status,
             u.name AS patient_name, u.phone AS patient_phone, p.blood_group AS patient_blood_group
             FROM BED b
             LEFT JOIN PATIENT p ON b.patient_id = p.patient_id
             LEFT JOIN \`USER\` u ON p.patient_id = u.user_id
             WHERE b.bed_id = ?`,
            [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Bed not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch bed' });
    }
});

router.patch('/beds/:id', requireRole('Admin'), async (req, res) => {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const { patient_id, status } = req.body;

        // Concurrency locking: Acquire row lock with SELECT ... FOR UPDATE (Bug 5 fix)
        const [beds] = await conn.query('SELECT * FROM BED WHERE bed_id = ? FOR UPDATE', [req.params.id]);
        if (!beds.length) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({ error: 'Bed not found' });
        }
        const currentBed = beds[0];

        // Concurrency check: If attempting to assign an already occupied bed to a different patient
        if (status === 'Occupied' && currentBed.status === 'Occupied' && currentBed.patient_id && Number(currentBed.patient_id) !== Number(patient_id)) {
            await conn.rollback();
            conn.release();
            return res.status(409).json({ error: `Concurrency conflict: Bed ${currentBed.bed_number} is already occupied by patient #${currentBed.patient_id}` });
        }

        const newPatientId = (status === 'Available' || status === 'Cleaning' || status === 'Maintenance') ? null : (patient_id || currentBed.patient_id);
        const newStatus = status || (newPatientId ? 'Occupied' : 'Available');

        await conn.query(
            'UPDATE BED SET patient_id = ?, status = ? WHERE bed_id = ?',
            [newPatientId, newStatus, req.params.id]
        );

        // Record admission if being occupied
        if (newStatus === 'Occupied' && newPatientId && currentBed.status !== 'Occupied') {
            await conn.query(
                'INSERT INTO ADMISSION (patient_id, bed_id, admission_date, status) VALUES (?, ?, NOW(), "Active")',
                [newPatientId, req.params.id]
            );
        } else if (newStatus === 'Available' || newStatus === 'Cleaning') {
            // Discharge active admission if any
            await conn.query(
                'UPDATE ADMISSION SET discharge_date = NOW(), status = "Discharged" WHERE bed_id = ? AND status = "Active"',
                [req.params.id]
            );
        }

        await conn.commit();
        conn.release();

        // Audit log in MongoDB
        try {
            const mongo = getMongo();
            await mongo.collection('audit_log').insertOne({
                event: 'bed_allocation_updated',
                bed_id: Number(req.params.id),
                bed_number: currentBed.bed_number,
                ward_name: currentBed.ward_name,
                previous_status: currentBed.status,
                previous_patient_id: currentBed.patient_id,
                new_status: newStatus,
                new_patient_id: newPatientId,
                updated_by: req.session.user.id,
                updated_at: new Date()
            });
        } catch (mongoErr) {
            console.warn('MongoDB audit_log write failed (non-fatal):', mongoErr.message);
        }

        res.json({ message: 'Bed updated successfully', bed_id: req.params.id, status: newStatus, patient_id: newPatientId });
    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error('Error updating bed:', err);
        res.status(500).json({ error: 'Failed to update bed' });
    }
});

// Appointments grouped by department (for bar chart)
router.get('/appointments/by-department', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT d.department_name, COUNT(a.appointment_id) as count
             FROM DEPARTMENT d LEFT JOIN APPOINTMENT a ON d.department_id = a.department_id
             GROUP BY d.department_id, d.department_name
             ORDER BY count DESC`
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load appointments by department' });
    }
});

// Recent appointments list (limit param, defaults to 10; optional status filter)
router.get('/appointments', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const status = req.query.status || '';
        let sql = `SELECT a.appointment_id, up.name as patient_name, ud.name as doctor_name,
                        dep.department_name, a.appointment_date, a.appointment_time, a.status
                 FROM APPOINTMENT a
                 JOIN PATIENT p ON a.patient_id = p.patient_id JOIN \`USER\` up ON p.patient_id = up.user_id
                 JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id JOIN \`USER\` ud ON doc.doctor_id = ud.user_id
                 JOIN DEPARTMENT dep ON a.department_id = dep.department_id`;
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

// Blood bank inventory
router.get('/blood-bank', requireRole('Admin'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        'SELECT blood_id, blood_group, units_available, last_updated FROM BLOOD_BANK ORDER BY blood_group'
    );
    res.json(rows);
});

// Ambulance fleet
router.get('/ambulances', requireRole('Admin'), async (req, res) => {
    const [rows] = await mysqlPool.query(
        'SELECT ambulance_id, vehicle_number, driver_name, driver_phone, status FROM AMBULANCE ORDER BY vehicle_number'
    );
    res.json(rows);
});

router.post('/ambulance/:id/dispatch', requireRole('Admin'), async (req, res) => {
    const { patient_name, pickup_location, destination, contact_phone } = req.body;
    // Phase 5: INSERT into MongoDB ambulance_dispatch_log {ambulance_id, patient_name, pickup_location, destination, contact_phone, dispatched_at}
    await mysqlPool.query("UPDATE AMBULANCE SET status='On Duty' WHERE ambulance_id=?", [req.params.id]);
    res.json({ message: 'Ambulance dispatched' });
});

router.post('/ambulance/:id/release', requireRole('Admin'), async (req, res) => {
    await mysqlPool.query("UPDATE AMBULANCE SET status='Available' WHERE ambulance_id=?", [req.params.id]);
    res.json({ message: 'Ambulance released' });
});

// ---- All patients (for admin-patients.html) ----
router.get('/patients/all', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT p.patient_id, u.name, u.email, u.phone, u.is_active,
                    p.blood_group, p.dob, p.gender, p.allergies
             FROM PATIENT p JOIN \`USER\` u ON p.patient_id = u.user_id
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
        let sql = `SELECT u.user_id, u.name, u.email, u.phone, r.role_name, u.is_active
                   FROM \`USER\` u JOIN ROLE r ON u.role_id = r.role_id
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
