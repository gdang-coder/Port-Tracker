const fmt = (n, digits = 2) =>
  n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const fmtPct = (n) =>
  n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

const gainClass = (n) => n == null ? '' : n >= 0 ? 'gain-pos' : 'gain-neg';

const fmtYield = (n) => n == null ? '—' : (n * 100).toFixed(2) + '%';

const PALETTE = [
  '#6366f1','#22c55e','#f59e0b','#ef4444','#06b6d4','#a855f7',
  '#ec4899','#14b8a6','#f97316','#84cc16','#3b82f6','#e11d48',
];

let allocationChart = null;
let brokerChart = null;
let timelineChart = null;
let _viewMode = 'detailed';   // 'detailed' | 'combined'
let _lastHoldings = [];
let _sort = { key: 'symbol', dir: 'asc' };

function sortRows(rows, key, dir) {
  const mul = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;   // nulls always last
    if (vb == null) return -1;
    if (typeof va === 'string' && typeof vb === 'string') return mul * va.localeCompare(vb);
    return mul * (va - vb);
  });
}

function sortArrow(key) {
  if (_sort.key !== key) return '<span class="sort-arrow">↕</span>';
  return _sort.dir === 'asc'
    ? '<span class="sort-arrow active">▲</span>'
    : '<span class="sort-arrow active">▼</span>';
}

function applySort(key) {
  if (_sort.key === key) _sort.dir = _sort.dir === 'asc' ? 'desc' : 'asc';
  else { _sort.key = key; _sort.dir = 'asc'; }
  renderTable(_lastHoldings);
  if (document.getElementById('tabPortfolio').classList.contains('active')) {
    renderCharts(_lastHoldings);
  }
}

document.getElementById('holdingsHead').addEventListener('click', e => {
  const th = e.target.closest('th[data-sort]');
  if (th) applySort(th.dataset.sort);
});

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
      <th data-sort="symbol">Symbol ${sortArrow('symbol')}</th>
      <th data-sort="broker">Broker ${sortArrow('broker')}</th>
      <th data-sort="account">Account ${sortArrow('account')}</th>
      <th class="num" data-sort="shares">Shares ${sortArrow('shares')}</th>
      <th class="num" data-sort="cost_per_share">Avg Cost ${sortArrow('cost_per_share')}</th>
      <th class="num" data-sort="current_price">Current Price ${sortArrow('current_price')}</th>
      <th class="num" data-sort="market_value">Market Value ${sortArrow('market_value')}</th>
      <th class="num" data-sort="gain">Gain / Loss ${sortArrow('gain')}</th>
      <th class="num" data-sort="gain_pct">Return ${sortArrow('gain_pct')}</th>
      <th class="num" data-sort="dividend_yield">Div Yield ${sortArrow('dividend_yield')}</th>
      <th class="num" data-sort="created_at">Updated ${sortArrow('created_at')}</th>
      <th></th>
    </tr>`;

  if (!holdings.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">No holdings yet. Import a CSV or add one manually.</td></tr>';
    return;
  }
  const sorted = sortRows(holdings, _sort.key, _sort.dir);
  tbody.innerHTML = sorted.map(h => `
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
      <td class="num muted-val">${fmtYield(h.dividend_yield)}</td>
      <td class="num muted-val" style="font-size:12px">${fmtDateShort(h.created_at)}</td>
      <td style="white-space:nowrap">
        <button class="edit-btn" data-id="${h.id}"
                data-symbol="${escHtml(h.symbol)}"
                data-shares="${h.shares}"
                data-cost="${h.cost_per_share}"
                data-context="${escHtml(h.broker + (h.account ? ' · ' + h.account : ''))}"
                title="Edit">✎</button>
        <button class="del-btn" data-id="${h.id}" title="Remove">✕</button>
      </td>
    </tr>
  `).join('');
}

// Edit & delete wired via event delegation on the tbody (survives re-renders)
document.getElementById('holdingsBody').addEventListener('click', async e => {
  const del = e.target.closest('.del-btn[data-id]');
  if (del && !del.classList.contains('del-acct-btn')) {
    if (!confirm('Remove this holding?')) return;
    await fetch(`/api/holding/${del.dataset.id}`, { method: 'DELETE' });
    loadPortfolio();
    loadSources();
  }
  const edit = e.target.closest('.edit-btn');
  if (edit) {
    _editId = edit.dataset.id;
    document.getElementById('eSymbol').value  = edit.dataset.symbol;
    document.getElementById('eShares').value  = edit.dataset.shares;
    document.getElementById('eCost').value    = edit.dataset.cost;
    document.getElementById('editModalContext').textContent = edit.dataset.context;
    document.getElementById('editStatus').textContent = '';
    document.getElementById('editModal').style.display = 'flex';
  }
});

let _editId = null;

function aggregateBySymbol(holdings) {
  const map = {};
  for (const h of holdings) {
    const k = h.symbol;
    if (!map[k]) {
      map[k] = {
        symbol: h.symbol, shares: 0, cost_total: 0,
        market_value: 0, has_value: false,
        current_price: h.current_price,
        dividend_yield: h.dividend_yield,
        locations: [],
        last_updated: '',
      };
    }
    const a = map[k];
    a.shares += h.shares;
    a.cost_total += h.cost_basis;
    if (h.market_value != null) { a.market_value += h.market_value; a.has_value = true; }
    a.current_price = h.current_price;
    a.dividend_yield = h.dividend_yield;
    if (h.created_at && h.created_at > a.last_updated) a.last_updated = h.created_at;
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
      <th data-sort="symbol">Symbol ${sortArrow('symbol')}</th>
      <th>Held In</th>
      <th class="num" data-sort="shares">Total Shares ${sortArrow('shares')}</th>
      <th class="num" data-sort="cost_per_share">Avg Cost ${sortArrow('cost_per_share')}</th>
      <th class="num" data-sort="current_price">Current Price ${sortArrow('current_price')}</th>
      <th class="num" data-sort="market_value">Market Value ${sortArrow('market_value')}</th>
      <th class="num" data-sort="gain">Gain / Loss ${sortArrow('gain')}</th>
      <th class="num" data-sort="gain_pct">Return ${sortArrow('gain_pct')}</th>
      <th class="num" data-sort="dividend_yield">Div Yield ${sortArrow('dividend_yield')}</th>
      <th class="num" data-sort="last_updated">Updated ${sortArrow('last_updated')}</th>
    </tr>`;

  if (!holdings.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">No holdings yet. Import a CSV or add one manually.</td></tr>';
    return;
  }

  const rows = sortRows(aggregateBySymbol(holdings), _sort.key, _sort.dir);
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
        <td class="num muted-val">${fmtYield(r.dividend_yield)}</td>
        <td class="num muted-val" style="font-size:12px">${fmtDateShort(r.last_updated)}</td>
      </tr>`;
  }).join('');
}

function renderCharts(holdings) {
  const section = document.getElementById('chartsSection');
  if (!holdings.length) { section.style.display = 'none'; return; }
  section.style.display = 'grid';

  // Aggregate per-symbol using the same combined-view logic so sort keys exist
  const aggRows = aggregateBySymbol(holdings);
  // Sort to match the current table sort; fall back to market_value desc if key
  // doesn't apply (e.g. broker/account don't exist in aggregated rows)
  const CHART_SORT_KEYS = new Set([
    'symbol','shares','cost_per_share','current_price',
    'market_value','gain','gain_pct','dividend_yield',
  ]);
  const chartSortKey = CHART_SORT_KEYS.has(_sort.key) ? _sort.key : 'market_value';
  const sorted = sortRows(aggRows, chartSortKey, _sort.dir);

  const symLabels = sorted.map(r => r.symbol);
  const symValues = sorted.map(r => r.market_value ?? r.cost_total);
  const totalVal = symValues.reduce((a, b) => a + b, 0);

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
        tooltip: {
          callbacks: {
            label: ctx => {
              const pct = totalVal > 0 ? (ctx.parsed / totalVal * 100).toFixed(1) : '0.0';
              return ` ${ctx.label}: ${fmt(ctx.parsed)} (${pct}%)`;
            },
          },
        },
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
let _importAccount = '';
let _importFile = null;      // File or Blob sent to preview & confirm
let _importFileName = '';    // display name for the mapping title
let _importMode = 'file';    // 'file' | 'paste'
let _colRoles = {};          // col name -> 'symbol'|'shares'|'cost'|'account'|null

// ── Paste helper ───────────────────────────────────────────────────────────

function pasteToCSVBlob(text) {
  if (!text.includes('\t')) return new Blob([text], { type: 'text/csv' });
  const csv = text.split('\n').map(line =>
    line.split('\t').map(cell => {
      if (cell.includes(',') || cell.includes('"') || cell.includes('\n'))
        return '"' + cell.replace(/"/g, '""') + '"';
      return cell;
    }).join(',')
  ).join('\n');
  return new Blob([csv], { type: 'text/csv' });
}

// ── Import mode toggle ─────────────────────────────────────────────────────

document.getElementById('importModeFile').addEventListener('click', () => {
  _importMode = 'file';
  document.getElementById('importModeFile').classList.add('active');
  document.getElementById('importModePaste').classList.remove('active');
  document.getElementById('importModePDF').classList.remove('active');
  document.getElementById('importFileArea').style.display = '';
  document.getElementById('importPasteArea').style.display = 'none';
  document.getElementById('importPdfArea').style.display = 'none';
  document.getElementById('previewBtn').style.display = '';
});
document.getElementById('importModePaste').addEventListener('click', () => {
  _importMode = 'paste';
  document.getElementById('importModePaste').classList.add('active');
  document.getElementById('importModeFile').classList.remove('active');
  document.getElementById('importModePDF').classList.remove('active');
  document.getElementById('importFileArea').style.display = 'none';
  document.getElementById('importPasteArea').style.display = 'block';
  document.getElementById('importPdfArea').style.display = 'none';
  document.getElementById('previewBtn').style.display = '';
});
document.getElementById('importModePDF').addEventListener('click', () => {
  _importMode = 'pdf';
  document.getElementById('importModePDF').classList.add('active');
  document.getElementById('importModeFile').classList.remove('active');
  document.getElementById('importModePaste').classList.remove('active');
  document.getElementById('importFileArea').style.display = 'none';
  document.getElementById('importPasteArea').style.display = 'none';
  document.getElementById('importPdfArea').style.display = 'block';
  document.getElementById('previewBtn').style.display = 'none';
  document.getElementById('previewStatus').textContent = '';
});


function renderColumnPicker() {
  const container = document.getElementById('columnPicker');

  const headerCells = _importColumns.map(col => {
    const role = _colRoles[col] || '';
    const opts = [
      `<option value="">— ignore —</option>`,
      `<option value="symbol"${role==='symbol'?' selected':''}>Symbol</option>`,
      `<option value="shares"${role==='shares'?' selected':''}>Shares</option>`,
      `<option value="cost"${role==='cost'?' selected':''}>Cost</option>`,
      `<option value="account"${role==='account'?' selected':''}>Account</option>`,
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

document.getElementById('previewBtn').addEventListener('click', async () => {
  const broker = document.getElementById('brokerName').value.trim();
  const account = document.getElementById('accountName').value.trim();
  const status = document.getElementById('previewStatus');

  if (!broker) { setStatus(status, 'Enter a broker name first', 'err'); return; }

  let file, fileName;
  if (_importMode === 'paste') {
    const text = document.getElementById('pasteData').value.trim();
    if (!text) { setStatus(status, 'Paste some data first', 'err'); return; }
    file = pasteToCSVBlob(text);
    fileName = 'pasted data';
  } else {
    file = document.getElementById('csvFile').files[0];
    if (!file) { setStatus(status, 'Select a CSV file first', 'err'); return; }
    fileName = file.name;
  }
  _importFile = file;
  _importFileName = fileName;
  _importBroker = broker;
  _importAccount = account;

  setStatus(status, 'Reading…', '');

  const fd = new FormData();
  fd.append('broker', broker);
  fd.append('file', _importFile, 'import.csv');

  const res = await fetch('/api/upload/preview', { method: 'POST', body: fd });
  const json = await res.json();

  if (!res.ok) { setStatus(status, json.error, 'err'); return; }

  setStatus(status, '', '');
  _importColumns = json.columns;
  _importRows = json.rows || [];

  // Init roles, then apply auto-detect / profile mapping
  _colRoles = {};
  for (const col of _importColumns) _colRoles[col] = null;
  const m = json.mapping;
  if (m.symbol  && _importColumns.includes(m.symbol))  _colRoles[m.symbol]  = 'symbol';
  if (m.shares  && _importColumns.includes(m.shares))  _colRoles[m.shares]  = 'shares';
  if (m.cost    && _importColumns.includes(m.cost))    _colRoles[m.cost]    = 'cost';
  if (m.account && _importColumns.includes(m.account)) _colRoles[m.account] = 'account';
  document.getElementById('costIsTotal').checked = !!m.cost_is_total;

  document.getElementById('saveProfile').checked = !json.has_profile;
  document.getElementById('saveProfileBroker').textContent = `"${broker}"`;

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
    `${_importFileName} — ${colCount} column${colCount !== 1 ? 's' : ''} found`;

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

  const mapping = {
    symbol:  Object.entries(_colRoles).find(([, r]) => r === 'symbol')?.[0]  || null,
    shares:  Object.entries(_colRoles).find(([, r]) => r === 'shares')?.[0]  || null,
    cost:    Object.entries(_colRoles).find(([, r]) => r === 'cost')?.[0]    || null,
    account: Object.entries(_colRoles).find(([, r]) => r === 'account')?.[0] || null,
    cost_is_total: document.getElementById('costIsTotal').checked,
  };

  if (!mapping.symbol || !mapping.shares || !mapping.cost) {
    setStatus(status, 'Assign all three columns first', 'err');
    return;
  }

  const fd = new FormData();
  fd.append('broker', _importBroker);
  fd.append('account', _importAccount);
  fd.append('file', _importFile, 'import.csv');
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
  _importFile = null;
  document.getElementById('brokerName').value = '';
  document.getElementById('accountName').value = '';
  document.getElementById('csvFile').value = '';
  document.getElementById('pasteData').value = '';

  loadPortfolio();
  setTimeout(loadSnapshots, 1500);
  loadProfiles();
  loadSources();
});

// ── Imported Sources (broker · account management) ────────────────────────

async function loadSources() {
  const res = await fetch('/api/sources');
  const sources = await res.json();
  const wrap = document.getElementById('sourcesSection');
  const list = document.getElementById('sourcesList');

  if (!sources.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  // Group by broker
  const byBroker = {};
  for (const s of sources) (byBroker[s.broker] ||= []).push(s);

  list.innerHTML = Object.entries(byBroker).map(([broker, accs]) => {
    const total = accs.reduce((n, s) => n + s.count, 0);
    const last = accs.map(s => s.last_updated || '').sort().pop();
    const showAccountRows = accs.length > 1 || (accs.length === 1 && accs[0].account);

    const accountLines = showAccountRows ? accs.map(s => `
      <div class="source-row source-account">
        <span class="source-acct">${s.account ? escHtml(s.account) : '<em style="color:var(--muted)">(no account)</em>'}</span>
        <span class="source-meta">${s.count} holding${s.count !== 1 ? 's' : ''} · updated ${fmtDateShort(s.last_updated)}</span>
        <button class="del-btn del-acct-btn"
                data-broker="${escHtml(broker)}"
                data-account="${escHtml(s.account || '')}"
                title="Delete this account">✕</button>
      </div>
    `).join('') : '';

    return `
      <div class="broker-group">
        <div class="source-row broker-header">
          <span class="source-broker">${escHtml(broker)}</span>
          <span class="source-meta">${total} holding${total !== 1 ? 's' : ''} · last updated ${fmtDateShort(last)}</span>
          <button class="btn-ghost btn-sm del-broker-btn" data-broker="${escHtml(broker)}">Delete entire broker</button>
        </div>
        ${accountLines}
      </div>
    `;
  }).join('');

  list.querySelectorAll('.del-acct-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const broker = btn.dataset.broker;
      const account = btn.dataset.account;
      const display = account ? `${broker} · ${account}` : `${broker} (no account)`;
      if (!confirm(`Delete all holdings from ${display}?`)) return;
      const params = new URLSearchParams({ broker, account });
      await fetch(`/api/sources?${params}`, { method: 'DELETE' });
      loadPortfolio();
      loadSources();
    });
  });
  list.querySelectorAll('.del-broker-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const broker = btn.dataset.broker;
      if (!confirm(`Delete ALL holdings from ${broker} across every account?`)) return;
      await fetch(`/api/sources?broker=${encodeURIComponent(broker)}`, { method: 'DELETE' });
      loadPortfolio();
      loadSources();
    });
  });
}

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

let _allSnapshots = [];
let _perfRange = { start: null, end: null };  // YYYY-MM-DD strings

async function loadSnapshots() {
  const res = await fetch('/api/snapshots');
  _allSnapshots = await res.json();
  initPerfRangeIfEmpty();
  renderPerformance();
  renderSnapshotList(filterSnapshotsByRange(_allSnapshots));
}

function snapDateStr(iso) {
  // 'YYYY-MM-DD HH:MM:SS' or ISO → 'YYYY-MM-DD'
  if (!iso) return '';
  return String(iso).slice(0, 10);
}

function filterSnapshotsByRange(snapshots) {
  const { start, end } = _perfRange;
  return snapshots.filter(s => {
    const d = snapDateStr(s.taken_at);
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });
}

function initPerfRangeIfEmpty() {
  const startEl = document.getElementById('perfStart');
  const endEl = document.getElementById('perfEnd');
  if (!_allSnapshots.length) return;
  const dates = _allSnapshots.map(s => snapDateStr(s.taken_at)).filter(Boolean).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  startEl.min = endEl.min = minDate;
  startEl.max = endEl.max = maxDate;
  if (!_perfRange.start) { _perfRange.start = minDate; startEl.value = minDate; }
  if (!_perfRange.end) { _perfRange.end = maxDate; endEl.value = maxDate; }
}

function renderPerformance() {
  const inRange = filterSnapshotsByRange(_allSnapshots);
  // Snapshots come back DESC (newest first); for period calc we want ASC
  const valued = inRange.filter(s => s.total_value != null).slice().reverse();

  const noData = document.getElementById('perfNoData');
  const wrap = document.getElementById('timelineWrap');

  const clear = () => {
    ['perfStartValue','perfEndValue','perfChange','perfReturn'].forEach(id => {
      const el = document.getElementById(id);
      el.textContent = '—';
      el.className = 'value';
    });
    document.getElementById('perfStartDate').textContent = '';
    document.getElementById('perfEndDate').textContent = '';
    document.getElementById('perfContrib').textContent = '';
    wrap.style.display = 'none';
    noData.style.display = 'block';
    if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
  };

  if (!valued.length) { clear(); return; }
  noData.style.display = 'none';

  const first = valued[0];
  const last = valued[valued.length - 1];

  // Contribution-aware return:
  // Period P&L = change in unrealized gain, excluding money added/removed.
  // This prevents imports that add new positions from looking like returns.
  const startGain = first.total_value - first.total_cost;
  const endGain   = last.total_value  - last.total_cost;
  const periodPL  = endGain - startGain;
  const contrib   = last.total_cost - first.total_cost;  // net new cost basis added
  const ret       = first.total_value ? periodPL / first.total_value * 100 : null;

  document.getElementById('perfStartValue').textContent = fmt(first.total_value);
  document.getElementById('perfEndValue').textContent   = fmt(last.total_value);
  document.getElementById('perfStartDate').textContent  = fmtDate(first.taken_at);
  document.getElementById('perfEndDate').textContent    = fmtDate(last.taken_at);

  const changeEl = document.getElementById('perfChange');
  changeEl.textContent = (periodPL >= 0 ? '+' : '') + fmt(periodPL);
  changeEl.className = 'value ' + gainClass(periodPL);

  // Show contribution note if cost basis changed meaningfully
  const contribEl = document.getElementById('perfContrib');
  if (Math.abs(contrib) > 0.01) {
    contribEl.textContent = `${contrib >= 0 ? '+' : ''}${fmt(contrib)} net contributions`;
  } else {
    contribEl.textContent = 'no contributions in period';
  }

  const retEl = document.getElementById('perfReturn');
  retEl.textContent = fmtPct(ret);
  retEl.className = 'value ' + gainClass(ret);

  renderTimeline(inRange);
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

function _toUTCDate(iso) {
  return new Date(iso.endsWith('Z') ? iso : iso + 'Z');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = _toUTCDate(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDateShort(iso) {
  if (!iso) return '—';
  const d = _toUTCDate(iso);
  if (isNaN(d.getTime())) return '—';
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
    loadSources();
  }
});

document.getElementById('refreshBtn').addEventListener('click', loadPortfolio);

// ── Edit holding modal ─────────────────────────────────────────────────────

document.getElementById('cancelEdit').addEventListener('click', () => {
  document.getElementById('editModal').style.display = 'none';
});
document.getElementById('editModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});

document.getElementById('editForm').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('editStatus');
  const body = {
    symbol: document.getElementById('eSymbol').value.trim().toUpperCase(),
    shares: parseFloat(document.getElementById('eShares').value),
    cost_per_share: parseFloat(document.getElementById('eCost').value),
  };
  setStatus(status, 'Saving…', '');
  const res = await fetch(`/api/holding/${_editId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    setStatus(status, json.error, 'err');
  } else {
    document.getElementById('editModal').style.display = 'none';
    loadPortfolio();
  }
});

document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _viewMode = btn.dataset.view;
    document.querySelectorAll('.toggle-btn').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
    renderTable(_lastHoldings);
  });
});

// ── Tab switching ─────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-pane').forEach(p =>
      p.classList.toggle('active', p.id === 'tab' + tab.charAt(0).toUpperCase() + tab.slice(1))
    );
  });
});

// ── Performance date range wiring ─────────────────────────────────────────

function refreshPerfTab() {
  renderPerformance();
  renderSnapshotList(filterSnapshotsByRange(_allSnapshots));
}

document.getElementById('perfStart').addEventListener('change', e => {
  _perfRange.start = e.target.value || null;
  document.querySelectorAll('.perf-presets .btn-ghost').forEach(b => b.classList.remove('active'));
  refreshPerfTab();
});
document.getElementById('perfEnd').addEventListener('change', e => {
  _perfRange.end = e.target.value || null;
  document.querySelectorAll('.perf-presets .btn-ghost').forEach(b => b.classList.remove('active'));
  refreshPerfTab();
});

document.querySelectorAll('.perf-presets .btn-ghost').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.preset;
    if (!_allSnapshots.length) return;

    const dates = _allSnapshots.map(s => snapDateStr(s.taken_at)).filter(Boolean).sort();
    const minDate = dates[0];
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    let startStr;
    if (preset === 'all') {
      startStr = minDate;
    } else if (preset === 'ytd') {
      startStr = `${today.getFullYear()}-01-01`;
    } else {
      const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[preset];
      const d = new Date(today);
      d.setMonth(d.getMonth() - months);
      startStr = d.toISOString().slice(0, 10);
    }

    _perfRange.start = startStr;
    _perfRange.end = todayStr;
    document.getElementById('perfStart').value = startStr;
    document.getElementById('perfEnd').value = todayStr;
    document.querySelectorAll('.perf-presets .btn-ghost').forEach(b => b.classList.toggle('active', b === btn));
    refreshPerfTab();
  });
});

// ── Transactions ──────────────────────────────────────────────────────────

const TX_ROLES = ['date','action','symbol','shares','price','amount','fees','description','account'];
const TX_ROLE_LABEL = {
  date: 'Date', action: 'Action', symbol: 'Symbol', shares: 'Shares',
  price: 'Price', amount: 'Amount', fees: 'Fees', description: 'Description', account: 'Account',
};
const TX_ROLE_COLOR = {
  date: '#a5b4fc', action: '#86efac', symbol: '#fcd34d',
  amount: '#f9a8d4', shares: '#67e8f9', price: '#fdba74',
  fees: '#d1d5db', description: '#c4b5fd', account: '#a7f3d0',
};

let _txColRoles = {};
let _txColumns = [];
let _txRows = [];
let _txFile = null;
let _txFileName = '';
let _txBroker = '';
let _txAccount = '';
let _txRange = { start: null, end: null };
let _allTransactions = [];

async function loadTransactions() {
  const params = new URLSearchParams();
  if (_txRange.start) params.set('start', _txRange.start);
  if (_txRange.end) params.set('end', _txRange.end);
  const res = await fetch('/api/transactions?' + params);
  _allTransactions = await res.json();
  renderTxSummary();
  renderTxTable(_allTransactions);
}

function renderTxSummary() {
  const txs = _allTransactions;
  const totals = { dividend: 0, buy: 0, sell: 0 };
  for (const t of txs) {
    const amt = Math.abs(t.amount || 0);
    if (t.action === 'dividend' || t.action === 'interest') totals.dividend += amt;
    else if (t.action === 'buy' || t.action === 'reinvest') totals.buy += amt;
    else if (t.action === 'sell') totals.sell += amt;
  }
  document.getElementById('txDividends').textContent = fmt(totals.dividend);
  document.getElementById('txBuys').textContent = fmt(totals.buy);
  document.getElementById('txSells').textContent = fmt(totals.sell);
  document.getElementById('txCount').textContent = txs.length.toLocaleString();
}

const ACTION_BADGE = {
  buy: '#86efac', sell: '#f9a8d4', dividend: '#fcd34d', reinvest: '#67e8f9',
  interest: '#fcd34d', fee: '#d1d5db', transfer: '#a5b4fc', deposit: '#86efac',
  withdrawal: '#f9a8d4', other: '#8892a4',
};

function renderTxTable(txs) {
  const head = document.getElementById('txHead');
  const tbody = document.getElementById('txBody');
  head.innerHTML = `
    <tr>
      <th>Date</th><th>Broker</th><th>Account</th><th>Symbol</th>
      <th>Action</th><th class="num">Shares</th><th class="num">Price</th>
      <th class="num">Amount</th><th class="num">Fees</th><th></th>
    </tr>`;
  if (!txs.length) {
    tbody.innerHTML = '<tr><td class="empty" colspan="10">No transactions in this range.</td></tr>';
    return;
  }
  tbody.innerHTML = txs.map(t => {
    const color = ACTION_BADGE[t.action] || '#8892a4';
    const amtClass = t.amount == null ? '' : t.amount >= 0 ? 'gain-pos' : 'gain-neg';
    return `<tr>
      <td style="white-space:nowrap">${t.trade_date}</td>
      <td><span class="broker-badge">${escHtml(t.broker)}</span></td>
      <td>${t.account ? escHtml(t.account) : '<span class="muted-val">—</span>'}</td>
      <td class="symbol">${t.symbol || '<span class="muted-val">—</span>'}</td>
      <td><span class="action-badge" style="background:${color}20;color:${color};border-color:${color}40">${escHtml(t.action)}</span></td>
      <td class="num">${t.shares != null ? t.shares.toLocaleString('en-US',{maximumFractionDigits:4}) : '—'}</td>
      <td class="num">${t.price != null ? fmt(t.price) : '—'}</td>
      <td class="num ${amtClass}">${t.amount != null ? fmt(t.amount) : '—'}</td>
      <td class="num muted-val">${t.fees ? fmt(t.fees) : '—'}</td>
      <td><button class="del-btn tx-del-btn" data-id="${t.id}" title="Delete">✕</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.tx-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this transaction?')) return;
      await fetch(`/api/transactions/${btn.dataset.id}`, { method: 'DELETE' });
      loadTransactions();
    });
  });
}

function applyTxPreset(preset, allTx) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  let startStr;
  if (preset === 'all') {
    const dates = allTx.map(t => t.trade_date).filter(Boolean).sort();
    startStr = dates[0] || todayStr;
  } else if (preset === 'ytd') {
    startStr = `${today.getFullYear()}-01-01`;
  } else {
    const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[preset];
    const d = new Date(today); d.setMonth(d.getMonth() - months);
    startStr = d.toISOString().slice(0, 10);
  }
  _txRange.start = startStr;
  _txRange.end = todayStr;
  document.getElementById('txStart').value = startStr;
  document.getElementById('txEnd').value = todayStr;
}

document.getElementById('txStart').addEventListener('change', e => {
  _txRange.start = e.target.value || null;
  document.querySelectorAll('#txPresets .btn-ghost').forEach(b => b.classList.remove('active'));
  loadTransactions();
});
document.getElementById('txEnd').addEventListener('change', e => {
  _txRange.end = e.target.value || null;
  document.querySelectorAll('#txPresets .btn-ghost').forEach(b => b.classList.remove('active'));
  loadTransactions();
});
document.querySelectorAll('#txPresets .btn-ghost').forEach(btn => {
  btn.addEventListener('click', async () => {
    const preset = btn.dataset.preset;
    if (preset === 'all') {
      // Need the full unfiltered list to find the earliest date
      const res = await fetch('/api/transactions');
      const all = await res.json();
      applyTxPreset(preset, all);
    } else {
      applyTxPreset(preset, _allTransactions);
    }
    document.querySelectorAll('#txPresets .btn-ghost').forEach(b => b.classList.toggle('active', b === btn));
    loadTransactions();
  });
});

// ── Transactions column picker ─────────────────────────────────────────────

function renderTxColumnPicker() {
  const container = document.getElementById('txColumnPicker');
  const headerCells = _txColumns.map(col => {
    const role = _txColRoles[col] || '';
    const opts = [`<option value="">— ignore —</option>`]
      .concat(TX_ROLES.map(r => `<option value="${r}"${role===r?' selected':''}>${TX_ROLE_LABEL[r]}</option>`))
      .join('');
    const color = TX_ROLE_COLOR[role] || 'transparent';
    return `<th style="${role ? `border-bottom:2px solid ${color}` : ''}">
      <div class="col-head">
        <div class="col-name" title="${escHtml(col)}">${escHtml(col)}</div>
        <select class="col-role-select" data-col="${escHtml(col)}">${opts}</select>
      </div>
    </th>`;
  }).join('');
  const dataRows = _txRows.map(row =>
    `<tr>${_txColumns.map((col, i) => `<td>${escHtml(String(row[i] ?? ''))}</td>`).join('')}</tr>`
  ).join('');
  container.innerHTML = `
    <table class="col-picker-table">
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${dataRows || `<tr><td colspan="${_txColumns.length}" class="empty">No preview rows</td></tr>`}</tbody>
    </table>`;

  container.querySelectorAll('.col-role-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const col = sel.dataset.col;
      const next = sel.value || null;
      if (next) {
        for (const c of Object.keys(_txColRoles)) {
          if (_txColRoles[c] === next && c !== col) _txColRoles[c] = null;
        }
      }
      _txColRoles[col] = next;
      renderTxColumnPicker();
      updateTxImportBtn();
    });
  });
}

function updateTxImportBtn() {
  const roles = Object.values(_txColRoles);
  document.getElementById('txConfirmBtn').disabled = !roles.includes('date');
}

document.getElementById('txPreviewBtn').addEventListener('click', async () => {
  const broker = document.getElementById('txBrokerName').value.trim();
  const status = document.getElementById('txPreviewStatus');
  if (!broker) { setStatus(status, 'Enter a broker name first', 'err'); return; }
  const file = document.getElementById('txCsvFile').files[0];
  if (!file) { setStatus(status, 'Select a CSV file first', 'err'); return; }

  _txFile = file; _txFileName = file.name; _txBroker = broker;
  _txAccount = document.getElementById('txAccountName').value.trim();

  setStatus(status, 'Reading…', '');
  const fd = new FormData();
  fd.append('broker', broker);
  fd.append('file', _txFile, 'import.csv');
  const res = await fetch('/api/transactions/upload/preview', { method: 'POST', body: fd });
  const json = await res.json();
  if (!res.ok) { setStatus(status, json.error, 'err'); return; }

  setStatus(status, '', '');
  _txColumns = json.columns;
  _txRows = json.rows || [];
  _txColRoles = {};
  for (const col of _txColumns) _txColRoles[col] = null;
  const m = json.mapping;
  for (const [role, col] of Object.entries(m)) {
    if (col && _txColumns.includes(col)) _txColRoles[col] = role;
  }
  document.getElementById('txMappingTitle').textContent =
    `${_txFileName} — ${_txColumns.length} columns found`;
  renderTxColumnPicker();
  updateTxImportBtn();
  document.getElementById('txImportStep1').style.display = 'none';
  document.getElementById('txImportStep2').style.display = 'block';
});

document.getElementById('txBackBtn').addEventListener('click', () => {
  document.getElementById('txImportStep2').style.display = 'none';
  document.getElementById('txImportStep1').style.display = 'block';
  document.getElementById('txPreviewStatus').textContent = '';
});

document.getElementById('txConfirmBtn').addEventListener('click', async () => {
  const status = document.getElementById('txConfirmStatus');
  const mapping = {};
  for (const [col, role] of Object.entries(_txColRoles)) {
    if (role) mapping[role] = col;
  }
  if (!mapping.date) { setStatus(status, 'Assign a Date column first', 'err'); return; }

  const fd = new FormData();
  fd.append('broker', _txBroker);
  fd.append('account', _txAccount);
  fd.append('file', _txFile, 'import.csv');
  fd.append('mapping', JSON.stringify(mapping));
  fd.append('replace', document.getElementById('txReplace').checked ? 'true' : 'false');

  setStatus(status, 'Importing…', '');
  let res, json;
  try {
    res = await fetch('/api/transactions/upload/confirm', { method: 'POST', body: fd });
    const text = await res.text();
    try { json = JSON.parse(text); } catch { throw new Error('Server returned: ' + text.slice(0, 200)); }
  } catch (err) {
    setStatus(status, 'Import failed: ' + err.message, 'err'); return;
  }
  if (!res.ok) { setStatus(status, json.error || 'Import failed', 'err'); return; }

  setStatus(status, `Imported ${json.imported} transactions for ${json.broker}`, 'ok');
  document.getElementById('txImportStep2').style.display = 'none';
  document.getElementById('txImportStep1').style.display = 'block';
  _txFile = null;
  document.getElementById('txBrokerName').value = '';
  document.getElementById('txAccountName').value = '';
  document.getElementById('txCsvFile').value = '';
  loadTransactions();
});

// ── PDF statement import ───────────────────────────────────────────────────

let _pdfHoldings = [];
let _pdfBroker = '';
let _pdfAccount = '';

function renderPdfHoldings() {
  const container = document.getElementById('pdfHoldingsTable');
  if (!_pdfHoldings.length) {
    container.innerHTML = '<p class="empty" style="padding:16px">No holdings found.</p>';
    return;
  }
  const inputStyle = 'background:var(--surface);border:1px solid var(--border);color:var(--fg);border-radius:4px;padding:4px 6px;font-size:13px';
  container.innerHTML = `
    <table class="col-picker-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th class="num">Shares</th>
          <th class="num">Avg Cost / Share</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${_pdfHoldings.map((h, i) => `
          <tr>
            <td><input class="pdf-sym" data-i="${i}" type="text" value="${escHtml(h.symbol)}"
              style="${inputStyle};width:80px;font-family:monospace;text-transform:uppercase" /></td>
            <td class="num"><input class="pdf-shares" data-i="${i}" type="number" value="${h.shares}"
              min="0.0001" step="any" style="${inputStyle};width:110px" /></td>
            <td class="num"><input class="pdf-cost" data-i="${i}" type="number" value="${h.cost_per_share.toFixed(4)}"
              min="0.0001" step="any" style="${inputStyle};width:120px" /></td>
            <td><button class="del-btn pdf-del-btn" data-i="${i}" title="Remove">✕</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  container.querySelectorAll('.pdf-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _pdfHoldings.splice(parseInt(btn.dataset.i), 1);
      renderPdfHoldings();
    });
  });
}

document.getElementById('parsePdfBtn').addEventListener('click', async () => {
  const broker = document.getElementById('brokerName').value.trim();
  const account = document.getElementById('accountName').value.trim();
  const status = document.getElementById('parsePdfStatus');
  const file = document.getElementById('pdfFile').files[0];

  if (!broker) { setStatus(status, 'Enter a broker name first', 'err'); return; }
  if (!file) { setStatus(status, 'Select a PDF file first', 'err'); return; }

  _pdfBroker = broker;
  _pdfAccount = account;

  setStatus(status, 'Extracting text and parsing with AI… this may take a moment', '');

  const fd = new FormData();
  fd.append('broker', broker);
  fd.append('account', account);
  fd.append('file', file, file.name);

  let res, json;
  try {
    res = await fetch('/api/upload/parse-pdf', { method: 'POST', body: fd });
    const text = await res.text();
    try { json = JSON.parse(text); } catch { throw new Error('Server returned: ' + text.slice(0, 200)); }
  } catch (err) {
    setStatus(status, 'Error: ' + err.message, 'err');
    return;
  }

  if (!res.ok) { setStatus(status, json.error || 'Parse failed', 'err'); return; }

  setStatus(status, '', '');
  _pdfHoldings = json.holdings;

  const count = json.holdings.length;
  document.getElementById('pdfStepTitle').textContent =
    `${file.name} — ${count} position${count !== 1 ? 's' : ''} found by AI`;

  renderPdfHoldings();
  document.getElementById('importStep1').style.display = 'none';
  document.getElementById('importPdfStep').style.display = 'block';
});

document.getElementById('pdfBackBtn').addEventListener('click', () => {
  document.getElementById('importPdfStep').style.display = 'none';
  document.getElementById('importStep1').style.display = 'block';
  document.getElementById('parsePdfStatus').textContent = '';
});

document.getElementById('pdfConfirmBtn').addEventListener('click', async () => {
  const status = document.getElementById('pdfConfirmStatus');
  if (!_pdfHoldings.length) { setStatus(status, 'No holdings to import', 'err'); return; }

  // Read latest values from the editable inputs before submitting
  document.querySelectorAll('.pdf-sym').forEach(inp => {
    _pdfHoldings[parseInt(inp.dataset.i)].symbol = inp.value.trim().toUpperCase();
  });
  document.querySelectorAll('.pdf-shares').forEach(inp => {
    _pdfHoldings[parseInt(inp.dataset.i)].shares = parseFloat(inp.value) || 0;
  });
  document.querySelectorAll('.pdf-cost').forEach(inp => {
    _pdfHoldings[parseInt(inp.dataset.i)].cost_per_share = parseFloat(inp.value) || 0;
  });

  const validRows = _pdfHoldings.filter(h => h.shares > 0 && h.cost_per_share > 0 && h.symbol);
  if (!validRows.length) { setStatus(status, 'No valid holdings to import', 'err'); return; }

  setStatus(status, 'Importing…', '');
  let res, json;
  try {
    res = await fetch('/api/upload/pdf-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ broker: _pdfBroker, account: _pdfAccount, holdings: validRows }),
    });
    const text = await res.text();
    try { json = JSON.parse(text); } catch { throw new Error('Server returned: ' + text.slice(0, 200)); }
  } catch (err) {
    setStatus(status, 'Import failed: ' + err.message, 'err');
    return;
  }

  if (!res.ok) { setStatus(status, json.error || 'Import failed', 'err'); return; }

  setStatus(status, `Imported ${json.imported} holdings for ${json.broker}`, 'ok');
  document.getElementById('importPdfStep').style.display = 'none';
  document.getElementById('importStep1').style.display = 'block';

  // Reset PDF form
  _pdfHoldings = [];
  document.getElementById('brokerName').value = '';
  document.getElementById('accountName').value = '';
  document.getElementById('pdfFile').value = '';

  loadPortfolio();
  setTimeout(loadSnapshots, 1500);
  loadSources();
});

// Initial load
loadPortfolio();
loadSnapshots();
loadProfiles();
loadSources();
loadTransactions();
