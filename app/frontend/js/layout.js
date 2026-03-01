document.addEventListener('DOMContentLoaded', () => {
  const currentSection = document.body.dataset.current;

  // Sidebar navigation
  const sidebarItems = document.querySelectorAll('.sidebar-item');
  sidebarItems.forEach((btn) => {
    const section = btn.dataset.section;
    const path = btn.dataset.path;

    if (currentSection && section === currentSection) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }

    if (path) {
      btn.addEventListener('click', () => {
        if (window.location.pathname !== path) {
          window.location.href = path;
        }
      });
    }
  });

  // Change password modal
  const changeBtn = document.getElementById('change-password-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const modal = document.getElementById('change-password-modal');
  const cancelBtn = document.getElementById('cancel-change');
  const form = document.getElementById('change-password-form');
  const errorEl = document.getElementById('change-error');

  if (changeBtn && modal) {
    changeBtn.addEventListener('click', () => {
      modal.style.display = 'block';
    });
  }

  if (cancelBtn && modal && form && errorEl) {
    cancelBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      form.reset();
      errorEl.textContent = '';
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

      const res = await fetch('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const data = await res.json();
      if (data.success) {
        alert('Password changed successfully');
        modal.style.display = 'none';
        form.reset();
      } else {
        errorEl.textContent = data.error || 'Change password failed';
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = '/login';
    });
  }
});

