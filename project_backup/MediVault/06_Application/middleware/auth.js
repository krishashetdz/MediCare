// A user is "logged in" once req.session.user exists (set at /api/auth/login).
// requireAuth checks that the session exists and has not expired.
// requireRole(...) additionally checks the role stored in the session against an allow-list.

function isSessionExpired(req) {
    if (!req.session || !req.session.user) return true;
    if (req.session.cookie && req.session.cookie.expires) {
        const expTime = new Date(req.session.cookie.expires).getTime();
        if (Number.isFinite(expTime) && expTime <= Date.now()) {
            return true;
        }
    }
    return false;
}

function requireAuth(req, res, next) {
    if (isSessionExpired(req)) {
        if (req.session && typeof req.session.destroy === 'function') {
            req.session.destroy(() => {});
        }
        return res.status(401).json({ error: 'Not logged in or session expired' });
    }
    next();
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (isSessionExpired(req)) {
            if (req.session && typeof req.session.destroy === 'function') {
                req.session.destroy(() => {});
            }
            return res.status(401).json({ error: 'Not logged in or session expired' });
        }
        if (!allowedRoles.includes(req.session.user.role)) {
            return res.status(403).json({ error: `Requires role: ${allowedRoles.join(' or ')}` });
        }
        next();
    };
}

module.exports = { requireAuth, requireRole };
