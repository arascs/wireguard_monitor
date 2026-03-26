// ─── Load & display backups ──────────────────────────────────────────────────

async function loadBackups() {
  const tbody = document.getElementById('backups-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  try {
    const res = await fetch('/api/backups', { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Cannot load backups');
      return;
    }
    (data.backups || []).forEach((b, idx) => {
      const dateStr = new Date(b.mtime).toLocaleString();
      const sizeKb = (b.size / 1024).toFixed(1) + ' KB';
      const tr = document.createElement('tr');
      const previewBtn = b.hasSnapshot
        ? `<button data-idx="${idx}" class="btn-preview" title="Preview Snapshot">👁</button>`
        : `<button data-idx="${idx}" class="btn-preview" style="opacity:0.35;cursor:not-allowed;" title="No snapshot data in this backup" disabled>👁</button>`;
      tr.innerHTML = `
        <td>${b.name}</td>
        <td>${sizeKb}</td>
        <td>${dateStr}</td>
        <td>${b.type || ''}</td>
        <td>
          <div class="btn-actions">
            <button data-idx="${idx}" class="btn-restore">Restore</button>
            ${previewBtn}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.btn-restore').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = btn.getAttribute('data-idx');
        const entry = data.backups[idx];
        if (entry) {
          if (confirm('Restore from ' + entry.name + '? This will overwrite existing data.')) {
            restoreBackup(entry.name);
          }
        }
      });
    });

    tbody.querySelectorAll('.btn-preview:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = btn.getAttribute('data-idx');
        const entry = data.backups[idx];
        if (entry) previewSnapshot(entry.name, entry);
      });
    });
  } catch (e) {
    alert(e.message || 'Error loading backups');
  }
}

// ─── Create backup ───────────────────────────────────────────────────────────

async function createBackup(type) {
  try {
    const res = await fetch('/api/backups/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type })
    });
    const data = await res.json();
    if (data.success) {
      alert('Backup created: ' + data.filename);
      loadBackups();
    } else {
      alert(data.error || 'Failed to create backup');
    }
  } catch (e) {
    alert(e.message || 'Error creating backup');
  }
}

// ─── Restore backup ──────────────────────────────────────────────────────────

async function restoreBackup(name) {
  try {
    const res = await fetch('/api/backups/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.success) {
      alert('Restore completed');
    } else {
      alert(data.error || 'Failed to restore');
    }
  } catch (e) {
    alert(e.message || 'Error restoring backup');
  }
}

// ─── Snapshot preview ────────────────────────────────────────────────────────

function orDash(str) {
  return str ? str : '—';
}

function renderSnapshotContent(snapshot) {
  const body = document.getElementById('snapshot-body');
  body.innerHTML = '';

  // ── Interfaces section ──
  if (snapshot.interfaces && snapshot.interfaces.length > 0) {
    const secTitle = document.createElement('div');
    secTitle.className = 'sn-section-title';
    secTitle.textContent = 'WireGuard Interfaces';
    body.appendChild(secTitle);

    snapshot.interfaces.forEach(iface => {
      const label = document.createElement('div');
      label.className = 'sn-item-label';

      const typeBadge = iface.type
        ? `<span class="badge badge-${(iface.type || '').toLowerCase()}">${iface.type}</span>`
        : '';
      const statusBadge = `<span class="badge badge-${iface.status || 'disconnected'}">${iface.status || 'unknown'}</span>`;
      const addr = iface.address ? ` — ${iface.address}` : '';
      const port = iface.listenPort ? ` : ${iface.listenPort}` : '';

      label.innerHTML = `<strong>${iface.name}</strong>${addr}${port} ${statusBadge} ${typeBadge}`;
      body.appendChild(label);

      const card = document.createElement('div');
      card.className = 'sn-card';

      if (!iface.peers || iface.peers.length === 0) {
        card.innerHTML = '<div style="padding:12px 14px;color:#bbb;font-size:0.82rem;">No peers</div>';
      } else {
        iface.peers.forEach(peer => {
          const row = document.createElement('div');
          row.className = 'peer-row' + (peer.enabled === false ? ' peer-disabled' : '');
          const peerName = peer.name || '(unnamed)';
          const status = peer.enabled === false
            ? '<span style="color:#c00;font-size:0.75rem;margin-left:6px;">disabled</span>'
            : '<span style="color:#22a06b;font-size:0.75rem;margin-left:6px;">enabled</span>';
          row.innerHTML = `
            <div class="peer-name">${peerName}${status}</div>
            <div class="peer-detail">
              AllowedIPs: <strong>${peer.allowedIPs || '—'}</strong>
              ${peer.endpoint ? `&nbsp;|&nbsp; Endpoint: <strong>${peer.endpoint}</strong>` : ''}
              ${peer.persistentKeepalive ? `&nbsp;|&nbsp; Keepalive: <strong>${peer.persistentKeepalive}s</strong>` : ''}
            </div>
            <div class="peer-key">PubKey: ${orDash(peer.publicKey)}</div>
          `;
          card.appendChild(row);
        });
      }
      body.appendChild(card);
    });
  }

  // ── Database section ──
  if (snapshot.database && snapshot.database.tables && snapshot.database.tables.length > 0) {
    const secTitle = document.createElement('div');
    secTitle.className = 'sn-section-title';
    secTitle.textContent = 'Database';
    body.appendChild(secTitle);

    snapshot.database.tables.forEach(tbl => {
      const label = document.createElement('div');
      label.className = 'sn-item-label';
      label.innerHTML = `<strong>${tbl.name}</strong> <span style="color:#888;font-size:0.78rem;font-weight:400;">(${(tbl.rows || []).length} rows)</span>`;
      body.appendChild(label);

      const card = document.createElement('div');
      card.className = 'sn-card';

      if (tbl.error) {
        card.innerHTML = `<div style="padding:10px 14px;color:#c00;font-size:0.82rem;">Error: ${tbl.error}</div>`;
      } else if (!tbl.rows || tbl.rows.length === 0) {
        card.innerHTML = '<div style="padding:12px 14px;color:#bbb;font-size:0.82rem;">Empty table</div>';
      } else {
        const cols = Object.keys(tbl.rows[0]);
        const wrap = document.createElement('div');
        wrap.className = 'db-table-wrap';
        const table = document.createElement('table');
        table.className = 'db-table';

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        cols.forEach(col => {
          const th = document.createElement('th');
          th.textContent = col;
          headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        tbl.rows.forEach(r => {
          const tr = document.createElement('tr');
          cols.forEach(col => {
            const td = document.createElement('td');
            const val = r[col];
            const cellStr = val !== null && val !== undefined ? String(val) : 'NULL';
            td.textContent = cellStr;
            td.style.whiteSpace = 'normal';
            td.style.wordBreak = 'break-all';
            td.style.maxWidth = '320px';
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        card.appendChild(wrap);
      }
      body.appendChild(card);
    });
  }

  // If nothing was rendered
  if (body.children.length === 0) {
    body.innerHTML = '<div class="sn-empty-msg">No snapshot data available.</div>';
  }
}

async function previewSnapshot(name, entry) {
  const modal = document.getElementById('snapshot-modal');
  const body = document.getElementById('snapshot-body');
  const metaEl = document.getElementById('snapshot-meta-info');

  // Show modal with loading state
  body.innerHTML = '<div class="sn-loading">Loading snapshot…</div>';
  metaEl.textContent = name;
  modal.classList.add('open');

  try {
    const res = await fetch(`/api/backups/snapshot/${encodeURIComponent(name)}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.success) {
      body.innerHTML = `<div class="sn-empty-msg" style="color:#c00;">${data.error || 'Failed to load snapshot.'}</div>`;
      return;
    }
    const snap = data.snapshot;
    const createdAt = snap.createdAt ? new Date(snap.createdAt).toLocaleString() : '';
    metaEl.textContent = `${name}${createdAt ? '  ·  Created: ' + createdAt : ''}`;
    renderSnapshotContent(snap);
  } catch (e) {
    body.innerHTML = `<div class="sn-empty-msg" style="color:#c00;">Error: ${e.message}</div>`;
  }
}

// ─── Modal close logic ───────────────────────────────────────────────────────

function closeSnapshotModal() {
  const modal = document.getElementById('snapshot-modal');
  modal.classList.remove('open');
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadBackups();
  const btnDb = document.getElementById('btn-create-db');
  const btnWg = document.getElementById('btn-create-wg');
  const btnFull = document.getElementById('btn-create-full');
  if (btnDb) btnDb.addEventListener('click', () => createBackup('db'));
  if (btnWg) btnWg.addEventListener('click', () => createBackup('wg_config'));
  if (btnFull) btnFull.addEventListener('click', () => createBackup('full'));

  // Close snapshot modal
  const closeBtn = document.getElementById('snapshot-close-btn');
  const snModal = document.getElementById('snapshot-modal');
  if (closeBtn) closeBtn.addEventListener('click', closeSnapshotModal);
  if (snModal) {
    snModal.addEventListener('click', (e) => {
      if (e.target === snModal) closeSnapshotModal();
    });
  }
});