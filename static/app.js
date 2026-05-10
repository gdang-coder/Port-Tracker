const fmt = (n, digits = 2) =>
  n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const fmtPct = (n) =>
  n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

const gainClass = (n) => n == null ? '' : n >= 0 ? 'gain-pos' : 'gain-neg';

const PALETTE = [
  '#6366f1','#22c55e','#f59e0b','#ef4444','#06b6d4','#a855f7',
  '#ec4899','#14b8a6','#f97316','#84cc16','#3b82f6','#e11d48',
];

let allocationChart = null;
let brokerChart = null;
let timelineChart = null;
let _viewMode = 'detailed';   // 'detailed' | 'combined'
let _lastHoldings = [];

// ── Portfolio ──────────────────────────────────────────────────────────────

async function loadPortfolio() {
  const res = await fetch('/api/portfolio');
  const data = await res.json();
  renderSummary(data.summary);
  renderTable(data.holdings);
  renderCharts(data.holdings);
}

function renderSummary(s) {
  document.getElementById('totalValue').textContent = fmt(s.total_value);
  document.getElementById('totalCost').textContent = fmt(s.total_cost);

  const gainEl = document.getElementById('totalGain');
  gainEl.textContent = fmt(s.total_gain);
  gainEl.className = 'value ' + gainClass(s.total_gain);

  const pctEl = document.getElementById('totalGainPct');
  pctEl.textContent = fmtPct(s.total_gain_pct);
  pctEl.className = 'value ' + gainClass(s.total_gain_pct);
}

function renderTable(holdings) {
  _lastHoldings = holdings;
  if (_viewMode === 'combined') return renderCombined(holdings);
  return renderDetailed(holdings);
}

function renderDetailed(holdings) {
  const head = document.getElementById('holdingsHead');
  const tbody = document.getElementById('holdingsBody');

  head.innerHTML = `
    <tr>
      <th>Symbol</th>
      <th>Broker</th>
      <th>Account</th>
      <th class="num">Shares</th>
      <th class="num">Avg Cost</th>
      <th class="num">Current Price</th>
      <th class="num">Market Value</th>
      <th class="num">Gain / Loss</th>
      <th class="num">Return</th>
      <th></th>
    </tr>`;

  if (!holdings.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">No holdings yet. Import a CSV or add one manually.</td></tr>';
    return;
  }
  tbody.innerHTML = holdings.map(h => `
    <tr>
      <td class="symbol">${h.symbol}</td>
      <td><span class="broker-badge">${escHtml(h.broker)}</span></td>
      <td>${h.account ? escHtml(h.account) : '<span class="muted-val">—</span>'}</td>
      <td class="num">${h.shares.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
      <td class="num">${fmt(h.cost_per_share)}</td>
      <td class="num ${h.current_price == null ? 'muted-val' : ''}">${fmt(h.current_price)}</td>
      <td class="num">${fmt(h.market_value)}</td>
      <td class="num ${gainClass(h.gain)}">${fmt(h.gain)}</td>
      <td class="num ${gainClass(h.gain_pct)}">${fmtPct(h.gain_pct)}</td>
      <td><button class="del-btn" data-id="${h.id}" title="Remove">✕</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this holding?')) return;
      await fetch(`/api/holding/${btn.dataset.id}`, { method: 'DELETE' });
      loadPortfolio();
    });
  });
}

function aggregateBySymbol(holdings) {
  const map = {};
  for (const h of holdings) {
    const k = h.symbol;
    if (!map[k]) {
      map[k] = {
        symbol: h.symbol, shares: 0, cost_total: 0,
        market_value: 0, has_value: false,
        current_price: h.current_price, locations: [],
      };
    }
    const a = map[k];
    a.shares += h.shares;
    a.cost_total += h.cost_basis;
    if (h.market_value != null) { a.market_value += h.market_value; a.has_value = true; }
    a.current_price = h.current_price;  // same per symbol
    const loc = h.account ? `${h.broker} · ${h.account}` : h.broker;
    a.locations.push({ loc, shares: h.shares });
  }
  return Object.values(map).map(a => {
    const cost_per_share = a.shares > 0 ? a.cost_total / a.shares : 0;
    const market_value = a.has_value ? a.market_value : null;
    const gain = market_value != null ? market_value - a.cost_total : null;
    const gain_pct = gain != null && a.cost_total > 0 ? gain / a.cost_total * 100 : null;
    return { ...a, cost_per_share, market_value, gain, gain_pct };
  }).sort((x, y) => x.symbol.localeCompare(y.symbol));
}

function renderCombined(holdings) {
  const head = document.getElementById('holdingsHead');
  const tbody = document.getElementById('holdingsBody');

  head.innerHTML = `
    <tr>
      <th>Symbol</th>
      <th>Held In</th>
      <th class="num">Total Shares</th>
      <th class="num">Avg Cost</th>
      <th class="num">Current Price</th>
      <th class="num">Market Value</th>
      <th class="num">Gain / Loss</th>
      <th class="num">Return</th>
    </tr>`;

  if (!holdings.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No holdings yet. Import a CSV or add one manually.</td></tr>';
    return;
  }

  const rows = aggregateBySymbol(holdings);
  tbody.innerHTML = rows.map(r => {
    const locText = r.locations.map(l =>
      `${escHtml(l.loc)} (${l.shares.toLocaleString('en-US', { maximumFractionDigits: 4 })})`
    ).join(', ');
    return `
      <tr>
        <td class="symbol">${r.symbol}</td>
        <td style="font-size:12px;color:var(--muted);white-space:normal">${locText}</td>
        <td class="num">${r.shares.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
        <td class="num">${fmt(r.cost_per_share)}</td>
        <td class="num ${r.current_price == null ? 'muted-val' : ''}">${fmt(r.current_price)}</td>
        <td class="num">${fmt(r.market_value)}</td>
        <td class="num ${gainClass(r.gain)}">${fmt(r.gain)}</td>
        <td class="num ${gainClass(r.gain_pct)}">${fmtPct(r.gain_pct)}</td>
      </tr>`;
  }).join('');
}

function renderCharts(holdings) {
  const section = document.getElementById('chartsSection');
  if (!holdings.length) { section.style.display = 'none'; return; }
  section.style.display = 'grid';

  const bySymbol = {};
  for (const h of holdings) {
    const val = h.market_value ?? h.cost_basis;
    bySymbol[h.symbol] = (bySymbol[h.symbol] || 0) + val;
  }
  const symLabels = Object.keys(bySymbol);
  const symValues = symLabels.map(s => bySymbol[s]);

  if (allocationChart) allocationChart.destroy();
  allocationChart = new Chart(document.getElementById('allocationChart'), {
    type: 'doughnut',
    data: {
      labels: symLabels,
      datasets: [{ data: symValues, backgroundColor: PALETTE.slice(0, symLabels.length), borderWidth: 2, borderColor: '#1a1d27' }],
    },
    options: {
      plugins: {
        legend: { position: 'right', labels: { color: '#e2e8f0', boxWidth: 12, padding: 14, font: { size: 12 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmt(ctx.parsed)}` } },
      },
    },
  });

  const byBroker = {};
  for (const h of holdings) {
    const val = h.market_value ?? h.cost_basis;
    byBroker[h.broker] = (byBroker[h.broker] || 0) + val;
  }
  const brkLabels = Object.keys(byBroker);
  const brkValues = brkLabels.map(b => byBroker[b]);

  if (brokerChart) brokerChart.destroy();
  brokerChart = new Chart(document.getElementById('brokerChart'), {
    type: 'bar',
    data: {
      labels: brkLabels,
      datasets: [{ label: 'Value', data: brkValues, backgroundColor: PALETTE.slice(0, brkLabels.length), borderRadius: 6 }],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${fmt(ctx.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: '#8892a4' }, grid: { color: '#2a2d3a' } },
        y: { ticks: { color: '#8892a4', callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(0)+'k' : v) }, grid: { color: '#2a2d3a' } },
      },
    },
  });
}

// ── Import: visual column picker ───────────────────────────────────────────

let _importColumns = [];
let _importRows = [];
let _importBroker = '';
let _colRoles = {};  // col name -> 'symbol'|'shares'|'cost'|null

const ROLE_CYCLE = [null, 'symbol', 'shares', 'cost'];
const ROLE_LABEL = { symbol: 'Symbol', shares: 'Shares', cost: 'Cost' };

function renderColumnPicker() {
  const container = document.getElementById('columnPicker');

  const headerCells = _importColumns.map(col => {
    const role = _colRoles[col] || '';
    const opts = [
      `<option value="">— ignore —</option>`,
      `<option value="symbol"${role==='symbol'?' selected':''}>Symbol</option>`,
      `<option value="shares"${role==='shares'?' selected':''}>Shares</option>`,
      `<option value="cost"${role==='cost'?' selected':''}>Cost</option>`,
    ].join('');
    return `<th class="${role ? 'th-' + role : ''}">
      <div class="col-head">
        <div class="col-name" title="${escHtml(col)}">${escHtml(col)}</div>
        <select class="col-role-select role-${role || 'none'}" data-col="${escHtml(col)}">${opts}</select>
      </div>
    </th>`;
  }).join('');

  const dataRows = _importRows.map(row =>
    `<tr>${_importColumns.map((col, i) => {
      const role = _colRoles[col] || null;
      return `<td class="${role ? 'col-' + role : ''}">${escHtml(String(row[i] ?? ''))}</td>`;
    }).join('')}</tr>`
  ).join('');

  const emptyRow = `<tr><td colspan="${_importColumns.length}" class="empty" style="padding:20px">No preview rows</td></tr>`;

  container.innerHTML = `
    <table class="col-picker-table">
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${dataRows || emptyRow}</tbody>
    </table>
  `;

  container.querySelectorAll('.col-role-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const col = sel.dataset.col;
      const next = sel.value || null;

      // If assigning a role, unassign any other column that had it
      if (next) {
        for (const c of Object.keys(_colRoles)) {
          if (_colRoles[c] === next && c !== col) _colRoles[c] = null;
        }
      }
      _colRoles[col] = next;
      renderColumnPicker();
      updateImportBtn();
    });
  });
}

function updateImportBtn() {
  const roles = Object.values(_colRoles);
  const allSet = ['symbol', 'shares', 'cost'].every(r => roles.includes(r));
  document.getElementById('confirmImportBtn').disabled = !allSet;
  document.getElementById('costIsTotalRow').style.display = roles.includes('cost') ? 'flex' : 'none';
}

let _importAccount = '';

document.getElementById('previewBtn').addEventListener('click', async () => {
  const broker = document.getElementById('brokerName').value.trim();
  const account = document.getElementById('accountName').value.trim();
  const file = document.getElementById('csvFile').files[0];
  const status = document.getElementById('previewStatus');

  if (!broker) { setStatus(status, 'Enter a broker name first', 'err'); return; }
  if (!file)   { setStatus(status, 'Select a CSV file first', 'err'); return; }
  _importAccount = account;

  setStatus(status, 'Reading file…', '');

  const fd = new FormData();
  fd.append('broker', broker);
  fd.append('file', file);

  const res = await fetch('/api/upload/preview', { method: 'POST', body: fd });
  const json = await res.json();

  if (!res.ok) {
    setStatus(status, json.error, 'err');
    return;
  }

  setStatus(status, '', '');
  _importColumns = json.columns;
  _importRows = json.rows || [];
  _importBroker = broker;

  // Init all roles to null, then apply auto-detect / profile mapping
  _colRoles = {};
  for (const col of _importColumns) _colRoles[col] = null;
  const m = json.mapping;
  if (m.symbol && _importColumns.includes(m.symbol)) _colRoles[m.symbol] = 'symbol';
  if (m.shares && _importColumns.includes(m.shares)) _colRoles[m.shares] = 'shares';
  if (m.cost   && _importColumns.includes(m.cost))   _colRoles[m.cost]   = 'cost';
  document.getElementById('costIsTotal').checked = !!m.cost_is_total;

  document.getElementById('saveProfile').checked = !json.has_profile;
  document.getElementById('saveProfileBroker').textContent = `"${broker}"`;

  // Profile banner
  const banner = document.getElementById('profileBanner');
  if (json.source === 'profile') {
    banner.textContent = `✓ Using saved profile for ${broker} — columns pre-assigned. Adjust if the export format changed.`;
    banner.style.display = 'block';
    banner.className = 'profile-banner profile-banner-ok';
  } else if (json.source === 'auto') {
    banner.textContent = 'Columns auto-detected — review the assignment below before importing.';
    banner.style.display = 'block';
    banner.className = 'profile-banner profile-banner-info';
  } else {
    banner.style.display = 'none';
  }

  const colCount = json.columns.length;
  document.getElementById('mappingTitle').textContent =
    `${file.name} — ${colCount} column${colCount !== 1 ? 's' : ''} found`;

  renderColumnPicker();
  updateImportBtn();

  document.getElementById('importStep1').style.display = 'none';
  document.getElementById('importStep2').style.display = 'block';
});

document.getElementById('backBtn').addEventListener('click', () => {
  document.getElementById('importStep2').style.display = 'none';
  document.getElementById('importStep1').style.display = 'block';
  document.getElementById('previewStatus').textContent = '';
});

document.getElementById('confirmImportBtn').addEventListener('click', async () => {
  const status = document.getElementById('confirmStatus');
  const file = document.getElementById('csvFile').files[0];

  const mapping = {
    symbol: Object.entries(_colRoles).find(([, r]) => r === 'symbol')?.[0] || null,
    shares: Object.entries(_colRoles).find(([, r]) => r === 'shares')?.[0] || null,
    cost:   Object.entries(_colRoles).find(([, r]) => r === 'cost')?.[0]   || null,
    cost_is_total: document.getElementById('costIsTotal').checked,
  };

  if (!mapping.symbol || !mapping.shares || !mapping.cost) {
    setStatus(status, 'Assign all three columns first', 'err');
    return;
  }

  const fd = new FormData();
  fd.append('broker', _importBroker);
  fd.append('account', _importAccount);
  fd.append('file', file);
  fd.append('mapping', JSON.stringify(mapping));
  fd.append('save_profile', document.getElementById('saveProfile').checked ? 'true' : 'false');

  setStatus(status, 'Importing…', '');
  let res, json;
  try {
    res = await fetch('/api/upload/confirm', { method: 'POST', body: fd });
    const text = await res.text();
    try { json = JSON.parse(text); }
    catch { throw new Error('Server returned: ' + text.slice(0, 200)); }
  } catch (err) {
    setStatus(status, 'Import failed: ' + err.message, 'err');
    return;
  }

  if (!res.ok) {
    setStatus(status, json.error || 'Import failed', 'err');
    return;
  }

  setStatus(status, `Imported ${json.imported} holdings for ${json.broker}`, 'ok');
  document.getElementById('importStep2').style.display = 'none';
  document.getElementById('importStep1').style.display = 'block';
  document.getElementById('brokerName').value = '';
  document.getElementById('accountName').value = '';
  document.getElementById('csvFile').value = '';

  loadPortfolio();
  setTimeout(loadSnapshots, 1500);
  loadProfiles();
});

// ── Broker profiles ────────────────────────────────────────────────────────

async function loadProfiles() {
  const res = await fetch('/api/broker-profiles');
  const profiles = await res.json();
  const wrap = document.getElementById('profilesWrap');
  const list = document.getElementById('profilesList');

  if (!profiles.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  list.innerHTML = profiles.map(p => `
    <div class="profile-row">
      <span class="profile-broker">${escHtml(p.broker)}</span>
      <span class="profile-cols">
        Symbol: <code>${escHtml(p.symbol_col)}</code> &nbsp;
        Shares: <code>${escHtml(p.shares_col)}</code> &nbsp;
        Cost: <code>${escHtml(p.cost_col)}</code>${p.cost_is_total ? ' <em>(total)</em>' : ''}
      </span>
      <button class="del-btn" data-broker="${escHtml(p.broker)}" title="Delete profile">✕</button>
    </div>
  `).join('');

  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete the "${btn.dataset.broker}" profile?`)) return;
      await fetch(`/api/broker-profiles/${encodeURIComponent(btn.dataset.broker)}`, { method: 'DELETE' });
      loadProfiles();
    });
  });
}

// ── History / Snapshots ────────────────────────────────────────────────────

async function loadSnapshots() {
  const res = await fetch('/api/snapshots');
  const snapshots = await res.json();
  renderTimeline(snapshots);
  renderSnapshotList(snapshots);
}

function renderTimeline(snapshots) {
  const wrap = document.getElementById('timelineWrap');
  const withValue = snapshots.filter(s => s.total_value != null).reverse();
  if (withValue.length < 2) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  const labels = withValue.map(s => fmtDateShort(s.taken_at));
  const costData = withValue.map(s => s.total_cost);
  const valueData = withValue.map(s => s.total_value);

  if (timelineChart) timelineChart.destroy();
  timelineChart = new Chart(document.getElementById('timelineChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Market Value',
          data: valueData,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99,102,241,0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointHoverRadius: 6,
        },
        {
          label: 'Cost Basis',
          data: costData,
          borderColor: '#8892a4',
          borderDash: [5, 4],
          backgroundColor: 'transparent',
          tension: 0.3,
          pointRadius: 3,
        },
      ],
    },
    options: {
      plugins: {
        legend: { labels: { color: '#e2e8f0', boxWidth: 12, font: { size: 12 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: '#8892a4', maxRotation: 30 }, grid: { color: '#2a2d3a' } },
        y: { ticks: { color: '#8892a4', callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(0)+'k' : v) }, grid: { color: '#2a2d3a' } },
      },
    },
  });
}

function renderSnapshotList(snapshots) {
  const list = document.getElementById('snapshotList');
  const empty = document.getElementById('snapshotEmpty');

  if (!snapshots.length) {
    empty.style.display = 'block';
    list.querySelectorAll('.snapshot-item').forEach(el => el.remove());
    return;
  }
  empty.style.display = 'none';
  list.querySelectorAll('.snapshot-item').forEach(el => el.remove());

  for (const snap of snapshots) {
    const item = document.createElement('div');
    item.className = 'snapshot-item';
    item.dataset.id = snap.id;

    const gain = snap.total_value != null ? snap.total_value - snap.total_cost : null;
    const gainPct = gain != null && snap.total_cost ? gain / snap.total_cost * 100 : null;

    item.innerHTML = `
      <div class="snap-row" data-id="${snap.id}">
        <div class="snap-meta">
          <span class="snap-label">${escHtml(snap.label)}</span>
          <span class="snap-date">${fmtDate(snap.taken_at)}</span>
        </div>
        <div class="snap-stats">
          <span class="snap-stat"><span class="snap-stat-label">Holdings</span> ${snap.num_holdings}</span>
          <span class="snap-stat"><span class="snap-stat-label">Cost</span> ${fmt(snap.total_cost)}</span>
          <span class="snap-stat"><span class="snap-stat-label">Value</span> ${fmt(snap.total_value)}</span>
          <span class="snap-stat ${gainClass(gain)}"><span class="snap-stat-label">Gain</span> ${gain != null ? fmt(gain) + ' (' + fmtPct(gainPct) + ')' : '—'}</span>
        </div>
        <div class="snap-actions">
          <button class="snap-expand btn-ghost" data-id="${snap.id}">View ▾</button>
          <button class="snap-del del-btn" data-id="${snap.id}" title="Delete snapshot">✕</button>
        </div>
      </div>
      <div class="snap-detail" id="snapDetail${snap.id}" style="display:none"></div>
    `;

    list.appendChild(item);
    item.querySelector('.snap-expand').addEventListener('click', () => toggleSnapshotDetail(snap.id));
    item.querySelector('.snap-del').addEventListener('click', async () => {
      if (!confirm('Delete this snapshot?')) return;
      await fetch(`/api/snapshots/${snap.id}`, { method: 'DELETE' });
      loadSnapshots();
    });
  }
}

async function toggleSnapshotDetail(id) {
  const detail = document.getElementById(`snapDetail${id}`);
  const btn = document.querySelector(`.snap-expand[data-id="${id}"]`);

  if (detail.style.display !== 'none') {
    detail.style.display = 'none';
    btn.textContent = 'View ▾';
    return;
  }

  btn.textContent = 'Loading…';
  const res = await fetch(`/api/snapshots/${id}`);
  const snap = await res.json();
  detail.innerHTML = buildSnapshotTable(snap.holdings);
  detail.style.display = 'block';
  btn.textContent = 'Hide ▴';
}

function buildSnapshotTable(holdings) {
  if (!holdings.length) return '<p class="empty" style="padding:16px">No holdings in this snapshot.</p>';
  return `
    <div style="overflow-x:auto">
      <table class="snap-table">
        <thead>
          <tr>
            <th>Symbol</th><th>Broker</th><th>Account</th>
            <th class="num">Shares</th><th class="num">Avg Cost</th>
            <th class="num">Price at Snapshot</th><th class="num">Value</th>
            <th class="num">Gain / Loss</th><th class="num">Return</th>
          </tr>
        </thead>
        <tbody>
          ${holdings.map(h => `
            <tr>
              <td class="symbol">${h.symbol}</td>
              <td><span class="broker-badge">${escHtml(h.broker)}</span></td>
              <td>${h.account ? escHtml(h.account) : '<span class="muted-val">—</span>'}</td>
              <td class="num">${h.shares.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
              <td class="num">${fmt(h.cost_per_share)}</td>
              <td class="num ${h.current_price == null ? 'muted-val' : ''}">${fmt(h.current_price)}</td>
              <td class="num">${fmt(h.market_value)}</td>
              <td class="num ${gainClass(h.gain)}">${fmt(h.gain)}</td>
              <td class="num ${gainClass(h.gain_pct)}">${fmtPct(h.gain_pct)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function fmtDate(iso) {
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDateShort(iso) {
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function setStatus(el, msg, type) {
  el.textContent = msg;
  el.className = 'status-msg ' + (type || '');
  if (type === 'ok') setTimeout(() => { el.textContent = ''; el.className = 'status-msg'; }, 3000);
}

// ── Other event wiring ─────────────────────────────────────────────────────

document.getElementById('saveSnapshotBtn').addEventListener('click', async () => {
  const label = prompt('Snapshot label (optional):', 'Manual snapshot');
  if (label === null) return;
  const res = await fetch('/api/snapshots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: label.trim() || 'Manual snapshot' }),
  });
  const json = await res.json();
  if (!res.ok) { alert(json.error); return; }
  loadSnapshots();
});

document.getElementById('addHoldingBtn').addEventListener('click', () => {
  document.getElementById('modal').style.display = 'flex';
});
document.getElementById('cancelModal').addEventListener('click', () => {
  document.getElementById('modal').style.display = 'none';
});
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});

document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('modalStatus');
  const body = {
    symbol: document.getElementById('mSymbol').value,
    broker: document.getElementById('mBroker').value,
    account: document.getElementById('mAccount').value,
    shares: parseFloat(document.getElementById('mShares').value),
    cost_per_share: parseFloat(document.getElementById('mCost').value),
  };
  setStatus(status, 'Saving…', '');
  const res = await fetch('/api/holding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    setStatus(status, json.error, 'err');
  } else {
    document.getElementById('modal').style.display = 'none';
    e.target.reset();
    loadPortfolio();
  }
});

document.getElementById('refreshBtn').addEventListener('click', loadPortfolio);

document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _viewMode = btn.dataset.view;
    document.querySelectorAll('.toggle-btn').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
    renderTable(_lastHoldings);
  });
});

// Initial load
loadPortfolio();
loadSnapshots();
loadProfiles();
