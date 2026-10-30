/* =====================================================================
   MediVault DS -- app shell

   Renders neutral role-aware navigation and a record-context header into
   <div id="mvShell"></div>, then hands the page its own <main> to fill.

   The sidebar is built from NAV_BY_ROLE below, which mirrors the RBAC in
   middleware/auth.js: a role only ever sees links whose API routes its own
   session is allowed to call. This is presentation only -- the server still
   enforces every request with requireRole(), so a hand-typed URL gains
   nothing.
   ===================================================================== */
(function (window, document) {
    'use strict';

    const MV = window.MV;

    /* ------------------------------------------------------ nav definitions */
    // Roles as stored in ROLE.role_name (Phase 2 seed data):
    // Admin, Doctor, Patient, Nurse, Lab Technician, Pharmacist, Receptionist
    const NAV_BY_ROLE = {
        Admin: [
            { href: '/admin-dashboard.html',  icon: 'chart-line',         label: 'Dashboard'        },
            { href: '/emergency.html',        icon: 'siren',              label: 'Emergency Ward'   },
            { href: '/admin-patients.html',    icon: 'users',              label: 'Patients'         },
            { href: '/admin-doctors.html',     icon: 'user-doctor',        label: 'Doctors'          },
            { href: '/admin-departments.html', icon: 'hospital',           label: 'Departments'      },
            { href: '/admin-appointments.html',icon: 'calendar-check',     label: 'Appointments'     },
            { href: '/lab.html',               icon: 'flask',              label: 'Laboratory'       },
            { href: '/pharmacy.html',          icon: 'pills',              label: 'Pharmacy'         },
            { href: '/billing.html',           icon: 'file-invoice-dollar',label: 'Billing'          },
            { href: '/bed-management.html',    icon: 'bed',                label: 'Emergency & Beds' },
            { href: '/blood-bank.html',        icon: 'droplet',            label: 'Blood Bank'       },
            { href: '/admin-staff.html',       icon: 'people-group',       label: 'Staff Management' },
            { href: '/ambulance.html',         icon: 'ambulance',          label: 'Ambulance'        },
            { href: '/admin-reports.html',     icon: 'chart-bar',          label: 'Reports'          }
        ],
        Doctor: [
            { href: '/doctor-dashboard.html', icon: 'clock',              label: 'My Schedule'      },
            { href: '/emergency.html',        icon: 'siren',              label: 'Emergency Ward'   },
            { href: '/doctor-patients.html',  icon: 'users',              label: 'My Patients'      },
            { href: '/blood-bank.html',       icon: 'droplet',            label: 'Blood Bank'       },
            { href: '/billing.html',          icon: 'file-invoice-dollar',label: 'Billing'          }
        ],
        Patient: [
            { href: '/patient-portal.html', icon: 'home', label: 'Home' },
            { href: '/patient-appointments.html', icon: 'calendar-check', label: 'Appointments' },
            { href: '/patient-reports.html', icon: 'file-medical', label: 'Doctor Reports' },
            { href: '/billing.html', icon: 'file-invoice', label: 'Bills' }
        ],
        Nurse: [
            { href: '/staff-portal.html', icon: 'bed-pulse', label: 'Staff Portal' },
            { href: '/emergency.html',    icon: 'siren',     label: 'Emergency Ward' },
            { href: '/blood-bank.html',   icon: 'droplet',   label: 'Blood Bank' }
        ],
        'Lab Technician': [
            { href: '/staff-portal.html', icon: 'flask', label: 'Staff Portal' },
            { href: '/lab.html', icon: 'file-lines', label: 'Lab Reports' }
        ],
        Pharmacist: [
            { href: '/staff-portal.html', icon: 'pills', label: 'Staff Portal' },
            { href: '/pharmacy.html', icon: 'box', label: 'Pharmacy Inventory' }
        ],
        Receptionist: [
            { href: '/staff-portal.html', icon: 'desk', label: 'Staff Portal' },
            { href: '/emergency.html',    icon: 'siren',     label: 'Emergency Ward' },
            { href: '/ambulance.html', icon: 'ambulance', label: 'Ambulance' },
            { href: '/billing.html', icon: 'file-invoice', label: 'Billing' }
        ]
    };

    // Which API path serves this role's NOTIFICATION rows. Roles absent from
    // this map have no notification endpoint yet, so the bell is hidden for
    // them rather than polling a 404 every 30 seconds.
    const NOTIF_ENDPOINT = {
        Admin: { list: '/api/admin/notifications', markAll: '/api/admin/notifications/mark-all-read' },
        Doctor: { list: '/api/doctor/notifications', markAll: '/api/doctor/notifications/mark-all-read' },
        Nurse: { list: '/api/staff/nurse/notifications' },
        Patient: { list: '/api/patient/notifications', markOne: '/api/patient/notifications/:id/read' },
        Pharmacist: { list: '/api/staff/pharmacist/notifications' }
    };

    const HOME_BY_ROLE = {
        Admin: '/admin-dashboard.html',
        Doctor: '/doctor-dashboard.html',
        Patient: '/patient-portal.html',
        Nurse: '/staff-portal.html',
        'Lab Technician': '/staff-portal.html',
        Pharmacist: '/staff-portal.html',
        Receptionist: '/staff-portal.html'
    };

    /* ------------------------------------------------------------- markup */
    function navMarkup(role, activePath) {
        const items = NAV_BY_ROLE[role] || [];
        return items.map(function (item) {
            const isActive = item.href === activePath;
            return '<a class="mv-nav-link" href="' + MV.esc(item.href) + '"' +
                (isActive ? ' aria-current="page"' : '') + '>' +
                MV.icon(item.icon) +
                '<span>' + MV.esc(item.label) + '</span>' +
                '</a>';
        }).join('');
    }

    function shellMarkup(user, opts) {
        const role = user.role;
        const activePath = window.location.pathname;

        return '' +
        '<a class="mv-skip" href="#mvMain">Skip to main content</a>' +

        '<aside class="mv-sidebar" id="mvSidebar">' +
          '<a class="mv-sidebar-brand" href="' + MV.esc(HOME_BY_ROLE[role] || '/') + '">' +
            '<span class="mv-logo" aria-hidden="true">' + MV.icon('heartbeat') + '</span>' +
            '<span class="mv-sidebar-name">MediCare</span>' +
          '</a>' +
          '<nav class="mv-nav" aria-label="Main navigation">' + navMarkup(role, activePath) + '</nav>' +
          '<div class="mv-sidebar-foot">' +
            '<a class="mv-nav-link" href="/profile.html"' + (activePath === '/profile.html' ? ' aria-current="page"' : '') + '>' + MV.icon('user') + '<span>Profile</span></a>' +
            '<button type="button" class="mv-btn mv-btn-outline mv-btn-block mt-2" data-mv-logout>' +
              MV.icon('sign-out-alt') + '<span>Sign out</span>' +
            '</button>' +
          '</div>' +
        '</aside>' +
        '<div class="mv-backdrop" data-mv-close-nav aria-hidden="true"></div>' +

        '<div class="mv-main">' +
          '<header class="mv-topbar">' +
            '<button type="button" class="mv-btn mv-btn-ghost mv-btn-icon mv-burger" data-mv-open-nav ' +
                    'aria-label="Open navigation" aria-controls="mvSidebar" aria-expanded="false">' +
              MV.icon('bars') +
            '</button>' +

            '<div class="mv-topbar-context">' + MV.icon('hospital') + '<span>MediCare / ' + MV.esc(opts.title || 'Account') + '</span></div>' +
            '<div class="mv-topbar-right">' +
              '<button type="button" class="mv-btn mv-btn-ghost mv-btn-icon" data-mv-theme aria-label="Toggle dark mode" aria-pressed="false">' + MV.icon('moon') + '</button>' +
              '<div class="dropdown">' +
                '<button type="button" class="mv-userchip" data-bs-toggle="dropdown" aria-expanded="false">' +
                  '<span class="mv-avatar" aria-hidden="true">' + MV.esc(MV.fmt.initials(user.name)) + '</span>' +
                  '<span class="mv-userchip-meta">' +
                    '<span class="mv-userchip-name d-block">' + MV.esc(user.name) + '</span>' +
                    '<span class="mv-userchip-role d-block">' + MV.esc(user.role) + '</span>' +
                  '</span>' +
                '</button>' +
                '<ul class="dropdown-menu dropdown-menu-end">' +
                  '<li><a class="dropdown-item" href="/profile.html">Profile</a></li>' +
                  '<li><hr class="dropdown-divider"></li>' +
                  '<li><button type="button" class="dropdown-item" data-mv-logout>Sign out</button></li>' +
                '</ul>' +
              '</div>' +
            '</div>' +
          '</header>' +

          '<main class="mv-page" id="mvMain" tabindex="-1"></main>' +
        '</div>';
    }

    /* --------------------------------------------------------- behaviour */
    function wireNav(root) {
        const open = function () {
            document.body.classList.add('mv-nav-open');
            const burger = root.querySelector('[data-mv-open-nav]');
            if (burger) burger.setAttribute('aria-expanded', 'true');
            const first = root.querySelector('.mv-nav .mv-nav-link');
            if (first) first.focus();
        };
        const close = function () {
            document.body.classList.remove('mv-nav-open');
            const burger = root.querySelector('[data-mv-open-nav]');
            if (burger) burger.setAttribute('aria-expanded', 'false');
        };

        root.addEventListener('click', function (e) {
            if (e.target.closest('[data-mv-open-nav]')) { open(); return; }
            if (e.target.closest('[data-mv-close-nav]')) { close(); return; }
            // tapping a link on mobile should close the drawer behind it
            if (e.target.closest('.mv-nav a') && window.innerWidth < 992) close();
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && document.body.classList.contains('mv-nav-open')) {
                close();
                const burger = root.querySelector('[data-mv-open-nav]');
                if (burger) burger.focus();
            }
        });
    }

    function wireTheme(root) {
        const btn = root.querySelector('[data-mv-theme]');
        const paint = function () {
            const dark = MV.theme.get() === 'dark';
            btn.setAttribute('aria-pressed', String(dark));
            btn.innerHTML = MV.icon(dark ? 'sun' : 'moon');
        };
        btn.addEventListener('click', function () { MV.theme.toggle(); paint(); });
        paint();
    }

    function wireLogout(root) {
        root.addEventListener('click', async function (e) {
            const btn = e.target.closest('[data-mv-logout]');
            if (!btn) return;
            const ok = await MV.confirm({
                title: 'Sign out?', message: 'You will need to log in again to continue.',
                confirmText: 'Sign out', kind: 'primary'
            });
            if (!ok) return;
            try { await MV.api.post('/api/auth/logout'); } catch (err) { /* leaving anyway */ }
            window.location.href = '/login.html';
        });
    }

    /* ---------------------------------------------------- notifications */
    function wireNotifications(root, user) {
        return null;
    }

    /* --------------------------------------------------------- global search */
    function wireGlobalSearch(root) {
        const input = root.querySelector('#mvGlobalSearch');
        if (!input) return;
        // No server-side search endpoint exists yet, so the topbar search filters
        // whatever the current page has already loaded. Pages opt in by listening
        // for mv:search; the DataTable-based pages wire it in their page script.
        input.addEventListener('input', MV.debounce(function () {
            document.dispatchEvent(new CustomEvent('mv:search', { detail: { query: input.value.trim() } }));
        }, 200));
        // "/" focuses search, the way every developer tool works
        document.addEventListener('keydown', function (e) {
            if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
                e.preventDefault();
                input.focus();
            }
        });
    }

    /* ---------------------------------------------------------------- boot */
    /**
     * MV.shell.mount({ roles: ['Admin'], title, subtitle, search })
     *
     * Verifies the session with GET /api/auth/me, refuses to render if the
     * role is not allowed on this page, paints the shell, and resolves with
     * { user, main } so the page can fill <main>.
     */
    MV.shell = {
        user: null,
        notifications: null,

        async mount(options) {
            const opts = options || {};
            const host = document.getElementById('mvShell') || document.body;

            let user;
            try {
                user = await MV.api.get('/api/auth/me');
            } catch (err) {
                window.location.href = '/login.html?expired=1';
                throw err;
            }

            // Page-level role gate. The server enforces this too; this just
            // avoids rendering a screen whose every request would 403.
            if (opts.roles && opts.roles.indexOf(user.role) === -1) {
                window.location.href = HOME_BY_ROLE[user.role] || '/login.html';
                throw new Error('Wrong role for this page');
            }

            MV.shell.user = user;
            host.innerHTML = shellMarkup(user, opts);

            const main = document.getElementById('mvMain');
            if (opts.title) {
                main.innerHTML =
                    '<div class="mv-page-head">' +
                      '<div>' +
                        '<h1 class="mv-page-title">' + MV.esc(opts.title) + '</h1>' +
                        (opts.subtitle ? '<p class="mv-page-sub">' + MV.esc(opts.subtitle) + '</p>' : '') +
                      '</div>' +
                      '<div class="mv-page-actions d-flex flex-wrap gap-2" id="mvPageActions"></div>' +
                    '</div>' +
                    '<div id="mvContent"></div>';
            }

            wireNav(host);
            wireTheme(host);
            wireLogout(host);
            wireGlobalSearch(host);
            MV.shell.notifications = wireNotifications(host, user);
            MV.icons();

            document.title = (opts.title ? opts.title + ' · ' : '') + 'MediCare';

            return {
                user: user,
                main: main,
                content: document.getElementById('mvContent') || main,
                actions: document.getElementById('mvPageActions')
            };
        }
    };

    MV.shell.NAV_BY_ROLE = NAV_BY_ROLE;
    MV.shell.HOME_BY_ROLE = HOME_BY_ROLE;
})(window, document);
