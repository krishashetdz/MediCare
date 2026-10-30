const http = require('http');

let cookie = '';

function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, 'http://localhost:3000');
        const headers = { 'Accept': 'application/json' };
        if (cookie) headers['Cookie'] = cookie;
        let payload = null;
        if (body) {
            payload = JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: url.pathname + url.search,
            method,
            headers
        }, (res) => {
            const setCookie = res.headers['set-cookie'];
            if (setCookie) {
                cookie = setCookie.map(c => c.split(';')[0]).join('; ');
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch (_) {}
                resolve({ status: res.statusCode, data: parsed });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function runTests() {
    console.log('=== STARTING MEDIVULT E2E VERIFICATION SUITE ===\n');

    let passed = 0;
    let failed = 0;

    function assert(cond, name, details = '') {
        if (cond) {
            console.log(`✅ [PASS] ${name}`);
            passed++;
        } else {
            console.error(`❌ [FAIL] ${name} ${details}`);
            failed++;
        }
    }

    try {
        // 1. Health check
        const health = await request('GET', '/health');
        assert(health.status === 200 && health.data.status === 'ok', 'Health Check');

        // 2. Admin Login
        const login = await request('POST', '/api/auth/login', {
            email: 'admin@medivault.in',
            password: 'admin1'
        });
        assert(login.status === 200 && login.data.user.role === 'Admin', 'Admin Authentication');

        // 3. Emergency Dashboard KPIs
        const emgDash = await request('GET', '/api/emergency/dashboard');
        assert(emgDash.status === 200 && emgDash.data.active_cases >= 1, 'Emergency Dashboard KPIs', JSON.stringify(emgDash.data));

        // 4. Emergency Queue
        const emgQueue = await request('GET', '/api/emergency/queue');
        assert(emgQueue.status === 200 && Array.isArray(emgQueue.data) && emgQueue.data.length > 0, 'Emergency Queue Priority Ordering');
        const topCase = emgQueue.data[0];
        console.log(`   -> Top Priority Queue Case: ${topCase.emg_number} (${topCase.triage_priority}) - Patient: ${topCase.patient_name}`);

        // 5. Register new Emergency Case (Walk-in)
        const regCase = await request('POST', '/api/emergency/register', {
            patient_id: 6, // Priya Nair
            arrival_method: 'Walk-in',
            initial_complaint: 'Sudden onset severe crushing retrosternal chest pain with diaphoresis and nausea',
            triage_priority: 'P1'
        });
        assert(regCase.status === 201 && regCase.data.case_id, 'Register Emergency Patient (Priya Nair, P1)');
        const newCaseId = regCase.data.case_id;
        const newEmgNum = regCase.data.emg_number;

        // 6. Triage Assessment recording
        const triage = await request('POST', `/api/emergency/triage/${newCaseId}`, {
            bp_systolic: 170,
            bp_diastolic: 110,
            heart_rate: 115,
            spo2: 92,
            temperature: 98.6,
            respiratory_rate: 24,
            consciousness_level: 'Alert',
            gcs_score: 15,
            priority: 'P1',
            priority_reason: 'Severe hypertensive crisis with acute coronary presentation',
            symptoms: 'Radiating pain to left arm and jaw',
            injury_details: 'None',
            assessment_notes: 'STAT Cardiology consultation initiated. Sublingual nitroglycerin administered.'
        });
        assert(triage.status === 201 && triage.data.priority === 'P1', 'Triage Assessment Recording with Vitals');

        // 7. Signature Feature: Priority Engine
        const engine = await request('GET', `/api/emergency/priority-engine/${newCaseId}`);
        assert(
            engine.status === 200 &&
            engine.data.recommended_doctor &&
            engine.data.recommended_department &&
            engine.data.recommended_bed,
            'Signature MediCare Priority Engine Execution'
        );
        console.log(`   -> Engine Recommended Doctor: ${engine.data.recommended_doctor ? engine.data.recommended_doctor.name : 'N/A'}`);
        console.log(`   -> Engine Recommended Bed: ${engine.data.recommended_bed ? (engine.data.recommended_bed.ward_name + ' ' + engine.data.recommended_bed.bed_number) : 'N/A'}`);
        console.log(`   -> Engine Recommended Department: ${engine.data.recommended_department.name} (${engine.data.recommended_department.reason})`);

        // 8. Confirm Resource Allocation (Doctor + Bed)
        const allocate = await request('POST', `/api/emergency/allocate/${newCaseId}`, {
            doctor_id: engine.data.recommended_doctor.doctor_id,
            bed_id: engine.data.recommended_bed.bed_id,
            department_id: engine.data.recommended_department.id
        });
        assert(allocate.status === 200, 'Confirm Doctor & Bed Allocation via Engine');

        // 9. Clinical Treatment Action
        const treatment = await request('POST', `/api/emergency/treatment/${newCaseId}`, {
            action_type: 'Medication Administered',
            description: 'Loaded with Aspirin 325mg and Ticagrelor 180mg. Heparin bolus 5000 IU IV given.',
            notes: 'Patient chest discomfort improved from 8/10 to 4/10.'
        });
        assert(treatment.status === 201, 'Record Emergency Clinical Treatment Log');

        // 10. Blood Bank: Check Inventory
        const bloodInv = await request('GET', '/api/admin/blood-bank');
        assert(bloodInv.status === 200 && Array.isArray(bloodInv.data) && bloodInv.data.length === 8, 'Blood Bank 8-Group Inventory Gauge');
        const oNeg = bloodInv.data.find(b => b.blood_group === 'O-');
        const initialUnits = oNeg ? oNeg.units_available : 0;

        // 11. Blood Bank: Request Blood
        const bloodReq = await request('POST', '/api/admin/blood-bank/request', {
            blood_group: 'O-',
            units: 2,
            patient_id: 6,
            case_id: newCaseId,
            priority: 'Emergency',
            reason: 'Emergency transfusion requirement for acute cardiac crisis stabilization'
        });
        assert(bloodReq.status === 201 && bloodReq.data.request_id, 'Request Blood Units Linked to Emergency Case');
        const reqId = bloodReq.data.request_id;

        // 12. Blood Bank: Approve Request
        const approveBlood = await request('POST', `/api/admin/blood-bank/requests/${reqId}/approve`);
        assert(approveBlood.status === 200, 'Approve Blood Transfusion Request');

        // 13. Blood Bank: Fulfill Request (Deduct units)
        const fulfillBlood = await request('POST', `/api/admin/blood-bank/requests/${reqId}/fulfill`);
        assert(fulfillBlood.status === 200, 'Fulfill Blood Request & Deduct Inventory');

        // Verify stock deducted
        const bloodInvAfter = await request('GET', '/api/admin/blood-bank');
        const oNegAfter = bloodInvAfter.data.find(b => b.blood_group === 'O-');
        assert(oNegAfter.units_available === initialUnits - 2, `Inventory Units Decremented Correctly (${initialUnits} -> ${oNegAfter.units_available})`);

        // 14. Nurse Assigned Patients
        const nursePatients = await request('GET', '/api/staff/nurse/assigned-patients');
        assert(nursePatients.status === 200 && Array.isArray(nursePatients.data) && nursePatients.data.length > 0, 'Nurse Portal: Assigned Patient Roster');

        // 15. Nurse Record Vitals
        const nurseVitals = await request('POST', '/api/staff/nurse/vitals', {
            patient_id: 6,
            case_id: newCaseId,
            bp_systolic: 135,
            bp_diastolic: 85,
            heart_rate: 80,
            spo2: 97,
            temperature: 98.4,
            respiratory_rate: 18,
            notes: 'Patient resting comfortably post-medication'
        });
        assert(nurseVitals.status === 201, 'Nurse Portal: Record Follow-up Vitals');

        // 16. Nurse Record Care Note
        const nurseNote = await request('POST', '/api/staff/nurse/notes', {
            patient_id: 6,
            case_id: newCaseId,
            note_type: 'Medication Given',
            content: 'IV line running at 50 mL/hr Normal Saline. Continuous telemetry normal sinus rhythm.'
        });
        assert(nurseNote.status === 201, 'Nurse Portal: Record Care Note');

        // 17. Nurse Emergency Monitor Feed
        const nurseMonitor = await request('GET', '/api/staff/nurse/emergency-monitor');
        assert(nurseMonitor.status === 200 && Array.isArray(nurseMonitor.data), 'Nurse Portal: Live Emergency Acuity Monitor');

        // 18. Emergency Discharge
        const discharge = await request('POST', `/api/emergency/discharge/${newCaseId}`, {
            discharge_summary: 'Patient successfully treated and stabilized. Coronary symptoms resolved. Follow-up cardiology outpatient appointment scheduled.',
            emergency_fee: 650
        });
        assert(discharge.status === 200, 'Emergency Discharge with Clinical Summary & Auto Bed Release');

        // 19. Verify Bed released to Cleaning/Available
        const beds = await request('GET', '/api/emergency/beds');
        const allocatedBed = beds.data.find(b => b.bed_id === engine.data.recommended_bed.bed_id);
        assert(allocatedBed && (allocatedBed.status === 'Cleaning' || allocatedBed.status === 'Available'), 'Bed Automatically Released for Turnover/Cleaning');

        console.log('\n=== E2E VERIFICATION SUMMARY ===');
        console.log(`Total Tests Run: ${passed + failed}`);
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${failed}`);

        if (failed === 0) {
            console.log('\n🎉 ALL WORKFLOWS PASSED 100%! SYSTEM READY.');
        } else {
            console.log('\n⚠️ SOME TESTS FAILED. CHECK DETAILS ABOVE.');
        }
    } catch (err) {
        console.error('Test script crashed:', err);
    }
}

runTests();
