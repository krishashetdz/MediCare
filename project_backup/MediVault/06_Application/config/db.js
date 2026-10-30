const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');

// MySQL: the system of record (patients, doctors, appointments, billing, etc.)
const mysqlPool = mysql.createPool({
    socketPath: process.env.MYSQL_SOCKET || undefined,
    host: process.env.MYSQL_HOST || 'localhost',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'medivault',
    waitForConnections: true,
    connectionLimit: 10
});

// MongoDB: audit_log / lab_reports_raw. Notifications remain in MySQL.
let mongoDb = null;
async function connectMongo() {
    const uri = process.env.MONGO_URL || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URL must be configured');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    await client.connect();
    mongoDb = client.db('medivault');
    console.log('MongoDB connected');
    return mongoDb;
}
function getMongo() {
    if (!mongoDb) throw new Error('MongoDB not connected yet');
    return mongoDb;
}

module.exports = { mysqlPool, connectMongo, getMongo };
