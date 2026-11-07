#!/usr/bin/env node
/**
 * scripts/verify-mongo.js
 * Prints document counts and one sample document for each MongoDB collection used by MediVault:
 *   - lab_reports_raw
 *   - audit_log
 *   - ambulance_dispatch_log
 *   - notification_log
 */
require('dotenv').config();
const { connectMongo } = require('../config/db');

const COLLECTIONS = [
    'lab_reports_raw',
    'audit_log',
    'ambulance_dispatch_log',
    'notification_log'
];

async function verifyMongo() {
    if (!process.env.MONGO_URL && !process.env.MONGO_URI) {
        process.env.MONGO_URI = 'mongodb://localhost:27017';
    }

    const db = await connectMongo();
    console.log('=== MediVault MongoDB Collection Verification ===\n');

    for (const colName of COLLECTIONS) {
        const col = db.collection(colName);
        const count = await col.countDocuments();
        const sample = await col.findOne({}, { sort: { _id: -1 } });
        console.log(`Collection: ${colName}`);
        console.log(`  Count: ${count}`);
        console.log(`  Sample Document: ${sample ? JSON.stringify(sample, null, 2) : 'None'}\n`);
    }

    process.exit(0);
}

verifyMongo().catch((err) => {
    console.error('MongoDB verification failed:', err.message);
    process.exit(1);
});
