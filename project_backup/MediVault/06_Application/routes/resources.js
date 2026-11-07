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
            return res.status(400).json({ error: 'This blood request has already been fulfilled' });
        }
        if (reqRow.status === 'Rejected') {
            await conn.rollback();
            return res.status(400).json({ error: 'Cannot fulfill a rejected request' });
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
// Ambulance Fleet & Dispatch (Linked to EMERGENCY_CASE)
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

router.post('/ambulance/:id/dispatch', requireRole('Admin', 'Receptionist'), async (req, res) => {
    const {
        patient_name,
        pickup_location,
        destination = 'Hospital',
        contact_phone,
        case_id,
        initial_complaint,
        triage_priority = 'P2'
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

        // Resolve or link emergency case
        let linkedCaseId = case_id ? Number(case_id) : null;
        let linkedEmgNumber = null;

        if (linkedCaseId) {
            const [[existingCase]] = await conn.query(
                'SELECT case_id, emg_number FROM EMERGENCY_CASE WHERE case_id = ? FOR UPDATE',
                [linkedCaseId]
            );
            if (!existingCase) {
                await conn.rollback();
                return res.status(404).json({ error: 'Specified emergency case not found' });
            }
            linkedEmgNumber = existingCase.emg_number;
            await conn.query(
                "UPDATE EMERGENCY_CASE SET ambulance_id = ?, arrival_method = 'Ambulance' WHERE case_id = ?",
                [req.params.id, linkedCaseId]
            );
        } else {
            // Check if an active waiting case matches this patient name without an ambulance yet
            const [matchingCases] = await conn.query(
                `SELECT ec.case_id, ec.emg_number
                 FROM EMERGENCY_CASE ec
                 LEFT JOIN \`USER\` u ON ec.patient_id = u.user_id
                 WHERE ec.ambulance_id IS NULL
                   AND ec.status NOT IN ('Discharged', 'Transferred')
                   AND (ec.temp_patient_name = ? OR u.name = ?)
                 ORDER BY ec.arrival_time DESC LIMIT 1 FOR UPDATE`,
                [patient_name.trim(), patient_name.trim()]
            );

            if (matchingCases.length) {
                linkedCaseId = matchingCases[0].case_id;
                linkedEmgNumber = matchingCases[0].emg_number;
                await conn.query(
                    "UPDATE EMERGENCY_CASE SET ambulance_id = ?, arrival_method = 'Ambulance' WHERE case_id = ?",
                    [req.params.id, linkedCaseId]
                );
            } else {
                // Auto-create an incoming Emergency Case linked to this ambulance dispatch
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
                        emg_number, temp_patient_name, contact_phone, arrival_time, arrival_method,
                        ambulance_id, initial_complaint, triage_priority, status, department_id
                    ) VALUES (?, ?, ?, NOW(), 'Ambulance', ?, ?, ?, 'Waiting', ?)`,
                    [
                        linkedEmgNumber,
                        patient_name.trim(),
                        contact_phone.trim(),
                        Number(req.params.id),
                        (initial_complaint && initial_complaint.trim()) || `Ambulance dispatch pickup from ${pickup_location.trim()}`,
                        ['P1', 'P2', 'P3', 'P4'].includes(triage_priority) ? triage_priority : 'P2',
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

        // MongoDB Dispatch Log & Audit
        try {
            const mongo = getMongo();
            await mongo.collection('ambulance_dispatch_log').insertOne({
                dispatch_id: dispRes.insertId,
                ambulance_id: Number(req.params.id),
                case_id: linkedCaseId,
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
            });

            await mongo.collection('audit_log').insertOne({
                user_id: req.session.user.id,
                action: 'DISPATCH ambulance',
                table_affected: 'AMBULANCE',
                details: {
                    dispatch_id: dispRes.insertId,
                    ambulance_id: Number(req.params.id),
                    case_id: linkedCaseId,
                    emg_number: linkedEmgNumber,
                    patient_name: patient_name.trim(),
                    pickup_location: pickup_location.trim(),
                    destination: destination.trim(),
                    contact_phone: contact_phone.trim()
                },
                timestamp: new Date()
            });
        } catch (_) {}

        await sendNotification({
            role_name: 'Nurse',
            message: `Ambulance ${amb.vehicle_number} dispatched to ${pickup_location.trim()} for ${patient_name.trim()} (Case ${linkedEmgNumber || '#' + linkedCaseId}).`,
            event_type: 'ambulance_dispatched'
        });

        res.json({
            message: 'Ambulance dispatched successfully',
            dispatch_id: dispRes.insertId,
            case_id: linkedCaseId,
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

router.post('/ambulance/:id/release', requireRole('Admin', 'Receptionist', 'Nurse'), async (req, res) => {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query("UPDATE AMBULANCE SET status='Available' WHERE ambulance_id=?", [req.params.id]);
        if (!result.affectedRows) {
            await conn.rollback();
            return res.status(404).json({ error: 'Ambulance not found' });
        }

        await conn.query(
            "UPDATE AMBULANCE_DISPATCH SET status = 'Completed', completed_at = NOW() WHERE ambulance_id = ? AND status = 'In Transit'",
            [req.params.id]
        );
        await conn.commit();

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
        await conn.rollback();
        res.status(500).json({ error: 'Failed to release ambulance' });
    } finally {
        conn.release();
    }
});

module.exports = router;
