const { mysqlPool, getMongo } = require('../config/db');

/**
 * Creates notification for a specific user, or broadcasts to all users of a given role.
 * @param {Object} options
 * @param {number} [options.user_id] - Specific recipient user_id
 * @param {string} [options.role_name] - Target role name ('Doctor', 'Nurse', 'Admin', etc.)
 * @param {string} options.message - Notification message text
 * @param {string} [options.event_type] - Optional classification for audit trail
 * @param {Object} [options.metadata] - Optional structured metadata for MongoDB log
 */
async function sendNotification({ user_id, role_name, message, event_type = 'general', metadata = null }) {
    if (!message) return;

    try {
        if (user_id) {
            await mysqlPool.query(
                'INSERT INTO NOTIFICATION (user_id, message, is_read) VALUES (?, ?, FALSE)',
                [user_id, message]
            );
        } else if (role_name) {
            const [users] = await mysqlPool.query(
                `SELECT u.user_id FROM \`USER\` u 
                 JOIN ROLE r ON u.role_id = r.role_id 
                 WHERE r.role_name = ? AND u.is_active = TRUE`,
                [role_name]
            );
            if (users.length) {
                const placeholders = users.map(() => '(?, ?, FALSE)').join(', ');
                const params = users.flatMap(u => [u.user_id, message]);
                await mysqlPool.query(
                    `INSERT INTO NOTIFICATION (user_id, message, is_read) VALUES ${placeholders}`,
                    params
                );
            }
        }

        // Optional MongoDB audit log
        try {
            const mongo = getMongo();
            await mongo.collection('notification_log').insertOne({
                user_id: user_id || null,
                role_name: role_name || null,
                message,
                event_type,
                metadata,
                created_at: new Date()
            });
        } catch (_) {}
    } catch (err) {
        console.warn('Failed to insert notification:', err.message);
    }
}

/**
 * Broadcasts a notification to all active users of a given role.
 * Supports both string messages and structured { title, message, type, metadata } payloads.
 */
async function broadcastToRole(role_name, payload = {}) {
    if (!role_name) return;
    const message = typeof payload === 'string'
        ? payload
        : (payload.title && payload.message ? `${payload.title}: ${payload.message}` : (payload.message || payload.title || ''));
    const event_type = (typeof payload === 'object' && payload) ? (payload.type || payload.event_type || 'broadcast') : 'broadcast';
    const metadata = (typeof payload === 'object' && payload && payload.metadata) ? payload.metadata : null;

    return sendNotification({ role_name, message, event_type, metadata });
}

module.exports = { sendNotification, broadcastToRole };
