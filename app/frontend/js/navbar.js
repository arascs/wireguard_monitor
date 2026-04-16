/**
 * navbar.js  –  Injects the shared navbar, sidebar and change-password modal
 * into every page, then wires up the sidebar active state, logout, and
 * change-password functionality.
 *
 * Each page only needs:
 *   <link rel="stylesheet" href="/styles.css">
 *   <script src="/js/navbar.js"></script>
 *   <script src="/js/<page>.js"></script>
 *
 * The <body> tag should carry  data-current="<section>"  so the sidebar
 * item gets highlighted automatically.
 */

(function () {
  // ── 1. Inject Navbar HTML ───────────────────────────────────
  const navbarHTML = `
<div class="navbar" id="main-navbar">
  <h1>WireGuard VPN Manager</h1>
  <div class="nav-buttons">
    <span class="hostname-display" id="navbar-hostname">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none"
           viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
      <strong id="navbar-hostname-text">Loading...</strong>
    </span>
    <div class="notification-wrap">
      <button class="nav-btn notification-btn" id="notification-btn" type="button" title="Notifications">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5"></path>
          <path d="M9 17a3 3 0 0 0 6 0"></path>
        </svg>
        <span class="notification-dot" id="notification-dot" style="display:none;"></span>
      </button>
      <div class="notification-popover" id="notification-popover" style="display:none;">
        <strong id="notification-text">0 new alerts</strong>
      </div>
    </div>
    <a href="/" class="nav-btn" id="nav-home-btn">Home</a>
    <button class="nav-btn" id="change-password-btn">Change Password</button>
    <button class="nav-btn" id="logout-btn">Logout</button>
  </div>
</div>`;

  // ── 2. Inject Sidebar HTML ──────────────────────────────────
  const sidebarHTML = `
<div class="sidebar" id="main-sidebar">
  <div class="sidebar-menu">
    <button class="sidebar-item" data-section="main-dashboard" data-path="/">Dashboard</button>
    <button class="sidebar-item" data-section="connections"    data-path="/interfaces">Interfaces</button>
    <button class="sidebar-item" data-section="users"         data-path="/users">Identity</button>
    <button class="sidebar-item" data-section="devices"       data-path="/devices">Devices</button>
    <button class="sidebar-item" data-section="applications"  data-path="/applications">Applications</button>
    <button class="sidebar-item" data-section="access"        data-path="/access-rules">Access rules</button>
    <button class="sidebar-item" data-section="audit"         data-path="/audit-log">Logging</button>
    <button class="sidebar-item" data-section="backup"        data-path="/backup">Backup &amp; Restore</button>
    <button class="sidebar-item" data-section="settings"      data-path="/settings">Settings</button>
  </div>
</div>`;

  // ── 3. Inject Change-Password Modal HTML ────────────────────
  const modalHTML = `
<div id="change-password-modal" class="modal">
  <div class="modal-content">
    <h3>Change Password</h3>
    <form id="change-password-form" autocomplete="off">
      <input type="password" id="current-password" placeholder="Current Password" required>
      <input type="password" id="new-password"     placeholder="New Password"     required>
      <input type="password" id="confirm-password" placeholder="Confirm New Password" required>
      <div class="change-pw-actions">
        <button type="button" id="cancel-change"
                style="background:none;border:1px solid #bbb;color:#555;padding:7px 16px;border-radius:5px;font-size:0.88rem;cursor:pointer;">
          Cancel
        </button>
        <button type="submit"
                style="padding:7px 20px;font-size:0.88rem;">
          Change
        </button>
      </div>
    </form>
    <p id="change-error"></p>
  </div>
</div>`;

  // Insert at the very beginning of <body> (before any existing children)
  document.body.insertAdjacentHTML('afterbegin', navbarHTML + sidebarHTML + modalHTML);

  // ── 4. Wire up sidebar navigation & active state ────────────
  document.addEventListener('DOMContentLoaded', () => {
    const currentSection = document.body.dataset.current;

    document.querySelectorAll('.sidebar-item').forEach((btn) => {
      const section = btn.dataset.section;
      const path = btn.dataset.path;

      // Highlight the active item
      if (currentSection && section === currentSection) {
        btn.classList.add('active');
      }

      // Navigate on click
      if (path) {
        btn.addEventListener('click', () => {
          if (window.location.pathname !== path) {
            window.location.href = path;
          }
        });
      }
    });

    // ── Fetch dynamic hostname ────────────────────────────────
    const hostnameTextEl = document.getElementById('navbar-hostname-text');
    if (hostnameTextEl) {
      fetch('/api/hostname')
        .then(r => r.json())
        .then(data => {
          if (data.success && data.hostname) {
            hostnameTextEl.textContent = data.hostname;
          } else {
            hostnameTextEl.textContent = 'Unknown Host';
          }
        })
        .catch(err => {
          console.error('Failed to fetch hostname', err);
          hostnameTextEl.textContent = 'Error';
        });
    }

    // ── 5. Change-password modal ────────────────────────────────
    const notificationBtn = document.getElementById('notification-btn');
    const notificationDot = document.getElementById('notification-dot');
    const notificationPopover = document.getElementById('notification-popover');
    const notificationText = document.getElementById('notification-text');
    let unreadAlerts = 0;
    let openedUnread = 0;

    async function loadUnreadAlerts() {
      try {
        const r = await fetch('/api/notifications/unread', { credentials: 'same-origin' });
        const data = await r.json();
        if (data.success) {
          unreadAlerts = Math.max(0, Number(data.unread) || 0);
          if (notificationText) {
            notificationText.textContent = `${unreadAlerts} new alerts`;
          }
          if (notificationDot) {
            notificationDot.style.display = unreadAlerts > 0 ? 'block' : 'none';
          }
        }
      } catch (e) {
        console.error('Failed to load notifications', e);
      }
    }

    if (notificationBtn) {
      notificationBtn.addEventListener('click', async () => {
        openedUnread = unreadAlerts;
        if (notificationText) {
          notificationText.textContent = `${openedUnread} new alerts`;
        }
        if (notificationPopover) {
          notificationPopover.style.display =
            notificationPopover.style.display === 'none' ? 'block' : 'none';
        }
        try {
          await fetch('/api/notifications/mark-read', {
            method: 'POST',
            credentials: 'same-origin'
          });
          unreadAlerts = 0;
          if (notificationDot) notificationDot.style.display = 'none';
        } catch (e) {
          console.error('Failed to mark notifications as read', e);
        }
      });
      setInterval(loadUnreadAlerts, 5000);
      loadUnreadAlerts();
    }

    const changeBtn = document.getElementById('change-password-btn');
    const modal = document.getElementById('change-password-modal');
    const cancelBtn = document.getElementById('cancel-change');
    const form = document.getElementById('change-password-form');
    const errorEl = document.getElementById('change-error');

    function closeModal() {
      modal.style.display = 'none';
      form.reset();
      if (errorEl) errorEl.textContent = '';
    }

    if (changeBtn && modal) {
      changeBtn.addEventListener('click', () => { modal.style.display = 'block'; });
    }

    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

    // Click outside modal-content to close
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
      });
    }

    if (form && errorEl) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPassword = document.getElementById('current-password').value;
        const newPassword = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('confirm-password').value;

        if (newPassword !== confirmPassword) {
          errorEl.textContent = 'New passwords do not match';
          return;
        }

        try {
          const res = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword }),
            credentials: 'same-origin',
          });
          const data = await res.json();
          if (data.success) {
            alert('Password changed successfully');
            closeModal();
          } else {
            errorEl.textContent = data.error || 'Change password failed';
          }
        } catch (err) {
          errorEl.textContent = 'Network error';
        }
      });
    }

    // ── 6. Logout ───────────────────────────────────────────────
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
        window.location.href = '/login';
      });
    }
  });
})();
