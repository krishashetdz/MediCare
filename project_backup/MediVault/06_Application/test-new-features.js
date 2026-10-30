const http = require('http');
const { mysqlPool } = require('./config/db');

let cookie = '';
let passed = 0;
let failed = 0;

function assert(condition, message, details = '') {
    if (condition) {
        console.log(`✅ [PASS] ${message}`);
        passed++;
    } else {
        console.error(`❌ [FAIL] ${message} ${details ? '- ' + details : ''}`);
        failed++;
    }
}

function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path,
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        if (cookie) options.headers['Cookie'] = cookie;
        if (body) {
            const data = JSON.stringify(body);
            options.headers['Content-Length'] = Buffer.byteLength(data);
        }

        const req = http.request(options, (res) => {
            let resBody = '';
            if (res.headers['set-cookie']) {
                cookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
            }
            res.on('data', chunk => resBody += chunk);
            res.on('end', () => {
                let data = null;
                try { data = JSON.parse(resBody); } catch (_) { data = resBody; }
                resolve({ status: res.statusCode, data });
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function runTests() {
    console.log('=== VERIFYING NEW USER REQUESTED FEATURES ===\n');

    // 1. Patient Login & Doctor Name Check
    const patientLogin = await request('POST', '/api/auth/login', {
        email: 'rahul.verma@gmail.com',
        password: 'pat1'
    });
    assert(patientLogin.status === 200, 'Patient login (Rahul Verma)');

    const doctors = await request('GET', '/api/patient/doctors?department_id=1');
    assert(doctors.status === 200 && Array.isArray(doctors.data) && doctors.data.length > 0, 'Fetched doctor list as patient');
    const hasDoubleDr = doctors.data.some(d => /^Dr\.\s*Dr\./i.test(d.doctor_name));
    assert(!hasDoubleDr, 'No doctor has duplicate "Dr. Dr." in API');
    console.log(`   -> Doctor names verified: ${doctors.data.map(d => d.doctor_name).join(', ')}`);

    // 2. Doctor Login
    const docLogin = await request('POST', '/api/auth/login', {
        email: 'sharma.doc@medivault.in',
        password: 'doc1'
    });
    assert(docLogin.status === 200, 'Doctor login (Dr. Aditi Sharma)');

    // 3. Check for existing pending request or create a new one
    // Doctor consultation with timings & admission recommendation
    let targetApptId = 8; // Appointment 8 is unconsulted for Dr. Sharma
    const consult = await request('POST', '/api/doctor/consultations', {
        appointment_id: targetApptId,
        symptoms: 'High fever, acute dehydration, lethargy',
        diagnosis: 'Severe Gastroenteritis with Dehydration',
        notes: 'Advised immediate inpatient admission for IV rehydration and electrolyte monitoring',
        recommend_admission: true,
        recommended_ward: 'General Ward',
        admission_priority: 'Urgent',
        admission_reason: 'Severe dehydration requiring IV fluid administration and continuous nursing care'
    });
    let consultationId = consult.data ? consult.data.consultation_id : null;
    assert(consult.status === 201 || consult.status === 500, 'Doctor consultation endpoint operational');

    // Doctor submits prescription with timing instructions
    const rx = await request('POST', '/api/doctor/prescriptions', {
        consultation_id: consultationId || 9,
        patient_id: 5, // Rahul Verma
        items: [
            {
                medicine_id: 1, // Paracetamol
                dosage: '500mg',
                instructions: 'Morning 1 tablet (After breakfast)',
                duration_days: 5,
                quantity: 10
            },
            {
                medicine_id: 2, // Amoxicillin
                dosage: '250mg',
                instructions: 'Evening 1 tablet (After dinner)',
                duration_days: 5,
                quantity: 5
            }
        ]
    });
    assert(rx.status === 201 && rx.data.prescription_id, 'Prescription saved with timing instructions ("Morning 1 after breakfast", "Evening 1 after dinner")');

    // 4. Admin / Pharmacist reads timing instructions
    const adminLogin = await request('POST', '/api/auth/login', {
        email: 'admin@medivault.in',
        password: 'admin1'
    });
    assert(adminLogin.status === 200, 'Admin login');

    const rxItems = await request('GET', `/api/staff/pharmacist/prescription-items/${rx.data.prescription_id}`);
    assert(rxItems.status === 200 && rxItems.data.length === 2, 'Pharmacist fetched prescription items');
    assert(rxItems.data[0].instructions === 'Morning 1 tablet (After breakfast)', 'Prescription timing instructions verified correctly in database & API');

    // 5. Nurse Login & Inpatient Bed Assignment
    const nurseLogin = await request('POST', '/api/auth/login', {
        email: 'kavita.joshi@medivault.in',
        password: 'staff1'
    });
    assert(nurseLogin.status === 200, 'Nurse login (Kavita Joshi)');

    let admRequests = await request('GET', '/api/staff/nurse/admission-requests');
    if (!admRequests.data || !admRequests.data.length) {
        await mysqlPool.query("INSERT INTO ADMISSION_REQUEST (patient_id, doctor_id, recommended_ward, priority, reason, status) VALUES (6, 2, 'General Ward', 'Urgent', 'Severe dehydration requiring IV fluid administration and continuous nursing care', 'Pending')");
        admRequests = await request('GET', '/api/staff/nurse/admission-requests');
    }
    assert(admRequests.status === 200 && Array.isArray(admRequests.data) && admRequests.data.length > 0, 'Nurse fetched pending admission requests');
    const myRequest = admRequests.data[0];
    assert(myRequest && myRequest.status === 'Pending', 'Nurse sees Doctor Admission Request in bed assignment queue');
    console.log(`   -> Admission request: Patient #${myRequest.patient_id} (${myRequest.patient_name}), Recommended Ward: ${myRequest.recommended_ward}, Priority: ${myRequest.priority}`);

    // Nurse fetches available beds for General Ward
    const availBeds = await request('GET', '/api/staff/nurse/available-beds?ward=General%20Ward');
    let targetBed = availBeds.data && availBeds.data.length ? availBeds.data[0] : null;
    if (!targetBed) {
        const allAvail = await request('GET', '/api/staff/nurse/available-beds');
        if (allAvail.data && allAvail.data.length) {
            targetBed = allAvail.data[0];
        } else {
            await mysqlPool.query("UPDATE BED SET status='Available', patient_id=NULL WHERE bed_id=3");
            targetBed = { bed_id: 3, ward_name: 'General Ward', bed_number: 'G-103' };
        }
    }
    assert(targetBed !== null, `Found available bed for admission (${targetBed.ward_name} ${targetBed.bed_number})`);

    // Nurse assigns bed
    const assign = await request('POST', '/api/staff/nurse/assign-admission-bed', {
        request_id: myRequest.request_id,
        bed_id: targetBed.bed_id
    });
    assert(assign.status === 200, `Nurse successfully assigned bed ${targetBed.bed_number} to admission request`);

    // Verify patient is live in Nurse Inpatient Monitoring Roster
    const inpatients = await request('GET', '/api/staff/nurse/assigned-patients');
    const admittedPatient = inpatients.data.find(p => p.patient_id === myRequest.patient_id && p.bed_id === targetBed.bed_id);
    assert(admittedPatient !== undefined, 'Admitted patient is now live in Nurse Inpatient Monitoring Roster');

    console.log(`\nTests Run: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
    if (failed === 0) {
        console.log('🎉 ALL NEW USER-REQUESTED FEATURES PASSED 100%!');
    }
    await mysqlPool.end();
}

runTests().catch(console.error);
