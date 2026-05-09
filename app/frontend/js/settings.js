function wireSecretToggles() {
  document.querySelectorAll('.btn-toggle-secret').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-target');
      const input = id ? document.getElementById(id) : null;
      if (!input) return;
      const plain = input.type === 'password';
      input.type = plain ? 'text' : 'password';
      btn.setAttribute('aria-pressed', plain ? 'true' : 'false');
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('settings-form');
  const btn = document.getElementById('save-settings-btn');
  wireSecretToggles();

  fetch('/api/settings', { credentials: 'same-origin' })
    .then((res) => res.json())
    .then((data) => {
      if (data.success && data.settings) {
        const s = data.settings;
        document.getElementById('keyExpiryDays').value = s.keyExpiryDays;
        document.getElementById('peerDisableHours').value = s.peerDisableHours;
        document.getElementById('keyRenewalTime').value = s.keyRenewalTime;
        document.getElementById('nodeApiKey').value = s.apiKey || '';
        document.getElementById('enforceKernelCheck').checked = s.enforceKernelCheck !== false;
        document.getElementById('minKernelVersion').value = s.minKernelVersion !== undefined ? s.minKernelVersion : 4;
        document.getElementById('enforceNoRootLogin').checked = s.enforceNoRootLogin !== false;
        document.getElementById('enforceFirewall').checked = s.enforceFirewall !== false;
      } else {
        alert('Failed to load settings: ' + (data.error || 'Unknown error'));
      }
    })
    .catch((err) => alert('Error fetching settings: ' + err.message));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const payload = {
      keyExpiryDays: document.getElementById('keyExpiryDays').value,
      peerDisableHours: document.getElementById('peerDisableHours').value,
      keyRenewalTime: document.getElementById('keyRenewalTime').value,
      apiKey: document.getElementById('nodeApiKey').value,
      enforceKernelCheck: document.getElementById('enforceKernelCheck').checked,
      minKernelVersion: document.getElementById('minKernelVersion').value,
      enforceNoRootLogin: document.getElementById('enforceNoRootLogin').checked,
      enforceFirewall: document.getElementById('enforceFirewall').checked
    };

    fetch('/api/settings', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          alert('Settings saved successfully!');
        } else {
          alert('Failed to save settings: ' + (data.error || 'Unknown error'));
        }
      })
      .catch((err) => alert('Error saving settings: ' + err.message))
      .finally(() => {
        btn.disabled = false;
        btn.textContent = 'Save Settings';
      });
  });
});
