/* =====================================================================
   MediVault DS -- core runtime (no build step, no framework)

   Everything shared by every page lives here: theme, API wrapper, toasts,
   confirm dialog, form validation, and the DataTable controller that gives
   any <table> search + sort + pagination + skeleton + empty state.

   Load order on a page:  bootstrap.bundle -> lucide -> mv-core.js -> mv-shell.js -> page script
   ===================================================================== */
(function (window, document) {
    'use strict';

    const MV = {};

    /* ============================================================ theme */
    // Applied to <html> by the inline snippet in each page's <head> so there
    // is no flash of the wrong theme; this object handles later toggling.
    MV.theme = {
        KEY: 'mv-theme',
        get() {
            return document.documentElement.getAttribute('data-theme') || 'light';
        },
        set(mode) {
            document.documentElement.setAttribute('data-theme', mode);
            try { localStorage.setItem(MV.theme.KEY, mode); } catch (e) { /* private mode */ }
            document.dispatchEvent(new CustomEvent('mv:themechange', { detail: { mode } }));
        },
        toggle() {
            MV.theme.set(MV.theme.get() === 'dark' ? 'light' : 'dark');
        }
    };

    /* ============================================================== dom */
    MV.el = function (tag, attrs, children) {
        const node = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (key) {
                const val = attrs[key];
                if (val === null || val === undefined || val === false) return;
                if (key === 'class') node.className = val;
                else if (key === 'text') node.textContent = val;
                else if (key === 'html') node.innerHTML = val;      // callers pass only MV-built markup
                else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), val);
                else node.setAttribute(key, val === true ? '' : val);
            });
        }
        (Array.isArray(children) ? children : children ? [children] : []).forEach(function (child) {
            if (child === null || child === undefined || child === false) return;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        });
        return node;
    };

    // Escape anything that came from the database before it touches innerHTML.
    MV.esc = function (value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    // Font Awesome icons - no post-processing needed, render inline
    MV.icons = function (root) {
        if (window.lucide) window.lucide.createIcons();
    };

    MV.icon = function (name, cls) {
        const aliases = {
            'x': 'xmark', 'eye-off': 'eye-slash', 'refresh-cw': 'arrows-rotate',
            'bed-double': 'bed', 'user-round': 'user', 'heart-handshake': 'hand-holding-heart',
            'flask-conical': 'flask', 'pill': 'pills', 'circle-alert': 'circle-exclamation',
            'alert-circle': 'circle-exclamation', 'triangle-alert': 'triangle-exclamation',
            'file-check': 'file-circle-check', 'package': 'box', 'desk': 'bell-concierge',
            'file-text': 'file-lines', 'calendar-clock': 'calendar',
            'circle-dashed': 'circle-half-stroke', 'siren': 'truck-medical',
            'send': 'paper-plane', 'check-circle': 'circle-check'
        };
        return '<i aria-hidden="true" class="fas fa-' + MV.esc(aliases[name] || name) + (cls ? ' ' + MV.esc(cls) : '') + '"></i>';
    };

    /* ============================================================== api */
    // Single fetch wrapper: JSON in, JSON out, session cookie included,
    // 401 bounces to the login page, and every error surfaces the server's
    // own message (which for this app is often a trigger/procedure SIGNAL).
    MV.api = async function (path, options) {
        const opts = options || {};
        const init = {
            method: opts.method || 'GET',
            credentials: 'same-origin',
            headers: Object.assign({ 'Accept': 'application/json' }, opts.headers || {})
        };
        if (opts.body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(opts.body);
        }

        let res;
        try {
            res = await fetch((window.MV_API_BASE || '') + path, init);
        } catch (netErr) {
            const err = new Error('Could not reach the server. Check your connection.');
            err.status = 0;
            throw err;
        }

        if (res.status === 401 && !opts.noRedirect) {
            window.location.href = '/login.html?expired=1';
            throw Object.assign(new Error('Session expired'), { status: 401 });
        }

        let data = null;
        const text = await res.text();
        if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }

        if (!res.ok) {
            const err = new Error((data && (data.error || data.message)) || 'Request failed (' + res.status + ')');
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    };

    MV.api.get = function (path) { return MV.api(path); };
    MV.api.post = function (path, body) { return MV.api(path, { method: 'POST', body: body }); };
    MV.api.put = function (path, body) { return MV.api(path, { method: 'PUT', body: body }); };
    MV.api.patch = function (path, body) { return MV.api(path, { method: 'PATCH', body: body }); };
    MV.api.del = function (path) { return MV.api(path, { method: 'DELETE' }); };

    /* =========================================================== toasts */
    const TOAST_ICON = { success: 'check-circle', danger: 'exclamation-circle', warning: 'exclamation-triangle', info: 'info-circle' };

    function toastHost() {
        let host = document.querySelector('.mv-toasts');
        if (!host) {
            host = MV.el('div', { class: 'mv-toasts', role: 'region', 'aria-label': 'Notifications' });
            document.body.appendChild(host);
        }
        return host;
    }

    MV.toast = function (opts) {
        const cfg = typeof opts === 'string' ? { title: opts } : (opts || {});
        const kind = cfg.kind || cfg.type || 'success';
        const host = toastHost();

        const node = MV.el('div', {
            class: 'mv-toast is-' + kind,
            role: kind === 'danger' ? 'alert' : 'status',
            'aria-live': kind === 'danger' ? 'assertive' : 'polite'
        }, [
            MV.el('span', { class: 'mv-toast-icon', html: MV.icon(TOAST_ICON[kind] || 'info') }),
            MV.el('div', { class: 'mv-toast-body' }, [
                MV.el('div', { class: 'mv-toast-title', text: cfg.title || cfg.message || '' }),
                cfg.text ? MV.el('div', { class: 'mv-toast-text', html: cfg.html ? cfg.text : MV.esc(cfg.text) }) : null
            ]),
            MV.el('button', {
                class: 'mv-btn mv-btn-ghost mv-btn-icon mv-btn-sm', type: 'button',
                'aria-label': 'Dismiss notification',
                html: MV.icon('x'),
                onclick: function () { close(); }
            })
        ]);

        host.appendChild(node);
        MV.icons(node);

        let timer = setTimeout(close, cfg.duration || (kind === 'danger' ? 7000 : 4500));
        function close() {
            clearTimeout(timer);
            node.classList.add('is-out');
            setTimeout(function () { node.remove(); }, 200);
        }
        return { close: close };
    };

    MV.toast.success = function (title, text) { return MV.toast({ kind: 'success', title: title, text: text }); };
    MV.toast.error = function (title, text) { return MV.toast({ kind: 'danger', title: title, text: text }); };
    MV.toast.warn = function (title, text) { return MV.toast({ kind: 'warning', title: title, text: text }); };
    MV.toast.info = function (title, text) { return MV.toast({ kind: 'info', title: title, text: text }); };

    /* ========================================================== confirm */
    // Promise-based confirm on top of a Bootstrap modal, so focus trapping
    // and Esc-to-close come for free. Used before every destructive action.
    MV.confirm = function (opts) {
        const cfg = typeof opts === 'string' ? { message: opts } : (opts || {});
        return new Promise(function (resolve) {
            const wrap = MV.el('div', { class: 'modal fade', tabindex: '-1', 'aria-hidden': 'true' });
            wrap.innerHTML =
                '<div class="modal-dialog modal-dialog-centered modal-sm">' +
                  '<div class="modal-content">' +
                    '<div class="modal-header">' +
                      '<h2 class="modal-title h5">' + MV.esc(cfg.title || 'Are you sure?') + '</h2>' +
                      '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>' +
                    '</div>' +
                    '<div class="modal-body"><p class="mb-0">' + MV.esc(cfg.message || 'This cannot be undone.') + '</p></div>' +
                    '<div class="modal-footer">' +
                      '<button type="button" class="mv-btn mv-btn-outline" data-bs-dismiss="modal">' +
                        MV.esc(cfg.cancelText || 'Cancel') + '</button>' +
                      '<button type="button" class="mv-btn mv-btn-' + (cfg.kind || 'danger') + '" data-mv-ok>' +
                        MV.esc(cfg.confirmText || 'Delete') + '</button>' +
                    '</div>' +
                  '</div>' +
                '</div>';
            document.body.appendChild(wrap);

            const modal = new window.bootstrap.Modal(wrap);
            let answer = false;
            wrap.querySelector('[data-mv-ok]').addEventListener('click', function () { answer = true; modal.hide(); });
            wrap.addEventListener('hidden.bs.modal', function () { wrap.remove(); resolve(answer); });
            wrap.addEventListener('shown.bs.modal', function () { wrap.querySelector('[data-mv-ok]').focus(); });
            modal.show();
        });
    };

    /* ======================================================= form state */
    // Disable a submit button and swap its label for a spinner while a
    // request is in flight. Returns the restore function.
    MV.pending = function (button, label) {
        if (!button) return function () {};
        const original = button.innerHTML;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.innerHTML = '<span class="mv-spin" aria-hidden="true"></span><span>' + MV.esc(label || 'Working...') + '</span>';
        return function restore() {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            button.innerHTML = original;
            MV.icons(button);
        };
    };

    /* ======================================================== validation */
    // Inline validation driven by the native constraint API plus a few extra
    // rules via data-mv-rule. Each control lives in a .mv-field wrapper that
    // holds the .mv-error message node.
    const RULES = {
        phone: { test: function (v) { return /^[0-9+\-\s()]{7,15}$/.test(v); }, message: 'Enter a valid phone number.' },
        positive: { test: function (v) { return Number(v) > 0; }, message: 'Enter a number greater than 0.' },
        nonneg: { test: function (v) { return Number(v) >= 0; }, message: 'Cannot be negative.' },
        past: { test: function (v) { return new Date(v) <= new Date(); }, message: 'Date cannot be in the future.' },
        future: { test: function (v) { return new Date(v) >= new Date(new Date().toDateString()); }, message: 'Pick today or a later date.' }
    };

    function fieldOf(control) { return control.closest('.mv-field') || control.parentElement; }

    function messageFor(control) {
        const value = (control.value || '').trim();
        if (control.required && !value) return control.dataset.mvRequiredMessage || 'This field is required.';
        if (!value) return '';
        if (!control.validity.valid) {
            if (control.validity.typeMismatch && control.type === 'email') return 'Enter a valid email address.';
            if (control.validity.tooShort) return 'Use at least ' + control.minLength + ' characters.';
            if (control.validity.rangeUnderflow) return 'Value is too low.';
            if (control.validity.rangeOverflow) return 'Value is too high.';
            if (control.validity.patternMismatch) return control.dataset.mvPatternMessage || 'Check the format.';
            return 'Check this value.';
        }
        const ruleName = control.dataset.mvRule;
        if (ruleName && RULES[ruleName] && !RULES[ruleName].test(value)) {
            return control.dataset.mvRuleMessage || RULES[ruleName].message;
        }
        const matchId = control.dataset.mvMatch;
        if (matchId) {
            const other = document.getElementById(matchId);
            if (other && other.value !== control.value) return control.dataset.mvMatchMessage || 'Values do not match.';
        }
        return '';
    }

    MV.validateControl = function (control) {
        const field = fieldOf(control);
        const msg = messageFor(control);
        let errNode = field ? field.querySelector('.mv-error') : null;
        if (field && !errNode) {
            errNode = MV.el('p', { class: 'mv-error' });
            field.appendChild(errNode);
        }
        if (msg) {
            if (field) field.classList.add('is-invalid');
            control.setAttribute('aria-invalid', 'true');
            if (errNode) {
                errNode.textContent = msg;
                if (!errNode.id) errNode.id = 'mv-err-' + Math.random().toString(36).slice(2, 8);
                control.setAttribute('aria-describedby', errNode.id);
            }
            return false;
        }
        if (field) field.classList.remove('is-invalid');
        control.removeAttribute('aria-invalid');
        return true;
    };

    MV.validateForm = function (form) {
        const controls = form.querySelectorAll('input, select, textarea');
        let firstBad = null;
        controls.forEach(function (control) {
            if (control.disabled || control.type === 'hidden') return;
            if (!MV.validateControl(control) && !firstBad) firstBad = control;
        });
        if (firstBad) firstBad.focus();
        return !firstBad;
    };

    // Validate on blur, and clear the error as soon as the user fixes it.
    MV.watchForm = function (form) {
        form.setAttribute('novalidate', '');
        form.addEventListener('blur', function (e) {
            if (e.target.matches('input, select, textarea')) MV.validateControl(e.target);
        }, true);
        form.addEventListener('input', function (e) {
            const field = fieldOf(e.target);
            if (field && field.classList.contains('is-invalid')) MV.validateControl(e.target);
        });
        return form;
    };

    MV.formValues = function (form) {
        const out = {};
        new FormData(form).forEach(function (value, key) {
            if (out[key] === undefined) out[key] = typeof value === 'string' ? value.trim() : value;
            else if (Array.isArray(out[key])) out[key].push(value);
            else out[key] = [out[key], value];
        });
        return out;
    };

    /* ========================================================= formatting */
    MV.fmt = {
        // All money in this database is INR (see Phase 2 DDL comment).
        money: function (value) {
            const n = Number(value);
            if (!isFinite(n)) return '--';
            return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        },
        moneyShort: function (value) {
            const n = Number(value) || 0;
            if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr';
            if (n >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L';
            if (n >= 1e3) return '₹' + (n / 1e3).toFixed(1) + 'k';
            return '₹' + n.toFixed(0);
        },
        number: function (value) {
            const n = Number(value);
            return isFinite(n) ? n.toLocaleString('en-IN') : '--';
        },
        date: function (value) {
            if (!value) return '--';
            const d = new Date(value);
            if (isNaN(d)) return String(value);
            return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        },
        dateTime: function (value) {
            if (!value) return '--';
            const d = new Date(value);
            if (isNaN(d)) return String(value);
            return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        },
        // MySQL TIME arrives as "14:30:00"; Date parsing would choke on it.
        time: function (value) {
            if (!value) return '--';
            const parts = String(value).split(':');
            if (parts.length < 2) return String(value);
            let h = parseInt(parts[0], 10);
            const m = parts[1];
            const suffix = h >= 12 ? 'PM' : 'AM';
            h = h % 12 || 12;
            return h + ':' + m + ' ' + suffix;
        },
        month: function (value) {
            if (!value) return '--';
            const parts = String(value).split('-');
            const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
            return isNaN(d) ? String(value) : d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
        },
        relative: function (value) {
            const d = new Date(value);
            if (isNaN(d)) return '';
            const secs = Math.round((Date.now() - d.getTime()) / 1000);
            if (secs < 60) return 'just now';
            if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
            if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
            if (secs < 604800) return Math.floor(secs / 86400) + 'd ago';
            return MV.fmt.date(value);
        },
        initials: function (name) {
            const words = String(name || '?').replace(/^Dr\.?\s+/i, '').trim().split(/\s+/);
            return ((words[0] || '?')[0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
        },
        docName: function (name) {
            if (!name) return '';
            const clean = String(name).trim();
            if (/^Dr\.?\s+/i.test(clean)) return clean;
            return 'Dr. ' + clean;
        },
        // YYYY-MM-DD in local time -- toISOString() would shift the date in IST.
        isoDate: function (date) {
            const d = date || new Date();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return d.getFullYear() + '-' + m + '-' + day;
        },
        daysUntil: function (value) {
            if (!value) return null;
            const d = new Date(value);
            if (isNaN(d)) return null;
            const today = new Date(); today.setHours(0, 0, 0, 0);
            return Math.round((d - today) / 86400000);
        },
        // Indian number formatting: 1,55,000 (lakhs/crores grouping)
        numberIndian: function (value) {
            const n = Number(value);
            if (!isFinite(n)) return '--';
            return n.toLocaleString('en-IN');
        },
        // Indian date: 12 Aug 2025
        dateIndian: function (value) {
            if (!value) return '--';
            const d = new Date(value);
            if (isNaN(d)) return String(value);
            return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        },
        // 12-hour time: 2:30 PM
        time12: function (value) {
            if (!value) return '--';
            const parts = String(value).split(':');
            if (parts.length < 2) return String(value);
            let h = parseInt(parts[0], 10);
            const m = parts[1];
            const suffix = h >= 12 ? 'PM' : 'AM';
            h = h % 12 || 12;
            return h + ':' + m + ' ' + suffix;
        },
        // Short month: Aug '25
        monthShort: function (value) {
            if (!value) return '--';
            const parts = String(value).split('-');
            const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
            return isNaN(d) ? String(value) : d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
        }
    };

    /* ================================================== status -> badge map */
    // One source of truth so "Pending" is the same amber pill on every screen.
    const STATUS_MAP = {
        available: ['success', 'circle-check'],
        occupied: ['danger', 'bed'],
        emergency: ['warning', 'siren'],
        scheduled: ['info', 'calendar-clock'],
        completed: ['success', 'check'],
        cancelled: ['neutral', 'x'],
        pending: ['warning', 'clock'],
        dispensed: ['success', 'check'],
        paid: ['success', 'check'],
        unpaid: ['danger', 'circle-alert'],
        partial: ['warning', 'circle-dashed'],
        'on duty': ['info', 'route'],
        maintenance: ['neutral', 'wrench'],
        high: ['danger', 'chevrons-up'],
        normal: ['neutral', 'minus'],
        urgent: ['danger', 'chevrons-up'],
        low: ['neutral', 'chevron-down'],
        critical: ['danger', 'triangle-alert']
    };

    MV.badge = function (status, overrideKind) {
        const key = String(status || '').toLowerCase();
        const hit = STATUS_MAP[key] || ['neutral', null];
        const kind = overrideKind || hit[0];
        return '<span class="mv-badge is-' + kind + '">' +
            (hit[1] ? MV.icon(hit[1]) : '') + MV.esc(status || '--') + '</span>';
    };

    /* =================================================== skeleton + empty */
    MV.skeletonRows = function (tbody, rows, cols) {
        let html = '';
        for (let r = 0; r < rows; r++) {
            html += '<tr>';
            for (let c = 0; c < cols; c++) {
                html += '<td><span class="mv-skeleton d-block" style="width:' + (45 + ((r + c) % 4) * 14) + '%"></span></td>';
            }
            html += '</tr>';
        }
        tbody.innerHTML = html;
    };

    MV.emptyState = function (opts) {
        const cfg = opts || {};
        return '<div class="mv-empty">' +
            '<div class="mv-empty-icon">' + MV.icon(cfg.icon || 'inbox') + '</div>' +
            '<p class="mv-empty-title">' + MV.esc(cfg.title || 'Nothing here yet') + '</p>' +
            '<p class="mv-empty-text">' + MV.esc(cfg.text || '') + '</p>' +
            '</div>';
    };

    // Original pages use both the interactive DataTable and a simple table.
    MV.table = function (cfg) {
        return '<div class="mv-table-wrap"><table class="mv-table"><thead><tr>' +
            cfg.columns.map(c => '<th scope="col">' + MV.esc(c) + '</th>').join('') +
            '</tr></thead><tbody>' + cfg.rows.map(row => '<tr>' + row.map((cell, i) =>
                '<td data-label="' + MV.esc(cfg.columns[i]) + '">' + cell + '</td>').join('') + '</tr>').join('') +
            '</tbody></table></div>';
    };

    /* ========================================================= DataTable */
    /**
     * Wraps a container in a full table experience: toolbar search, sortable
     * headers, client-side pagination, skeleton loader, empty state.
     *
     * new MV.DataTable(mount, {
     *   columns: [{ key, label, sortable, align, width, render(row) }],
     *   fetch: () => MV.api.get('/api/...'),   // must resolve to an array
     *   rowActions: (row) => htmlString,
     *   searchKeys: ['name', 'email'],
     *   pageSize: 10,
     *   empty: { icon, title, text },
     *   toolbar: htmlString | Node          // extra controls, right of search
     * })
     */
    MV.DataTable = function (mount, options) {
        const self = this;
        const cfg = Object.assign({ pageSize: 10, searchPlaceholder: 'Search...' }, options || {});
        const cols = cfg.columns.slice();
        if (cfg.rowActions) cols.push({ key: '__actions', label: 'Actions', align: 'actions', sortable: false, render: cfg.rowActions });

        let rows = [];
        let view = [];
        let page = 1;
        let query = '';
        let sortKey = cfg.defaultSort || null;
        let sortDir = cfg.defaultSortDir || 'asc';

        const uid = 'mvdt-' + Math.random().toString(36).slice(2, 8);

        mount.innerHTML =
            '<div class="mv-data-record">' +
              '<div class="mv-table-toolbar">' +
                '<div class="mv-input-icon">' +
                  MV.icon('search') +
                  '<label class="mv-sr" for="' + uid + '-q">' + MV.esc(cfg.searchLabel || 'Search table') + '</label>' +
                  '<input id="' + uid + '-q" class="mv-input" type="search" placeholder="' + MV.esc(cfg.searchPlaceholder) + '">' +
                '</div>' +
                '<div class="mv-table-extra d-flex flex-wrap align-items-center gap-2 ms-auto"></div>' +
              '</div>' +
              '<div class="mv-table-wrap">' +
                '<table class="mv-table">' +
                  '<caption class="mv-sr">' + MV.esc(cfg.caption || 'Data table') + '</caption>' +
                  '<thead><tr></tr></thead><tbody></tbody>' +
                '</table>' +
              '</div>' +
              '<div class="mv-empty-slot"></div>' +
              '<div class="mv-pagination">' +
                '<span class="mv-page-info" aria-live="polite"></span>' +
                '<div class="mv-pagination-btns">' +
                  '<button type="button" class="mv-btn mv-btn-outline mv-btn-sm" data-mv-prev>' + MV.icon('chevron-left') + 'Prev</button>' +
                  '<button type="button" class="mv-btn mv-btn-outline mv-btn-sm" data-mv-next>Next' + MV.icon('chevron-right') + '</button>' +
                '</div>' +
              '</div>' +
            '</div>';

        const card = mount.firstElementChild;
        const search = card.querySelector('input[type="search"]');
        const extra = card.querySelector('.mv-table-extra');
        const headRow = card.querySelector('thead tr');
        const tbody = card.querySelector('tbody');
        const tableWrap = card.querySelector('.mv-table-wrap');
        const emptySlot = card.querySelector('.mv-empty-slot');
        const pager = card.querySelector('.mv-pagination');
        const pageInfo = card.querySelector('.mv-page-info');
        const prevBtn = card.querySelector('[data-mv-prev]');
        const nextBtn = card.querySelector('[data-mv-next]');

        if (cfg.toolbar) {
            if (typeof cfg.toolbar === 'string') extra.innerHTML = cfg.toolbar;
            else extra.appendChild(cfg.toolbar);
        }

        // header cells
        cols.forEach(function (col) {
            const th = MV.el('th', {
                scope: 'col',
                class: col.align === 'right' ? 'mv-num' : col.align === 'actions' ? 'mv-actions' : null,
                style: col.width ? 'width:' + col.width : null
            });
            if (col.sortable === false || col.align === 'actions') {
                th.textContent = col.label;
            } else {
                const btn = MV.el('button', {
                    type: 'button', class: 'mv-sort',
                    html: MV.esc(col.label) + MV.icon('arrow-up', 'mv-sort-arrow'),
                    onclick: function () { self.sort(col.key); }
                });
                btn.dataset.key = col.key;
                th.appendChild(btn);
            }
            headRow.appendChild(th);
        });

        search.addEventListener('input', function () {
            query = search.value.trim().toLowerCase();
            page = 1;
            apply();
        });
        prevBtn.addEventListener('click', function () { if (page > 1) { page--; render(); } });
        nextBtn.addEventListener('click', function () {
            if (page < Math.ceil(view.length / cfg.pageSize)) { page++; render(); }
        });

        function cellValue(row, col) {
            return col.value ? col.value(row) : row[col.key];
        }

        function apply() {
            const keys = cfg.searchKeys || cols.filter(function (c) { return c.key !== '__actions'; }).map(function (c) { return c.key; });
            view = !query ? rows.slice() : rows.filter(function (row) {
                return keys.some(function (k) {
                    const v = row[k];
                    return v !== null && v !== undefined && String(v).toLowerCase().indexOf(query) !== -1;
                });
            });

            if (sortKey) {
                const col = cols.filter(function (c) { return c.key === sortKey; })[0] || { key: sortKey };
                const dir = sortDir === 'asc' ? 1 : -1;
                view.sort(function (a, b) {
                    let av = cellValue(a, col), bv = cellValue(b, col);
                    if (av === null || av === undefined) return 1;
                    if (bv === null || bv === undefined) return -1;
                    const an = Number(av), bn = Number(bv);
                    if (!isNaN(an) && !isNaN(bn) && av !== '' && bv !== '') return (an - bn) * dir;
                    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * dir;
                });
            }

            headRow.querySelectorAll('.mv-sort').forEach(function (btn) {
                const th = btn.closest('th');
                if (btn.dataset.key === sortKey) {
                    btn.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
                    th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
                } else {
                    btn.removeAttribute('aria-sort');
                    th.removeAttribute('aria-sort');
                }
            });

            render();
        }

        function render() {
            const total = view.length;
            const pages = Math.max(1, Math.ceil(total / cfg.pageSize));
            if (page > pages) page = pages;
            const start = (page - 1) * cfg.pageSize;
            const slice = view.slice(start, start + cfg.pageSize);

            if (!total) {
                tableWrap.style.display = 'none';
                pager.style.display = 'none';
                emptySlot.innerHTML = MV.emptyState(query
                    ? { icon: 'search-x', title: 'No matches', text: 'No rows match "' + query + '". Try a different search.' }
                    : (cfg.empty || {}));
                MV.icons(emptySlot);
                return;
            }

            emptySlot.innerHTML = '';
            tableWrap.style.display = '';
            pager.style.display = total > cfg.pageSize ? '' : 'none';

            tbody.innerHTML = slice.map(function (row, i) {
                const cells = cols.map(function (col) {
                    const cls = col.align === 'right' ? ' class="mv-num"' : col.align === 'actions' ? ' class="mv-actions"' : '';
                    const content = col.render ? col.render(row, start + i) : MV.esc(cellValue(row, col));
                    return '<td' + cls + '>' + (content === null || content === undefined ? '' : content) + '</td>';
                }).join('');
                const attrs = cfg.rowAttrs ? cfg.rowAttrs(row) : '';
                return '<tr' + (attrs ? ' ' + attrs : '') + '>' + cells + '</tr>';
            }).join('');

            MV.icons(tbody);
            pageInfo.textContent = 'Showing ' + (start + 1) + '-' + Math.min(start + cfg.pageSize, total) + ' of ' + total;
            prevBtn.disabled = page === 1;
            nextBtn.disabled = page === pages;

            if (cfg.onRender) cfg.onRender(tbody, slice);
        }

        this.sort = function (key) {
            if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            else { sortKey = key; sortDir = 'asc'; }
            apply();
        };

        this.setRows = function (next) {
            rows = Array.isArray(next) ? next : [];
            apply();
            return self;
        };

        this.getRows = function () { return rows.slice(); };

        this.loading = function () {
            emptySlot.innerHTML = '';
            tableWrap.style.display = '';
            pager.style.display = 'none';
            MV.skeletonRows(tbody, Math.min(cfg.pageSize, 6), cols.length);
            return self;
        };

        this.error = function (message) {
            tableWrap.style.display = 'none';
            pager.style.display = 'none';
            emptySlot.innerHTML = MV.emptyState({
                icon: 'wifi-off', title: 'Could not load this table', text: message || 'Try reloading the page.'
            });
            MV.icons(emptySlot);
            return self;
        };

        this.reload = async function () {
            if (!cfg.fetch) return self;
            self.loading();
            try {
                self.setRows(await cfg.fetch());
            } catch (err) {
                self.error(err.message);
            }
            return self;
        };

        if (cfg.fetch && cfg.autoLoad !== false) this.reload();
    };

    /* ================================================== misc small helpers */
    MV.debounce = function (fn, wait) {
        let t;
        return function () {
            const args = arguments, ctx = this;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(ctx, args); }, wait || 250);
        };
    };

    MV.qs = function (name) {
        return new URLSearchParams(window.location.search).get(name);
    };

    window.MV = MV;
})(window, document);
