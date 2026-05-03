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

  // Fetch and display
  fetch('/api/settings')
    .then(res => res.json())
    .then(data => {
      if (data.success && data.settings) {
        document.getElementById('keyExpiryDays').value = data.settings.keyExpiryDays;
        document.getElementById('peerDisableHours').value = data.settings.peerDisableHours;
        document.getElementById('keyRenewalTime').value = data.settings.keyRenewalTime;
        document.getElementById('registerApiKey').value = (data.settings.apiKeys && data.settings.apiKeys.registerKey) || '';
        document.getElementById('pushApiKey').value = (data.settings.apiKeys && data.settings.apiKeys.pushKey) || '';
        document.getElementById('pullApiKey').value = (data.settings.apiKeys && data.settings.apiKeys.pullKey) || '';
        document.getElementById('enforceKernelCheck').checked = data.settings.enforceKernelCheck !== false;
        document.getElementById('minKernelVersion').value = data.settings.minKernelVersion !== undefined ? data.settings.minKernelVersion : 4;
        document.getElementById('enforceNoRootLogin').checked = data.settings.enforceNoRootLogin !== false;
        document.getElementById('enforceFirewall').checked = data.settings.enforceFirewall !== false;
      } else {
        alert('Failed to load settings: ' + (data.error || 'Unknown error'));
      }
    })
    .catch(err => {
      alert('Error fetching settings: ' + err.message);
    });

  // Save
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Saving...';
    
    const payload = {
      keyExpiryDays: document.getElementById('keyExpiryDays').value,
      peerDisableHours: document.getElementById('peerDisableHours').value,
      keyRenewalTime: document.getElementById('keyRenewalTime').value,
      apiKeys: {
        registerKey: document.getElementById('registerApiKey').value,
        pushKey: document.getElementById('pushApiKey').value,
        pullKey: document.getElementById('pullApiKey').value
      },
      enforceKernelCheck: document.getElementById('enforceKernelCheck').checked,
      minKernelVersion: document.getElementById('minKernelVersion').value,
      enforceNoRootLogin: document.getElementById('enforceNoRootLogin').checked,
      enforceFirewall: document.getElementById('enforceFirewall').checked
    };

    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        alert('Settings saved successfully!');
      } else {
        alert('Failed to save settings: ' + (data.error || 'Unknown error'));
      }
    })
    .catch(err => {
      alert('Error saving settings: ' + err.message);
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Save Settings';
    });
  });
});
