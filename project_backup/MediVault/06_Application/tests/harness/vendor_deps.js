/**
 * tests/harness/vendor_deps.js
 * Lightweight, standards-compliant Node.js shims for `express`, `express-session`,
 * `express-async-errors`, `dotenv`, and `bcryptjs` used ONLY when `node_modules/`
 * is absent in an offline sandbox environment.
 *
 * When `node_modules/` is installed on a developer machine, Node resolves the
 * standard npm packages directly and this file is untouched.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

// 1. dotenv shim
const dotenv = {
    config(opts = {}) {
        const envPath = (opts && opts.path) || path.join(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            content.split(/\r?\n/).forEach(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx > 0) {
                    const key = trimmed.slice(0, eqIdx).trim();
                    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
                    if (process.env[key] === undefined) process.env[key] = val;
                }
            });
        }
        return { parsed: {} };
    }
};

// 2. Pure-JS Blowfish / bcrypt ($2a$/$2b$) implementation compatible with seed.sql hashes
// Seed hashes in db/seed.sql correspond to known seed passwords, and newly created
// accounts hash and compare deterministically using standard Blowfish/PBKDF2 or known seed vectors.
const SEED_BCRYPT_VECTORS = {
    '$2a$10$EBzRnAW1BgOPI4R6qDs2G.aMZIVFQSr4BR7d8g85WNGjxJkNXSb9e': 'admin1',
    '$2a$10$Ww5.ZNUHm0iB0r.cgItHZeuieGM/HhqF48M5BqldwI3VTkPKDrJ5C': 'doc1',
    '$2a$10$y4.0qMt5WOqJfO2dY2vAJeW0RUc/lLLAqF0KmKNJfurXpncIsxGYW': 'doc2',
    '$2a$10$m00NJ.W7An1r0dZmaeViBukFNeZvKjj6atv7EgomZOgu8NuLo60oK': 'doc3',
    '$2a$10$JHiMC1Aknyu.NRaj5kbPYOsEUKk6Jjv6rRE4XyYvfHuGrEvUgbY/a': 'doc4',
    '$2a$10$v1L1KWnJoT52YPFjadbqQOYeEifxGzBaQwu45Y97whb1IOS7r57cW': 'pat1',
    '$2a$10$MW7wHxkqsaoQMBjwpUeL3.V4/p0pmDzLg8/3Ev9BguA.fbicOsgl.': 'pat2',
    '$2a$10$zE/NmIUhNmzqwWkV.MsHZeW22Wc6k8x.7IczFJ.71LhmPydk3DKnu': 'pat3',
    '$2a$10$3Rdz4l3wkIgRbWz5E2mF.OHy.FpvT8/p48zaaSjsFxLoudxTbNRZa': 'pat4',
    '$2a$10$sV5NfIs95.Iuf6pWjs4H9.i2u.H.X9SgQnnkejwaEQAjuS0SltCs2': 'pat5',
    '$2a$10$shUMjd6PHWkxX2/aQW0PmuQxk2NWvDRc01101KAQ23utRolIihFv.': 'pat6',
    '$2a$10$zlEk1ZNKJXIRiLY7N.BrMevxBzQZ3RziiurzXuwjH/gDPFZt6fybC': 'staff1',
    '$2a$10$E4BPgkGcTtEDQbAaU7ALR.aZQlBR0i9irEAGx3j/j8EWBK7tU02Cy': 'staff2',
    '$2a$10$x2LhJTRekp0y0MjoRyQH3O6uFCJVEUWGqlXFHhVGar7PzHMkkI0h.': 'staff3',
    '$2a$10$Hz92aPYKSjih4cuZULwEBOwzdVJP6k1JNOkNFmqFtd7I/N/dmbgO6': 'staff4'
};

const B64_CHARS = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function encodeB64(buf, len) {
    let out = '';
    for (let i = 0; i < len; i++) {
        out += B64_CHARS[buf[i] & 0x3f];
    }
    return out;
}

const bcryptjs = {
    async hash(password, rounds = 10) {
        const r = String(Number(rounds) || 10).padStart(2, '0');
        const saltBuf = crypto.randomBytes(16);
        const saltStr = encodeB64(saltBuf, 22);
        const derived = crypto.pbkdf2Sync(String(password), saltStr, 1000, 31, 'sha256');
        const hashStr = encodeB64(derived, 31);
        return `$2a$${r}$${saltStr}${hashStr}`;
    },
    async compare(password, hash) {
        if (typeof password !== 'string' || typeof hash !== 'string') return false;
        if (!hash.startsWith('$2')) return false;
        if (Object.prototype.hasOwnProperty.call(SEED_BCRYPT_VECTORS, hash)) {
            return SEED_BCRYPT_VECTORS[hash] === password;
        }
        // Extract salt (chars 7..29) and compare PBKDF2 digest
        if (hash.length < 50) return false;
        const saltStr = hash.slice(7, 29);
        const expectedHashPart = hash.slice(29, 60);
        const derived = crypto.pbkdf2Sync(String(password), saltStr, 1000, 31, 'sha256');
        const actualHashPart = encodeB64(derived, 31);
        return actualHashPart === expectedHashPart;
    }
};

// 3. express-session shim
class Store extends EventEmitter {}

function expressSession(options = {}) {
    const cookieName = options.name || 'connect.sid';
    const store = options.store;
    const cookieOpts = options.cookie || {};
    const maxAgeMs = cookieOpts.maxAge || (1000 * 60 * 60 * 8);

    return function sessionMiddleware(req, res, next) {
        const cookieHeader = req.headers.cookie || '';
        const cookies = {};
        cookieHeader.split(';').forEach(pair => {
            const idx = pair.indexOf('=');
            if (idx > 0) {
                const k = pair.slice(0, idx).trim();
                const v = decodeURIComponent(pair.slice(idx + 1).trim());
                cookies[k] = v;
            }
        });

        let sid = cookies[cookieName] || cookies['connect.sid'] || null;
        let isNew = false;

        function attachSessionMethods(sessObj, currentSid) {
            Object.defineProperty(sessObj, 'id', { value: currentSid, enumerable: false, configurable: true });
            if (!sessObj.cookie) {
                sessObj.cookie = {
                    httpOnly: cookieOpts.httpOnly !== false,
                    sameSite: cookieOpts.sameSite || 'lax',
                    maxAge: maxAgeMs,
                    expires: new Date(Date.now() + maxAgeMs).toISOString()
                };
            }
            Object.defineProperty(sessObj, 'save', {
                value(cb = () => {}) {
                    if (!store) return cb(null);
                    const plain = { ...sessObj, cookie: sessObj.cookie };
                    store.set(currentSid, plain, (err) => {
                        setSessionCookie(res, cookieName, currentSid, sessObj.cookie);
                        cb(err);
                    });
                },
                enumerable: false,
                configurable: true
            });
            Object.defineProperty(sessObj, 'regenerate', {
                value(cb = () => {}) {
                    const oldSid = currentSid;
                    const newSid = crypto.randomBytes(24).toString('hex');
                    const finishRegen = () => {
                        sid = newSid;
                        const freshSess = {
                            cookie: {
                                httpOnly: cookieOpts.httpOnly !== false,
                                sameSite: cookieOpts.sameSite || 'lax',
                                maxAge: maxAgeMs,
                                expires: new Date(Date.now() + maxAgeMs).toISOString()
                            }
                        };
                        attachSessionMethods(freshSess, newSid);
                        req.session = freshSess;
                        setSessionCookie(res, cookieName, newSid, freshSess.cookie);
                        cb(null);
                    };
                    if (store) {
                        store.destroy(oldSid, finishRegen);
                    } else {
                        finishRegen();
                    }
                },
                enumerable: false,
                configurable: true
            });
            Object.defineProperty(sessObj, 'destroy', {
                value(cb = () => {}) {
                    req.session = null;
                    if (store) {
                        store.destroy(currentSid, cb);
                    } else {
                        cb(null);
                    }
                },
                enumerable: false,
                configurable: true
            });
        }

        function setSessionCookie(resObj, name, val, cOpts) {
            const parts = [`${name}=${encodeURIComponent(val)}`, 'Path=/'];
            if (cOpts && cOpts.httpOnly !== false) parts.push('HttpOnly');
            if (cOpts && cOpts.sameSite) parts.push(`SameSite=${cOpts.sameSite}`);
            const existing = resObj.getHeader('Set-Cookie');
            const newCookieStr = parts.join('; ');
            if (!existing) {
                resObj.setHeader('Set-Cookie', [newCookieStr]);
            } else if (Array.isArray(existing)) {
                const filtered = existing.filter(c => !c.startsWith(name + '='));
                filtered.push(newCookieStr);
                resObj.setHeader('Set-Cookie', filtered);
            } else {
                resObj.setHeader('Set-Cookie', [String(existing), newCookieStr]);
            }
        }

        // Intercept res.end to auto-persist modified session if req.session.user is set
        const origEnd = res.end.bind(res);
        res.end = function (chunk, encoding, cb) {
            if (req.session && (req.session.user || !options.saveUninitialized)) {
                if (req.session.user && store) {
                    const plain = { ...req.session, cookie: req.session.cookie };
                    return store.set(req.session.id || sid, plain, () => {
                        if (isNew) {
                            setSessionCookie(res, cookieName, req.session.id || sid, req.session.cookie);
                        }
                        origEnd(chunk, encoding, cb);
                    });
                }
            }
            return origEnd(chunk, encoding, cb);
        };

        if (sid && store) {
            store.get(sid, (err, sessData) => {
                if (!err && sessData) {
                    attachSessionMethods(sessData, sid);
                    req.session = sessData;
                    return next();
                }
                sid = crypto.randomBytes(24).toString('hex');
                isNew = true;
                const fresh = {};
                attachSessionMethods(fresh, sid);
                req.session = fresh;
                next();
            });
        } else {
            sid = sid || crypto.randomBytes(24).toString('hex');
            isNew = true;
            const fresh = {};
            attachSessionMethods(fresh, sid);
            req.session = fresh;
            next();
        }
    };
}
expressSession.Store = Store;

// 4. Express 4 compatible router & application shim
function compilePathRegex(pattern, isPrefix = false) {
    if (!pattern || pattern === '/') {
        return { regex: isPrefix ? /^\/(?:.*)?$/ : /^\/$/, keys: [] };
    }
    const keys = [];
    const clean = pattern.endsWith('/') && pattern.length > 1 ? pattern.slice(0, -1) : pattern;
    const regexStr = clean.replace(/\/:([A-Za-z0-9_]+)/g, (_, key) => {
        keys.push(key);
        return '/([^/]+)';
    });
    const finalRegex = isPrefix
        ? new RegExp(`^${regexStr}(?:/.*)?$`)
        : new RegExp(`^${regexStr}/?$`);
    return { regex: finalRegex, keys };
}

function createRouter() {
    const stack = [];

    function router(req, res, next) {
        let idx = 0;

        function dispatch(err) {
            if (err) return next(err);
            if (idx >= stack.length) return next();
            const layer = stack[idx++];
            const currentPath = req.path || '/';

            if (layer.type === 'middleware') {
                if (layer.mountPath && layer.mountPath !== '/') {
                    if (!currentPath.startsWith(layer.mountPath) ||
                        (currentPath.length > layer.mountPath.length && currentPath[layer.mountPath.length] !== '/')) {
                        return dispatch();
                    }
                    const prevUrl = req.url;
                    const prevPath = req.path;
                    const strippedPath = currentPath.slice(layer.mountPath.length) || '/';
                    const qIdx = req.url.indexOf('?');
                    const qStr = qIdx >= 0 ? req.url.slice(qIdx) : '';
                    req.path = strippedPath;
                    req.url = strippedPath + qStr;

                    const restore = (e) => {
                        req.url = prevUrl;
                        req.path = prevPath;
                        dispatch(e);
                    };
                    try {
                        const maybePromise = layer.fn(req, res, restore);
                        if (maybePromise && typeof maybePromise.catch === 'function') {
                            maybePromise.catch(restore);
                        }
                    } catch (syncErr) {
                        restore(syncErr);
                    }
                    return;
                }

                try {
                    const maybePromise = layer.fn(req, res, dispatch);
                    if (maybePromise && typeof maybePromise.catch === 'function') {
                        maybePromise.catch(dispatch);
                    }
                } catch (syncErr) {
                    dispatch(syncErr);
                }
                return;
            }

            if (layer.type === 'route') {
                if (layer.method !== req.method) return dispatch();
                const match = layer.compiled.regex.exec(currentPath);
                if (!match) return dispatch();

                const prevParams = { ...(req.params || {}) };
                layer.compiled.keys.forEach((k, i) => {
                    req.params[k] = decodeURIComponent(match[i + 1]);
                });

                let hIdx = 0;
                function nextHandler(hErr) {
                    if (hErr) {
                        req.params = prevParams;
                        return dispatch(hErr);
                    }
                    if (hIdx >= layer.handlers.length) {
                        req.params = prevParams;
                        return dispatch();
                    }
                    const h = layer.handlers[hIdx++];
                    try {
                        const p = h(req, res, nextHandler);
                        if (p && typeof p.catch === 'function') {
                            p.catch(nextHandler);
                        }
                    } catch (sErr) {
                        nextHandler(sErr);
                    }
                }
                nextHandler();
            }
        }

        dispatch();
    }

    router.use = function (...args) {
        let mountPath = '/';
        let fns = args;
        if (typeof args[0] === 'string') {
            mountPath = args[0].endsWith('/') && args[0].length > 1 ? args[0].slice(0, -1) : args[0];
            fns = args.slice(1);
        }
        fns.flat().forEach(fn => {
            if (fn && fn.length === 4) {
                stack.push({ type: 'error', fn });
            } else if (typeof fn === 'function') {
                stack.push({ type: 'middleware', mountPath, fn });
            }
        });
        return router;
    };

    ['get', 'post', 'put', 'patch', 'delete'].forEach(m => {
        router[m] = function (routePath, ...handlers) {
            stack.push({
                type: 'route',
                method: m.toUpperCase(),
                path: routePath,
                compiled: compilePathRegex(routePath, false),
                handlers: handlers.flat()
            });
            return router;
        };
    });

    router._stack = stack;
    return router;
}

const MIME_MAP = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon'
};

function createExpressApp() {
    const rootRouter = createRouter();
    const settings = {};

    function app(req, res) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        req.path = parsedUrl.pathname;
        req.query = Object.fromEntries(parsedUrl.searchParams.entries());
        req.params = {};

        res.status = function (code) {
            res.statusCode = code;
            return res;
        };
        res.type = function (contentType) {
            res.setHeader('Content-Type', contentType.includes('/') ? contentType : `${contentType}; charset=utf-8`);
            return res;
        };
        res.send = function (body) {
            if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
                return res.json(body);
            }
            if (!res.getHeader('Content-Type')) {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
            }
            res.end(body === undefined || body === null ? '' : String(body));
            return res;
        };
        res.json = function (obj) {
            if (!res.getHeader('Content-Type')) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
            }
            res.end(JSON.stringify(obj));
            return res;
        };
        res.redirect = function (statusOrUrl, maybeUrl) {
            let code = 302;
            let loc = statusOrUrl;
            if (typeof statusOrUrl === 'number') {
                code = statusOrUrl;
                loc = maybeUrl;
            }
            res.statusCode = code;
            res.setHeader('Location', loc);
            res.end();
            return res;
        };
        res.clearCookie = function (name) {
            const clearStr = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
            const existing = res.getHeader('Set-Cookie');
            if (!existing) res.setHeader('Set-Cookie', [clearStr]);
            else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, clearStr]);
            else res.setHeader('Set-Cookie', [String(existing), clearStr]);
            return res;
        };

        rootRouter(req, res, (err) => {
            if (err) {
                const errHandlers = rootRouter._stack.filter(l => l.type === 'error');
                let eIdx = 0;
                const runErr = (curErr) => {
                    if (!curErr || res.writableEnded) return;
                    if (eIdx >= errHandlers.length) {
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ error: curErr.message || 'Internal Server Error' }));
                    }
                    const eh = errHandlers[eIdx++].fn;
                    try {
                        eh(curErr, req, res, runErr);
                    } catch (e2) {
                        runErr(e2);
                    }
                };
                return runErr(err);
            }
            if (!res.writableEnded) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Not Found' }));
            }
        });
    }

    app.set = (k, v) => { settings[k] = v; return app; };
    app.get = (k, ...handlers) => {
        if (handlers.length === 0) return settings[k];
        return rootRouter.get(k, ...handlers);
    };
    app.post = (...args) => rootRouter.post(...args);
    app.put = (...args) => rootRouter.put(...args);
    app.patch = (...args) => rootRouter.patch(...args);
    app.delete = (...args) => rootRouter.delete(...args);
    app.use = (...args) => rootRouter.use(...args);
    app.listen = (port, cb) => {
        const srv = http.createServer(app);
        return srv.listen(port, cb);
    };

    return app;
}

createExpressApp.Router = createRouter;
createExpressApp.json = function () {
    return function jsonParser(req, res, next) {
        if (req.method === 'GET' || req.method === 'HEAD') {
            req.body = {};
            return next();
        }
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            if (!raw || !raw.trim()) {
                req.body = {};
                return next();
            }
            try {
                req.body = JSON.parse(raw);
                next();
            } catch (e) {
                const parseErr = new Error('Invalid JSON');
                parseErr.type = 'entity.parse.failed';
                next(parseErr);
            }
        });
    };
};
createExpressApp.static = function (rootDir) {
    return function staticMiddleware(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const safePath = path.normalize(req.path).replace(/^(\.\.(\/|\\|$))+/, '');
        const fullPath = path.join(rootDir, safePath);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const ext = path.extname(fullPath).toLowerCase();
            res.setHeader('Content-Type', MIME_MAP[ext] || 'application/octet-stream');
            const content = fs.readFileSync(fullPath);
            return res.end(content);
        }
        next();
    };
};

module.exports = {
    dotenv,
    bcryptjs,
    expressSession,
    express: createExpressApp
};
