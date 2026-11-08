/**
 * tests/harness/test_db_engine.js
 * Transactional Relational (MySQL 8 / MariaDB 10.6 compatible) + Document (MongoDB)
 * Test Engine for running the complete MediCare test suites (TEST A through TEST K)
 * in an isolated sandbox without touching any user production database.
 */

function localIsoDate(offsetDays = 0) {
    const d = new Date();
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function localTimeStr() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mi}:${ss}`;
}

function nowDatetimeStr() {
    return `${localIsoDate(0)} ${localTimeStr()}`;
}

function computeAgeYears(dobStr) {
    if (!dobStr) return null;
    const dob = new Date(dobStr);
    if (isNaN(dob.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
    return Math.max(0, age);
}

function minutesSince(dtStr) {
    if (!dtStr) return 0;
    const t = new Date(String(dtStr).replace(' ', 'T')).getTime();
    if (isNaN(t)) return 0;
    return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

function isTimeWithinShift(curTime, startTime, endTime) {
    if (!startTime || !endTime) return false;
    if (startTime <= endTime) {
        return curTime >= startTime && curTime <= endTime;
    }
    return curTime >= startTime || curTime <= endTime;
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function createInMemoryMongoDb() {
    const collections = new Map();

    function getColData(name) {
        if (!collections.has(name)) collections.set(name, []);
        return collections.get(name);
    }

    function matchesFilter(doc, filter = {}) {
        for (const [k, v] of Object.entries(filter)) {
            if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
                if (Array.isArray(v.$in)) {
                    if (!v.$in.some(x => x == doc[k])) return false;
                } else if (v.$ne !== undefined) {
                    if (doc[k] === v.$ne) return false;
                }
            } else if (doc[k] != v) {
                return false;
            }
        }
        return true;
    }

    return {
        async command(cmd) {
            if (cmd && cmd.ping) return { ok: 1 };
            return { ok: 1 };
        },
        collection(name) {
            return {
                async insertOne(doc) {
                    const arr = getColData(name);
                    const copy = deepClone({ _id: `${name}_${arr.length + 1}_${Date.now()}`, ...doc });
                    arr.push(copy);
                    return { insertedId: copy._id, acknowledged: true };
                },
                async updateOne(filter, update, opts = {}) {
                    const arr = getColData(name);
                    const idx = arr.findIndex(d => matchesFilter(d, filter));
                    if (idx >= 0) {
                        if (update.$set) Object.assign(arr[idx], deepClone(update.$set));
                        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
                    }
                    if (opts.upsert) {
                        const base = {};
                        for (const [fk, fv] of Object.entries(filter || {})) {
                            if (typeof fv !== 'object') base[fk] = fv;
                        }
                        if (update.$setOnInsert) Object.assign(base, deepClone(update.$setOnInsert));
                        if (update.$set) Object.assign(base, deepClone(update.$set));
                        base._id = `${name}_${arr.length + 1}_${Date.now()}`;
                        arr.push(base);
                        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
                    }
                    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
                },
                find(filter = {}, opts = {}) {
                    const arr = getColData(name).filter(d => matchesFilter(d, filter));
                    const projected = arr.map(d => {
                        const c = deepClone(d);
                        if (opts.projection && opts.projection._id === 0) delete c._id;
                        return c;
                    });
                    return {
                        async toArray() {
                            return projected;
                        }
                    };
                },
                async findOne(filter = {}, opts = {}) {
                    const arr = getColData(name).filter(d => matchesFilter(d, filter));
                    if (!arr.length) return null;
                    const item = opts.sort && opts.sort._id === -1 ? arr[arr.length - 1] : arr[0];
                    const c = deepClone(item);
                    if (opts.projection && opts.projection._id === 0) delete c._id;
                    return c;
                },
                async countDocuments(filter = {}) {
                    return getColData(name).filter(d => matchesFilter(d, filter)).length;
                }
            };
        }
    };
}

function createInMemoryMysqlPool() {
    const state = {
        tables: {
            SCHEMA_MIGRATIONS: [],
            ROLE: [],
            USER: [],
            DEPARTMENT: [],
            DOCTOR: [],
            DOCTOR_SHIFT: [],
            DOCTOR_LEAVE: [],
            PATIENT: [],
            PATIENT_ALLERGY: [],
            STAFF: [],
            APPOINTMENT: [],
            MEDICAL_RECORD: [],
            CONSULTATION: [],
            MEDICINE: [],
            MEDICINE_BATCH: [],
            PRESCRIPTION: [],
            PRESCRIPTION_ITEM: [],
            DISPENSING_RECORD: [],
            DISPENSING_ITEM: [],
            LAB_TEST: [],
            LAB_REQUEST: [],
            LAB_REPORT: [],
            WARD: [],
            BED: [],
            AMBULANCE: [],
            BLOOD_BANK: [],
            EMERGENCY_SEQUENCE: [],
            EMERGENCY_CASE: [],
            EMERGENCY_DOCTOR_ASSIGNMENT: [],
            EMERGENCY_BED_ASSIGNMENT: [],
            AMBULANCE_DISPATCH: [],
            TRIAGE_ASSESSMENT: [],
            EMERGENCY_PRIORITY_LOG: [],
            EMERGENCY_TREATMENT_LOG: [],
            BLOOD_REQUEST: [],
            PATIENT_VITALS: [],
            NURSE_NOTE: [],
            ADMISSION_REQUEST: [],
            ADMISSION: [],
            BILL: [],
            BILL_ITEM: [],
            PAYMENT: [],
            NOTIFICATION: [],
            AUDIT_LOG: [],
            USER_SESSION: [],
            CROSS_DB_OUTBOX: []
        },
        autoInc: {},
        failNextQueryPattern: null
    };

    function nextId(table, pkCol) {
        const rows = state.tables[table] || [];
        const maxExisting = rows.reduce((m, r) => Math.max(m, Number(r[pkCol] || 0)), 0);
        const cur = Math.max(state.autoInc[table] || 0, maxExisting) + 1;
        state.autoInc[table] = cur;
        return cur;
    }

    function computeVwMedicineInventory() {
        const today = localIsoDate(0);
        return state.tables.MEDICINE.map(m => {
            const batches = state.tables.MEDICINE_BATCH.filter(b => Number(b.medicine_id) === Number(m.medicine_id));
            const validBatches = batches.filter(b => b.expiry_date >= today);
            const stockQty = validBatches.reduce((sum, b) => sum + Number(b.available_qty || 0), 0);
            const activeExp = validBatches.filter(b => Number(b.available_qty) > 0).map(b => b.expiry_date).sort()[0];
            const anyExp = batches.map(b => b.expiry_date).sort()[0] || null;
            return {
                medicine_id: m.medicine_id,
                medicine_name: m.medicine_name,
                manufacturer: m.manufacturer,
                unit_price: Number(m.unit_price),
                stock_qty: stockQty,
                expiry_date: activeExp || anyExp
            };
        });
    }

    function computeVwBillSummary() {
        return state.tables.BILL.map(b => {
            const items = state.tables.BILL_ITEM.filter(i => Number(i.bill_id) === Number(b.bill_id));
            const payments = state.tables.PAYMENT.filter(p => Number(p.bill_id) === Number(b.bill_id));
            const total = Number(items.reduce((s, i) => s + Number(i.amount || 0), 0).toFixed(2));
            const paid = Number(payments.reduce((s, p) => s + Number(p.amount_paid || 0), 0).toFixed(2));
            const balance = Number(Math.max(0, total - paid).toFixed(2));
            let status = 'Unpaid';
            if (total > 0 && paid >= total - 0.001) status = 'Paid';
            else if (paid > 0) status = 'Partial';
            return {
                bill_id: b.bill_id,
                patient_id: b.patient_id,
                appointment_id: b.appointment_id || null,
                admission_id: b.admission_id || null,
                case_id: b.case_id || null,
                total_amount: total,
                paid_amount: paid,
                balance_due: balance,
                payment_status: status,
                bill_date: b.bill_date,
                generated_by: b.generated_by || null
            };
        });
    }

    function computeVwBedDetails() {
        return state.tables.BED.map(b => {
            const w = state.tables.WARD.find(x => Number(x.ward_id) === Number(b.ward_id)) || {};
            const adm = state.tables.ADMISSION.find(a => Number(a.bed_id) === Number(b.bed_id) && a.status === 'Admitted');
            const eba = state.tables.EMERGENCY_BED_ASSIGNMENT.find(e => Number(e.bed_id) === Number(b.bed_id) && Boolean(e.is_active));
            const ec = eba ? state.tables.EMERGENCY_CASE.find(c => Number(c.case_id) === Number(eba.case_id) && !['Discharged', 'Transferred', 'Admitted'].includes(c.status)) : null;
            return {
                bed_id: b.bed_id,
                ward_id: b.ward_id,
                ward_name: w.ward_name || 'General Ward',
                daily_rate: Number(w.daily_rate || 1000),
                bed_number: b.bed_number,
                status: b.status,
                patient_id: (adm && adm.patient_id) || (ec && ec.patient_id) || null,
                admission_id: adm ? adm.admission_id : null,
                admitting_doctor_id: adm ? adm.admitting_doctor_id : null,
                case_id: eba ? eba.case_id : null,
                emg_number: ec ? ec.emg_number : null
            };
        });
    }

    function computeVwPatientAllergies() {
        return state.tables.PATIENT.map(p => {
            const algs = state.tables.PATIENT_ALLERGY
                .filter(a => Number(a.patient_id) === Number(p.patient_id))
                .map(a => a.allergy_name)
                .sort();
            return {
                patient_id: p.patient_id,
                allergies: algs.length ? algs.join(', ') : null
            };
        });
    }

    function parseSqlValuesList(valuesSegment) {
        const rows = [];
        let inQuote = false;
        let depth = 0;
        let currentToken = '';
        let currentRow = [];

        for (let i = 0; i < valuesSegment.length; i++) {
            const ch = valuesSegment[i];
            if (ch === "'" && valuesSegment[i - 1] !== '\\') {
                inQuote = !inQuote;
                currentToken += ch;
                continue;
            }
            if (!inQuote) {
                if (ch === '(') {
                    depth++;
                    if (depth === 1) {
                        currentRow = [];
                        currentToken = '';
                        continue;
                    }
                } else if (ch === ')') {
                    depth--;
                    if (depth === 0) {
                        currentRow.push(evalSqlToken(currentToken.trim()));
                        rows.push(currentRow);
                        currentToken = '';
                        continue;
                    }
                } else if (ch === ',' && depth === 1) {
                    currentRow.push(evalSqlToken(currentToken.trim()));
                    currentToken = '';
                    continue;
                }
            }
            if (depth >= 1) {
                currentToken += ch;
            }
        }
        return rows;
    }

    function evalSqlToken(tok) {
        if (!tok || /^NULL$/i.test(tok)) return null;
        if (/^TRUE$/i.test(tok)) return true;
        if (/^FALSE$/i.test(tok)) return false;
        if (/^CURDATE\(\)$/i.test(tok)) return localIsoDate(0);
        if (/^NOW\(\)$/i.test(tok)) return nowDatetimeStr();
        const dateAddMatch = tok.match(/^DATE_ADD\(CURDATE\(\),\s*INTERVAL\s+(\d+)\s+DAY\)$/i);
        if (dateAddMatch) return localIsoDate(Number(dateAddMatch[1]));
        const dateSubMinMatch = tok.match(/^DATE_SUB\(NOW\(\),\s*INTERVAL\s+(\d+)\s+MINUTE\)$/i);
        if (dateSubMinMatch) {
            const d = new Date(Date.now() - Number(dateSubMinMatch[1]) * 60000);
            return d.toISOString().slice(0, 19).replace('T', ' ');
        }
        if (tok.startsWith("'") && tok.endsWith("'")) {
            return tok.slice(1, -1).replace(/\\'/g, "'");
        }
        const n = Number(tok);
        if (!Number.isNaN(n)) return n;
        return tok;
    }

    let txLockPromise = Promise.resolve();

    async function executeSql(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();

        if (state.failNextQueryPattern && norm.toLowerCase().includes(state.failNextQueryPattern.toLowerCase())) {
            const pattern = state.failNextQueryPattern;
            state.failNextQueryPattern = null;
            const simErr = new Error(`Simulated database failure on query matching '${pattern}'`);
            simErr.sqlMessage = simErr.message;
            throw simErr;
        }

        if (/^SELECT 1 AS ok$/i.test(norm)) {
            return [[{ ok: 1 }]];
        }
        if (/^(CREATE|ALTER|DROP)\s+(TABLE|VIEW|OR REPLACE VIEW|TRIGGER|PROCEDURE|DATABASE)/i.test(norm)) {
            if (/INVALID_SQL_SYNTAX_ERROR/i.test(norm)) {
                const err = new Error('You have an error in your SQL syntax near INVALID_SQL_SYNTAX_ERROR');
                err.sqlMessage = err.message;
                throw err;
            }
            return [{ affectedRows: 0 }];
        }

        const seedMatch = norm.match(/^INSERT\s+(?:IGNORE\s+)?INTO\s+`?([A-Z_]+)`?\s*\(([^)]+)\)\s*VALUES\s*(.+)$/i);
        if (seedMatch && params.length === 0 && !norm.includes('?')) {
            const tableName = seedMatch[1].toUpperCase();
            const cols = seedMatch[2].split(',').map(c => c.trim().replace(/`/g, ''));
            const valRows = parseSqlValuesList(seedMatch[3]);
            const tableArr = state.tables[tableName];
            if (tableArr) {
                const pkCol = cols[0];
                for (const vr of valRows) {
                    const obj = {};
                    cols.forEach((c, idx) => { obj[c] = vr[idx]; });
                    if (tableName === 'EMERGENCY_CASE') {
                        if (!obj.status) obj.status = 'Waiting';
                        if (!obj.assessment_status) obj.assessment_status = 'Assessed';
                    }
                    if (tableName === 'EMERGENCY_DOCTOR_ASSIGNMENT' || tableName === 'EMERGENCY_BED_ASSIGNMENT') {
                        if (!obj.assigned_at) obj.assigned_at = nowDatetimeStr();
                    }
                    if (tableName === 'TRIAGE_ASSESSMENT' && !obj.assessed_at) {
                        obj.assessed_at = nowDatetimeStr();
                    }
                    const exists = tableArr.some(r => r[pkCol] !== undefined && r[pkCol] === obj[pkCol]);
                    if (!exists) tableArr.push(obj);
                }
            }
            return [{ affectedRows: valRows.length }];
        }

        const hodMatch = norm.match(/^UPDATE DEPARTMENT SET hod_doctor_id = (\d+) WHERE department_name = '([^']+)'/i);
        if (hodMatch) {
            const dept = state.tables.DEPARTMENT.find(d => d.department_name === hodMatch[2]);
            if (dept) dept.hod_doctor_id = Number(hodMatch[1]);
            return [{ affectedRows: dept ? 1 : 0 }];
        }

        if (/^UPDATE EMERGENCY_CASE ec SET ec\.assessment_status = 'Assessed' WHERE EXISTS/i.test(norm)) {
            let count = 0;
            state.tables.EMERGENCY_CASE.forEach(ec => {
                const hasTriage = state.tables.TRIAGE_ASSESSMENT.some(t => Number(t.case_id) === Number(ec.case_id));
                if (hasTriage) {
                    ec.assessment_status = 'Assessed';
                    count++;
                }
            });
            return [{ affectedRows: count }];
        }

        if (norm.includes('FROM SCHEMA_MIGRATIONS')) {
            if (norm.includes("WHERE status = 'Applied'") && norm.includes('version = ?')) {
                const v = String(params[0]);
                return [state.tables.SCHEMA_MIGRATIONS.filter(m => String(m.version) === v && m.status === 'Applied')];
            }
            if (norm.includes("WHERE status = 'Applied'")) {
                return [state.tables.SCHEMA_MIGRATIONS.filter(m => m.status === 'Applied')];
            }
            return [[...state.tables.SCHEMA_MIGRATIONS].sort((a, b) => String(a.version).localeCompare(String(b.version)))];
        }
        if (norm.startsWith('INSERT IGNORE INTO SCHEMA_MIGRATIONS') || norm.startsWith('INSERT INTO SCHEMA_MIGRATIONS')) {
            const [version, filename, checksum, execMs] = params;
            const existing = state.tables.SCHEMA_MIGRATIONS.find(m => String(m.version) === String(version));
            if (existing) {
                if (norm.includes('ON DUPLICATE KEY UPDATE')) {
                    existing.checksum = checksum;
                    existing.execution_ms = execMs || 0;
                    existing.status = 'Applied';
                    existing.applied_at = nowDatetimeStr();
                }
            } else {
                state.tables.SCHEMA_MIGRATIONS.push({
                    migration_id: nextId('SCHEMA_MIGRATIONS', 'migration_id'),
                    version: String(version),
                    filename,
                    checksum,
                    execution_ms: execMs || 0,
                    status: 'Applied',
                    applied_at: nowDatetimeStr()
                });
            }
            return [{ affectedRows: 1 }];
        }
        if (norm.startsWith("UPDATE SCHEMA_MIGRATIONS SET status = 'RolledBack'")) {
            const v = String(params[0]);
            const row = state.tables.SCHEMA_MIGRATIONS.find(m => String(m.version) === v);
            if (row) row.status = 'RolledBack';
            return [{ affectedRows: row ? 1 : 0 }];
        }

        const selectAllTableMatch = norm.match(/^SELECT \* FROM `([A-Z_]+)`$/i);
        if (selectAllTableMatch) {
            const tName = selectAllTableMatch[1].toUpperCase();
            return [deepClone(state.tables[tName] || [])];
        }
        if (/^SELECT COUNT\(\*\) AS cnt FROM `USER`$/i.test(norm)) {
            return [[{ cnt: state.tables.USER.length }]];
        }
        if (/^SELECT COUNT\(\*\) AS cnt FROM PATIENT$/i.test(norm)) {
            return [[{ cnt: state.tables.PATIENT.length }]];
        }

        if (norm.startsWith('SELECT') && norm.includes('FROM USER_SESSION WHERE session_id = ?')) {
            const sid = String(params[0]);
            return [state.tables.USER_SESSION.filter(s => s.session_id === sid)];
        }
        if (norm.startsWith('INSERT INTO USER_SESSION')) {
            const [sid, userId, expiresAt, sessionData] = params;
            const existing = state.tables.USER_SESSION.find(s => s.session_id === String(sid));
            if (existing) {
                existing.user_id = userId;
                existing.expires_at = Number(expiresAt);
                existing.session_data = sessionData;
                existing.updated_at = nowDatetimeStr();
            } else {
                state.tables.USER_SESSION.push({
                    session_id: String(sid),
                    user_id: userId,
                    expires_at: Number(expiresAt),
                    session_data: sessionData,
                    updated_at: nowDatetimeStr()
                });
            }
            return [{ affectedRows: 1 }];
        }
        if (norm.startsWith('UPDATE USER_SESSION SET expires_at = ?')) {
            const [expiresAt, sid] = params;
            const existing = state.tables.USER_SESSION.find(s => s.session_id === String(sid));
            if (existing) existing.expires_at = Number(expiresAt);
            return [{ affectedRows: existing ? 1 : 0 }];
        }
        if (norm.startsWith('DELETE FROM USER_SESSION WHERE session_id = ?')) {
            const sid = String(params[0]);
            const before = state.tables.USER_SESSION.length;
            state.tables.USER_SESSION = state.tables.USER_SESSION.filter(s => s.session_id !== sid);
            return [{ affectedRows: before - state.tables.USER_SESSION.length }];
        }
        if (norm.startsWith('DELETE FROM USER_SESSION WHERE expires_at <= ?')) {
            const now = Number(params[0]);
            const before = state.tables.USER_SESSION.length;
            state.tables.USER_SESSION = state.tables.USER_SESSION.filter(s => Number(s.expires_at) > now);
            return [{ affectedRows: before - state.tables.USER_SESSION.length }];
        }

        if (norm.startsWith('INSERT INTO CROSS_DB_OUTBOX')) {
            const [idempKey, colName, opType, filterJson, payloadJson, status, retryCount, lastErr, syncedAt] = params;
            const existing = state.tables.CROSS_DB_OUTBOX.find(o => o.idempotency_key === idempKey);
            if (existing) {
                existing.payload_json = payloadJson;
                existing.status = status;
                existing.last_error = lastErr;
                existing.synced_at = syncedAt;
            } else {
                state.tables.CROSS_DB_OUTBOX.push({
                    outbox_id: nextId('CROSS_DB_OUTBOX', 'outbox_id'),
                    idempotency_key: idempKey,
                    collection_name: colName,
                    operation_type: opType,
                    filter_json: filterJson,
                    payload_json: payloadJson,
                    status,
                    retry_count: Number(retryCount || 0),
                    last_error: lastErr,
                    created_at: nowDatetimeStr(),
                    synced_at: syncedAt
                });
            }
            return [{ affectedRows: 1 }];
        }
        if (norm.includes("FROM CROSS_DB_OUTBOX WHERE status IN ('Pending', 'Failed')")) {
            return [state.tables.CROSS_DB_OUTBOX.filter(o => ['Pending', 'Failed'].includes(o.status) && Number(o.retry_count) < 10)];
        }
        if (norm.startsWith("UPDATE CROSS_DB_OUTBOX SET status = 'Synced'")) {
            const id = Number(params[0]);
            const row = state.tables.CROSS_DB_OUTBOX.find(o => Number(o.outbox_id) === id);
            if (row) {
                row.status = 'Synced';
                row.last_error = null;
                row.synced_at = nowDatetimeStr();
            }
            return [{ affectedRows: row ? 1 : 0 }];
        }
        if (norm.startsWith('UPDATE CROSS_DB_OUTBOX SET retry_count = retry_count + 1')) {
            const [lastErr, id] = params;
            const row = state.tables.CROSS_DB_OUTBOX.find(o => Number(o.outbox_id) === Number(id));
            if (row) {
                row.retry_count = Number(row.retry_count || 0) + 1;
                row.status = row.retry_count >= 10 ? 'Failed' : 'Pending';
                row.last_error = lastErr;
            }
            return [{ affectedRows: row ? 1 : 0 }];
        }
        if (norm.includes("SELECT COUNT(*) AS cnt FROM CROSS_DB_OUTBOX WHERE status = 'Pending'")) {
            const cnt = state.tables.CROSS_DB_OUTBOX.filter(o => o.status === 'Pending').length;
            return [[{ cnt }]];
        }
        if (norm.includes("SELECT payload_json FROM CROSS_DB_OUTBOX WHERE collection_name = 'lab_reports_raw'")) {
            return [state.tables.CROSS_DB_OUTBOX.filter(o => o.collection_name === 'lab_reports_raw').map(o => ({ payload_json: o.payload_json }))];
        }

        if (norm.includes('FROM `USER` u JOIN ROLE r ON u.role_id = r.role_id WHERE u.email = ? AND u.is_active = TRUE')) {
            const email = String(params[0] || '').toLowerCase();
            const user = state.tables.USER.find(u => String(u.email).toLowerCase() === email && Boolean(u.is_active));
            if (!user) return [[]];
            const role = state.tables.ROLE.find(r => Number(r.role_id) === Number(user.role_id));
            return [[{
                user_id: user.user_id,
                name: user.name,
                email: user.email,
                password_hash: user.password_hash,
                role_name: role ? role.role_name : 'Patient'
            }]];
        }
        if (norm === 'SELECT staff_type FROM STAFF WHERE staff_id = ?') {
            const s = state.tables.STAFF.find(x => Number(x.staff_id) === Number(params[0]));
            return [s ? [{ staff_type: s.staff_type }] : []];
        }
        if (norm === 'SELECT email FROM `USER` WHERE user_id = ?') {
            const u = state.tables.USER.find(x => Number(x.user_id) === Number(params[0]));
            return [u ? [{ email: u.email }] : []];
        }
        if (norm === 'SELECT password_hash FROM `USER` WHERE user_id = ?') {
            const u = state.tables.USER.find(x => Number(x.user_id) === Number(params[0]));
            return [u ? [{ password_hash: u.password_hash }] : []];
        }
        if (norm === 'UPDATE `USER` SET password_hash = ? WHERE user_id = ?') {
            const u = state.tables.USER.find(x => Number(x.user_id) === Number(params[1]));
            if (u) u.password_hash = params[0];
            return [{ affectedRows: u ? 1 : 0 }];
        }

        if (norm.startsWith('CALL sp_book_appointment')) {
            const [patientId, doctorId, _deptId, apptDate, apptTime, bookedBy] = params;
            const doc = state.tables.DOCTOR.find(d => Number(d.doctor_id) === Number(doctorId));
            if (!doc) {
                const err = new Error('Selected doctor does not exist');
                err.sqlMessage = err.message;
                throw err;
            }
            const conflict = state.tables.APPOINTMENT.find(a =>
                Number(a.doctor_id) === Number(doctorId) &&
                a.appointment_date === String(apptDate) &&
                a.appointment_time === String(apptTime) &&
                ['Scheduled', 'Confirmed', 'Checked In'].includes(a.status)
            );
            if (conflict) {
                const err = new Error('Selected slot is already booked for this doctor');
                err.code = 'ER_DUP_ENTRY';
                err.sqlMessage = err.message;
                throw err;
            }
            const apptId = nextId('APPOINTMENT', 'appointment_id');
            state.tables.APPOINTMENT.push({
                appointment_id: apptId,
                patient_id: Number(patientId),
                doctor_id: Number(doctorId),
                appointment_date: String(apptDate),
                appointment_time: String(apptTime),
                status: 'Scheduled',
                booked_by: bookedBy ? Number(bookedBy) : null,
                created_at: nowDatetimeStr()
            });
            state.tables.NOTIFICATION.push({
                notification_id: nextId('NOTIFICATION', 'notification_id'),
                user_id: Number(patientId),
                message: `Your appointment is booked for ${apptDate} at ${apptTime}`,
                is_read: false,
                created_at: nowDatetimeStr()
            });
            return [{ affectedRows: 1, insertId: apptId }];
        }

        if (norm.startsWith('CALL sp_generate_bill')) {
            const [apptId, generatedBy] = params;
            const appt = state.tables.APPOINTMENT.find(a => Number(a.appointment_id) === Number(apptId));
            if (!appt) {
                const err = new Error('Appointment not found');
                err.sqlMessage = err.message;
                throw err;
            }
            const consult = state.tables.CONSULTATION.find(c => Number(c.appointment_id) === Number(apptId));
            if (!consult) {
                const err = new Error('No consultation on record for this appointment yet');
                err.sqlMessage = err.message;
                throw err;
            }
            const existingBill = state.tables.BILL.find(b => Number(b.appointment_id) === Number(apptId));
            if (existingBill) {
                return [{ affectedRows: 0 }];
            }
            const doc = state.tables.DOCTOR.find(d => Number(d.doctor_id) === Number(appt.doctor_id));
            const fee = doc ? Number(doc.consultation_fee || 500) : 500;
            const billId = nextId('BILL', 'bill_id');
            state.tables.BILL.push({
                bill_id: billId,
                patient_id: appt.patient_id,
                appointment_id: Number(apptId),
                admission_id: null,
                case_id: null,
                bill_date: nowDatetimeStr(),
                generated_by: generatedBy ? Number(generatedBy) : null
            });
            state.tables.BILL_ITEM.push({
                bill_item_id: nextId('BILL_ITEM', 'bill_item_id'),
                bill_id: billId,
                item_type: 'Consultation',
                description: 'Doctor consultation fee',
                amount: fee,
                reference_key: `APPT-CONSULT-${apptId}`
            });
            const labReqs = state.tables.LAB_REQUEST.filter(lr => Number(lr.consultation_id) === Number(consult.consultation_id));
            for (const lr of labReqs) {
                const lt = state.tables.LAB_TEST.find(t => Number(t.test_id) === Number(lr.test_id));
                if (lt) {
                    state.tables.BILL_ITEM.push({
                        bill_item_id: nextId('BILL_ITEM', 'bill_item_id'),
                        bill_id: billId,
                        item_type: 'Lab',
                        description: lt.test_name,
                        amount: Number(lt.price),
                        reference_key: `LAB-REQ-${lr.request_id}`
                    });
                }
            }
            const prescs = state.tables.PRESCRIPTION.filter(p => Number(p.consultation_id) === Number(consult.consultation_id));
            for (const pr of prescs) {
                const pItems = state.tables.PRESCRIPTION_ITEM.filter(pi => Number(pi.prescription_id) === Number(pr.prescription_id));
                for (const pi of pItems) {
                    const med = state.tables.MEDICINE.find(m => Number(m.medicine_id) === Number(pi.medicine_id));
                    if (med) {
                        state.tables.BILL_ITEM.push({
                            bill_item_id: nextId('BILL_ITEM', 'bill_item_id'),
                            bill_id: billId,
                            item_type: 'Medicine',
                            description: med.medicine_name,
                            amount: Number((Number(med.unit_price) * Number(pi.quantity)).toFixed(2)),
                            reference_key: `RX-ITEM-${pi.item_id}`
                        });
                    }
                }
            }
            return [{ affectedRows: 1, insertId: billId }];
        }

        if (norm.startsWith('INSERT INTO NOTIFICATION (user_id, message, is_read) VALUES')) {
            if (params.length === 2) {
                state.tables.NOTIFICATION.push({
                    notification_id: nextId('NOTIFICATION', 'notification_id'),
                    user_id: Number(params[0]),
                    message: params[1],
                    is_read: false,
                    created_at: nowDatetimeStr()
                });
            } else {
                for (let i = 0; i < params.length; i += 2) {
                    state.tables.NOTIFICATION.push({
                        notification_id: nextId('NOTIFICATION', 'notification_id'),
                        user_id: Number(params[i]),
                        message: params[i + 1],
                        is_read: false,
                        created_at: nowDatetimeStr()
                    });
                }
            }
            return [{ affectedRows: Math.floor(params.length / 2) || 1 }];
        }
        if (norm.includes('SELECT u.user_id FROM `USER` u JOIN ROLE r ON u.role_id = r.role_id WHERE r.role_name = ? AND u.is_active = TRUE')) {
            const roleName = params[0];
            const role = state.tables.ROLE.find(r => r.role_name === roleName);
            if (!role) return [[]];
            return [state.tables.USER.filter(u => Number(u.role_id) === Number(role.role_id) && Boolean(u.is_active)).map(u => ({ user_id: u.user_id }))];
        }
        if (norm.includes('FROM NOTIFICATION WHERE user_id = ?')) {
            const uid = Number(params[0]);
            return [state.tables.NOTIFICATION.filter(n => Number(n.user_id) === uid).reverse().slice(0, 50)];
        }
        if (norm.startsWith('UPDATE NOTIFICATION SET is_read = TRUE WHERE notification_id = ? AND user_id = ?')) {
            const n = state.tables.NOTIFICATION.find(x => Number(x.notification_id) === Number(params[0]) && Number(x.user_id) === Number(params[1]));
            if (n) n.is_read = true;
            return [{ affectedRows: n ? 1 : 0 }];
        }
        if (norm.startsWith('UPDATE NOTIFICATION SET is_read = TRUE WHERE user_id = ?')) {
            const uid = Number(params[0]);
            state.tables.NOTIFICATION.filter(x => Number(x.user_id) === uid).forEach(x => { x.is_read = true; });
            return [{ affectedRows: 1 }];
        }

        if (norm.startsWith('SELECT user_id FROM `USER` WHERE email = ?')) {
            const email = String(params[0] || '').toLowerCase();
            return [state.tables.USER.filter(u => String(u.email).toLowerCase() === email).map(u => ({ user_id: u.user_id }))];
        }
        if (/^SELECT role_id FROM ROLE WHERE role_name\s*=\s*'([^']+)'$/i.test(norm)) {
            const m = norm.match(/role_name\s*=\s*'([^']+)'/i);
            return [state.tables.ROLE.filter(r => r.role_name === m[1])];
        }
        if (norm === 'SELECT role_id FROM ROLE WHERE role_name = ?') {
            return [state.tables.ROLE.filter(r => r.role_name === params[0])];
        }
        if (norm.startsWith('INSERT INTO `USER` (name, email, password_hash, phone, role_id) VALUES')) {
            let [name, email, pwHash, phone, roleId] = params;
            if (norm.includes("(SELECT role_id FROM ROLE WHERE role_name='Patient')")) {
                const patRole = state.tables.ROLE.find(r => r.role_name === 'Patient');
                roleId = patRole ? patRole.role_id : 3;
            }
            if (state.tables.USER.some(u => String(u.email).toLowerCase() === String(email).toLowerCase())) {
                const err = new Error('Duplicate email');
                err.code = 'ER_DUP_ENTRY';
                throw err;
            }
            const uid = nextId('USER', 'user_id');
            state.tables.USER.push({
                user_id: uid,
                name,
                email,
                password_hash: pwHash,
                phone: phone || null,
                role_id: Number(roleId),
                is_active: true,
                created_at: nowDatetimeStr()
            });
            return [{ insertId: uid, affectedRows: 1 }];
        }
        if (norm.startsWith('INSERT INTO `USER` (name, email, password_hash, role_id) VALUES')) {
            const [name, email, pwHash, roleId] = params;
            const uid = nextId('USER', 'user_id');
            state.tables.USER.push({
                user_id: uid,
                name,
                email,
                password_hash: pwHash,
                phone: null,
                role_id: Number(roleId),
                is_active: true,
                created_at: nowDatetimeStr()
            });
            return [{ insertId: uid, affectedRows: 1 }];
        }
        if (norm.startsWith('INSERT INTO PATIENT (patient_id, dob, gender, blood_group, address, emergency_contact) VALUES')) {
            let [patientId, dob, gender, bloodGroup, address, emgContact] = params;
            if (norm.includes('DATE_SUB(CURDATE(), INTERVAL ? YEAR)')) {
                const [pId, ageYrs, genChar, emgCont] = params;
                patientId = pId;
                const yr = new Date().getFullYear() - Number(ageYrs || 30);
                dob = `${yr}-01-01`;
                gender = genChar;
                bloodGroup = null;
                address = 'Emergency Admission';
                emgContact = emgCont;
            }
            state.tables.PATIENT.push({
                patient_id: Number(patientId),
                dob,
                gender,
                blood_group: bloodGroup,
                address,
                emergency_contact: emgContact
            });
            return [{ affectedRows: 1 }];
        }
        if (norm.startsWith('INSERT IGNORE INTO PATIENT_ALLERGY (patient_id, allergy_name) VALUES')) {
            const [pid, algName] = params;
            const exists = state.tables.PATIENT_ALLERGY.some(a => Number(a.patient_id) === Number(pid) && a.allergy_name === algName);
            if (!exists) {
                state.tables.PATIENT_ALLERGY.push({
                    allergy_id: nextId('PATIENT_ALLERGY', 'allergy_id'),
                    patient_id: Number(pid),
                    allergy_name: algName,
                    severity: 'Moderate',
                    noted_at: nowDatetimeStr()
                });
            }
            return [{ affectedRows: 1 }];
        }
        if (norm.startsWith('INSERT INTO STAFF (staff_id, staff_type, department_id, shift) VALUES')) {
            const [staffId, staffType, deptId, shift] = params;
            state.tables.STAFF.push({
                staff_id: Number(staffId),
                staff_type: staffType,
                department_id: deptId ? Number(deptId) : null,
                shift: shift || 'Morning'
            });
            return [{ affectedRows: 1 }];
        }
        if (norm.startsWith('INSERT INTO DOCTOR (doctor_id, department_id, specialization, qualification, consultation_fee) VALUES')) {
            const [docId, deptId, spec, qual, fee] = params;
            state.tables.DOCTOR.push({
                doctor_id: Number(docId),
                department_id: Number(deptId),
                specialization: spec,
                qualification: qual,
                consultation_fee: Number(fee || 500),
                experience_years: 5
            });
            return [{ affectedRows: 1 }];
        }

        if (norm === 'SELECT * FROM vw_patient_portal_summary WHERE patient_id = ?') {
            const pid = Number(params[0]);
            const u = state.tables.USER.find(x => Number(x.user_id) === pid);
            const today = localIsoDate(0);
            const futureAppts = state.tables.APPOINTMENT
                .filter(a => Number(a.patient_id) === pid && ['Scheduled', 'Confirmed'].includes(a.status) && a.appointment_date >= today)
                .map(a => a.appointment_date)
                .sort();
            const recCount = state.tables.MEDICAL_RECORD.filter(m => Number(m.patient_id) === pid).length;
            const pendingBills = computeVwBillSummary().filter(b => Number(b.patient_id) === pid && b.payment_status !== 'Paid').length;
            const unreadNotifs = state.tables.NOTIFICATION.filter(n => Number(n.user_id) === pid && !n.is_read).length;
            return [[{
                patient_id: pid,
                patient_name: u ? u.name : 'Patient',
                next_appointment_date: futureAppts[0] || null,
                record_count: recCount,
                pending_bills: pendingBills,
                unread_notifications: unreadNotifs
            }]];
        }
        if (norm === 'SELECT department_id, department_name FROM DEPARTMENT ORDER BY department_name') {
            return [[...state.tables.DEPARTMENT].sort((a, b) => a.department_name.localeCompare(b.department_name))];
        }
        if (norm.includes('FROM DOCTOR d JOIN `USER` u ON d.doctor_id = u.user_id WHERE d.department_id = ?')) {
            const deptId = Number(params[0]);
            const rows = state.tables.DOCTOR
                .filter(d => Number(d.department_id) === deptId)
                .map(d => {
                    const u = state.tables.USER.find(x => Number(x.user_id) === Number(d.doctor_id)) || {};
                    return { doctor_id: d.doctor_id, doctor_name: u.name, specialization: d.specialization };
                });
            return [rows];
        }
        if (norm.startsWith("SELECT appointment_time FROM APPOINTMENT WHERE doctor_id=? AND appointment_date=? AND status IN ('Scheduled', 'Confirmed', 'Checked In')")) {
            const [docId, apptDate] = params;
            const rows = state.tables.APPOINTMENT
                .filter(a => Number(a.doctor_id) === Number(docId) && a.appointment_date === String(apptDate) && ['Scheduled', 'Confirmed', 'Checked In'].includes(a.status))
                .map(a => ({ appointment_time: a.appointment_time }));
            return [rows];
        }
        if (norm.includes('FROM APPOINTMENT a') && norm.includes('WHERE a.patient_id = ?') && norm.includes('ORDER BY a.appointment_date DESC')) {
            const pid = Number(params[0]);
            const rows = state.tables.APPOINTMENT
                .filter(a => Number(a.patient_id) === pid)
                .map(a => {
                    const doc = state.tables.DOCTOR.find(d => Number(d.doctor_id) === Number(a.doctor_id)) || {};
                    const u = state.tables.USER.find(x => Number(x.user_id) === Number(a.doctor_id)) || {};
                    const dept = state.tables.DEPARTMENT.find(dp => Number(dp.department_id) === Number(doc.department_id)) || {};
                    return {
                        appointment_id: a.appointment_id,
                        doctor_id: a.doctor_id,
                        doctor_name: u.name,
                        specialization: doc.specialization,
                        department_name: dept.department_name,
                        appointment_date: a.appointment_date,
                        appointment_time: a.appointment_time,
                        status: a.status,
                        created_at: a.created_at
                    };
                })
                .sort((a, b) => b.appointment_date.localeCompare(a.appointment_date) || b.appointment_time.localeCompare(a.appointment_time));
            return [rows];
        }
        if (norm.startsWith("UPDATE APPOINTMENT SET status = 'Cancelled' WHERE appointment_id = ? AND patient_id = ?")) {
            const [apptId, pid] = params;
            const appt = state.tables.APPOINTMENT.find(a => Number(a.appointment_id) === Number(apptId) && Number(a.patient_id) === Number(pid) && ['Scheduled', 'Confirmed'].includes(a.status));
            if (appt) appt.status = 'Cancelled';
            return [{ affectedRows: appt ? 1 : 0 }];
        }
        if (norm.includes('FROM CONSULTATION c') && norm.includes('WHERE a.patient_id = ?') && norm.includes('dept.department_name')) {
            const pid = Number(params[0]);
            const rows = state.tables.CONSULTATION
                .map(c => {
                    const a = state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === Number(c.appointment_id));
                    if (!a || Number(a.patient_id) !== pid) return null;
                    const doc = state.tables.DOCTOR.find(d => Number(d.doctor_id) === Number(a.doctor_id)) || {};
                    const u = state.tables.USER.find(x => Number(x.user_id) === Number(a.doctor_id)) || {};
                    const dept = state.tables.DEPARTMENT.find(dp => Number(dp.department_id) === Number(doc.department_id)) || {};
                    return {
                        ...c,
                        doctor_name: u.name,
                        specialization: doc.specialization,
                        department_name: dept.department_name,
                        appointment_date: a.appointment_date,
                        appointment_time: a.appointment_time
                    };
                })
                .filter(Boolean);
            return [rows];
        }
        if (norm.includes('FROM MEDICAL_RECORD mr') && norm.includes('WHERE mr.patient_id = ?')) {
            const pid = Number(params[0]);
            const rows = state.tables.MEDICAL_RECORD
                .filter(m => Number(m.patient_id) === pid)
                .map(m => {
                    const doc = state.tables.DOCTOR.find(d => Number(d.doctor_id) === Number(m.doctor_id)) || {};
                    const u = state.tables.USER.find(x => Number(x.user_id) === Number(m.doctor_id)) || {};
                    return {
                        ...m,
                        doctor_name: u.name || 'Attending Physician',
                        specialization: doc.specialization || 'General Medicine'
                    };
                })
                .reverse();
            return [rows];
        }
        if (norm.includes('FROM PRESCRIPTION p') && norm.includes('WHERE a.patient_id = ?')) {
            const pid = Number(params[0]);
            const rows = state.tables.PRESCRIPTION
                .map(p => {
                    const c = state.tables.CONSULTATION.find(x => Number(x.consultation_id) === Number(p.consultation_id));
                    const a = c ? state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === Number(c.appointment_id)) : null;
                    if (!a || Number(a.patient_id) !== pid) return null;
                    const u = state.tables.USER.find(x => Number(x.user_id) === Number(a.doctor_id)) || {};
                    return {
                        prescription_id: p.prescription_id,
                        prescribed_date: p.prescribed_date,
                        status: p.status,
                        doctor_name: u.name
                    };
                })
                .filter(Boolean);
            return [rows];
        }
        if (norm.includes('FROM PRESCRIPTION_ITEM pi') && norm.includes('WHERE pi.prescription_id = ? AND a.patient_id = ?')) {
            const [prescId, pid] = params;
            const pr = state.tables.PRESCRIPTION.find(p => Number(p.prescription_id) === Number(prescId));
            const c = pr ? state.tables.CONSULTATION.find(x => Number(x.consultation_id) === Number(pr.consultation_id)) : null;
            const a = c ? state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === Number(c.appointment_id)) : null;
            if (!a || Number(a.patient_id) !== Number(pid)) return [[]];
            const items = state.tables.PRESCRIPTION_ITEM
                .filter(pi => Number(pi.prescription_id) === Number(prescId))
                .map(pi => {
                    const m = state.tables.MEDICINE.find(x => Number(x.medicine_id) === Number(pi.medicine_id)) || {};
                    return { ...pi, medicine_name: m.medicine_name };
                });
            return [items];
        }

        if (norm.includes('FROM APPOINTMENT a JOIN `USER` up ON up.user_id=a.patient_id') && norm.includes('LEFT JOIN CONSULTATION c')) {
            const rows = state.tables.APPOINTMENT.map(a => {
                const up = state.tables.USER.find(u => Number(u.user_id) === Number(a.patient_id)) || {};
                const doc = state.tables.DOCTOR.find(d => Number(d.doctor_id) === Number(a.doctor_id)) || {};
                const ud = state.tables.USER.find(u => Number(u.user_id) === Number(a.doctor_id)) || {};
                const c = state.tables.CONSULTATION.find(x => Number(x.appointment_id) === Number(a.appointment_id));
                const bills = state.tables.BILL.filter(b => Number(b.appointment_id) === Number(a.appointment_id));
                const maxBillId = bills.length ? Math.max(...bills.map(b => b.bill_id)) : null;
                return {
                    appointment_id: a.appointment_id,
                    patient_id: a.patient_id,
                    patient_name: up.name,
                    doctor_id: a.doctor_id,
                    department_id: doc.department_id,
                    doctor_name: ud.name,
                    appointment_date: a.appointment_date,
                    appointment_time: a.appointment_time,
                    status: a.status,
                    consultation_id: c ? c.consultation_id : null,
                    bill_id: maxBillId
                };
            });
            return [rows];
        }
        if (norm.includes('FROM APPOINTMENT WHERE appointment_id = ? FOR UPDATE') || norm === 'SELECT appointment_id, patient_id, doctor_id, status FROM APPOINTMENT WHERE appointment_id = ? FOR UPDATE') {
            const apptId = Number(params[0]);
            return [state.tables.APPOINTMENT.filter(a => Number(a.appointment_id) === apptId)];
        }
        if (norm.includes('FROM APPOINTMENT a JOIN DOCTOR d ON a.doctor_id = d.doctor_id WHERE a.appointment_id = ? FOR UPDATE')) {
            const apptId = Number(params[0]);
            const a = state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === apptId);
            if (!a) return [[]];
            const d = state.tables.DOCTOR.find(x => Number(x.doctor_id) === Number(a.doctor_id)) || {};
            return [[{ ...a, department_id: d.department_id }]];
        }
        if (norm.startsWith("UPDATE APPOINTMENT SET status = 'Cancelled' WHERE appointment_id = ?")) {
            const appt = state.tables.APPOINTMENT.find(a => Number(a.appointment_id) === Number(params[0]));
            if (appt) appt.status = 'Cancelled';
            return [{ affectedRows: appt ? 1 : 0 }];
        }
        if (norm.includes('FROM APPOINTMENT WHERE patient_id = ? AND doctor_id = ? AND appointment_date = ? AND appointment_time = ?')) {
            const [pid, docId, dt, tm] = params;
            const matches = state.tables.APPOINTMENT
                .filter(a => Number(a.patient_id) === Number(pid) && Number(a.doctor_id) === Number(docId) && a.appointment_date === String(dt) && a.appointment_time === String(tm) && ['Scheduled', 'Confirmed', 'Checked In'].includes(a.status))
                .sort((a, b) => b.appointment_id - a.appointment_id);
            return [matches.slice(0, 1)];
        }

        if (norm === 'SELECT 1 AS ok FROM APPOINTMENT WHERE doctor_id = ? AND patient_id = ? LIMIT 1') {
            const ok = state.tables.APPOINTMENT.some(a => Number(a.doctor_id) === Number(params[0]) && Number(a.patient_id) === Number(params[1]));
            return [ok ? [{ ok: 1 }] : []];
        }
        if (norm === 'SELECT 1 AS ok FROM MEDICAL_RECORD WHERE doctor_id = ? AND patient_id = ? LIMIT 1') {
            const ok = state.tables.MEDICAL_RECORD.some(m => Number(m.doctor_id) === Number(params[0]) && Number(m.patient_id) === Number(params[1]));
            return [ok ? [{ ok: 1 }] : []];
        }
        if (norm === 'SELECT 1 AS ok FROM ADMISSION WHERE admitting_doctor_id = ? AND patient_id = ? LIMIT 1') {
            const ok = state.tables.ADMISSION.some(a => Number(a.admitting_doctor_id) === Number(params[0]) && Number(a.patient_id) === Number(params[1]));
            return [ok ? [{ ok: 1 }] : []];
        }
        if (norm.includes('FROM EMERGENCY_DOCTOR_ASSIGNMENT eda JOIN EMERGENCY_CASE ec ON eda.case_id = ec.case_id WHERE eda.doctor_id = ? AND ec.patient_id = ?')) {
            const ok = state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.some(eda => {
                if (Number(eda.doctor_id) !== Number(params[0])) return false;
                const ec = state.tables.EMERGENCY_CASE.find(c => Number(c.case_id) === Number(eda.case_id));
                return ec && Number(ec.patient_id) === Number(params[1]);
            });
            return [ok ? [{ ok: 1 }] : []];
        }
        if (norm.includes('FROM APPOINTMENT a') && norm.includes('WHERE a.doctor_id = ?')) {
            const docId = Number(params[0]);
            const dateFilter = params[1] ? String(params[1]) : null;
            const today = localIsoDate(0);
            const rows = state.tables.APPOINTMENT
                .filter(a => {
                    if (Number(a.doctor_id) !== docId) return false;
                    if (dateFilter) return a.appointment_date === dateFilter;
                    if (norm.includes('DATE_ADD(CURDATE(), INTERVAL 30 DAY)')) {
                        return a.appointment_date === today || (a.appointment_date >= today && ['Scheduled', 'Confirmed', 'Checked In'].includes(a.status));
                    }
                    return true;
                })
                .map(a => {
                    const ud = state.tables.USER.find(u => Number(u.user_id) === Number(a.doctor_id)) || {};
                    const up = state.tables.USER.find(u => Number(u.user_id) === Number(a.patient_id)) || {};
                    return {
                        appointment_id: a.appointment_id,
                        doctor_id: a.doctor_id,
                        doctor_name: ud.name,
                        patient_name: up.name,
                        patient_email: up.email,
                        patient_phone: up.phone,
                        appointment_date: a.appointment_date,
                        appointment_time: a.appointment_time,
                        status: a.status,
                        patient_id: a.patient_id
                    };
                })
                .sort((a, b) => a.appointment_date.localeCompare(b.appointment_date) || a.appointment_time.localeCompare(b.appointment_time));
            return [rows];
        }
        if (norm === 'UPDATE APPOINTMENT SET status = ? WHERE appointment_id = ? AND doctor_id = ?') {
            const [st, apptId, docId] = params;
            const appt = state.tables.APPOINTMENT.find(a => Number(a.appointment_id) === Number(apptId) && Number(a.doctor_id) === Number(docId));
            if (appt) appt.status = st;
            return [{ affectedRows: appt ? 1 : 0 }];
        }
        if (norm.includes('FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id LEFT JOIN vw_patient_allergies vpa')) {
            if (norm.includes('WHERE p.patient_id = ?')) {
                const pid = Number(params[0]);
                const p = state.tables.PATIENT.find(x => Number(x.patient_id) === pid);
                if (!p) return [[]];
                const u = state.tables.USER.find(x => Number(x.user_id) === pid) || {};
                const vpa = computeVwPatientAllergies().find(x => Number(x.patient_id) === pid);
                return [[{
                    patient_id: p.patient_id,
                    name: u.name,
                    email: u.email,
                    phone: u.phone,
                    dob: p.dob,
                    age: computeAgeYears(p.dob),
                    gender: p.gender,
                    blood_group: p.blood_group,
                    address: p.address,
                    emergency_contact: p.emergency_contact,
                    allergies: (vpa && vpa.allergies) || 'None documented'
                }]];
            }
            const allVpa = computeVwPatientAllergies();
            const rows = state.tables.PATIENT.map(p => {
                const u = state.tables.USER.find(x => Number(x.user_id) === Number(p.patient_id)) || {};
                const vpa = allVpa.find(x => Number(x.patient_id) === Number(p.patient_id));
                return {
                    patient_id: p.patient_id,
                    name: u.name,
                    email: u.email,
                    phone: u.phone,
                    is_active: u.is_active,
                    blood_group: p.blood_group,
                    dob: p.dob,
                    gender: p.gender,
                    allergies: vpa ? vpa.allergies : null
                };
            });
            return [rows];
        }
        if (norm.includes('FROM CONSULTATION c JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id LEFT JOIN `USER` ud ON a.doctor_id = ud.user_id WHERE a.patient_id = ?')) {
            const pid = Number(params[0]);
            const rows = state.tables.CONSULTATION
                .map(c => {
                    const a = state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === Number(c.appointment_id));
                    if (!a || Number(a.patient_id) !== pid) return null;
                    const ud = state.tables.USER.find(u => Number(u.user_id) === Number(a.doctor_id)) || {};
                    return { ...c, appointment_date: a.appointment_date, appointment_time: a.appointment_time, doctor_name: ud.name };
                })
                .filter(Boolean)
                .reverse();
            return [rows];
        }
        if (norm.includes('FROM PRESCRIPTION pr JOIN CONSULTATION c ON pr.consultation_id = c.consultation_id') && norm.includes('WHERE a.patient_id = ?')) {
            const pid = Number(params[0]);
            const out = [];
            for (const pr of state.tables.PRESCRIPTION) {
                const c = state.tables.CONSULTATION.find(x => Number(x.consultation_id) === Number(pr.consultation_id));
                const a = c ? state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === Number(c.appointment_id)) : null;
                if (!a || Number(a.patient_id) !== pid) continue;
                const items = state.tables.PRESCRIPTION_ITEM.filter(pi => Number(pi.prescription_id) === Number(pr.prescription_id));
                for (const pi of items) {
                    const m = state.tables.MEDICINE.find(x => Number(x.medicine_id) === Number(pi.medicine_id)) || {};
                    out.push({
                        prescription_id: pr.prescription_id,
                        consultation_id: pr.consultation_id,
                        prescribed_date: pr.prescribed_date,
                        status: pr.status,
                        medicine_name: m.medicine_name,
                        dosage: pi.dosage,
                        instructions: pi.instructions,
                        duration_days: pi.duration_days,
                        quantity: pi.quantity
                    });
                }
            }
            return [out];
        }
        if (norm === 'SELECT consultation_id FROM CONSULTATION WHERE appointment_id = ? FOR UPDATE') {
            const c = state.tables.CONSULTATION.find(x => Number(x.appointment_id) === Number(params[0]));
            return [c ? [{ consultation_id: c.consultation_id }] : []];
        }
        if (norm === 'UPDATE CONSULTATION SET symptoms = ?, diagnosis = ?, notes = ? WHERE consultation_id = ?') {
            const [sym, diag, notes, cid] = params;
            const c = state.tables.CONSULTATION.find(x => Number(x.consultation_id) === Number(cid));
            if (c) {
                c.symptoms = sym;
                c.diagnosis = diag;
                c.notes = notes;
            }
            return [{ affectedRows: c ? 1 : 0 }];
        }
        if (norm === "UPDATE APPOINTMENT SET status = 'Completed' WHERE appointment_id = ?") {
            const a = state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === Number(params[0]));
            if (a) a.status = 'Completed';
            return [{ affectedRows: a ? 1 : 0 }];
        }
        if (norm === 'INSERT INTO CONSULTATION (appointment_id, symptoms, diagnosis, notes) VALUES (?, ?, ?, ?)') {
            const [apptId, sym, diag, notes] = params;
            const cid = nextId('CONSULTATION', 'consultation_id');
            state.tables.CONSULTATION.push({
                consultation_id: cid,
                appointment_id: Number(apptId),
                symptoms: sym,
                diagnosis: diag,
                notes: notes,
                consultation_date: nowDatetimeStr()
            });
            return [{ insertId: cid, affectedRows: 1 }];
        }
        if (norm === 'INSERT INTO MEDICAL_RECORD (patient_id, doctor_id, diagnosis_summary) VALUES (?, ?, ?)') {
            const [pid, docId, summary] = params;
            const rid = nextId('MEDICAL_RECORD', 'record_id');
            state.tables.MEDICAL_RECORD.push({
                record_id: rid,
                patient_id: Number(pid),
                doctor_id: Number(docId),
                diagnosis_summary: summary,
                created_at: nowDatetimeStr()
            });
            return [{ insertId: rid, affectedRows: 1 }];
        }
        if (norm === "SELECT request_id FROM ADMISSION_REQUEST WHERE consultation_id = ? AND status = 'Pending' LIMIT 1") {
            const r = state.tables.ADMISSION_REQUEST.find(x => Number(x.consultation_id) === Number(params[0]) && x.status === 'Pending');
            return [r ? [{ request_id: r.request_id }] : []];
        }
        if (norm === 'SELECT ward_id, ward_name FROM WARD WHERE ward_name = ? LIMIT 1') {
            const w = state.tables.WARD.find(x => x.ward_name === params[0]);
            return [w ? [{ ward_id: w.ward_id, ward_name: w.ward_name }] : []];
        }
        if (norm.startsWith('INSERT INTO ADMISSION_REQUEST')) {
            const [pid, docId, cid, apptId, wardId, prio, reason] = params;
            const reqId = nextId('ADMISSION_REQUEST', 'request_id');
            state.tables.ADMISSION_REQUEST.push({
                request_id: reqId,
                patient_id: Number(pid),
                doctor_id: Number(docId),
                consultation_id: cid ? Number(cid) : null,
                appointment_id: apptId ? Number(apptId) : null,
                recommended_ward_id: Number(wardId),
                priority: prio,
                reason,
                status: 'Pending',
                assigned_bed_id: null,
                assigned_by: null,
                created_at: nowDatetimeStr(),
                assigned_at: null
            });
            return [{ insertId: reqId, affectedRows: 1 }];
        }
        if (norm === 'SELECT medicine_id FROM MEDICINE WHERE medicine_id = ?') {
            const m = state.tables.MEDICINE.find(x => Number(x.medicine_id) === Number(params[0]));
            return [m ? [{ medicine_id: m.medicine_id }] : []];
        }
        if (norm === 'INSERT INTO PRESCRIPTION (consultation_id, status) VALUES (?, ?)') {
            const [cid, st] = params;
            const pid = nextId('PRESCRIPTION', 'prescription_id');
            state.tables.PRESCRIPTION.push({
                prescription_id: pid,
                consultation_id: Number(cid),
                prescribed_date: nowDatetimeStr(),
                status: st || 'Pending'
            });
            return [{ insertId: pid, affectedRows: 1 }];
        }
        if (norm === 'INSERT INTO PRESCRIPTION_ITEM (prescription_id, medicine_id, dosage, instructions, duration_days, quantity) VALUES (?, ?, ?, ?, ?, ?)') {
            const [prescId, medId, dosage, instr, dur, qty] = params;
            const itemId = nextId('PRESCRIPTION_ITEM', 'item_id');
            state.tables.PRESCRIPTION_ITEM.push({
                item_id: itemId,
                prescription_id: Number(prescId),
                medicine_id: Number(medId),
                dosage,
                instructions: instr,
                duration_days: Number(dur),
                quantity: Number(qty)
            });
            return [{ insertId: itemId, affectedRows: 1 }];
        }
        if (norm.includes('SELECT c.consultation_id, a.doctor_id') && norm.includes('FROM CONSULTATION c JOIN APPOINTMENT a')) {
            const cid = Number(params[0]);
            const c = state.tables.CONSULTATION.find(x => Number(x.consultation_id) === cid);
            if (!c) return [[]];
            const a = state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === Number(c.appointment_id));
            if (!a) return [[]];
            return [[{ consultation_id: c.consultation_id, doctor_id: a.doctor_id, patient_id: a.patient_id }]];
        }
        if (norm === 'SELECT test_id FROM LAB_TEST WHERE test_id = ?') {
            const t = state.tables.LAB_TEST.find(x => Number(x.test_id) === Number(params[0]));
            return [t ? [{ test_id: t.test_id }] : []];
        }
        if (norm === "INSERT INTO LAB_REQUEST (consultation_id, test_id, requested_by, priority, status) VALUES (?, ?, ?, ?, 'Pending')") {
            const [cid, tid, reqBy, prio] = params;
            const reqId = nextId('LAB_REQUEST', 'request_id');
            state.tables.LAB_REQUEST.push({
                request_id: reqId,
                consultation_id: Number(cid),
                test_id: Number(tid),
                requested_by: Number(reqBy),
                priority: prio || 'Normal',
                status: 'Pending',
                request_date: nowDatetimeStr()
            });
            return [{ insertId: reqId, affectedRows: 1 }];
        }
        if (norm === 'SELECT test_id, test_name FROM LAB_TEST ORDER BY test_name') {
            return [[...state.tables.LAB_TEST].sort((a, b) => a.test_name.localeCompare(b.test_name))];
        }
        if (norm.startsWith('SELECT medicine_id, medicine_name, stock_qty FROM vw_medicine_inventory WHERE medicine_name LIKE ?')) {
            const q = String(params[0] || '').replace(/%/g, '').toLowerCase();
            const rows = computeVwMedicineInventory()
                .filter(m => m.stock_qty > 0 && m.medicine_name.toLowerCase().includes(q))
                .sort((a, b) => a.medicine_name.localeCompare(b.medicine_name));
            return [rows];
        }

        if (norm.includes('FROM LAB_REPORT lr') && norm.includes('JOIN LAB_REQUEST')) {
            const rows = state.tables.LAB_REPORT.map(lr => {
                const rq = state.tables.LAB_REQUEST.find(x => Number(x.request_id) === Number(lr.request_id)) || {};
                const lt = state.tables.LAB_TEST.find(x => Number(x.test_id) === Number(rq.test_id)) || {};
                const c = state.tables.CONSULTATION.find(x => Number(x.consultation_id) === Number(rq.consultation_id)) || {};
                const a = state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === Number(c.appointment_id)) || {};
                const up = state.tables.USER.find(x => Number(x.user_id) === Number(a.patient_id)) || {};
                const ud = state.tables.USER.find(x => Number(x.user_id) === Number(rq.requested_by)) || {};
                const ut = state.tables.USER.find(x => Number(x.user_id) === Number(lr.technician_id)) || {};
                return {
                    report_id: lr.report_id,
                    request_id: lr.request_id,
                    priority: rq.priority,
                    status: rq.status,
                    patient_id: a.patient_id,
                    patient_name: up.name,
                    test_name: lt.test_name,
                    test_category: lt.test_category,
                    result_summary: lr.result_summary,
                    report_date: lr.report_date,
                    requested_by: rq.requested_by,
                    doctor_id: a.doctor_id,
                    requested_by_name: ud.name,
                    technician_name: ut.name
                };
            });
            if (norm.includes('WHERE lr.report_id = ?')) {
                return [rows.filter(r => Number(r.report_id) === Number(params[0]))];
            }
            if (norm.includes('WHERE a.patient_id = ?')) {
                return [rows.filter(r => Number(r.patient_id) === Number(params[0]))];
            }
            if (norm.includes('WHERE rq.requested_by = ? OR a.doctor_id = ?')) {
                const docId = Number(params[0]);
                return [rows.filter(r => Number(r.requested_by) === docId || Number(r.doctor_id) === docId)];
            }
            return [rows];
        }
        if (norm.includes('FROM LAB_REQUEST lr') && norm.includes("WHERE lr.status = 'Pending'")) {
            const rows = state.tables.LAB_REQUEST
                .filter(lr => lr.status === 'Pending')
                .map(lr => {
                    const lt = state.tables.LAB_TEST.find(x => Number(x.test_id) === Number(lr.test_id)) || {};
                    const c = state.tables.CONSULTATION.find(x => Number(x.consultation_id) === Number(lr.consultation_id)) || {};
                    const a = state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === Number(c.appointment_id)) || {};
                    const up = state.tables.USER.find(x => Number(x.user_id) === Number(a.patient_id)) || {};
                    const ud = state.tables.USER.find(x => Number(x.user_id) === Number(lr.requested_by)) || {};
                    return {
                        request_id: lr.request_id,
                        priority: lr.priority,
                        test_name: lt.test_name,
                        test_category: lt.test_category,
                        patient_id: a.patient_id,
                        patient_name: up.name,
                        requested_by: ud.name
                    };
                });
            return [rows];
        }
        if (norm.includes('FROM LAB_REQUEST lr') && norm.includes('WHERE lr.request_id = ? FOR UPDATE')) {
            const lr = state.tables.LAB_REQUEST.find(x => Number(x.request_id) === Number(params[0]));
            if (!lr) return [[]];
            const lt = state.tables.LAB_TEST.find(x => Number(x.test_id) === Number(lr.test_id)) || {};
            const c = state.tables.CONSULTATION.find(x => Number(x.consultation_id) === Number(lr.consultation_id)) || {};
            const a = state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === Number(c.appointment_id)) || {};
            return [[{
                request_id: lr.request_id,
                test_id: lr.test_id,
                requested_by: lr.requested_by,
                status: lr.status,
                test_name: lt.test_name,
                test_category: lt.test_category,
                patient_id: a.patient_id
            }]];
        }
        if (norm === 'SELECT staff_id FROM STAFF WHERE staff_id = ?') {
            const s = state.tables.STAFF.find(x => Number(x.staff_id) === Number(params[0]));
            return [s ? [{ staff_id: s.staff_id }] : []];
        }
        if (norm === "SELECT staff_id FROM STAFF WHERE staff_type = 'LAB_TECHNICIAN' LIMIT 1") {
            const s = state.tables.STAFF.find(x => x.staff_type === 'LAB_TECHNICIAN');
            return [s ? [{ staff_id: s.staff_id }] : []];
        }
        if (norm === 'INSERT INTO LAB_REPORT (request_id, technician_id, result_summary) VALUES (?, ?, ?)') {
            const [reqId, techId, summary] = params;
            const repId = nextId('LAB_REPORT', 'report_id');
            state.tables.LAB_REPORT.push({
                report_id: repId,
                request_id: Number(reqId),
                technician_id: Number(techId),
                result_summary: summary,
                report_date: nowDatetimeStr()
            });
            return [{ insertId: repId, affectedRows: 1 }];
        }
        if (norm === "UPDATE LAB_REQUEST SET status='Completed' WHERE request_id=?") {
            const lr = state.tables.LAB_REQUEST.find(x => Number(x.request_id) === Number(params[0]));
            if (lr) lr.status = 'Completed';
            return [{ affectedRows: lr ? 1 : 0 }];
        }

        if (norm.includes('FROM PRESCRIPTION pr') && norm.includes("WHERE pr.status = 'Pending'")) {
            const rows = state.tables.PRESCRIPTION
                .filter(p => p.status === 'Pending')
                .map(p => {
                    const c = state.tables.CONSULTATION.find(x => Number(x.consultation_id) === Number(p.consultation_id)) || {};
                    const a = state.tables.APPOINTMENT.find(x => Number(x.appointment_id) === Number(c.appointment_id)) || {};
                    const up = state.tables.USER.find(x => Number(x.user_id) === Number(a.patient_id)) || {};
                    const ud = state.tables.USER.find(x => Number(x.user_id) === Number(a.doctor_id)) || {};
                    return {
                        prescription_id: p.prescription_id,
                        patient_name: up.name,
                        doctor_name: ud.name,
                        prescribed_date: p.prescribed_date
                    };
                });
            return [rows];
        }
        if (norm.includes('FROM PRESCRIPTION_ITEM pi JOIN vw_medicine_inventory m ON pi.medicine_id = m.medicine_id WHERE pi.prescription_id = ?')) {
            const prescId = Number(params[0]);
            const inv = computeVwMedicineInventory();
            const items = state.tables.PRESCRIPTION_ITEM.filter(pi => Number(pi.prescription_id) === prescId);
            const rows = items.map(pi => {
                const m = inv.find(x => Number(x.medicine_id) === Number(pi.medicine_id)) || {};
                const reqQty = items.filter(x => Number(x.medicine_id) === Number(pi.medicine_id)).reduce((s, x) => s + Number(x.quantity), 0);
                return {
                    ...pi,
                    medicine_name: m.medicine_name,
                    current_stock: m.stock_qty || 0,
                    required_quantity: reqQty,
                    stock_after: (m.stock_qty || 0) - reqQty
                };
            });
            return [rows];
        }
        if (norm.startsWith('SELECT medicine_id, medicine_name, manufacturer, unit_price, stock_qty, expiry_date FROM vw_medicine_inventory')) {
            let rows = computeVwMedicineInventory();
            if (params.length > 0) {
                const q = String(params[0]).replace(/%/g, '').toLowerCase();
                rows = rows.filter(r => r.medicine_name.toLowerCase().includes(q));
            }
            return [rows];
        }
        if (norm === 'SELECT * FROM PRESCRIPTION WHERE prescription_id = ? FOR UPDATE') {
            return [state.tables.PRESCRIPTION.filter(p => Number(p.prescription_id) === Number(params[0]))];
        }
        if (norm.includes('FROM PRESCRIPTION_ITEM pi JOIN MEDICINE m ON pi.medicine_id = m.medicine_id WHERE pi.prescription_id = ?')) {
            const prescId = Number(params[0]);
            const rows = state.tables.PRESCRIPTION_ITEM
                .filter(pi => Number(pi.prescription_id) === prescId)
                .map(pi => {
                    const m = state.tables.MEDICINE.find(x => Number(x.medicine_id) === Number(pi.medicine_id)) || {};
                    return { item_id: pi.item_id, medicine_id: pi.medicine_id, quantity: pi.quantity, medicine_name: m.medicine_name };
                });
            return [rows];
        }
        if (norm === 'INSERT INTO DISPENSING_RECORD (prescription_id, pharmacist_id, dispensed_at, notes) VALUES (?, ?, NOW(), ?)') {
            const [prescId, pharmId, notes] = params;
            const dispId = nextId('DISPENSING_RECORD', 'dispensing_id');
            state.tables.DISPENSING_RECORD.push({
                dispensing_id: dispId,
                prescription_id: Number(prescId),
                pharmacist_id: Number(pharmId),
                dispensed_at: nowDatetimeStr(),
                notes
            });
            return [{ insertId: dispId, affectedRows: 1 }];
        }
        if (norm.includes('FROM MEDICINE_BATCH WHERE medicine_id = ? AND available_qty > 0 AND expiry_date >= CURDATE()')) {
            const medId = Number(params[0]);
            const today = localIsoDate(0);
            const rows = state.tables.MEDICINE_BATCH
                .filter(b => Number(b.medicine_id) === medId && Number(b.available_qty) > 0 && b.expiry_date >= today)
                .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date) || (a.batch_id - b.batch_id));
            return [rows];
        }
        if (norm === 'UPDATE MEDICINE_BATCH SET available_qty = available_qty - ? WHERE batch_id = ?') {
            const [deduct, batchId] = params;
            const b = state.tables.MEDICINE_BATCH.find(x => Number(x.batch_id) === Number(batchId));
            if (b) {
                const invBefore = computeVwMedicineInventory().find(m => Number(m.medicine_id) === Number(b.medicine_id));
                const oldTotal = invBefore ? invBefore.stock_qty : 0;
                b.available_qty = Number(b.available_qty) - Number(deduct);
                const invAfter = computeVwMedicineInventory().find(m => Number(m.medicine_id) === Number(b.medicine_id));
                const newTotal = invAfter ? invAfter.stock_qty : 0;
                if (newTotal < 20 && oldTotal >= 20) {
                    const med = state.tables.MEDICINE.find(m => Number(m.medicine_id) === Number(b.medicine_id));
                    state.tables.USER.filter(u => [1, 6].includes(Number(u.role_id))).forEach(u => {
                        state.tables.NOTIFICATION.push({
                            notification_id: nextId('NOTIFICATION', 'notification_id'),
                            user_id: u.user_id,
                            message: `Low stock alert: ${med ? med.medicine_name : 'Medicine'} has only ${newTotal} units left`,
                            is_read: false,
                            created_at: nowDatetimeStr()
                        });
                    });
                }
            }
            return [{ affectedRows: b ? 1 : 0 }];
        }
        if (norm.startsWith('INSERT INTO DISPENSING_ITEM')) {
            const [dispId, pItemId, batchId, qty] = params;
            const diId = nextId('DISPENSING_ITEM', 'dispensing_item_id');
            state.tables.DISPENSING_ITEM.push({
                dispensing_item_id: diId,
                dispensing_id: Number(dispId),
                prescription_item_id: Number(pItemId),
                batch_id: Number(batchId),
                quantity_dispensed: Number(qty)
            });
            return [{ insertId: diId, affectedRows: 1 }];
        }
        if (norm === "UPDATE PRESCRIPTION SET status = 'Dispensed' WHERE prescription_id = ?") {
            const p = state.tables.PRESCRIPTION.find(x => Number(x.prescription_id) === Number(params[0]));
            if (p) p.status = 'Dispensed';
            return [{ affectedRows: p ? 1 : 0 }];
        }

        if (norm.includes('FROM vw_bill_summary')) {
            let summaries = computeVwBillSummary().map(b => {
                const up = state.tables.USER.find(u => Number(u.user_id) === Number(b.patient_id)) || {};
                return { ...b, patient_name: up.name };
            });
            if (norm.includes('WHERE appointment_id = ?')) {
                const apptId = Number(params[0]);
                return [summaries.filter(b => Number(b.appointment_id) === apptId).sort((a, b) => b.bill_id - a.bill_id).slice(0, 1)];
            }
            if (norm.includes('WHERE b.bill_id = ?') || norm.includes('WHERE bill_id = ?')) {
                const bid = Number(params[0]);
                return [summaries.filter(b => Number(b.bill_id) === bid)];
            }
            if (norm.includes('WHERE b.patient_id = ?') || norm.includes('WHERE patient_id = ?')) {
                const pid = Number(params[0]);
                return [summaries.filter(b => Number(b.patient_id) === pid)];
            }
            if (norm.includes('EXISTS (SELECT 1 FROM APPOINTMENT')) {
                const docId = Number(params[0]);
                summaries = summaries.filter(b => {
                    const apptOk = b.appointment_id && state.tables.APPOINTMENT.some(a => Number(a.appointment_id) === Number(b.appointment_id) && Number(a.doctor_id) === docId);
                    const admOk = b.admission_id && state.tables.ADMISSION.some(a => Number(a.admission_id) === Number(b.admission_id) && Number(a.admitting_doctor_id) === docId);
                    const emgOk = b.case_id && state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.some(e => Number(e.case_id) === Number(b.case_id) && Number(e.doctor_id) === docId);
                    return apptOk || admOk || emgOk;
                });
                return [summaries];
            }
            return [summaries];
        }
        if (norm === 'SELECT appointment_id FROM APPOINTMENT WHERE appointment_id = ? AND doctor_id = ?') {
            return [state.tables.APPOINTMENT.filter(a => Number(a.appointment_id) === Number(params[0]) && Number(a.doctor_id) === Number(params[1]))];
        }
        if (norm === 'SELECT admission_id FROM ADMISSION WHERE admission_id = ? AND admitting_doctor_id = ?') {
            return [state.tables.ADMISSION.filter(a => Number(a.admission_id) === Number(params[0]) && Number(a.admitting_doctor_id) === Number(params[1]))];
        }
        if (norm === 'SELECT assignment_id FROM EMERGENCY_DOCTOR_ASSIGNMENT WHERE case_id = ? AND doctor_id = ?') {
            return [state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.filter(e => Number(e.case_id) === Number(params[0]) && Number(e.doctor_id) === Number(params[1]))];
        }
        if (norm.includes('FROM BILL_ITEM WHERE bill_id = ?')) {
            return [state.tables.BILL_ITEM.filter(i => Number(i.bill_id) === Number(params[0]))];
        }
        if (norm.includes('FROM PAYMENT pm') && norm.includes('WHERE pm.bill_id = ?')) {
            const bid = Number(params[0]);
            const rows = state.tables.PAYMENT
                .filter(p => Number(p.bill_id) === bid)
                .map(p => {
                    const u = state.tables.USER.find(x => Number(x.user_id) === Number(p.received_by)) || {};
                    return { ...p, received_by_name: u.name || 'System' };
                });
            return [rows];
        }
        if (norm.includes('FROM PAYMENT pm') && norm.includes('WHERE pm.payment_id = ?')) {
            const pid = Number(params[0]);
            const p = state.tables.PAYMENT.find(x => Number(x.payment_id) === pid);
            if (!p) return [[]];
            const u = state.tables.USER.find(x => Number(x.user_id) === Number(p.received_by)) || {};
            return [[{ ...p, received_by_name: u.name || 'Staff' }]];
        }
        if (norm === 'SELECT * FROM BILL WHERE bill_id = ? FOR UPDATE') {
            return [state.tables.BILL.filter(b => Number(b.bill_id) === Number(params[0]))];
        }
        if (norm === 'SELECT payment_id, receipt_number FROM PAYMENT WHERE bill_id = ? AND reference_no = ? LIMIT 1') {
            const p = state.tables.PAYMENT.find(x => Number(x.bill_id) === Number(params[0]) && x.reference_no === params[1]);
            return [p ? [p] : []];
        }
        if (norm === 'SELECT COALESCE(MAX(payment_id), 0) AS max_id FROM PAYMENT FOR UPDATE') {
            const maxId = state.tables.PAYMENT.reduce((m, p) => Math.max(m, Number(p.payment_id || 0)), 0);
            return [[{ max_id: maxId }]];
        }
        if (norm.startsWith('INSERT INTO PAYMENT')) {
            const [billId, amtPaid, method, refNo, receiptNo, recBy] = params;
            const pid = nextId('PAYMENT', 'payment_id');
            state.tables.PAYMENT.push({
                payment_id: pid,
                bill_id: Number(billId),
                amount_paid: Number(amtPaid),
                payment_method: method,
                reference_no: refNo,
                receipt_number: receiptNo,
                paid_at: nowDatetimeStr(),
                received_by: recBy ? Number(recBy) : null
            });
            return [{ insertId: pid, affectedRows: 1 }];
        }

        if (norm.includes('FROM ADMISSION_REQUEST ar') && norm.includes("WHERE ar.status = 'Pending'")) {
            const rows = state.tables.ADMISSION_REQUEST
                .filter(ar => ar.status === 'Pending')
                .map(ar => {
                    const w = state.tables.WARD.find(x => Number(x.ward_id) === Number(ar.recommended_ward_id)) || {};
                    const p = state.tables.PATIENT.find(x => Number(x.patient_id) === Number(ar.patient_id)) || {};
                    const up = state.tables.USER.find(x => Number(x.user_id) === Number(ar.patient_id)) || {};
                    const doc = state.tables.DOCTOR.find(x => Number(x.doctor_id) === Number(ar.doctor_id)) || {};
                    const ud = state.tables.USER.find(x => Number(x.user_id) === Number(ar.doctor_id)) || {};
                    return {
                        ...ar,
                        patient_name: up.name,
                        patient_phone: up.phone,
                        blood_group: p.blood_group,
                        gender: p.gender,
                        age: computeAgeYears(p.dob),
                        doctor_name: ud.name,
                        specialization: doc.specialization,
                        recommended_ward: w.ward_name
                    };
                });
            return [rows];
        }
        if (norm === 'SELECT * FROM ADMISSION_REQUEST WHERE request_id = ? FOR UPDATE') {
            return [state.tables.ADMISSION_REQUEST.filter(r => Number(r.request_id) === Number(params[0]))];
        }
        if (norm === "SELECT admission_id, bed_id FROM ADMISSION WHERE patient_id = ? AND status = 'Admitted' FOR UPDATE") {
            return [state.tables.ADMISSION.filter(a => Number(a.patient_id) === Number(params[0]) && a.status === 'Admitted')];
        }
        if (norm === "SELECT admission_id, bed_id FROM ADMISSION WHERE patient_id = ? AND status = 'Admitted' AND bed_id <> ? FOR UPDATE") {
            return [state.tables.ADMISSION.filter(a => Number(a.patient_id) === Number(params[0]) && a.status === 'Admitted' && Number(a.bed_id) !== Number(params[1]))];
        }
        if (norm === "SELECT admission_id, bed_id FROM ADMISSION WHERE case_id = ? AND status = 'Admitted' FOR UPDATE") {
            return [state.tables.ADMISSION.filter(a => Number(a.case_id) === Number(params[0]) && a.status === 'Admitted')];
        }
        if (norm === "SELECT admission_id FROM ADMISSION WHERE bed_id = ? AND status = 'Admitted' FOR UPDATE") {
            return [state.tables.ADMISSION.filter(a => Number(a.bed_id) === Number(params[0]) && a.status === 'Admitted')];
        }
        if (norm === "SELECT * FROM ADMISSION WHERE bed_id = ? AND status = 'Admitted' FOR UPDATE") {
            return [state.tables.ADMISSION.filter(a => Number(a.bed_id) === Number(params[0]) && a.status === 'Admitted')];
        }
        if (norm.includes('FROM BED b JOIN WARD w ON b.ward_id = w.ward_id WHERE b.bed_id = ? FOR UPDATE')) {
            const b = state.tables.BED.find(x => Number(x.bed_id) === Number(params[0]));
            if (!b) return [[]];
            const w = state.tables.WARD.find(x => Number(x.ward_id) === Number(b.ward_id)) || {};
            return [[{ ...b, ward_name: w.ward_name, daily_rate: w.daily_rate }]];
        }
        if (norm === 'SELECT * FROM BED WHERE bed_id = ? FOR UPDATE') {
            return [state.tables.BED.filter(b => Number(b.bed_id) === Number(params[0]))];
        }
        if (norm === "UPDATE BED SET status = 'Occupied' WHERE bed_id = ?" || norm === "UPDATE BED SET status='Occupied' WHERE bed_id=?") {
            const b = state.tables.BED.find(x => Number(x.bed_id) === Number(params[0]));
            if (b) b.status = 'Occupied';
            return [{ affectedRows: b ? 1 : 0 }];
        }
        if (norm === "UPDATE BED SET status = 'Cleaning' WHERE bed_id = ?" || norm === "UPDATE BED SET status='Cleaning' WHERE bed_id=?") {
            const b = state.tables.BED.find(x => Number(x.bed_id) === Number(params[0]));
            if (b) b.status = 'Cleaning';
            return [{ affectedRows: b ? 1 : 0 }];
        }
        if (norm === "UPDATE BED SET status = 'Available' WHERE bed_id = ?") {
            const b = state.tables.BED.find(x => Number(x.bed_id) === Number(params[0]));
            if (b) b.status = 'Available';
            return [{ affectedRows: b ? 1 : 0 }];
        }
        if (norm === 'UPDATE BED SET status = ? WHERE bed_id = ?') {
            const [st, bid] = params;
            const b = state.tables.BED.find(x => Number(x.bed_id) === Number(bid));
            if (b) b.status = st;
            return [{ affectedRows: b ? 1 : 0 }];
        }
        if (norm === "UPDATE ADMISSION_REQUEST SET status = 'Assigned', assigned_bed_id = ?, assigned_by = ?, assigned_at = NOW() WHERE request_id = ?") {
            const [bid, byId, reqId] = params;
            const r = state.tables.ADMISSION_REQUEST.find(x => Number(x.request_id) === Number(reqId));
            if (r) {
                r.status = 'Assigned';
                r.assigned_bed_id = Number(bid);
                r.assigned_by = Number(byId);
                r.assigned_at = nowDatetimeStr();
            }
            return [{ affectedRows: r ? 1 : 0 }];
        }
        if (norm.startsWith('INSERT INTO ADMISSION')) {
            const admId = nextId('ADMISSION', 'admission_id');
            if (norm.includes('request_id')) {
                const [pid, reqId, docId, bid] = params;
                state.tables.ADMISSION.push({
                    admission_id: admId,
                    patient_id: Number(pid),
                    case_id: null,
                    request_id: Number(reqId),
                    admitting_doctor_id: Number(docId),
                    bed_id: Number(bid),
                    admitted_at: nowDatetimeStr(),
                    discharged_at: null,
                    discharged_by: null,
                    discharge_summary: null,
                    status: 'Admitted'
                });
            } else if (norm.includes('case_id')) {
                const [pid, caseId, docId, bid] = params;
                state.tables.ADMISSION.push({
                    admission_id: admId,
                    patient_id: Number(pid),
                    case_id: Number(caseId),
                    request_id: null,
                    admitting_doctor_id: docId ? Number(docId) : null,
                    bed_id: Number(bid),
                    admitted_at: nowDatetimeStr(),
                    discharged_at: null,
                    discharged_by: null,
                    discharge_summary: null,
                    status: 'Admitted'
                });
            } else {
                const [pid, docId, bid] = params;
                state.tables.ADMISSION.push({
                    admission_id: admId,
                    patient_id: Number(pid),
                    case_id: null,
                    request_id: null,
                    admitting_doctor_id: docId ? Number(docId) : null,
                    bed_id: Number(bid),
                    admitted_at: nowDatetimeStr(),
                    discharged_at: null,
                    discharged_by: null,
                    discharge_summary: null,
                    status: 'Admitted'
                });
            }
            return [{ insertId: admId, affectedRows: 1 }];
        }
        if (norm.includes('FROM ADMISSION adm JOIN BED b ON adm.bed_id = b.bed_id JOIN WARD w ON b.ward_id = w.ward_id')) {
            let rows = state.tables.ADMISSION.map(adm => {
                const b = state.tables.BED.find(x => Number(x.bed_id) === Number(adm.bed_id)) || {};
                const w = state.tables.WARD.find(x => Number(x.ward_id) === Number(b.ward_id)) || {};
                return { ...adm, bed_number: b.bed_number, ward_name: w.ward_name, daily_rate: Number(w.daily_rate || 1000) };
            });
            if (norm.includes("WHERE adm.status = 'Admitted'")) {
                rows = rows.filter(r => r.status === 'Admitted');
            }
            if (norm.includes('adm.admission_id = ?')) {
                rows = rows.filter(r => Number(r.admission_id) === Number(params[0]));
            } else if (norm.includes('adm.bed_id = ?')) {
                rows = rows.filter(r => Number(r.bed_id) === Number(params[0]));
            } else if (norm.includes('adm.patient_id = ?')) {
                rows = rows.filter(r => Number(r.patient_id) === Number(params[0]));
            }
            return [rows];
        }
        if (norm.startsWith('UPDATE ADMISSION SET') && norm.includes("status = 'Discharged'")) {
            const admId = Number(params[params.length - 1]);
            const adm = state.tables.ADMISSION.find(a => Number(a.admission_id) === admId);
            if (adm) {
                adm.status = 'Discharged';
                adm.discharged_at = nowDatetimeStr();
                adm.discharged_by = Number(params[0]);
                adm.discharge_summary = params[1] || adm.discharge_summary || 'Discharged from inpatient ward';
            }
            return [{ affectedRows: adm ? 1 : 0 }];
        }
        if (norm === 'SELECT bill_item_id, bill_id FROM BILL_ITEM WHERE reference_key = ? LIMIT 1') {
            const bi = state.tables.BILL_ITEM.find(x => x.reference_key === params[0]);
            return [bi ? [{ bill_item_id: bi.bill_item_id, bill_id: bi.bill_id }] : []];
        }
        if (norm.includes("FROM BILL b JOIN vw_bill_summary vbs ON b.bill_id = vbs.bill_id WHERE b.patient_id = ? AND vbs.payment_status <> 'Paid'")) {
            const pid = Number(params[0]);
            const unpaid = computeVwBillSummary()
                .filter(b => Number(b.patient_id) === pid && b.payment_status !== 'Paid')
                .sort((a, b) => b.bill_id - a.bill_id);
            return [unpaid.slice(0, 1)];
        }
        if (norm === 'UPDATE BILL SET admission_id = COALESCE(admission_id, ?) WHERE bill_id = ?') {
            const [admId, bid] = params;
            const b = state.tables.BILL.find(x => Number(x.bill_id) === Number(bid));
            if (b && !b.admission_id) b.admission_id = Number(admId);
            return [{ affectedRows: b ? 1 : 0 }];
        }
        if (norm === 'UPDATE BILL SET case_id = COALESCE(case_id, ?) WHERE bill_id = ?') {
            const [caseId, bid] = params;
            const b = state.tables.BILL.find(x => Number(x.bill_id) === Number(bid));
            if (b && !b.case_id) b.case_id = Number(caseId);
            return [{ affectedRows: b ? 1 : 0 }];
        }
        if (norm === 'INSERT INTO BILL (patient_id, admission_id, bill_date, generated_by) VALUES (?, ?, NOW(), ?)') {
            const [pid, admId, genBy] = params;
            const bid = nextId('BILL', 'bill_id');
            state.tables.BILL.push({
                bill_id: bid,
                patient_id: Number(pid),
                appointment_id: null,
                admission_id: Number(admId),
                case_id: null,
                bill_date: nowDatetimeStr(),
                generated_by: Number(genBy)
            });
            return [{ insertId: bid, affectedRows: 1 }];
        }
        if (norm === 'INSERT INTO BILL (patient_id, case_id, bill_date, generated_by) VALUES (?, ?, NOW(), ?)') {
            const [pid, caseId, genBy] = params;
            const bid = nextId('BILL', 'bill_id');
            state.tables.BILL.push({
                bill_id: bid,
                patient_id: Number(pid),
                appointment_id: null,
                admission_id: null,
                case_id: Number(caseId),
                bill_date: nowDatetimeStr(),
                generated_by: Number(genBy)
            });
            return [{ insertId: bid, affectedRows: 1 }];
        }
        if (norm.startsWith('INSERT INTO BILL_ITEM')) {
            const [billId, itemType, desc, amt, refKey] = params;
            if (refKey && state.tables.BILL_ITEM.some(x => x.reference_key === refKey)) {
                const err = new Error(`Duplicate reference_key ${refKey}`);
                err.code = 'ER_DUP_ENTRY';
                throw err;
            }
            const biId = nextId('BILL_ITEM', 'bill_item_id');
            state.tables.BILL_ITEM.push({
                bill_item_id: biId,
                bill_id: Number(billId),
                item_type: itemType,
                description: desc,
                amount: Number(amt),
                reference_key: refKey || null
            });
            return [{ insertId: biId, affectedRows: 1 }];
        }
        if (norm.startsWith('INSERT INTO NURSE_NOTE')) {
            const nid = nextId('NURSE_NOTE', 'note_id');
            if (params.length === 4) {
                const [pid, bid, nurseId, content] = params;
                state.tables.NURSE_NOTE.push({ note_id: nid, patient_id: Number(pid), bed_id: Number(bid), nurse_id: Number(nurseId), note_type: 'Discharge', content, created_at: nowDatetimeStr() });
            } else {
                const [pid, cid, bid, nurseId, nType, content] = params;
                state.tables.NURSE_NOTE.push({ note_id: nid, patient_id: pid ? Number(pid) : null, case_id: cid ? Number(cid) : null, bed_id: bid ? Number(bid) : null, nurse_id: Number(nurseId), note_type: nType, content, created_at: nowDatetimeStr() });
            }
            return [{ insertId: nid, affectedRows: 1 }];
        }
        if (norm.startsWith('INSERT INTO PATIENT_VITALS')) {
            const vid = nextId('PATIENT_VITALS', 'vitals_id');
            const [pid, cid, recBy, sys, dia, hr, spo2, temp, rr, notes] = params;
            state.tables.PATIENT_VITALS.push({
                vitals_id: vid,
                patient_id: pid ? Number(pid) : null,
                case_id: cid ? Number(cid) : null,
                recorded_by: Number(recBy),
                bp_systolic: sys,
                bp_diastolic: dia,
                heart_rate: hr,
                spo2: spo2,
                temperature: temp,
                respiratory_rate: rr,
                notes,
                recorded_at: nowDatetimeStr()
            });
            return [{ insertId: vid, affectedRows: 1 }];
        }

        if (norm === 'SELECT department_id, department_name FROM DEPARTMENT WHERE LOWER(department_name) = LOWER(?) LIMIT 1' ||
            norm === "SELECT department_id FROM DEPARTMENT WHERE department_name = 'Emergency Medicine' LIMIT 1") {
            const target = params[0] ? String(params[0]).toLowerCase() : 'emergency medicine';
            const d = state.tables.DEPARTMENT.find(x => x.department_name.toLowerCase() === target);
            return [d ? [d] : []];
        }
        if (norm === 'SELECT department_id FROM DEPARTMENT WHERE department_id = ?') {
            const d = state.tables.DEPARTMENT.find(x => Number(x.department_id) === Number(params[0]));
            return [d ? [d] : []];
        }
        if (norm.startsWith('INSERT INTO EMERGENCY_SEQUENCE')) {
            const yr = Number(params[0]);
            if (!state.tables.EMERGENCY_SEQUENCE.some(s => Number(s.seq_year) === yr)) {
                state.tables.EMERGENCY_SEQUENCE.push({ seq_year: yr, last_val: 0 });
            }
            return [{ affectedRows: 1 }];
        }
        if (norm === 'SELECT last_val FROM EMERGENCY_SEQUENCE WHERE seq_year = ? FOR UPDATE') {
            const yr = Number(params[0]);
            const s = state.tables.EMERGENCY_SEQUENCE.find(x => Number(x.seq_year) === yr);
            return [s ? [{ last_val: s.last_val }] : [{ last_val: 0 }]];
        }
        if (norm === 'UPDATE EMERGENCY_SEQUENCE SET last_val = ? WHERE seq_year = ?') {
            const [val, yr] = params;
            const s = state.tables.EMERGENCY_SEQUENCE.find(x => Number(x.seq_year) === Number(yr));
            if (s) s.last_val = Number(val);
            return [{ affectedRows: 1 }];
        }
        if (norm.startsWith('INSERT INTO EMERGENCY_CASE')) {
            const caseId = nextId('EMERGENCY_CASE', 'case_id');
            if (params.length === 11) {
                const [emgNo, pid, tempName, tempGen, tempAge, phone, emgCont, method, ambId, complaint, deptId] = params;
                state.tables.EMERGENCY_CASE.push({
                    case_id: caseId,
                    emg_number: emgNo,
                    patient_id: pid,
                    temp_patient_name: tempName,
                    temp_patient_gender: tempGen,
                    temp_patient_age: tempAge,
                    contact_phone: phone,
                    emergency_contact: emgCont,
                    arrival_time: nowDatetimeStr(),
                    arrival_method: method || 'Walk-in',
                    ambulance_id: ambId,
                    initial_complaint: complaint,
                    triage_priority: 'UNASSESSED',
                    assessment_status: 'Pending_Triage',
                    status: 'Waiting',
                    department_id: deptId,
                    treatment_notes: null,
                    discharge_summary: null,
                    discharged_at: null,
                    discharged_by: null,
                    created_at: nowDatetimeStr()
                });
            } else {
                const [emgNo, pid, tempName, phone, ambId, complaint, deptId] = params;
                state.tables.EMERGENCY_CASE.push({
                    case_id: caseId,
                    emg_number: emgNo,
                    patient_id: pid,
                    temp_patient_name: tempName,
                    temp_patient_gender: null,
                    temp_patient_age: null,
                    contact_phone: phone,
                    emergency_contact: null,
                    arrival_time: nowDatetimeStr(),
                    arrival_method: 'Ambulance',
                    ambulance_id: ambId,
                    initial_complaint: complaint,
                    triage_priority: 'UNASSESSED',
                    assessment_status: 'Pending_Triage',
                    status: 'Waiting',
                    department_id: deptId,
                    treatment_notes: null,
                    discharge_summary: null,
                    discharged_at: null,
                    discharged_by: null,
                    created_at: nowDatetimeStr()
                });
            }
            return [{ insertId: caseId, affectedRows: 1 }];
        }
        if (norm.includes('FROM EMERGENCY_CASE ec') && norm.includes("WHERE ec.status NOT IN ('Discharged', 'Transferred')") && norm.includes('triage_count')) {
            const rows = state.tables.EMERGENCY_CASE
                .filter(ec => !['Discharged', 'Transferred'].includes(ec.status))
                .map(ec => {
                    const p = ec.patient_id ? state.tables.PATIENT.find(x => Number(x.patient_id) === Number(ec.patient_id)) : null;
                    const u = ec.patient_id ? state.tables.USER.find(x => Number(x.user_id) === Number(ec.patient_id)) : null;
                    const eda = state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.find(x => Number(x.case_id) === Number(ec.case_id) && Boolean(x.is_active));
                    const doc = eda ? state.tables.DOCTOR.find(x => Number(x.doctor_id) === Number(eda.doctor_id)) : null;
                    const ud = doc ? state.tables.USER.find(x => Number(x.user_id) === Number(doc.doctor_id)) : null;
                    const eba = state.tables.EMERGENCY_BED_ASSIGNMENT.find(x => Number(x.case_id) === Number(ec.case_id) && Boolean(x.is_active));
                    const b = eba ? state.tables.BED.find(x => Number(x.bed_id) === Number(eba.bed_id)) : null;
                    const w = b ? state.tables.WARD.find(x => Number(x.ward_id) === Number(b.ward_id)) : null;
                    const dep = ec.department_id ? state.tables.DEPARTMENT.find(x => Number(x.department_id) === Number(ec.department_id)) : null;
                    const amb = ec.ambulance_id ? state.tables.AMBULANCE.find(x => Number(x.ambulance_id) === Number(ec.ambulance_id)) : null;
                    const triages = state.tables.TRIAGE_ASSESSMENT.filter(t => Number(t.case_id) === Number(ec.case_id));
                    return {
                        case_id: ec.case_id,
                        emg_number: ec.emg_number,
                        patient_id: ec.patient_id,
                        patient_name: (u && u.name) || ec.temp_patient_name || 'Unidentified Patient',
                        gender: (p && p.gender) || ec.temp_patient_gender || '--',
                        age: (p && computeAgeYears(p.dob)) ?? ec.temp_patient_age ?? '--',
                        arrival_time: ec.arrival_time,
                        waiting_minutes: minutesSince(ec.arrival_time),
                        arrival_method: ec.arrival_method,
                        initial_complaint: ec.initial_complaint,
                        triage_priority: ec.triage_priority,
                        assessment_status: ec.assessment_status,
                        status: ec.status,
                        assigned_doctor_id: eda ? eda.doctor_id : null,
                        assigned_doctor_name: ud ? ud.name : null,
                        doctor_specialization: doc ? doc.specialization : null,
                        assigned_bed_id: eba ? eba.bed_id : null,
                        bed_number: b ? b.bed_number : null,
                        ward_name: w ? w.ward_name : null,
                        department_id: ec.department_id,
                        department_name: dep ? dep.department_name : null,
                        ambulance_number: amb ? amb.vehicle_number : null,
                        triage_count: triages.length,
                        last_triage_time: triages.length ? triages[triages.length - 1].assessed_at : null
                    };
                });
            return [rows];
        }
        if (norm.includes('FROM EMERGENCY_CASE ec') && norm.includes('WHERE ec.case_id = ?')) {
            const cid = Number(params[0]);
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === cid);
            if (!ec) return [[]];
            const p = ec.patient_id ? state.tables.PATIENT.find(x => Number(x.patient_id) === Number(ec.patient_id)) : null;
            const u = ec.patient_id ? state.tables.USER.find(x => Number(x.user_id) === Number(ec.patient_id)) : null;
            const eda = state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.find(x => Number(x.case_id) === cid && Boolean(x.is_active));
            const doc = eda ? state.tables.DOCTOR.find(x => Number(x.doctor_id) === Number(eda.doctor_id)) : null;
            const ud = doc ? state.tables.USER.find(x => Number(x.user_id) === Number(doc.doctor_id)) : null;
            const eba = state.tables.EMERGENCY_BED_ASSIGNMENT.find(x => Number(x.case_id) === cid && Boolean(x.is_active));
            const b = eba ? state.tables.BED.find(x => Number(x.bed_id) === Number(eba.bed_id)) : null;
            const w = b ? state.tables.WARD.find(x => Number(x.ward_id) === Number(b.ward_id)) : null;
            const dep = ec.department_id ? state.tables.DEPARTMENT.find(x => Number(x.department_id) === Number(ec.department_id)) : null;
            const amb = ec.ambulance_id ? state.tables.AMBULANCE.find(x => Number(x.ambulance_id) === Number(ec.ambulance_id)) : null;
            const vpa = ec.patient_id ? computeVwPatientAllergies().find(x => Number(x.patient_id) === Number(ec.patient_id)) : null;
            return [[{
                ...ec,
                assigned_doctor_id: eda ? eda.doctor_id : null,
                assigned_bed_id: eba ? eba.bed_id : null,
                patient_name: (u && u.name) || ec.temp_patient_name || 'Unidentified Patient',
                patient_email: (u && u.email) || '--',
                phone: (u && u.phone) || ec.contact_phone || '--',
                gender: (p && p.gender) || ec.temp_patient_gender || '--',
                blood_group: (p && p.blood_group) || '--',
                allergies: (vpa && vpa.allergies) || 'None documented',
                age: (p && computeAgeYears(p.dob)) ?? ec.temp_patient_age ?? 35,
                assigned_doctor_name: ud ? ud.name : null,
                doctor_specialization: doc ? doc.specialization : null,
                bed_number: b ? b.bed_number : null,
                ward_name: w ? w.ward_name : null,
                department_name: dep ? dep.department_name : null,
                vehicle_number: amb ? amb.vehicle_number : null,
                driver_name: amb ? amb.driver_name : null,
                waiting_minutes: minutesSince(ec.arrival_time)
            }]];
        }
        if (norm.includes('FROM EMERGENCY_CASE WHERE case_id = ?')) {
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === Number(params[0]));
            return [ec ? [ec] : []];
        }
        if (norm.startsWith('INSERT INTO TRIAGE_ASSESSMENT')) {
            const [cid, nurseId, sys, dia, hr, spo2, temp, tempUnit, rr, consc, gcs, prio, reason, sym, inj, notes, rawPayload] = params;
            const aid = nextId('TRIAGE_ASSESSMENT', 'assessment_id');
            state.tables.TRIAGE_ASSESSMENT.push({
                assessment_id: aid,
                case_id: Number(cid),
                nurse_id: Number(nurseId),
                bp_systolic: sys,
                bp_diastolic: dia,
                heart_rate: hr,
                spo2,
                temperature: temp,
                temperature_unit: tempUnit || 'F',
                respiratory_rate: rr,
                consciousness_level: consc,
                gcs_score: gcs,
                priority: prio,
                priority_reason: reason,
                symptoms: sym,
                injury_details: inj,
                assessment_notes: notes,
                raw_payload: rawPayload,
                assessed_at: nowDatetimeStr()
            });
            return [{ insertId: aid, affectedRows: 1 }];
        }
        if (norm.startsWith("UPDATE EMERGENCY_CASE SET triage_priority = ?, assessment_status = 'Assessed'")) {
            const [prio, cid] = params;
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === Number(cid));
            if (ec) {
                ec.triage_priority = prio;
                ec.assessment_status = 'Assessed';
                if (ec.status === 'Waiting') ec.status = 'Triage';
            }
            return [{ affectedRows: ec ? 1 : 0 }];
        }
        if (norm === 'INSERT INTO EMERGENCY_PRIORITY_LOG (case_id, old_priority, new_priority, changed_by, reason) VALUES (?, ?, ?, ?, ?)') {
            const [cid, oldP, newP, byId, reason] = params;
            const lid = nextId('EMERGENCY_PRIORITY_LOG', 'log_id');
            state.tables.EMERGENCY_PRIORITY_LOG.push({
                log_id: lid,
                case_id: Number(cid),
                old_priority: oldP,
                new_priority: newP,
                changed_by: Number(byId),
                reason,
                changed_at: nowDatetimeStr()
            });
            return [{ insertId: lid, affectedRows: 1 }];
        }
        if (norm === 'UPDATE EMERGENCY_CASE SET triage_priority = ? WHERE case_id = ?') {
            const [prio, cid] = params;
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === Number(cid));
            if (ec) ec.triage_priority = prio;
            return [{ affectedRows: ec ? 1 : 0 }];
        }
        if (norm === 'SELECT * FROM TRIAGE_ASSESSMENT WHERE case_id = ? ORDER BY assessed_at DESC LIMIT 1' ||
            norm.includes('FROM TRIAGE_ASSESSMENT ta LEFT JOIN `USER` un ON ta.nurse_id = un.user_id WHERE ta.case_id = ?')) {
            const cid = Number(params[0]);
            const rows = state.tables.TRIAGE_ASSESSMENT
                .filter(t => Number(t.case_id) === cid)
                .map(t => {
                    const un = state.tables.USER.find(u => Number(u.user_id) === Number(t.nurse_id)) || {};
                    return { ...t, nurse_name: un.name };
                })
                .reverse();
            return [norm.includes('LIMIT 1') ? rows.slice(0, 1) : rows];
        }
        if (norm.includes('FROM EMERGENCY_TREATMENT_LOG etl LEFT JOIN `USER` u ON etl.doctor_id = u.user_id WHERE etl.case_id = ?')) {
            const cid = Number(params[0]);
            const rows = state.tables.EMERGENCY_TREATMENT_LOG
                .filter(t => Number(t.case_id) === cid)
                .map(t => {
                    const u = state.tables.USER.find(x => Number(x.user_id) === Number(t.doctor_id)) || {};
                    return { ...t, doctor_name: u.name };
                })
                .reverse();
            return [rows];
        }
        if (norm.includes('FROM PATIENT_VITALS pv') && norm.includes('WHERE pv.case_id = ?')) {
            const cid = Number(params[0]);
            return [state.tables.PATIENT_VITALS.filter(v => Number(v.case_id) === cid).reverse()];
        }
        if (norm.includes('FROM BLOOD_REQUEST br') && norm.includes('WHERE br.case_id = ?')) {
            const cid = Number(params[0]);
            return [state.tables.BLOOD_REQUEST.filter(b => Number(b.case_id) === cid).reverse()];
        }
        if (norm.includes('FROM EMERGENCY_PRIORITY_LOG epl') && norm.includes('WHERE epl.case_id = ?')) {
            const cid = Number(params[0]);
            return [state.tables.EMERGENCY_PRIORITY_LOG.filter(l => Number(l.case_id) === cid).reverse()];
        }
        if (norm.includes('FROM EMERGENCY_DOCTOR_ASSIGNMENT eda') && norm.includes('WHERE eda.case_id = ?') && !norm.includes('FOR UPDATE') && !norm.includes('LIMIT 1')) {
            const cid = Number(params[0]);
            const rows = state.tables.EMERGENCY_DOCTOR_ASSIGNMENT
                .filter(e => Number(e.case_id) === cid)
                .map(e => {
                    const u = state.tables.USER.find(x => Number(x.user_id) === Number(e.doctor_id)) || {};
                    const urec = e.recommended_doctor_id ? state.tables.USER.find(x => Number(x.user_id) === Number(e.recommended_doctor_id)) : null;
                    const uby = e.assigned_by ? state.tables.USER.find(x => Number(x.user_id) === Number(e.assigned_by)) : null;
                    return { ...e, doctor_name: u.name, recommended_doctor_name: urec ? urec.name : null, assigned_by_name: uby ? uby.name : null };
                })
                .reverse();
            return [rows];
        }
        if (norm.includes('FROM EMERGENCY_BED_ASSIGNMENT eba') && norm.includes('WHERE eba.case_id = ?') && !norm.includes('FOR UPDATE')) {
            const cid = Number(params[0]);
            const rows = state.tables.EMERGENCY_BED_ASSIGNMENT
                .filter(e => Number(e.case_id) === cid)
                .map(e => {
                    const b = state.tables.BED.find(x => Number(x.bed_id) === Number(e.bed_id)) || {};
                    const w = state.tables.WARD.find(x => Number(x.ward_id) === Number(b.ward_id)) || {};
                    const rb = e.recommended_bed_id ? state.tables.BED.find(x => Number(x.bed_id) === Number(e.recommended_bed_id)) : null;
                    const uby = e.assigned_by ? state.tables.USER.find(x => Number(x.user_id) === Number(e.assigned_by)) : null;
                    return { ...e, bed_number: b.bed_number, ward_name: w.ward_name, recommended_bed_number: rb ? rb.bed_number : null, assigned_by_name: uby ? uby.name : null };
                })
                .reverse();
            return [rows];
        }

        if (norm.includes('FROM DOCTOR d JOIN `USER` u ON d.doctor_id = u.user_id JOIN DEPARTMENT dept ON d.department_id = dept.department_id ORDER BY d.doctor_id ASC')) {
            const excludeCaseId = Number(params[0] || 0);
            const today = localIsoDate(0);
            const curTime = localTimeStr();
            const rows = state.tables.DOCTOR.map(d => {
                const u = state.tables.USER.find(x => Number(x.user_id) === Number(d.doctor_id)) || {};
                const dept = state.tables.DEPARTMENT.find(x => Number(x.department_id) === Number(d.department_id)) || {};
                const activeShift = state.tables.DOCTOR_SHIFT.find(ds =>
                    Number(ds.doctor_id) === Number(d.doctor_id) &&
                    ds.shift_date === today &&
                    Boolean(ds.is_on_duty) &&
                    isTimeWithinShift(curTime, ds.start_time, ds.end_time)
                );
                const activeLeave = state.tables.DOCTOR_LEAVE.find(dl =>
                    Number(dl.doctor_id) === Number(d.doctor_id) &&
                    dl.status === 'Approved' &&
                    dl.start_date <= today &&
                    dl.end_date >= today
                );
                const activeEmgCases = state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.filter(eda => {
                    if (Number(eda.doctor_id) !== Number(d.doctor_id) || !eda.is_active) return false;
                    const aec = state.tables.EMERGENCY_CASE.find(c => Number(c.case_id) === Number(eda.case_id));
                    return aec && Number(aec.case_id) !== excludeCaseId && ['Assigned', 'In Treatment'].includes(aec.status);
                }).length;
                const todayAppts = state.tables.APPOINTMENT.filter(ap =>
                    Number(ap.doctor_id) === Number(d.doctor_id) &&
                    ap.appointment_date === today &&
                    ['Scheduled', 'Confirmed', 'Checked In'].includes(ap.status)
                ).length;

                return {
                    doctor_id: d.doctor_id,
                    name: u.name,
                    email: u.email,
                    is_active: Boolean(u.is_active),
                    specialization: d.specialization,
                    department_id: d.department_id,
                    department_name: dept.department_name,
                    active_shift_type: activeShift ? activeShift.shift_type : null,
                    active_shift_start: activeShift ? activeShift.start_time : null,
                    active_shift_end: activeShift ? activeShift.end_time : null,
                    active_leave_reason: activeLeave ? activeLeave.reason : null,
                    is_on_leave: activeLeave ? 1 : 0,
                    active_emergency_cases: activeEmgCases,
                    today_appointments: todayAppts
                };
            });
            return [rows];
        }
        if (norm.includes('SELECT b.bed_id, b.ward_id, w.ward_name, w.ward_type, b.bed_number, b.status') && norm.includes('active_admissions')) {
            const excludeCaseId = Number(params[0] || 0);
            const prefWard = params[1] || 'Emergency Ward';
            const rows = state.tables.BED.map(b => {
                const w = state.tables.WARD.find(x => Number(x.ward_id) === Number(b.ward_id)) || {};
                const activeAdms = state.tables.ADMISSION.filter(a => Number(a.bed_id) === Number(b.bed_id) && a.status === 'Admitted').length;
                const activeEmgs = state.tables.EMERGENCY_BED_ASSIGNMENT.filter(e => Number(e.bed_id) === Number(b.bed_id) && Boolean(e.is_active) && Number(e.case_id) !== excludeCaseId).length;
                return {
                    bed_id: b.bed_id,
                    ward_id: b.ward_id,
                    ward_name: w.ward_name,
                    ward_type: w.ward_type,
                    bed_number: b.bed_number,
                    status: b.status,
                    active_admissions: activeAdms,
                    active_emg_assignments: activeEmgs
                };
            }).sort((a, b) => {
                const rank = (wName) => wName === prefWard ? 0 : (wName === 'Emergency Ward' ? 1 : (wName === 'ICU' ? 2 : 3));
                return rank(a.ward_name) - rank(b.ward_name) || a.bed_number.localeCompare(b.bed_number);
            });
            return [rows];
        }

        if (norm === 'SELECT * FROM EMERGENCY_DOCTOR_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE' ||
            norm === 'SELECT doctor_id FROM EMERGENCY_DOCTOR_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE LIMIT 1') {
            const cid = Number(params[0]);
            return [state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.filter(e => Number(e.case_id) === cid && Boolean(e.is_active))];
        }
        if (norm === 'SELECT * FROM EMERGENCY_BED_ASSIGNMENT WHERE case_id = ? AND is_active = TRUE FOR UPDATE') {
            const cid = Number(params[0]);
            return [state.tables.EMERGENCY_BED_ASSIGNMENT.filter(e => Number(e.case_id) === cid && Boolean(e.is_active))];
        }
        if (norm.includes('SELECT d.doctor_id, d.department_id, d.specialization, u.name, u.is_active, dept.department_name FROM DOCTOR d')) {
            const docId = Number(params[0]);
            const d = state.tables.DOCTOR.find(x => Number(x.doctor_id) === docId);
            if (!d) return [[]];
            const u = state.tables.USER.find(x => Number(x.user_id) === docId) || {};
            const dept = state.tables.DEPARTMENT.find(x => Number(x.department_id) === Number(d.department_id)) || {};
            return [[{
                doctor_id: d.doctor_id,
                department_id: d.department_id,
                specialization: d.specialization,
                name: u.name,
                is_active: Boolean(u.is_active),
                department_name: dept.department_name
            }]];
        }
        if (norm.includes('SELECT leave_id, reason FROM DOCTOR_LEAVE WHERE doctor_id = ?')) {
            const docId = Number(params[0]);
            const today = localIsoDate(0);
            const lv = state.tables.DOCTOR_LEAVE.find(l => Number(l.doctor_id) === docId && l.status === 'Approved' && l.start_date <= today && l.end_date >= today);
            return [lv ? [lv] : []];
        }
        if (norm.includes('SELECT shift_id, shift_type, start_time, end_time FROM DOCTOR_SHIFT WHERE doctor_id = ?')) {
            const docId = Number(params[0]);
            const today = localIsoDate(0);
            const curTime = localTimeStr();
            const sh = state.tables.DOCTOR_SHIFT.find(s => Number(s.doctor_id) === docId && s.shift_date === today && Boolean(s.is_on_duty) && isTimeWithinShift(curTime, s.start_time, s.end_time));
            return [sh ? [sh] : []];
        }
        if (norm.includes('SELECT COUNT(*) AS active_count FROM EMERGENCY_DOCTOR_ASSIGNMENT eda')) {
            const [docId, excludeCaseId] = params;
            const cnt = state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.filter(eda => {
                if (Number(eda.doctor_id) !== Number(docId) || !eda.is_active) return false;
                const aec = state.tables.EMERGENCY_CASE.find(c => Number(c.case_id) === Number(eda.case_id));
                return aec && Number(aec.case_id) !== Number(excludeCaseId) && ['Assigned', 'In Treatment'].includes(aec.status);
            }).length;
            return [[{ active_count: cnt }]];
        }
        if (norm === 'SELECT assignment_id, case_id FROM EMERGENCY_BED_ASSIGNMENT WHERE bed_id = ? AND is_active = TRUE AND case_id <> ? FOR UPDATE') {
            const [bid, cid] = params;
            return [state.tables.EMERGENCY_BED_ASSIGNMENT.filter(e => Number(e.bed_id) === Number(bid) && Boolean(e.is_active) && Number(e.case_id) !== Number(cid))];
        }
        if (norm === 'UPDATE EMERGENCY_BED_ASSIGNMENT SET is_active = FALSE, released_at = NOW() WHERE assignment_id = ?') {
            const e = state.tables.EMERGENCY_BED_ASSIGNMENT.find(x => Number(x.assignment_id) === Number(params[0]));
            if (e) { e.is_active = false; e.released_at = nowDatetimeStr(); }
            return [{ affectedRows: e ? 1 : 0 }];
        }
        if (norm === 'UPDATE EMERGENCY_BED_ASSIGNMENT SET is_active = FALSE, released_at = NOW() WHERE bed_id = ? AND is_active = TRUE') {
            state.tables.EMERGENCY_BED_ASSIGNMENT.filter(x => Number(x.bed_id) === Number(params[0]) && Boolean(x.is_active)).forEach(e => {
                e.is_active = false;
                e.released_at = nowDatetimeStr();
            });
            return [{ affectedRows: 1 }];
        }
        if (norm.startsWith('INSERT INTO EMERGENCY_BED_ASSIGNMENT')) {
            const aid = nextId('EMERGENCY_BED_ASSIGNMENT', 'assignment_id');
            if (params.length === 5) {
                const [cid, bid, recBedId, byId, ovReason] = params;
                state.tables.EMERGENCY_BED_ASSIGNMENT.push({
                    assignment_id: aid,
                    case_id: Number(cid),
                    bed_id: Number(bid),
                    recommended_bed_id: recBedId ? Number(recBedId) : null,
                    assigned_by: Number(byId),
                    override_reason: ovReason || null,
                    assigned_at: nowDatetimeStr(),
                    released_at: null,
                    is_active: true
                });
            } else {
                const [cid, bid, byId] = params;
                state.tables.EMERGENCY_BED_ASSIGNMENT.push({
                    assignment_id: aid,
                    case_id: Number(cid),
                    bed_id: Number(bid),
                    recommended_bed_id: null,
                    assigned_by: Number(byId),
                    override_reason: null,
                    assigned_at: nowDatetimeStr(),
                    released_at: null,
                    is_active: true
                });
            }
            return [{ insertId: aid, affectedRows: 1 }];
        }
        if (norm === 'UPDATE EMERGENCY_DOCTOR_ASSIGNMENT SET is_active = FALSE, unassigned_at = NOW() WHERE assignment_id = ?') {
            const e = state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.find(x => Number(x.assignment_id) === Number(params[0]));
            if (e) { e.is_active = false; e.unassigned_at = nowDatetimeStr(); }
            return [{ affectedRows: e ? 1 : 0 }];
        }
        if (norm === 'UPDATE EMERGENCY_DOCTOR_ASSIGNMENT SET override_reason = ? WHERE assignment_id = ?') {
            const [ovReason, aid] = params;
            const e = state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.find(x => Number(x.assignment_id) === Number(aid));
            if (e) e.override_reason = ovReason;
            return [{ affectedRows: e ? 1 : 0 }];
        }
        if (norm.startsWith('INSERT INTO EMERGENCY_DOCTOR_ASSIGNMENT')) {
            const [cid, docId, recDocId, byId, ovReason] = params;
            const aid = nextId('EMERGENCY_DOCTOR_ASSIGNMENT', 'assignment_id');
            state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.push({
                assignment_id: aid,
                case_id: Number(cid),
                doctor_id: Number(docId),
                recommended_doctor_id: recDocId ? Number(recDocId) : null,
                assigned_by: Number(byId),
                override_reason: ovReason || null,
                assigned_at: nowDatetimeStr(),
                unassigned_at: null,
                is_active: true
            });
            return [{ insertId: aid, affectedRows: 1 }];
        }
        if (norm.startsWith('UPDATE EMERGENCY_CASE SET department_id = COALESCE(?, department_id)')) {
            const [deptId, cid] = params;
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === Number(cid));
            if (ec) {
                if (deptId) ec.department_id = Number(deptId);
                if (['Waiting', 'Triage'].includes(ec.status)) ec.status = 'Assigned';
            }
            return [{ affectedRows: ec ? 1 : 0 }];
        }
        if (norm.startsWith('INSERT INTO EMERGENCY_TREATMENT_LOG')) {
            const [cid, docId, aType, desc] = params;
            const tid = nextId('EMERGENCY_TREATMENT_LOG', 'treatment_id');
            state.tables.EMERGENCY_TREATMENT_LOG.push({
                treatment_id: tid,
                case_id: Number(cid),
                doctor_id: Number(docId),
                action_type: aType,
                description: desc,
                performed_at: nowDatetimeStr()
            });
            return [{ insertId: tid, affectedRows: 1 }];
        }
        if (norm.startsWith('UPDATE EMERGENCY_CASE SET treatment_notes = CONCAT')) {
            const [uName, notes, cid] = params;
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === Number(cid));
            if (ec) {
                ec.treatment_notes = `${ec.treatment_notes || ''}\n[${nowDatetimeStr()} ${uName}]: ${notes}`;
                ec.status = 'In Treatment';
            }
            return [{ affectedRows: ec ? 1 : 0 }];
        }
        if (norm.startsWith("UPDATE EMERGENCY_CASE SET status = 'In Treatment' WHERE case_id = ?")) {
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === Number(params[0]));
            if (ec && ['Waiting', 'Triage', 'Assigned'].includes(ec.status)) ec.status = 'In Treatment';
            return [{ affectedRows: ec ? 1 : 0 }];
        }
        if (norm === 'UPDATE EMERGENCY_CASE SET patient_id = ? WHERE case_id = ?') {
            const [pid, cid] = params;
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === Number(cid));
            if (ec) ec.patient_id = Number(pid);
            return [{ affectedRows: ec ? 1 : 0 }];
        }
        if (norm === "UPDATE EMERGENCY_CASE SET status = 'Admitted' WHERE case_id = ?") {
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === Number(params[0]));
            if (ec) ec.status = 'Admitted';
            return [{ affectedRows: ec ? 1 : 0 }];
        }
        if (norm.startsWith("UPDATE EMERGENCY_CASE SET status = 'Discharged'")) {
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === Number(params[params.length - 1]));
            if (ec) {
                ec.status = 'Discharged';
                ec.discharge_summary = params[0] || ec.discharge_summary;
                ec.discharged_at = nowDatetimeStr();
                if (params.length >= 3) ec.discharged_by = Number(params[1]);
            }
            return [{ affectedRows: ec ? 1 : 0 }];
        }
        if (norm === 'SELECT doctor_id FROM DOCTOR WHERE doctor_id = ?') {
            return [state.tables.DOCTOR.filter(d => Number(d.doctor_id) === Number(params[0]))];
        }
        if (norm === 'SELECT doctor_id FROM DOCTOR LIMIT 1' || norm === 'SELECT doctor_id FROM DOCTOR ORDER BY doctor_id LIMIT 1') {
            return [state.tables.DOCTOR.slice(0, 1)];
        }

        if (norm === 'SELECT blood_id, blood_group, units_available, last_updated FROM BLOOD_BANK ORDER BY blood_group') {
            return [[...state.tables.BLOOD_BANK].sort((a, b) => a.blood_group.localeCompare(b.blood_group))];
        }
        if (norm.includes('FROM BLOOD_REQUEST br JOIN `USER` ur ON br.requested_by = ur.user_id')) {
            const rows = state.tables.BLOOD_REQUEST.map(br => {
                const ur = state.tables.USER.find(u => Number(u.user_id) === Number(br.requested_by)) || {};
                const ua = br.approved_by ? state.tables.USER.find(u => Number(u.user_id) === Number(br.approved_by)) : null;
                const up = br.patient_id ? state.tables.USER.find(u => Number(u.user_id) === Number(br.patient_id)) : null;
                const ec = br.case_id ? state.tables.EMERGENCY_CASE.find(c => Number(c.case_id) === Number(br.case_id)) : null;
                return {
                    ...br,
                    requested_by_name: ur.name,
                    approved_by_name: ua ? ua.name : '--',
                    patient_name: (up && up.name) || (ec && ec.temp_patient_name) || 'Unknown Patient',
                    emg_number: ec ? ec.emg_number : null
                };
            });
            return [rows];
        }
        if (norm.startsWith('INSERT INTO BLOOD_REQUEST')) {
            const [pid, cid, reqBy, bg, units, prio, reason] = params;
            const reqId = nextId('BLOOD_REQUEST', 'request_id');
            state.tables.BLOOD_REQUEST.push({
                request_id: reqId,
                patient_id: pid,
                case_id: cid,
                requested_by: Number(reqBy),
                blood_group: bg,
                units: Number(units),
                priority: prio || 'Normal',
                reason,
                status: 'Pending',
                approved_by: null,
                fulfilled_at: null,
                created_at: nowDatetimeStr()
            });
            return [{ insertId: reqId, affectedRows: 1 }];
        }
        if (norm === "UPDATE BLOOD_REQUEST SET status='Approved', approved_by=? WHERE request_id=? AND status='Pending'") {
            const [appBy, reqId] = params;
            const br = state.tables.BLOOD_REQUEST.find(x => Number(x.request_id) === Number(reqId) && x.status === 'Pending');
            if (br) { br.status = 'Approved'; br.approved_by = Number(appBy); }
            return [{ affectedRows: br ? 1 : 0 }];
        }
        if (norm === "UPDATE BLOOD_REQUEST SET status='Rejected', approved_by=? WHERE request_id=? AND status IN ('Pending', 'Approved')") {
            const [appBy, reqId] = params;
            const br = state.tables.BLOOD_REQUEST.find(x => Number(x.request_id) === Number(reqId) && ['Pending', 'Approved'].includes(x.status));
            if (br) { br.status = 'Rejected'; br.approved_by = Number(appBy); }
            return [{ affectedRows: br ? 1 : 0 }];
        }
        if (norm === 'SELECT requested_by, blood_group, units FROM BLOOD_REQUEST WHERE request_id=?') {
            return [state.tables.BLOOD_REQUEST.filter(x => Number(x.request_id) === Number(params[0]))];
        }
        if (norm === 'SELECT * FROM BLOOD_REQUEST WHERE request_id = ? FOR UPDATE') {
            return [state.tables.BLOOD_REQUEST.filter(x => Number(x.request_id) === Number(params[0]))];
        }
        if (norm === 'SELECT units_available FROM BLOOD_BANK WHERE blood_group = ? FOR UPDATE') {
            return [state.tables.BLOOD_BANK.filter(b => b.blood_group === params[0])];
        }
        if (norm === 'UPDATE BLOOD_BANK SET units_available = units_available - ?, last_updated = NOW() WHERE blood_group = ?') {
            const [units, bg] = params;
            const b = state.tables.BLOOD_BANK.find(x => x.blood_group === bg);
            if (b) { b.units_available = Number(b.units_available) - Number(units); b.last_updated = nowDatetimeStr(); }
            return [{ affectedRows: b ? 1 : 0 }];
        }
        if (norm === "UPDATE BLOOD_REQUEST SET status = 'Fulfilled', fulfilled_at = NOW() WHERE request_id = ?") {
            const br = state.tables.BLOOD_REQUEST.find(x => Number(x.request_id) === Number(params[0]));
            if (br) { br.status = 'Fulfilled'; br.fulfilled_at = nowDatetimeStr(); }
            return [{ affectedRows: br ? 1 : 0 }];
        }

        if (norm.includes('FROM AMBULANCE a LEFT JOIN AMBULANCE_DISPATCH ad')) {
            const rows = state.tables.AMBULANCE.map(a => {
                const ad = state.tables.AMBULANCE_DISPATCH.find(d => Number(d.ambulance_id) === Number(a.ambulance_id) && d.status === 'In Transit');
                const ec = ad && ad.case_id ? state.tables.EMERGENCY_CASE.find(c => Number(c.case_id) === Number(ad.case_id)) : null;
                return {
                    ...a,
                    dispatch_id: ad ? ad.dispatch_id : null,
                    case_id: ad ? ad.case_id : null,
                    emg_number: ec ? ec.emg_number : null,
                    dispatch_patient_name: ad ? ad.patient_name : null,
                    pickup_location: ad ? ad.pickup_location : null
                };
            });
            return [rows];
        }
        if (norm === 'SELECT ambulance_id FROM AMBULANCE WHERE vehicle_number = ? LIMIT 1') {
            return [state.tables.AMBULANCE.filter(a => a.vehicle_number === params[0])];
        }
        if (norm === 'INSERT INTO AMBULANCE (vehicle_number, driver_name, driver_phone, status) VALUES (?, ?, ?, ?)') {
            const [vNum, dName, dPhone, st] = params;
            const aid = nextId('AMBULANCE', 'ambulance_id');
            state.tables.AMBULANCE.push({
                ambulance_id: aid,
                vehicle_number: vNum,
                driver_name: dName,
                driver_phone: dPhone,
                status: st || 'Available'
            });
            return [{ insertId: aid, affectedRows: 1 }];
        }
        if (norm === 'SELECT * FROM AMBULANCE WHERE ambulance_id = ?' || norm === 'SELECT * FROM AMBULANCE WHERE ambulance_id = ? FOR UPDATE') {
            return [state.tables.AMBULANCE.filter(a => Number(a.ambulance_id) === Number(params[0]))];
        }
        if (norm === 'UPDATE AMBULANCE SET driver_name = ?, driver_phone = ?, status = ? WHERE ambulance_id = ?') {
            const [dName, dPhone, st, aid] = params;
            const a = state.tables.AMBULANCE.find(x => Number(x.ambulance_id) === Number(aid));
            if (a) { a.driver_name = dName; a.driver_phone = dPhone; a.status = st; }
            return [{ affectedRows: a ? 1 : 0 }];
        }
        if (norm.includes('SELECT p.patient_id FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id WHERE u.name = ?')) {
            const [pName, phone] = params;
            const u = state.tables.USER.find(x => {
                const isPat = state.tables.PATIENT.some(p => Number(p.patient_id) === Number(x.user_id));
                if (!isPat) return false;
                return x.name === pName || (phone && x.phone === phone);
            });
            return [u ? [{ patient_id: u.user_id }] : []];
        }
        if (norm.includes("WHERE ec.ambulance_id IS NULL AND ec.status NOT IN ('Discharged', 'Transferred')")) {
            const [pName1, pName2, resPid] = params;
            const matches = state.tables.EMERGENCY_CASE.filter(ec => {
                if (ec.ambulance_id !== null || ['Discharged', 'Transferred'].includes(ec.status)) return false;
                const u = ec.patient_id ? state.tables.USER.find(x => Number(x.user_id) === Number(ec.patient_id)) : null;
                return ec.temp_patient_name === pName1 || (u && u.name === pName2) || (resPid && Number(ec.patient_id) === Number(resPid));
            });
            return [matches.slice(0, 1)];
        }
        if (norm.startsWith("UPDATE EMERGENCY_CASE SET ambulance_id = ?, arrival_method = 'Ambulance'")) {
            const [ambId, resPid, cid] = params.length === 3 ? params : [params[0], null, params[1]];
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === Number(cid));
            if (ec) {
                ec.ambulance_id = Number(ambId);
                ec.arrival_method = 'Ambulance';
                if (!ec.patient_id && resPid) ec.patient_id = Number(resPid);
            }
            return [{ affectedRows: ec ? 1 : 0 }];
        }
        if (norm === "UPDATE AMBULANCE SET status = 'On Duty' WHERE ambulance_id = ?") {
            const a = state.tables.AMBULANCE.find(x => Number(x.ambulance_id) === Number(params[0]));
            if (a) a.status = 'On Duty';
            return [{ affectedRows: a ? 1 : 0 }];
        }
        if (norm === "UPDATE AMBULANCE SET status='Available' WHERE ambulance_id=?" || norm === "UPDATE AMBULANCE SET status = 'Available' WHERE ambulance_id = ?") {
            const a = state.tables.AMBULANCE.find(x => Number(x.ambulance_id) === Number(params[0]));
            if (a) a.status = 'Available';
            return [{ affectedRows: a ? 1 : 0 }];
        }
        if (norm.startsWith('INSERT INTO AMBULANCE_DISPATCH')) {
            const [ambId, cid, pName, pickup, dest, phone, byId] = params;
            const did = nextId('AMBULANCE_DISPATCH', 'dispatch_id');
            state.tables.AMBULANCE_DISPATCH.push({
                dispatch_id: did,
                ambulance_id: Number(ambId),
                case_id: cid ? Number(cid) : null,
                patient_name: pName,
                pickup_location: pickup,
                destination: dest || 'Hospital',
                contact_phone: phone,
                dispatched_by: Number(byId),
                dispatched_at: nowDatetimeStr(),
                completed_at: null,
                status: 'In Transit'
            });
            return [{ insertId: did, affectedRows: 1 }];
        }
        if (norm.includes("FROM AMBULANCE_DISPATCH WHERE ambulance_id = ? AND status = 'In Transit'")) {
            const rows = state.tables.AMBULANCE_DISPATCH.filter(d => Number(d.ambulance_id) === Number(params[0]) && d.status === 'In Transit');
            return [rows.slice(-1)];
        }
        if (norm === "UPDATE AMBULANCE_DISPATCH SET status = 'Completed', completed_at = NOW() WHERE dispatch_id = ?") {
            const d = state.tables.AMBULANCE_DISPATCH.find(x => Number(x.dispatch_id) === Number(params[0]));
            if (d) { d.status = 'Completed'; d.completed_at = nowDatetimeStr(); }
            return [{ affectedRows: d ? 1 : 0 }];
        }
        if (norm === "UPDATE AMBULANCE_DISPATCH SET status = 'Completed', completed_at = NOW() WHERE ambulance_id = ? AND status = 'In Transit'") {
            state.tables.AMBULANCE_DISPATCH.filter(d => Number(d.ambulance_id) === Number(params[0]) && d.status === 'In Transit').forEach(d => {
                d.status = 'Completed';
                d.completed_at = nowDatetimeStr();
            });
            return [{ affectedRows: 1 }];
        }
        if (norm === 'UPDATE EMERGENCY_CASE SET arrival_time = NOW() WHERE case_id = ?') {
            const ec = state.tables.EMERGENCY_CASE.find(x => Number(x.case_id) === Number(params[0]));
            if (ec) ec.arrival_time = nowDatetimeStr();
            return [{ affectedRows: ec ? 1 : 0 }];
        }
        if (norm.startsWith('UPDATE AMBULANCE_DISPATCH SET case_id = COALESCE(case_id, ?)')) {
            const [cid, ambId] = params;
            state.tables.AMBULANCE_DISPATCH.filter(d => Number(d.ambulance_id) === Number(ambId) && d.status === 'In Transit').forEach(d => {
                if (!d.case_id) d.case_id = Number(cid);
            });
            return [{ affectedRows: 1 }];
        }

        if (norm === 'SELECT COUNT(*) AS total_patients FROM PATIENT') return [[{ total_patients: state.tables.PATIENT.length }]];
        if (norm === 'SELECT COUNT(*) AS total_doctors FROM DOCTOR') return [[{ total_doctors: state.tables.DOCTOR.length }]];
        if (norm === 'SELECT COUNT(*) AS total_appointments FROM APPOINTMENT') return [[{ total_appointments: state.tables.APPOINTMENT.length }]];
        if (norm === "SELECT COUNT(*) AS available_beds FROM BED WHERE status='Available'") return [[{ available_beds: state.tables.BED.filter(b => b.status === 'Available').length }]];
        if (norm === "SELECT COUNT(*) AS pending_lab_reports FROM LAB_REQUEST WHERE status='Pending'") return [[{ pending_lab_reports: state.tables.LAB_REQUEST.filter(l => l.status === 'Pending').length }]];
        if (norm === 'SELECT COUNT(*) AS low_stock_medicines FROM vw_medicine_inventory WHERE stock_qty < 20') return [[{ low_stock_medicines: computeVwMedicineInventory().filter(m => m.stock_qty < 20).length }]];
        if (norm === 'SELECT * FROM vw_monthly_revenue') {
            const summaries = computeVwBillSummary();
            const byMonth = {};
            summaries.forEach(b => {
                const m = String(b.bill_date || '2026-09').slice(0, 7);
                if (!byMonth[m]) byMonth[m] = { month: m, revenue: 0, bill_count: 0 };
                byMonth[m].revenue += Number(b.total_amount);
                byMonth[m].bill_count += 1;
            });
            return [Object.values(byMonth)];
        }
        if (norm === 'SELECT * FROM vw_bed_occupancy') {
            const rows = state.tables.WARD.map(w => {
                const beds = state.tables.BED.filter(b => Number(b.ward_id) === Number(w.ward_id));
                const occ = beds.filter(b => b.status === 'Occupied').length;
                return {
                    ward_name: w.ward_name,
                    occupied: occ,
                    total_beds: beds.length,
                    occupancy_pct: beds.length ? Number(((100 * occ) / beds.length).toFixed(1)) : 0
                };
            });
            return [rows];
        }
        if (norm.includes('FROM vw_bed_details v')) {
            let rows = computeVwBedDetails().map(v => {
                const p = v.patient_id ? state.tables.PATIENT.find(x => Number(x.patient_id) === Number(v.patient_id)) : null;
                const u = v.patient_id ? state.tables.USER.find(x => Number(x.user_id) === Number(v.patient_id)) : null;
                return {
                    ...v,
                    patient_name: u ? u.name : null,
                    patient_phone: u ? u.phone : null,
                    patient_blood_group: p ? p.blood_group : null
                };
            });
            if (norm.includes('WHERE v.bed_id = ?')) {
                return [rows.filter(r => Number(r.bed_id) === Number(params[0]))];
            }
            if (norm.includes('WHERE v.ward_name = ?')) {
                rows = rows.filter(r => r.ward_name === params[0]);
            }
            return [rows];
        }
        if (norm.includes('SELECT eba.*, ec.patient_id FROM EMERGENCY_BED_ASSIGNMENT eba JOIN EMERGENCY_CASE ec')) {
            const bid = Number(params[0]);
            const rows = state.tables.EMERGENCY_BED_ASSIGNMENT
                .filter(e => Number(e.bed_id) === bid && Boolean(e.is_active))
                .map(e => {
                    const ec = state.tables.EMERGENCY_CASE.find(c => Number(c.case_id) === Number(e.case_id)) || {};
                    return { ...e, patient_id: ec.patient_id };
                });
            return [rows];
        }
        if (norm.includes('SELECT doc.doctor_id, u.name, u.email, dep.department_name, doc.specialization, doc.consultation_fee FROM DOCTOR doc')) {
            const rows = state.tables.DOCTOR.map(doc => {
                const u = state.tables.USER.find(x => Number(x.user_id) === Number(doc.doctor_id)) || {};
                const dep = state.tables.DEPARTMENT.find(x => Number(x.department_id) === Number(doc.department_id)) || {};
                return {
                    doctor_id: doc.doctor_id,
                    name: u.name,
                    email: u.email,
                    department_name: dep.department_name,
                    specialization: doc.specialization,
                    consultation_fee: doc.consultation_fee
                };
            });
            return [rows];
        }
        if (norm.includes('FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id WHERE u.name LIKE ?')) {
            const q = String(params[0] || '').replace(/%/g, '').toLowerCase();
            const rows = state.tables.PATIENT.map(p => {
                const u = state.tables.USER.find(x => Number(x.user_id) === Number(p.patient_id)) || {};
                return { patient_id: p.patient_id, name: u.name, email: u.email, phone: u.phone, blood_group: p.blood_group };
            }).filter(r =>
                (r.name && r.name.toLowerCase().includes(q)) ||
                (r.email && r.email.toLowerCase().includes(q)) ||
                (r.phone && r.phone.toLowerCase().includes(q))
            );
            return [rows];
        }
        if (norm.includes('FROM `USER` u JOIN ROLE r ON u.role_id = r.role_id LEFT JOIN STAFF s')) {
            let rows = state.tables.USER.map(u => {
                const r = state.tables.ROLE.find(x => Number(x.role_id) === Number(u.role_id)) || {};
                const s = state.tables.STAFF.find(x => Number(x.staff_id) === Number(u.user_id)) || {};
                const dep = s.department_id ? state.tables.DEPARTMENT.find(x => Number(x.department_id) === Number(s.department_id)) : null;
                return {
                    user_id: u.user_id,
                    name: u.name,
                    email: u.email,
                    phone: u.phone,
                    role_name: r.role_name,
                    is_active: u.is_active,
                    staff_type: s.staff_type || null,
                    department_id: s.department_id || null,
                    department_name: dep ? dep.department_name : null,
                    shift: s.shift || null
                };
            }).filter(r => ['Doctor', 'Nurse', 'Lab Technician', 'Pharmacist', 'Receptionist'].includes(r.role_name));
            if (params.length > 0) {
                rows = rows.filter(r => r.role_name === params[0]);
            }
            return [rows];
        }
        if (norm.includes("FROM EMERGENCY_CASE WHERE status NOT IN ('Discharged', 'Transferred')")) {
            const active = state.tables.EMERGENCY_CASE.filter(c => !['Discharged', 'Transferred'].includes(c.status));
            if (norm.includes("triage_priority = 'P1'")) {
                return [[{ total: active.filter(c => c.triage_priority === 'P1').length }]];
            }
            if (norm.includes("triage_priority = 'P2'")) {
                return [[{ total: active.filter(c => c.triage_priority === 'P2').length }]];
            }
            if (norm.includes('Pending_Triage')) {
                return [[{ total: active.filter(c => c.assessment_status === 'Pending_Triage').length }]];
            }
            return [[{ total: active.length, count: active.length }]];
        }
        if (norm === "SELECT COUNT(*) AS total FROM EMERGENCY_CASE WHERE status = 'Waiting'") {
            return [[{ total: state.tables.EMERGENCY_CASE.filter(c => c.status === 'Waiting').length }]];
        }
        if (norm.includes("FROM BED b JOIN WARD w ON b.ward_id = w.ward_id WHERE w.ward_name IN ('Emergency Ward', 'ICU') AND b.status = 'Available'")) {
            const cnt = computeVwBedDetails().filter(b => ['Emergency Ward', 'ICU'].includes(b.ward_name) && b.status === 'Available').length;
            return [[{ total: cnt }]];
        }
        if (norm.includes("FROM BED b JOIN WARD w ON b.ward_id = w.ward_id WHERE w.ward_name = 'Emergency Ward' AND b.status = 'Occupied'")) {
            const cnt = computeVwBedDetails().filter(b => b.ward_name === 'Emergency Ward' && b.status === 'Occupied').length;
            return [[{ total: cnt }]];
        }
        if (norm.includes('SELECT COUNT(DISTINCT d.doctor_id) AS total FROM DOCTOR d')) {
            return [[{ total: state.tables.DOCTOR.length }]];
        }
        if (norm === "SELECT COUNT(*) AS total FROM AMBULANCE WHERE status = 'On Duty'") {
            return [[{ total: state.tables.AMBULANCE.filter(a => a.status === 'On Duty').length }]];
        }
        if (norm.includes('SELECT COUNT(*) AS total FROM ADMISSION WHERE admitted_at >=')) {
            return [[{ total: state.tables.ADMISSION.length }]];
        }
        if (norm.includes('FROM DOCTOR d JOIN `USER` u ON d.doctor_id = u.user_id JOIN DEPARTMENT dept ON d.department_id = dept.department_id LEFT JOIN DOCTOR_SHIFT ds')) {
            const today = localIsoDate(0);
            const curTime = localTimeStr();
            const rows = state.tables.DOCTOR.map(d => {
                const u = state.tables.USER.find(x => Number(x.user_id) === Number(d.doctor_id)) || {};
                const dept = state.tables.DEPARTMENT.find(x => Number(x.department_id) === Number(d.department_id)) || {};
                const ds = state.tables.DOCTOR_SHIFT.find(s => Number(s.doctor_id) === Number(d.doctor_id) && s.shift_date === today && Boolean(s.is_on_duty) && isTimeWithinShift(curTime, s.start_time, s.end_time));
                const lv = state.tables.DOCTOR_LEAVE.find(l => Number(l.doctor_id) === Number(d.doctor_id) && l.status === 'Approved' && l.start_date <= today && l.end_date >= today);
                const activeCases = state.tables.EMERGENCY_DOCTOR_ASSIGNMENT.filter(eda => {
                    if (Number(eda.doctor_id) !== Number(d.doctor_id) || !eda.is_active) return false;
                    const ec = state.tables.EMERGENCY_CASE.find(c => Number(c.case_id) === Number(eda.case_id));
                    return ec && ['Assigned', 'In Treatment'].includes(ec.status);
                }).length;
                return {
                    doctor_id: d.doctor_id,
                    name: u.name,
                    specialization: d.specialization,
                    department_id: d.department_id,
                    department_name: dept.department_name,
                    shift_type: ds ? ds.shift_type : 'Not on shift',
                    is_on_duty: Boolean(ds && !lv),
                    is_on_leave: lv ? 1 : 0,
                    active_cases: activeCases
                };
            });
            return [rows];
        }

        if (norm.startsWith('INSERT INTO DOCTOR_LEAVE')) {
            const [docId, startDt, endDt, reason, status] = params;
            const lid = nextId('DOCTOR_LEAVE', 'leave_id');
            state.tables.DOCTOR_LEAVE.push({
                leave_id: lid,
                doctor_id: Number(docId),
                start_date: startDt,
                end_date: endDt,
                reason,
                status: status || 'Approved'
            });
            return [{ insertId: lid, affectedRows: 1 }];
        }
        if (norm.startsWith('DELETE FROM DOCTOR_LEAVE WHERE leave_id = ?')) {
            state.tables.DOCTOR_LEAVE = state.tables.DOCTOR_LEAVE.filter(l => Number(l.leave_id) !== Number(params[0]));
            return [{ affectedRows: 1 }];
        }
        if (norm.startsWith('UPDATE DOCTOR_SHIFT SET is_on_duty = ? WHERE doctor_id = ?')) {
            const [onDuty, docId] = params;
            state.tables.DOCTOR_SHIFT.filter(s => Number(s.doctor_id) === Number(docId)).forEach(s => {
                s.is_on_duty = Boolean(onDuty);
            });
            return [{ affectedRows: 1 }];
        }

        return [[]];
    }

    const pool = {
        __state: state,
        async query(sql, params = []) {
            return executeSql(sql, params);
        },
        async getConnection() {
            let snapshot = null;
            let releaseLock = null;
            return {
                async beginTransaction() {
                    const prevLock = txLockPromise;
                    let resolver;
                    txLockPromise = new Promise(r => { resolver = r; });
                    releaseLock = resolver;
                    await prevLock;
                    snapshot = deepClone(state.tables);
                },
                async query(sql, params = []) {
                    return executeSql(sql, params);
                },
                async commit() {
                    snapshot = null;
                    if (releaseLock) {
                        const r = releaseLock;
                        releaseLock = null;
                        r();
                    }
                },
                async rollback() {
                    if (snapshot) {
                        state.tables = snapshot;
                        snapshot = null;
                    }
                    if (releaseLock) {
                        const r = releaseLock;
                        releaseLock = null;
                        r();
                    }
                },
                release() {
                    if (releaseLock) {
                        const r = releaseLock;
                        releaseLock = null;
                        r();
                    }
                }
            };
        },
        async end() {}
    };

    return pool;
}

module.exports = {
    createInMemoryMysqlPool,
    createInMemoryMongoDb,
    localIsoDate
};
