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
  const tbody = document.getElementById('holdingsBody');
  if (!holdings.length) {
    tbody.innerHTML = '<tr id="emptyRow"><td colspan="9" class="empty">No holdings yet. Import a CSV or add one manually.</td></tr>';
    return;
  }
  tbody.innerHTML = holdings.map(h => `
    <tr>
      <td class="symbol">${h.symbol}</td>
      <td><span class="broker-badge">${escHtml(h.broker)}</span></td>
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
      if (!confirm(`Remove this holding?`)) return;
      await fetch(`/api/holding/${btn.dataset.id}`, { method: 'DELETE' });
      loadPortfolio();
    });
  });
}

function renderCharts(holdings) {
  const section = document.getElementById('chartsSection');
  if (!holdings.length) { section.style.display = 'none'; return; }
  section.style.display = 'grid';

  // Allocation by symbol (by market value, fallback to cost basis)
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

  // By broker (bar)
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
      datasets: [{
        label: 'Value',
        data: brkValues,
        backgroundColor: PALETTE.slice(0, brkLabels.length),
        borderRadius: 6,
      }],
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

function escHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function setStatus(el, msg, type) {
  el.textContent = msg;
  el.className = 'status-msg ' + (type || '');
  if (type === 'ok') setTimeout(() => { el.textContent = ''; el.className = 'status-msg'; }, 3000);
}

// Import form
document.getElementById('importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('importStatus');
  const broker = document.getElementById('brokerName').value.trim();
  const file = document.getElementById('csvFile').files[0];
  if (!broker || !file) return;

  const fd = new FormData();
  fd.append('broker', broker);
  fd.append('file', file);

  setStatus(status, 'Importing…', '');
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const json = await res.json();

  if (!res.ok) {
    setStatus(status, json.error, 'err');
  } else {
    setStatus(status, `Imported ${json.imported} holdings for ${json.broker}`, 'ok');
    e.target.reset();
    loadPortfolio();
  }
});

// Add holding modal
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

// Refresh button
document.getElementById('refreshBtn').addEventListener('click', loadPortfolio);

// Initial load
loadPortfolio();
