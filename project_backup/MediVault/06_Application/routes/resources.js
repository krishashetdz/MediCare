// Shared operational screens: Blood Bank & Ambulance Fleet
const router = require('express').Router();
const { mysqlPool, getMongo } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { sendNotification } = require('../services/notificationService');

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

        // MongoDB Audit log
        try {
            await getMongo().collection('audit_log').insertOne({
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
            });
        } catch (_) {}

        // Notify Admin & Staff
        const alertMsg = priority === 'Emergency'
            ? `🚨 EMERGENCY BLOOD REQUEST: ${units} units of ${blood_group} urgently requested by ${req.session.user.name}. Reason: ${reason.slice(0, 50)}`
            : `Blood Request: ${units} units of ${blood_group} requested by ${req.session.user.name}`;
        
        await sendNotification({ role_name: 'Admin', message: alertMsg, event_type: 'blood_request' });

        res.status(201).json({
            message: 'Blood request recorded. Inventory remains unchanged until fulfilled.',
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
                message: `Your blood request for ${reqRow.units} units of ${reqRow.blood_group} has been approved. Awaiting pharmacy/lab issue.`,
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
            return res.status(404).json({ error: 'Request not found' });
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
// Blood Request: Fulfill & Deduct Inventory (Transactional)
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
            return res.status(400).json({ error: 'This blood request has already been fulfilled' });
        }
        if (reqRow.status === 'Rejected') {
            await conn.rollback();
            return res.status(400).json({ error: 'Cannot fulfill a rejected request' });
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
            "UPDATE BLOOD_REQUEST SET status = 'Fulfilled', fulfilled_at = NOW(), approved_by = COALESCE(approved_by, ?) WHERE request_id = ?",
            [req.session.user.id, req.params.id]
        );

        await conn.commit();

        // MongoDB Audit Log
        try {
            await getMongo().collection('audit_log').insertOne({
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
            });
        } catch (_) {}

        // Notify requester
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
// Ambulance Fleet & Dispatch
// -----------------------------------------------------------------------------
router.get('/ambulances', requireRole('Admin', 'Receptionist', 'Doctor', 'Nurse'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            'SELECT ambulance_id, vehicle_number, driver_name, driver_phone, status FROM AMBULANCE ORDER BY vehicle_number'
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load ambulances' });
    }
});

router.post('/ambulance/:id/dispatch', requireRole('Admin', 'Receptionist'), async (req, res) => {
    const { patient_name, pickup_location, destination, contact_phone } = req.body;
    if (![patient_name, pickup_location, destination, contact_phone].every(x => typeof x === 'string' && x.trim())) {
        return res.status(400).json({ error: 'Complete all dispatch fields (patient name, pickup, destination, contact phone)' });
    }

    try {
        const [result] = await mysqlPool.query(
            "UPDATE AMBULANCE SET status='On Duty' WHERE ambulance_id=? AND status='Available'",
            [req.params.id]
        );
        if (!result.affectedRows) {
            return res.status(409).json({ error: 'This ambulance is no longer available' });
        }

        const [[amb]] = await mysqlPool.query('SELECT vehicle_number, driver_name FROM AMBULANCE WHERE ambulance_id=?', [req.params.id]);

        // MongoDB Dispatch Log & Audit
        try {
            const mongo = getMongo();
            await mongo.collection('ambulance_dispatch_log').insertOne({
                ambulance_id: Number(req.params.id),
                vehicle_number: amb ? amb.vehicle_number : null,
                driver_name: amb ? amb.driver_name : null,
                patient_name: patient_name.trim(),
                pickup_location: pickup_location.trim(),
                destination: destination.trim(),
                contact_phone: contact_phone.trim(),
                dispatched_by: req.session.user.id,
                dispatched_at: new Date(),
                status: 'In Transit'
            });

            await mongo.collection('audit_log').insertOne({
                user_id: req.session.user.id,
                action: 'DISPATCH ambulance',
                table_affected: 'AMBULANCE',
                details: {
                    ambulance_id: Number(req.params.id),
                    patient_name: patient_name.trim(),
                    pickup_location: pickup_location.trim(),
                    destination: destination.trim(),
                    contact_phone: contact_phone.trim()
                },
                timestamp: new Date()
            });
        } catch (_) {}

        // Send Notification to Emergency Staff
        await sendNotification({
            role_name: 'Nurse',
            message: `Ambulance ${amb ? amb.vehicle_number : req.params.id} dispatched to ${pickup_location.trim()} for ${patient_name.trim()}.`,
            event_type: 'ambulance_dispatched'
        });

        res.json({ message: 'Ambulance dispatched successfully' });
    } catch (err) {
        console.error('Ambulance dispatch error:', err);
        res.status(500).json({ error: 'Failed to dispatch ambulance' });
    }
});

router.post('/ambulance/:id/release', requireRole('Admin', 'Receptionist', 'Nurse'), async (req, res) => {
    try {
        const [result] = await mysqlPool.query("UPDATE AMBULANCE SET status='Available' WHERE ambulance_id=?", [req.params.id]);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Ambulance not found' });
        }

        // Update MongoDB log
        try {
            await getMongo().collection('ambulance_dispatch_log').updateOne(
                { ambulance_id: Number(req.params.id), status: 'In Transit' },
                { $set: { status: 'Completed', completed_at: new Date() } },
                { sort: { dispatched_at: -1 } }
            );
        } catch (_) {}

        res.json({ message: 'Ambulance marked available' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to release ambulance' });
    }
});

module.exports = router;
