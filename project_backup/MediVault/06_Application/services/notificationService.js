const { mysqlPool, getMongo } = require('../config/db');

/**
 * Creates notification for a specific user, or broadcasts to all users of a given role.
 * @param {Object} options
 * @param {number} [options.user_id] - Specific recipient user_id
 * @param {string} [options.role_name] - Target role name ('Doctor', 'Nurse', 'Admin', etc.)
 * @param {string} options.message - Notification message text
 * @param {string} [options.event_type] - Optional classification for audit trail
 */
async function sendNotification({ user_id, role_name, message, event_type = 'general' }) {
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
                const values = users.map(u => [u.user_id, message, false]);
                await mysqlPool.query(
                    'INSERT INTO NOTIFICATION (user_id, message, is_read) VALUES ?',
                    [values]
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
                created_at: new Date()
            });
        } catch (_) {}
    } catch (err) {
        console.warn('Failed to insert notification:', err.message);
    }
}

module.exports = { sendNotification };

