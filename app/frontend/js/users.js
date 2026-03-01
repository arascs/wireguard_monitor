async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Cannot load users');
      return;
    }
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = '';
    (data.users || []).forEach((user) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${user.username}</td>
        <td>${user.allowed_ips || ''}</td>
        <td>${user.public_key || ''}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    alert(e.message || 'Error loading users');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadUsers();

  const form = document.getElementById('create-user-form');
  const keyModal = document.getElementById('user-key-modal');
  const keyTextarea = document.getElementById('user-private-key');
  const copyBtn = document.getElementById('copy-user-key-btn');
  const closeBtn = document.getElementById('close-user-key-btn');

  if (copyBtn && keyTextarea) {
    copyBtn.addEventListener('click', async () => {
      const value = keyTextarea.value || '';
      if (!value) {
        return;
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          keyTextarea.focus();
          keyTextarea.select();
          document.execCommand('copy');
        }
        alert('Đã copy private key vào clipboard.');
      } catch (e) {
        alert('Không copy được tự động, hãy chọn và copy thủ công.');
      }
    });
  }

  if (closeBtn && keyModal && keyTextarea) {
    closeBtn.addEventListener('click', () => {
      keyModal.style.display = 'none';
      keyTextarea.value = '';
    });
  }
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('user-username').value.trim();
      const password = document.getElementById('user-password').value;
      const allowedIPs = document.getElementById('user-allowedips').value.trim();
      if (!username || !password || !allowedIPs) {
        return;
      }

      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, allowedIPs })
      });
      const data = await res.json();
      if (data.success) {
        form.reset();
        loadUsers();
        if (data.privateKey && keyModal && keyTextarea) {
          keyTextarea.value = data.privateKey;
          keyModal.style.display = 'block';
        }
      } else {
        alert(data.error || 'Cannot create user');
      }
    });
  }
});

