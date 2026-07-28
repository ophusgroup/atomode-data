// Browse page: filterable, sortable, paginated table backed by DuckDB-Wasm.

import { initDB, query } from './db.js';
import { downloadStructureXYZ, xyzqUrlFor } from './xyzdl.js?v=2';

const PAGE_SIZE = 50;
const PARQUET_PATH = 'data/dataset.parquet';

const state = {
  filters: {
    composition: '',
    mp_id: '',
    regime: '',
    density_min: '',
    density_max: '',
    n_atoms_min: '',
    n_atoms_max: '',
  },
  sort:  { col: 'structure_id', dir: 'asc' },
  page:  1,
  total: 0,
};

const COLUMNS = [
  { key: 'structure_id',     label: 'ID',           type: 'str',  cls: '' },
  { key: 'composition',      label: 'Composition',  type: 'str',  cls: '' },
  { key: 'mp_id',            label: 'MP-ID',        type: 'str',  cls: '' },
  { key: 'regime',           label: 'Regime',       type: 'str',  cls: 'regime-cell' },
  { key: 'density',          label: 'ρ (at/Å³)',    type: 'num',  fmt: (v) => v?.toFixed(3) ?? '' },
  { key: 'n_atoms',          label: 'N atoms',      type: 'num',  fmt: (v) => Number(v).toLocaleString() },
  { key: 'seed',             label: 'Seed',         type: 'num',  fmt: (v) => String(v) },
  { key: 'max_force',        label: '|F|_max',      type: 'num',  fmt: (v) => v?.toFixed(3) ?? '' },
  { key: 'generated_at',     label: 'Generated',    type: 'str',  fmt: (v) => (v ?? '').slice(0, 10) },
  { key: 'xyz_path',         label: '↓',            type: 'download', sortable: false },
];

// ── filter SQL ─────────────────────────────────────────────────────────────

function buildWhereClause(filters) {
  const clauses = [];
  if (filters.composition)  clauses.push(`composition ILIKE '%${escapeLike(filters.composition)}%'`);
  if (filters.mp_id)        clauses.push(`mp_id ILIKE '%${escapeLike(filters.mp_id)}%'`);
  if (filters.regime)       clauses.push(`regime = '${escapeLike(filters.regime)}'`);
  if (filters.density_min)  clauses.push(`density >= ${Number(filters.density_min)}`);
  if (filters.density_max)  clauses.push(`density <= ${Number(filters.density_max)}`);
  if (filters.n_atoms_min)  clauses.push(`n_atoms >= ${Number(filters.n_atoms_min)}`);
  if (filters.n_atoms_max)  clauses.push(`n_atoms <= ${Number(filters.n_atoms_max)}`);
  return clauses.length ? `where ${clauses.join(' and ')}` : '';
}

function escapeLike(s) {
  return String(s).replace(/'/g, "''");
}

// ── rendering ──────────────────────────────────────────────────────────────

function renderTable(rows) {
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${COLUMNS.length}" class="message">no results</td></tr>`;
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = row.structure_id;
    for (const col of COLUMNS) {
      const td = document.createElement('td');
      const raw = row[col.key];
      if (col.type === 'download') {
        td.classList.add('download-cell');
        const a = document.createElement('a');
        a.className = 'row-download';
        a.href = '#';
        a.title = `download ${row.structure_id}.xyz (display precision — see downloads page)`;
        a.textContent = '↓';
        a.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const prev = a.textContent;
          a.textContent = '…';
          try {
            await downloadStructureXYZ(xyzqUrlFor(row.xyz_path), row.structure_id);
          } catch (err) {
            console.error(err);
            alert('Download failed: ' + err.message);
          }
          a.textContent = prev;
        });
        td.appendChild(a);
      } else {
        td.textContent = col.fmt ? col.fmt(raw) : (raw ?? '');
        if (col.type === 'num') td.classList.add('num');
        if (col.cls === 'regime-cell') td.classList.add(`regime-${raw}`);
      }
      tr.appendChild(td);
    }
    tr.addEventListener('click', () => {
      window.location.href = `structure.html?id=${encodeURIComponent(row.structure_id)}`;
    });
    tbody.appendChild(tr);
  }
}

function renderHeader() {
  const thead = document.getElementById('table-head');
  thead.innerHTML = '';
  const tr = document.createElement('tr');
  for (const col of COLUMNS) {
    const th = document.createElement('th');
    th.textContent = col.label;
    if (col.sortable === false) {
      th.classList.add('no-sort');
      tr.appendChild(th);
      continue;
    }
    if (state.sort.col === col.key) {
      const m = document.createElement('span');
      m.className = 'sort-marker';
      m.textContent = state.sort.dir === 'asc' ? '▲' : '▼';
      th.appendChild(m);
    }
    th.addEventListener('click', () => {
      if (state.sort.col === col.key) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.col = col.key;
        state.sort.dir = 'asc';
      }
      state.page = 1;
      refresh();
    });
    tr.appendChild(th);
  }
  thead.appendChild(tr);
}

function renderPagination() {
  const div = document.getElementById('pagination');
  const lastPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  state.page = Math.min(state.page, lastPage);
  div.innerHTML = '';
  const prev = document.createElement('button');
  prev.textContent = '‹ prev';
  prev.disabled = state.page <= 1;
  prev.addEventListener('click', () => { state.page--; refresh(); });
  const next = document.createElement('button');
  next.textContent = 'next ›';
  next.disabled = state.page >= lastPage;
  next.addEventListener('click', () => { state.page++; refresh(); });
  const info = document.createElement('span');
  info.className = 'page-info';
  info.textContent = `page ${state.page} / ${lastPage}`;
  div.append(prev, info, next);
}

function renderStatus(shownCount) {
  const el = document.getElementById('status-count');
  const start = (state.page - 1) * PAGE_SIZE + 1;
  const end = Math.min(state.total, start + shownCount - 1);
  el.textContent = state.total
    ? `showing ${start}–${end} of ${state.total.toLocaleString()}`
    : 'no results';
}

// ── data fetch ─────────────────────────────────────────────────────────────

async function refresh() {
  const where = buildWhereClause(state.filters);
  const orderCol = state.sort.col;
  const orderDir = state.sort.dir.toUpperCase();
  const offset = (state.page - 1) * PAGE_SIZE;

  const countRows = await query(`select count(*) as c from dataset ${where}`);
  state.total = Number(countRows[0].c);

  const rows = await query(`
    select * from dataset
    ${where}
    order by ${orderCol} ${orderDir}
    limit ${PAGE_SIZE} offset ${offset}
  `);

  renderHeader();
  renderTable(rows);
  renderPagination();
  renderStatus(rows.length);
}

// ── filter wiring ──────────────────────────────────────────────────────────

function wireFilters() {
  for (const key of Object.keys(state.filters)) {
    const el = document.getElementById(`f-${key}`);
    if (!el) continue;
    el.addEventListener('input', (e) => {
      state.filters[key] = e.target.value;
      state.page = 1;
      refresh();
    });
  }
  document.getElementById('reset-filters').addEventListener('click', () => {
    for (const key of Object.keys(state.filters)) {
      state.filters[key] = '';
      const el = document.getElementById(`f-${key}`);
      if (el) el.value = '';
    }
    state.page = 1;
    refresh();
  });
}

async function populateRegimeDropdown() {
  const rows = await query('select distinct regime from dataset order by regime');
  const sel = document.getElementById('f-regime');
  for (const r of rows) {
    const o = document.createElement('option');
    o.value = r.regime;
    // MRO is flagged as provisional (known density bug, will be regenerated).
    o.textContent = r.regime === 'MRO' ? 'MRO ⚠ (provisional)' : r.regime;
    sel.appendChild(o);
  }
}

// ── boot ───────────────────────────────────────────────────────────────────

(async () => {
  const statusEl = document.getElementById('status-count');
  try {
    statusEl.textContent = 'loading dataset…';
    await initDB(PARQUET_PATH);
    await populateRegimeDropdown();
    wireFilters();
    await refresh();
  } catch (err) {
    console.error(err);
    const tbody = document.getElementById('table-body');
    tbody.innerHTML = `<tr><td colspan="${COLUMNS.length}" class="message error">
      failed to load dataset: ${err.message}<br>
      did you run <code>python site/tools/build_mock_data.py</code>?
    </td></tr>`;
    statusEl.textContent = '';
  }
})();
