/**
 * export.js – Shared export helper (CSV + PDF via print)
 * Usage: openExportModal({ title, headers, rows })
 *   headers: string[]
 *   rows: (string|number|null)[][]
 */

(function () {
  // ── Inject modal HTML once ──────────────────────────────────
  const MODAL_ID = 'export-modal';

  function ensureModal() {
    if (document.getElementById(MODAL_ID)) return;

    const style = document.createElement('style');
    style.textContent = `
      #export-modal {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.45);
        z-index: 9999;
        align-items: center;
        justify-content: center;
      }
      #export-modal.open { display: flex; }
      #export-modal-box {
        background: #fff;
        border-radius: 10px;
        padding: 28px 32px 24px;
        width: 340px;
        box-shadow: 0 8px 32px rgba(0,0,0,.18);
        position: relative;
        font-family: Roboto, sans-serif;
      }
      #export-modal-box h3 {
        margin: 0 0 18px;
        font-size: 1.1rem;
        color: rgba(134,22,24,1);
        border-bottom: 1px solid #eee;
        padding-bottom: 10px;
      }
      #export-modal-box .export-format-row {
        display: flex;
        gap: 14px;
        margin-bottom: 22px;
      }
      #export-modal-box .export-format-row label {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 0.95rem;
        cursor: pointer;
        padding: 10px 18px;
        border: 2px solid #e0e0e0;
        border-radius: 7px;
        flex: 1;
        justify-content: center;
        font-weight: 500;
        transition: border-color .2s, background .2s;
      }
      #export-modal-box .export-format-row label:has(input:checked) {
        border-color: rgba(134,22,24,.8);
        background: rgba(134,22,24,.05);
        color: rgba(134,22,24,1);
      }
      #export-modal-box .export-format-row input[type=radio] {
        accent-color: rgba(134,22,24,1);
        width: 16px; height: 16px;
      }
      #export-modal-box .export-actions {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
      }
      #export-modal-box .btn-export-confirm {
        background: rgba(134,22,24,.85);
        color: #fff;
        border: none;
        padding: 8px 22px;
        border-radius: 5px;
        font-size: .9rem;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        transition: background .2s;
      }
      #export-modal-box .btn-export-confirm:hover { background: rgba(134,22,24,1); }
      #export-modal-box .btn-export-cancel {
        background: none;
        border: 1px solid #bbb;
        color: #555;
        padding: 8px 18px;
        border-radius: 5px;
        font-size: .9rem;
        cursor: pointer;
        font-family: inherit;
        transition: background .2s;
      }
      #export-modal-box .btn-export-cancel:hover { background: #f2f2f2; }
      #export-modal-close-x {
        position: absolute;
        top: 12px; right: 16px;
        background: none; border: none;
        font-size: 1.3rem; color: #999;
        cursor: pointer; line-height: 1; padding: 0;
      }
      #export-modal-close-x:hover { color: #333; background: none; }
    `;
    document.head.appendChild(style);

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div id="export-modal-box">
        <button id="export-modal-close-x" title="Close">&times;</button>
        <h3 id="export-modal-title">Export report</h3>
        <div class="export-format-row">
          <label><input type="radio" name="export-fmt" value="csv" checked> CSV</label>
          <label><input type="radio" name="export-fmt" value="pdf"> PDF</label>
        </div>
        <div class="export-actions">
          <button class="btn-export-cancel" id="btn-export-cancel">Cancel</button>
          <button class="btn-export-confirm" id="btn-export-confirm">Download</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Close handlers
    document.getElementById('export-modal-close-x').addEventListener('click', closeExportModal);
    document.getElementById('btn-export-cancel').addEventListener('click', closeExportModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeExportModal(); });
  }

  function closeExportModal() {
    document.getElementById(MODAL_ID)?.classList.remove('open');
  }

  // ── CSV builder ─────────────────────────────────────────────
  function escapeCSV(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }

  function downloadCSV(filename, headers, rows) {
    const lines = [headers.map(escapeCSV).join(',')];
    rows.forEach(r => lines.push(r.map(escapeCSV).join(',')));
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── PDF via print iframe ─────────────────────────────────────
  function downloadPDF(title, headers, rows) {
    const ths = headers.map(h => `<th>${h}</th>`).join('');
    const trs = rows.map(r =>
      '<tr>' + r.map(c => `<td>${c === null || c === undefined ? '' : c}</td>`).join('') + '</tr>'
    ).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>${title}</title>
      <style>
        body { font-family: Arial, sans-serif; font-size: 12px; margin: 20px; }
        h2 { color: #861618; margin-bottom: 12px; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #861618; color: #fff; padding: 6px 8px; text-align: left; font-size: 11px; }
        td { padding: 5px 8px; border-bottom: 1px solid #ddd; font-size: 11px; }
        tr:nth-child(even) td { background: #f9f9f9; }
        .meta { color: #888; font-size: 11px; margin-bottom: 8px; }
      </style></head><body>
      <h2>${title}</h2>
      <p class="meta">Exported: ${new Date().toLocaleString()}</p>
      <table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>
      </body></html>`;

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;';
    document.body.appendChild(iframe);
    iframe.contentDocument.open();
    iframe.contentDocument.write(html);
    iframe.contentDocument.close();
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => document.body.removeChild(iframe), 2000);
  }

  // ── Public API ───────────────────────────────────────────────
  window.openExportModal = function ({ title = 'Report', filename = 'report', headers, rows }) {
    ensureModal();
    document.getElementById('export-modal-title').textContent = `Export: ${title}`;
    document.getElementById('export-modal').classList.add('open');

    const confirm = document.getElementById('btn-export-confirm');
    // Remove previous listener by cloning
    const newConfirm = confirm.cloneNode(true);
    confirm.parentNode.replaceChild(newConfirm, confirm);

    newConfirm.addEventListener('click', () => {
      const fmt = document.querySelector('input[name="export-fmt"]:checked')?.value || 'csv';
      closeExportModal();
      if (fmt === 'csv') {
        downloadCSV(`${filename}.csv`, headers, rows);
      } else {
        downloadPDF(title, headers, rows);
      }
    });
  };
})();
