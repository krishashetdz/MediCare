#!/usr/bin/env node
/**
 * db/backup.js
 * Non-destructive JSON/SQL Logical Snapshot Backup Utility for MediCare (`medivault`).
 */
const fs = require('fs');
const path = require('path');

const CORE_TABLES = [
    'ROLE', 'USER', 'DEPARTMENT', 'DOCTOR', 'DOCTOR_SHIFT', 'DOCTOR_LEAVE',
    'PATIENT', 'PATIENT_ALLERGY', 'STAFF', 'APPOINTMENT', 'MEDICAL_RECORD',
    'CONSULTATION', 'MEDICINE', 'MEDICINE_BATCH', 'PRESCRIPTION', 'PRESCRIPTION_ITEM',
    'DISPENSING_RECORD', 'DISPENSING_ITEM', 'LAB_TEST', 'LAB_REQUEST', 'LAB_REPORT',
    'WARD', 'BED', 'AMBULANCE', 'BLOOD_BANK', 'EMERGENCY_SEQUENCE', 'EMERGENCY_CASE',
    'EMERGENCY_DOCTOR_ASSIGNMENT', 'EMERGENCY_BED_ASSIGNMENT', 'AMBULANCE_DISPATCH',
    'TRIAGE_ASSESSMENT', 'EMERGENCY_PRIORITY_LOG', 'EMERGENCY_TREATMENT_LOG',
    'BLOOD_REQUEST', 'PATIENT_VITALS', 'NURSE_NOTE', 'ADMISSION_REQUEST', 'ADMISSION',
    'BILL', 'BILL_ITEM', 'PAYMENT', 'NOTIFICATION', 'AUDIT_LOG'
];

async function createDatabaseBackup(pool, outputDir) {
    const targetDir = outputDir || path.join(__dirname, 'backups');
    fs.mkdirSync(targetDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(targetDir, `medivault-backup-${timestamp}.json`);

    const snapshot = {
        database: process.env.MYSQL_DATABASE || 'medivault',
        created_at: new Date().toISOString(),
        tables: {}
    };

    for (const table of CORE_TABLES) {
        try {
            const [rows] = await pool.query(`SELECT * FROM \`${table}\``);
            snapshot.tables[table] = rows;
        } catch (_) {
            snapshot.tables[table] = [];
        }
    }

    fs.writeFileSync(backupFile, JSON.stringify(snapshot, null, 2), 'utf8');
    return {
        backup_file: backupFile,
        table_count: Object.keys(snapshot.tables).length,
        created_at: snapshot.created_at
    };
}

if (require.main === module) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    const { mysqlPool } = require('../config/db');
    createDatabaseBackup(mysqlPool)
        .then(res => {
            console.log('[backup] Backup created:', res.backup_file);
            process.exit(0);
        })
        .catch(err => {
            console.error('[backup] ERROR:', err.message);
            process.exit(1);
        });
}

module.exports = { createDatabaseBackup, CORE_TABLES };
