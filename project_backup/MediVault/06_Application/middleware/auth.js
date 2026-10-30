// A user is "logged in" once req.session.user exists (set at /api/auth/login).
// requireAuth just checks that. requireRole(...) additionally checks the
// role stored in the session against an allow-list -- this IS the RBAC gate:
// every protected route in routes/*.js is wrapped with one of these two.

function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not logged in' });
    }
    next();
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.session.user) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        if (!allowedRoles.includes(req.session.user.role)) {
            return res.status(403).json({ error: `Requires role: ${allowedRoles.join(' or ')}` });
        }
        next();
    };
}

module.exports = { requireAuth, requireRole };
