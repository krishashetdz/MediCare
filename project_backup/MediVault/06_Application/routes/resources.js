// Shared operational screens: Blood Bank & Ambulance Fleet
const router = require('express').Router();
const { mysqlPool } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { sendNotification } = require('../services/notificationService');
const { recordCrossDbOperation } = require('../services/crossDbSync');

// -----------------------------------------------------------------------------
// Blood Bank Inventory
// -----------------------------------------------------------------------------
router.get('/blood-bank', requireRole('Admin', 'Doctor', 'Nurse'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            'SELECT blood_id, blood_group, units_available, last_updated FROM BLOOD_BANK ORDER BY blood_group'
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load blood bank inventory' });
    }
});

// -----------------------------------------------------------------------------
// Blood Requests: List All (Pending + History)
// -----------------------------------------------------------------------------
router.get('/blood-bank/requests', requireRole('Admin', 'Doctor', 'Nurse'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT 
                br.request_id,
                br.patient_id,
                br.case_id,
                br.blood_group,
                br.units,
                br.priority,
                br.reason,
                br.status,
                br.created_at,
                br.fulfilled_at,
                ur.name AS requested_by_name,
                COALESCE(ua.name, '--') AS approved_by_name,
                COALESCE(up.name, ec.temp_patient_name, 'Unknown Patient') AS patient_name,
                ec.emg_number
             FROM BLOOD_REQUEST br
             JOIN \`USER\` ur ON br.requested_by = ur.user_id
             LEFT JOIN \`USER\` ua ON br.approved_by = ua.user_id
             LEFT JOIN PATIENT p ON br.patient_id = p.patient_id
             LEFT JOIN \`USER\` up ON p.patient_id = up.user_id
             LEFT JOIN EMERGENCY_CASE ec ON br.case_id = ec.case_id
             ORDER BY 
                CASE WHEN br.status = 'Pending' THEN 1 
                     WHEN br.status = 'Approved' THEN 2 
                     ELSE 3 END,
                CASE WHEN br.priority = 'Emergency' THEN 1 
                     WHEN br.priority = 'Urgent' THEN 2 
                     ELSE 3 END,
                br.created_at DESC`
        );
        res.json(rows);
    } catch (err) {
        console.error('Blood request list error:', err);
        res.status(500).json({ error: 'Failed to fetch blood requests' });
    }
});

// -----------------------------------------------------------------------------
// Blood Request: Create Request
// -----------------------------------------------------------------------------
router.post('/blood-bank/request', requireRole('Admin', 'Doctor', 'Nurse'), async (req, res) => {
    const { blood_group, units, patient_id, case_id, priority = 'Normal', reason } = req.body;

    if (!['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].includes(blood_group) ||
        !Number.isInteger(Number(units)) || Number(units) < 1 || Number(units) > 10 ||
        !String(reason || '').trim()) {
        return res.status(400).json({ error: 'Valid blood group, units (1-10), and documented clinical reason are required' });
    }

    let pId = patient_id ? Number(patient_id) : null;
    let cId = case_id ? Number(case_id) : null;

    if (!pId && !cId) {
        return res.status(400).json({ error: 'Either Patient ID or Emergency Case ID must be provided' });
    }

    try {
        const [result] = await mysqlPool.query(
            `INSERT INTO BLOOD_REQUEST (patient_id, case_id, requested_by, blood_group, units, priority, reason, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
            [pId, cId, req.session.user.id, blood_group, Number(units), priority, reason.trim()]
        );

        await recordCrossDbOperation({
            idempotency_key: `AUDIT-BLOOD-REQ-${result.insertId}`,
            collection_name: 'audit_log',
            operation_type: 'insert',
            payload: {
                user_id: req.session.user.id,
                action: 'REQUEST blood',
                table_affected: 'BLOOD_BANK',
                details: {
                    request_id: result.insertId,
                    patient_id: pId,
                    case_id: cId,
                    blood_group,
                    units: Number(units),
                    priority,
                    reason: reason.trim()
                },
                timestamp: new Date()
            }
        });

        const alertMsg = priority === 'Emergency'
            ? `🚨 EMERGENCY BLOOD REQUEST: ${units} units of ${blood_group} urgently requested by ${req.session.user.name}. Reason: ${reason.slice(0, 50)}`
            : `Blood Request: ${units} units of ${blood_group} requested by ${req.session.user.name}`;

        await sendNotification({ role_name: 'Admin', message: alertMsg, event_type: 'blood_request' });

        res.status(201).json({
            message: 'Blood request recorded. Inventory remains unchanged until approved and fulfilled.',
            request_id: result.insertId
        });
    } catch (err) {
        console.error('Blood request error:', err);
        res.status(500).json({ error: 'Failed to record blood request: ' + err.message });
    }
});

// -----------------------------------------------------------------------------
// Blood Request: Approve Request
// -----------------------------------------------------------------------------
router.post('/blood-bank/requests/:id/approve', requireRole('Admin', 'Doctor'), async (req, res) => {
    try {
        const [result] = await mysqlPool.query(
            "UPDATE BLOOD_REQUEST SET status='Approved', approved_by=? WHERE request_id=? AND status='Pending'",
            [req.session.user.id, req.params.id]
        );
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Pending request not found' });
        }

        const [[reqRow]] = await mysqlPool.query('SELECT requested_by, blood_group, units FROM BLOOD_REQUEST WHERE request_id=?', [req.params.id]);
        if (reqRow) {
            await sendNotification({
                user_id: reqRow.requested_by,
                message: `Your blood request for ${reqRow.units} units of ${reqRow.blood_group} has been approved. Ready for issuance.`,
                event_type: 'blood_approved'
            });
        }

        res.json({ message: 'Blood request approved' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to approve request' });
    }
});

// -----------------------------------------------------------------------------
// Blood Request: Reject Request
// -----------------------------------------------------------------------------
router.post('/blood-bank/requests/:id/reject', requireRole('Admin', 'Doctor'), async (req, res) => {
    try {
        const [result] = await mysqlPool.query(
            "UPDATE BLOOD_REQUEST SET status='Rejected', approved_by=? WHERE request_id=? AND status IN ('Pending', 'Approved')",
            [req.session.user.id, req.params.id]
        );
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Request not found or already fulfilled' });
        }

        const [[reqRow]] = await mysqlPool.query('SELECT requested_by, blood_group, units FROM BLOOD_REQUEST WHERE request_id=?', [req.params.id]);
        if (reqRow) {
            await sendNotification({
                user_id: reqRow.requested_by,
                message: `Your blood request for ${reqRow.units} units of ${reqRow.blood_group} was rejected.`,
                event_type: 'blood_rejected'
            });
        }

        res.json({ message: 'Blood request rejected' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reject request' });
    }
});

// -----------------------------------------------------------------------------
// Blood Request: Fulfill & Deduct Inventory (Transactional; requires Approved status)
// -----------------------------------------------------------------------------
router.post('/blood-bank/requests/:id/fulfill', requireRole('Admin', 'Doctor', 'Nurse'), async (req, res) => {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [[reqRow]] = await conn.query(
            'SELECT * FROM BLOOD_REQUEST WHERE request_id = ? FOR UPDATE',
            [req.params.id]
        );
        if (!reqRow) {
            await conn.rollback();
            return res.status(404).json({ error: 'Blood request not found' });
        }
        if (reqRow.status === 'Fulfilled') {
            await conn.rollback();
            return res.status(409).json({ error: 'This blood request has already been fulfilled' });
        }
        if (reqRow.status === 'Rejected') {
            await conn.rollback();
            return res.status(409).json({ error: 'Cannot fulfill a rejected request' });
        }
        if (reqRow.status !== 'Approved') {
            await conn.rollback();
            return res.status(409).json({ error: 'Blood request must be Approved before it can be fulfilled' });
        }

        // Check inventory
        const [[bankRow]] = await conn.query(
            'SELECT units_available FROM BLOOD_BANK WHERE blood_group = ? FOR UPDATE',
            [reqRow.blood_group]
        );
        if (!bankRow || bankRow.units_available < reqRow.units) {
            await conn.rollback();
            return res.status(409).json({
                error: `Insufficient inventory for blood group ${reqRow.blood_group}. Available: ${bankRow ? bankRow.units_available : 0}, Requested: ${reqRow.units}`
            });
        }

        // Deduct inventory
        await conn.query(
            'UPDATE BLOOD_BANK SET units_available = units_available - ?, last_updated = NOW() WHERE blood_group = ?',
            [reqRow.units, reqRow.blood_group]
        );

        // Mark request fulfilled
        await conn.query(
            "UPDATE BLOOD_REQUEST SET status = 'Fulfilled', fulfilled_at = NOW() WHERE request_id = ?",
            [req.params.id]
        );

        await conn.commit();

        await recordCrossDbOperation({
            idempotency_key: `AUDIT-BLOOD-FULFILL-${req.params.id}`,
            collection_name: 'audit_log',
            operation_type: 'insert',
            payload: {
                user_id: req.session.user.id,
                action: 'FULFILL blood request',
                table_affected: 'BLOOD_BANK',
                details: {
                    request_id: Number(req.params.id),
                    blood_group: reqRow.blood_group,
                    units_deducted: reqRow.units,
                    fulfilled_by: req.session.user.id
                },
                timestamp: new Date()
            }
        });

        await sendNotification({
            user_id: reqRow.requested_by,
            message: `Blood units issued: ${reqRow.units} unit(s) of ${reqRow.blood_group} fulfilled successfully.`,
            event_type: 'blood_fulfilled'
        });

        res.json({ message: `Successfully issued ${reqRow.units} unit(s) of ${reqRow.blood_group}. Inventory updated.` });
    } catch (err) {
        await conn.rollback();
        console.error('Blood fulfillment error:', err);
        res.status(500).json({ error: 'Failed to fulfill blood request: ' + err.message });
    } finally {
        conn.release();
    }
});

// -----------------------------------------------------------------------------
// Ambulance Fleet, Registration, Driver Assignment & Dispatch
// -----------------------------------------------------------------------------
router.get('/ambulances', requireRole('Admin', 'Receptionist', 'Doctor', 'Nurse'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            `SELECT a.ambulance_id, a.vehicle_number, a.driver_name, a.driver_phone, a.status,
                    ad.dispatch_id, ad.case_id, ec.emg_number, ad.patient_name AS dispatch_patient_name, ad.pickup_location
             FROM AMBULANCE a
             LEFT JOIN AMBULANCE_DISPATCH ad ON a.ambulance_id = ad.ambulance_id AND ad.status = 'In Transit'
             LEFT JOIN EMERGENCY_CASE ec ON ad.case_id = ec.case_id
             ORDER BY a.vehicle_number`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load ambulances' });
    }
});

// Register a new ambulance vehicle in the fleet (TEST H: Register ambulance)
router.post('/ambulances', requireRole('Admin', 'Receptionist'), async (req, res) => {
    const { vehicle_number, driver_name, driver_phone, status = 'Available' } = req.body;
    if (!vehicle_number || typeof vehicle_number !== 'string' || !vehicle_number.trim()) {
        return res.status(400).json({ error: 'vehicle_number is required' });
    }
    const cleanVehicle = vehicle_number.trim().toUpperCase();
    const validStatus = ['Available', 'On Duty', 'Maintenance'].includes(status) ? status : 'Available';

    try {
        const [existing] = await mysqlPool.query(
            'SELECT ambulance_id FROM AMBULANCE WHERE vehicle_number = ? LIMIT 1',
            [cleanVehicle]
        );
        if (existing.length > 0) {
            return res.status(409).json({ error: `Ambulance with vehicle number ${cleanVehicle} is already registered` });
        }

        const [ins] = await mysqlPool.query(
            'INSERT INTO AMBULANCE (vehicle_number, driver_name, driver_phone, status) VALUES (?, ?, ?, ?)',
            [
                cleanVehicle,
                driver_name ? String(driver_name).trim() : null,
                driver_phone ? String(driver_phone).trim() : null,
                validStatus
            ]
        );

        await recordCrossDbOperation({
            idempotency_key: `AUDIT-AMB-REGISTER-${ins.insertId}`,
            collection_name: 'audit_log',
            operation_type: 'insert',
            payload: {
                user_id: req.session.user.id,
                action: 'REGISTER ambulance',
                table_affected: 'AMBULANCE',
                details: {
                    ambulance_id: ins.insertId,
                    vehicle_number: cleanVehicle,
                    driver_name: driver_name ? String(driver_name).trim() : null,
                    status: validStatus
                },
                timestamp: new Date()
            }
        });

        res.status(201).json({
            message: 'Ambulance registered successfully',
            ambulance_id: ins.insertId,
            vehicle_number: cleanVehicle,
            driver_name: driver_name ? String(driver_name).trim() : null,
            driver_phone: driver_phone ? String(driver_phone).trim() : null,
            status: validStatus
        });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: `Ambulance with vehicle number ${cleanVehicle} is already registered` });
        }
        res.status(500).json({ error: 'Failed to register ambulance: ' + err.message });
    }
});

// Assign or update driver / status on an existing ambulance (TEST H: Assign driver)
router.patch('/ambulance/:id', requireRole('Admin', 'Receptionist'), async (req, res) => {
    const { driver_name, driver_phone, status } = req.body;
    const [[amb]] = await mysqlPool.query('SELECT * FROM AMBULANCE WHERE ambulance_id = ?', [req.params.id]);
    if (!amb) {
        return res.status(404).json({ error: 'Ambulance not found' });
    }

    const updatedDriver = driver_name !== undefined ? (driver_name ? String(driver_name).trim() : null) : amb.driver_name;
    const updatedPhone = driver_phone !== undefined ? (driver_phone ? String(driver_phone).trim() : null) : amb.driver_phone;
    const updatedStatus = status && ['Available', 'On Duty', 'Maintenance'].includes(status) ? status : amb.status;

    await mysqlPool.query(
        'UPDATE AMBULANCE SET driver_name = ?, driver_phone = ?, status = ? WHERE ambulance_id = ?',
        [updatedDriver, updatedPhone, updatedStatus, req.params.id]
    );

    res.json({
        message: 'Ambulance updated successfully',
        ambulance_id: Number(req.params.id),
        vehicle_number: amb.vehicle_number,
        driver_name: updatedDriver,
        driver_phone: updatedPhone,
        status: updatedStatus
    });
});

router.post('/ambulance/:id/dispatch', requireRole('Admin', 'Receptionist'), async (req, res) => {
    const {
        patient_name,
        patient_id,
        pickup_location,
        destination = 'Hospital',
        contact_phone,
        case_id,
        initial_complaint
    } = req.body;

    if (![patient_name, pickup_location, destination, contact_phone].every(x => typeof x === 'string' && x.trim())) {
        return res.status(400).json({ error: 'Complete all dispatch fields (patient name, pickup, destination, contact phone)' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [ambRows] = await conn.query(
            "SELECT * FROM AMBULANCE WHERE ambulance_id = ? FOR UPDATE",
            [req.params.id]
        );
        if (!ambRows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Ambulance not found' });
        }
        const amb = ambRows[0];
        if (amb.status !== 'Available') {
            await conn.rollback();
            return res.status(409).json({ error: 'This ambulance is no longer available' });
        }

        // Resolve or link emergency case (without creating duplicate patient rows)
        let linkedCaseId = case_id ? Number(case_id) : null;
        let linkedEmgNumber = null;
        let resolvedPatientId = patient_id ? Number(patient_id) : null;

        if (!resolvedPatientId) {
            const [[existingPatient]] = await conn.query(
                `SELECT p.patient_id FROM PATIENT p JOIN \`USER\` u ON p.patient_id = u.user_id
                 WHERE u.name = ? OR (u.phone IS NOT NULL AND u.phone = ?) LIMIT 1`,
                [patient_name.trim(), contact_phone.trim()]
            );
            resolvedPatientId = existingPatient ? existingPatient.patient_id : null;
        }

        if (linkedCaseId) {
            const [[existingCase]] = await conn.query(
                'SELECT case_id, emg_number, patient_id FROM EMERGENCY_CASE WHERE case_id = ? FOR UPDATE',
                [linkedCaseId]
            );
            if (!existingCase) {
                await conn.rollback();
                return res.status(404).json({ error: 'Specified emergency case not found' });
            }
            linkedEmgNumber = existingCase.emg_number;
            await conn.query(
                "UPDATE EMERGENCY_CASE SET ambulance_id = ?, arrival_method = 'Ambulance', patient_id = COALESCE(patient_id, ?) WHERE case_id = ?",
                [req.params.id, resolvedPatientId, linkedCaseId]
            );
        } else {
            // Check if an active waiting case matches this patient without an ambulance yet
            const [matchingCases] = await conn.query(
                `SELECT ec.case_id, ec.emg_number
                 FROM EMERGENCY_CASE ec
                 LEFT JOIN \`USER\` u ON ec.patient_id = u.user_id
                 WHERE ec.ambulance_id IS NULL
                   AND ec.status NOT IN ('Discharged', 'Transferred')
                   AND (ec.temp_patient_name = ? OR u.name = ? OR (? IS NOT NULL AND ec.patient_id = ?))
                 ORDER BY ec.arrival_time DESC LIMIT 1 FOR UPDATE`,
                [patient_name.trim(), patient_name.trim(), resolvedPatientId, resolvedPatientId]
            );

            if (matchingCases.length) {
                linkedCaseId = matchingCases[0].case_id;
                linkedEmgNumber = matchingCases[0].emg_number;
                await conn.query(
                    "UPDATE EMERGENCY_CASE SET ambulance_id = ?, arrival_method = 'Ambulance', patient_id = COALESCE(patient_id, ?) WHERE case_id = ?",
                    [req.params.id, resolvedPatientId, linkedCaseId]
                );
            } else {
                // Auto-create an incoming Emergency Case linked to this ambulance dispatch
                // Marked as Pending_Triage / UNASSESSED until nurse triage is completed on arrival
                const currentYear = new Date().getFullYear();
                await conn.query(
                    'INSERT INTO EMERGENCY_SEQUENCE (seq_year, last_val) VALUES (?, 0) ON DUPLICATE KEY UPDATE last_val = last_val',
                    [currentYear]
                );
                const [[seqRow]] = await conn.query(
                    'SELECT last_val FROM EMERGENCY_SEQUENCE WHERE seq_year = ? FOR UPDATE',
                    [currentYear]
                );
                const nextSeq = (seqRow ? seqRow.last_val : 0) + 1;
                await conn.query(
                    'UPDATE EMERGENCY_SEQUENCE SET last_val = ? WHERE seq_year = ?',
                    [nextSeq, currentYear]
                );
                linkedEmgNumber = `EMG-${currentYear}-${String(nextSeq).padStart(3, '0')}`;

                const [[emgDept]] = await conn.query(
                    "SELECT department_id FROM DEPARTMENT WHERE department_name = 'Emergency Medicine' LIMIT 1"
                );
                const [caseIns] = await conn.query(
                    `INSERT INTO EMERGENCY_CASE (
                        emg_number, patient_id, temp_patient_name, contact_phone, arrival_time, arrival_method,
                        ambulance_id, initial_complaint, triage_priority, assessment_status, status, department_id
                    ) VALUES (?, ?, ?, ?, NOW(), 'Ambulance', ?, ?, 'UNASSESSED', 'Pending_Triage', 'Waiting', ?)`,
                    [
                        linkedEmgNumber,
                        resolvedPatientId,
                        resolvedPatientId ? null : patient_name.trim(),
                        contact_phone.trim(),
                        Number(req.params.id),
                        (initial_complaint && initial_complaint.trim()) || `Ambulance dispatch pickup from ${pickup_location.trim()}`,
                        emgDept ? emgDept.department_id : null
                    ]
                );
                linkedCaseId = caseIns.insertId;
            }
        }

        await conn.query("UPDATE AMBULANCE SET status = 'On Duty' WHERE ambulance_id = ?", [req.params.id]);

        const [dispRes] = await conn.query(
            `INSERT INTO AMBULANCE_DISPATCH (
                ambulance_id, case_id, patient_name, pickup_location, destination, contact_phone, dispatched_by, status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'In Transit')`,
            [
                Number(req.params.id),
                linkedCaseId,
                patient_name.trim(),
                pickup_location.trim(),
                destination.trim(),
                contact_phone.trim(),
                req.session.user.id
            ]
        );

        await conn.commit();

        await recordCrossDbOperation({
            idempotency_key: `AMB-DISPATCH-${dispRes.insertId}`,
            collection_name: 'ambulance_dispatch_log',
            operation_type: 'upsert',
            filter: { dispatch_id: dispRes.insertId },
            payload: {
                dispatch_id: dispRes.insertId,
                ambulance_id: Number(req.params.id),
                case_id: linkedCaseId,
                patient_id: resolvedPatientId,
                emg_number: linkedEmgNumber,
                vehicle_number: amb.vehicle_number,
                driver_name: amb.driver_name,
                patient_name: patient_name.trim(),
                pickup_location: pickup_location.trim(),
                destination: destination.trim(),
                contact_phone: contact_phone.trim(),
                dispatched_by: req.session.user.id,
                dispatched_at: new Date(),
                status: 'In Transit'
            }
        });

        await recordCrossDbOperation({
            idempotency_key: `AUDIT-AMB-DISPATCH-${dispRes.insertId}`,
            collection_name: 'audit_log',
            operation_type: 'insert',
            payload: {
                user_id: req.session.user.id,
                action: 'DISPATCH ambulance',
                table_affected: 'AMBULANCE',
                details: {
                    dispatch_id: dispRes.insertId,
                    ambulance_id: Number(req.params.id),
                    case_id: linkedCaseId,
                    patient_id: resolvedPatientId,
                    emg_number: linkedEmgNumber,
                    patient_name: patient_name.trim(),
                    pickup_location: pickup_location.trim(),
                    destination: destination.trim(),
                    contact_phone: contact_phone.trim()
                },
                timestamp: new Date()
            }
        });

        await sendNotification({
            role_name: 'Nurse',
            message: `Ambulance ${amb.vehicle_number} dispatched to ${pickup_location.trim()} for ${patient_name.trim()} (Case ${linkedEmgNumber || '#' + linkedCaseId}).`,
            event_type: 'ambulance_dispatched'
        });

        res.json({
            message: 'Ambulance dispatched successfully',
            dispatch_id: dispRes.insertId,
            case_id: linkedCaseId,
            patient_id: resolvedPatientId,
            emg_number: linkedEmgNumber
        });
    } catch (err) {
        await conn.rollback();
        console.error('Ambulance dispatch error:', err);
        res.status(500).json({ error: 'Failed to dispatch ambulance' });
    } finally {
        conn.release();
    }
});

// Record ambulance arrival at hospital & link patient/case (TEST H: Record arrival)
router.post('/ambulance/:id/arrive', requireRole('Admin', 'Receptionist', 'Nurse'), async (req, res) => {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [[amb]] = await conn.query('SELECT * FROM AMBULANCE WHERE ambulance_id = ? FOR UPDATE', [req.params.id]);
        if (!amb) {
            await conn.rollback();
            return res.status(404).json({ error: 'Ambulance not found' });
        }

        const [[activeDispatch]] = await conn.query(
            "SELECT * FROM AMBULANCE_DISPATCH WHERE ambulance_id = ? AND status = 'In Transit' ORDER BY dispatched_at DESC LIMIT 1 FOR UPDATE",
            [req.params.id]
        );
        if (!activeDispatch) {
            await conn.rollback();
            return res.status(409).json({ error: 'No active in-transit dispatch found for this ambulance' });
        }

        await conn.query(
            "UPDATE AMBULANCE_DISPATCH SET status = 'Completed', completed_at = NOW() WHERE dispatch_id = ?",
            [activeDispatch.dispatch_id]
        );
        await conn.query("UPDATE AMBULANCE SET status = 'Available' WHERE ambulance_id = ?", [req.params.id]);

        if (activeDispatch.case_id) {
            await conn.query(
                'UPDATE EMERGENCY_CASE SET arrival_time = NOW() WHERE case_id = ?',
                [activeDispatch.case_id]
            );
        }

        await conn.commit();

        await recordCrossDbOperation({
            idempotency_key: `AMB-ARRIVE-${activeDispatch.dispatch_id}`,
            collection_name: 'ambulance_dispatch_log',
            operation_type: 'upsert',
            filter: { dispatch_id: activeDispatch.dispatch_id },
            payload: {
                dispatch_id: activeDispatch.dispatch_id,
                ambulance_id: Number(req.params.id),
                case_id: activeDispatch.case_id,
                status: 'Completed',
                completed_at: new Date()
            }
        });

        res.json({
            message: 'Ambulance arrival recorded and vehicle returned to Available status',
            dispatch_id: activeDispatch.dispatch_id,
            case_id: activeDispatch.case_id,
            ambulance_status: 'Available'
        });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Failed to record ambulance arrival' });
    } finally {
        conn.release();
    }
});

router.post('/ambulance/:id/release', requireRole('Admin', 'Receptionist', 'Nurse'), async (req, res) => {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query("UPDATE AMBULANCE SET status='Available' WHERE ambulance_id=?", [req.params.id]);
        if (!result.affectedRows) {
            await conn.rollback();
            return res.status(404).json({ error: 'Ambulance not found' });
        }

        const [[activeDispatch]] = await conn.query(
            "SELECT dispatch_id, case_id FROM AMBULANCE_DISPATCH WHERE ambulance_id = ? AND status = 'In Transit' ORDER BY dispatched_at DESC LIMIT 1 FOR UPDATE",
            [req.params.id]
        );

        await conn.query(
            "UPDATE AMBULANCE_DISPATCH SET status = 'Completed', completed_at = NOW() WHERE ambulance_id = ? AND status = 'In Transit'",
            [req.params.id]
        );
        await conn.commit();

        if (activeDispatch) {
            await recordCrossDbOperation({
                idempotency_key: `AMB-RELEASE-${activeDispatch.dispatch_id}`,
                collection_name: 'ambulance_dispatch_log',
                operation_type: 'upsert',
                filter: { dispatch_id: activeDispatch.dispatch_id },
                payload: {
                    dispatch_id: activeDispatch.dispatch_id,
                    ambulance_id: Number(req.params.id),
                    case_id: activeDispatch.case_id,
                    status: 'Completed',
                    completed_at: new Date()
                }
            });
        }

        res.json({ message: 'Ambulance marked available' });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Failed to release ambulance' });
    } finally {
        conn.release();
    }
});

module.exports = router;
