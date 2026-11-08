/**
 * config/sessionStore.js
 * Persistent MySQL-Backed Session Store for express-session (`USER_SESSION` table).
 */
const EventEmitter = require('events');

function createMySqlSessionStore(sessionModule, mysqlPool, options = {}) {
    const BaseStore = (sessionModule && sessionModule.Store) ? sessionModule.Store : EventEmitter;
    const defaultTtlMs = options.ttlMs || (1000 * 60 * 60 * 8);

    class MySqlSessionStore extends BaseStore {
        constructor() {
            super();
            this.fallbackCache = new Map();
            this.tableEnsured = false;
        }

        async ensureTable() {
            if (this.tableEnsured) return;
            try {
                await mysqlPool.query(`
                    CREATE TABLE IF NOT EXISTS USER_SESSION (
                        session_id      VARCHAR(128) PRIMARY KEY,
                        user_id         INT NULL,
                        expires_at      BIGINT NOT NULL,
                        session_data    TEXT NOT NULL,
                        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                        INDEX idx_session_expires (expires_at)
                    ) ENGINE=InnoDB
                `);
                this.tableEnsured = true;
            } catch (_) {}
        }

        _computeExpiresAt(sess) {
            if (sess && sess.cookie && sess.cookie.expires) {
                const exp = new Date(sess.cookie.expires).getTime();
                if (Number.isFinite(exp)) return exp;
            }
            if (sess && sess.cookie && Number.isFinite(Number(sess.cookie.maxAge))) {
                return Date.now() + Number(sess.cookie.maxAge);
            }
            return Date.now() + defaultTtlMs;
        }

        get(sid, callback) {
            (async () => {
                await this.ensureTable();
                const now = Date.now();
                try {
                    const [rows] = await mysqlPool.query(
                        'SELECT session_data, expires_at FROM USER_SESSION WHERE session_id = ? LIMIT 1',
                        [String(sid)]
                    );
                    if (!rows.length) {
                        return callback(null, null);
                    }
                    const row = rows[0];
                    if (Number(row.expires_at) <= now) {
                        await mysqlPool.query('DELETE FROM USER_SESSION WHERE session_id = ?', [String(sid)]);
                        this.fallbackCache.delete(String(sid));
                        return callback(null, null);
                    }
                    const parsed = JSON.parse(row.session_data);
                    return callback(null, parsed);
                } catch (err) {
                    const cached = this.fallbackCache.get(String(sid));
                    if (cached && cached.expires_at > now) {
                        return callback(null, JSON.parse(cached.session_data));
                    }
                    return callback(null, null);
                }
            })();
        }

        set(sid, sess, callback = () => {}) {
            (async () => {
                await this.ensureTable();
                const expiresAt = this._computeExpiresAt(sess);
                const userId = sess && sess.user && sess.user.id ? Number(sess.user.id) : null;
                const serialized = JSON.stringify(sess);
                this.fallbackCache.set(String(sid), { session_data: serialized, expires_at: expiresAt, user_id: userId });

                try {
                    await mysqlPool.query(
                        `INSERT INTO USER_SESSION (session_id, user_id, expires_at, session_data)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                            user_id = VALUES(user_id),
                            expires_at = VALUES(expires_at),
                            session_data = VALUES(session_data),
                            updated_at = NOW()`,
                        [String(sid), userId, expiresAt, serialized]
                    );
                    callback(null);
                } catch (err) {
                    callback(null);
                }
            })();
        }

        touch(sid, sess, callback = () => {}) {
            (async () => {
                const expiresAt = this._computeExpiresAt(sess);
                const cached = this.fallbackCache.get(String(sid));
                if (cached) cached.expires_at = expiresAt;
                try {
                    await mysqlPool.query(
                        'UPDATE USER_SESSION SET expires_at = ?, updated_at = NOW() WHERE session_id = ?',
                        [expiresAt, String(sid)]
                    );
                } catch (_) {}
                callback(null);
            })();
        }

        destroy(sid, callback = () => {}) {
            (async () => {
                this.fallbackCache.delete(String(sid));
                try {
                    await mysqlPool.query('DELETE FROM USER_SESSION WHERE session_id = ?', [String(sid)]);
                } catch (_) {}
                callback(null);
            })();
        }
    }

    return new MySqlSessionStore();
}

module.exports = { createMySqlSessionStore };
