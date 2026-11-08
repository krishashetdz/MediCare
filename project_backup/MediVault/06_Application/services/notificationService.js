const { mysqlPool } = require('../config/db');
const { recordCrossDbOperation } = require('./crossDbSync');

/**
 * Creates notification for a specific user, or broadcasts to all users of a given role.
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

        await recordCrossDbOperation({
            idempotency_key: `NOTIF-${event_type}-${user_id || role_name || 'all'}-${Date.now()}`,
            collection_name: 'notification_log',
            operation_type: 'insert',
            payload: {
                user_id: user_id || null,
                role_name: role_name || null,
                message,
                event_type,
                metadata,
                created_at: new Date()
            }
        });
    } catch (err) {
        console.warn('Failed to insert notification:', err.message);
    }
}

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
