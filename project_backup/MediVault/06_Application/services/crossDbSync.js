/**
 * services/crossDbSync.js
 * Cross-Database Consistency & Outbox Reconciliation Service (MySQL <-> MongoDB).
 */
const { mysqlPool, getMongo, isMongoAvailable } = require('../config/db');

async function recordCrossDbOperation({
    idempotency_key,
    collection_name,
    operation_type = 'upsert',
    filter = null,
    payload = {},
    conn = null
}) {
    if (!idempotency_key || !collection_name) {
        return { synced: false, status: 'skipped_invalid_args' };
    }

    const dbExecutor = conn || mysqlPool;
    const filterObj = filter || { _idempotency_key: idempotency_key };
    const enrichedPayload = { ...payload, _idempotency_key: idempotency_key };

    let syncedImmediately = false;
    let lastError = null;

    if (isMongoAvailable()) {
        try {
            const mongo = getMongo();
            const col = mongo.collection(collection_name);
            if (operation_type === 'insert') {
                await col.updateOne(
                    { _idempotency_key: idempotency_key },
                    { $setOnInsert: enrichedPayload },
                    { upsert: true }
                );
            } else {
                await col.updateOne(
                    filterObj,
                    { $set: enrichedPayload },
                    { upsert: true }
                );
            }
            syncedImmediately = true;
        } catch (mongoErr) {
            lastError = mongoErr.message || 'MongoDB write error';
            syncedImmediately = false;
        }
    } else {
        lastError = 'MongoDB connection unavailable';
    }

    try {
        await dbExecutor.query(
            `INSERT INTO CROSS_DB_OUTBOX (
                idempotency_key, collection_name, operation_type, filter_json, payload_json, status, retry_count, last_error, synced_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                payload_json = VALUES(payload_json),
                status = VALUES(status),
                last_error = VALUES(last_error),
                synced_at = VALUES(synced_at)`,
            [
                String(idempotency_key).slice(0, 120),
                String(collection_name).slice(0, 60),
                operation_type,
                JSON.stringify(filterObj),
                JSON.stringify(enrichedPayload),
                syncedImmediately ? 'Synced' : 'Pending',
                syncedImmediately ? 0 : 1,
                lastError ? String(lastError).slice(0, 500) : null,
                syncedImmediately ? new Date() : null
            ]
        );
    } catch (outboxErr) {
        console.warn('[crossDbSync] Outbox record warning:', outboxErr.message);
    }

    return {
        synced: syncedImmediately,
        status: syncedImmediately ? 'Synced' : 'Pending',
        idempotency_key,
        error: lastError
    };
}

async function reconcilePendingOutbox() {
    if (!isMongoAvailable()) {
        return { reconciled: 0, remaining: 0, status: 'mongo_unavailable' };
    }

    let pendingRows = [];
    try {
        const [rows] = await mysqlPool.query(
            "SELECT * FROM CROSS_DB_OUTBOX WHERE status IN ('Pending', 'Failed') AND retry_count < 10 ORDER BY outbox_id ASC LIMIT 100"
        );
        pendingRows = rows;
    } catch (_) {
        return { reconciled: 0, remaining: 0, status: 'outbox_table_unavailable' };
    }

    let reconciled = 0;
    const mongo = getMongo();

    for (const row of pendingRows) {
        try {
            const filterObj = row.filter_json ? JSON.parse(row.filter_json) : { _idempotency_key: row.idempotency_key };
            const payloadObj = JSON.parse(row.payload_json);
            const col = mongo.collection(row.collection_name);

            if (row.operation_type === 'insert') {
                await col.updateOne(
                    { _idempotency_key: row.idempotency_key },
                    { $setOnInsert: payloadObj },
                    { upsert: true }
                );
            } else {
                await col.updateOne(
                    filterObj,
                    { $set: payloadObj },
                    { upsert: true }
                );
            }

            await mysqlPool.query(
                "UPDATE CROSS_DB_OUTBOX SET status = 'Synced', last_error = NULL, synced_at = NOW() WHERE outbox_id = ?",
                [row.outbox_id]
            );
            reconciled++;
        } catch (err) {
            await mysqlPool.query(
                "UPDATE CROSS_DB_OUTBOX SET retry_count = retry_count + 1, status = CASE WHEN retry_count + 1 >= 10 THEN 'Failed' ELSE 'Pending' END, last_error = ? WHERE outbox_id = ?",
                [String(err.message || 'Sync error').slice(0, 500), row.outbox_id]
            );
        }
    }

    const [[remRow]] = await mysqlPool.query(
        "SELECT COUNT(*) AS cnt FROM CROSS_DB_OUTBOX WHERE status = 'Pending'"
    );

    return {
        reconciled,
        remaining: Number(remRow ? remRow.cnt : 0),
        status: 'ok'
    };
}

module.exports = { recordCrossDbOperation, reconcilePendingOutbox };
