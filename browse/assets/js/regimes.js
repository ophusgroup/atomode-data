// Regime panel: MACE energy/atom across the disorder spectrum for the
// same composition + mp_id.  Bars are clickable — clicking jumps to that
// regime's structure page.  Energies are NaN until the metadata writer
// runs; the panel still renders so the layout is honest about what's
// pending.

// Version must match structure.js's ./db.js?v=N — different URLs load as
// different modules, and the DB singleton lives in module scope.
import { query } from './db.js?v=24';

const REGIME_ORDER = [
  'amorphous', 'SRO', 'MRO', 'LRO', 'nanocrystalline', 'crystalline_30',
];
const REGIME_COLORS = {
  amorphous:       '#ff8a80',
  SRO:             '#ffd54f',
  MRO:             '#80cbc4',
  LRO:             '#82b1ff',
  nanocrystalline: '#ce93d8',
  crystalline_30:  '#65d6ad',
};

const LAYOUT_BASE = {
  paper_bgcolor: '#171a21',
  plot_bgcolor:  '#0f1115',
  font: {
    family: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    color:  '#e6e8ec',
    size:   12,
  },
  margin: { l: 60, r: 12, t: 16, b: 56 },
  hovermode: 'closest',
};

export async function renderRegimePanel(row, hostElId) {
  const host = document.getElementById(hostElId);
  if (!host) return;
  const composition = row.composition.replace(/'/g, "''");
  const mp_id       = row.mp_id.replace(/'/g, "''");

  // Pull EVERY seed for (composition, mp_id) — the atomode docs plot shows
  // seeds as scatter points along each regime column, not a single bar.
  const rows = await query(`
    select structure_id, regime, seed,
           mace_energy_per_atom_eV_mean,
           mace_energy_per_atom_eV_std
    from dataset
    where composition = '${composition}'
      and mp_id       = '${mp_id}'
  `);
  if (!rows.length) { host.innerHTML = ''; return; }

  const plotDiv = document.getElementById('regimes-plot');
  document.querySelector('.regimes-mp').textContent =
    `${row.composition} · ${row.mp_id}  ·  click a point to open that structure`;

  // Group by regime for plotting.  Skip null/NaN so a partially-enriched
  // regime doesn't plant a phantom zero on the axis.
  const byRegime = {};
  for (const r of rows) {
    const v = r.mace_energy_per_atom_eV_mean;
    const e = (v == null || Number.isNaN(v)) ? null : Number(v);
    if (e === null) continue;
    (byRegime[r.regime] ??= []).push({
      seed: Number(r.seed),
      structure_id: r.structure_id,
      energy: e,
      std:    r.mace_energy_per_atom_eV_std == null ? null
                : Number(r.mace_energy_per_atom_eV_std),
    });
  }
  const present = REGIME_ORDER.filter((r) => byRegime[r]?.length);
  if (!present.length) { plotDiv.innerHTML =
    '<div class="plots-empty">no MACE energies for this composition</div>';
    return;
  }

  // One scatter trace per regime — each seed is a point AT the regime's
  // x-centre (no horizontal jitter).  Seeds separate naturally along the
  // y-axis by energy; identical energies stack.  Currently-viewed
  // structure is highlighted with a white ring.
  const currentId = row.structure_id;
  const nR = present.length;
  const xTickPositions = present.map((_, i) => i);
  const traces = present.map((regime, ti) => {
    const pts = byRegime[regime];
    return {
      type: 'scatter',
      mode: 'markers',
      name: regime,
      x: pts.map(() => xTickPositions[ti]),
      y: pts.map((p) => p.energy),
      customdata: pts.map((p) => p.structure_id),
      text: pts.map((p) => `seed ${p.seed}`),
      hovertemplate:
        '<b>%{fullData.name}</b><br>' +
        'E/atom = %{y:.4f} eV<br>' +
        '%{text}<extra></extra>',
      marker: {
        size:  pts.map((p) => p.structure_id === currentId ? 12 : 9),
        color: REGIME_COLORS[regime] || '#9aa0aa',
        line:  {
          color: pts.map((p) => p.structure_id === currentId ? '#ffffff' : '#000000'),
          width: pts.map((p) => p.structure_id === currentId ? 2   : 0.5),
        },
        opacity: 0.9,
      },
      showlegend: false,
    };
  });

  const hasMRO = present.includes('MRO');
  const layout = {
    ...LAYOUT_BASE,
    height: 260,
    margin: { l: 60, r: 12, t: hasMRO ? 24 : 8, b: 68 },
    annotations: hasMRO ? [{
      xref: 'paper', yref: 'paper', x: 0, y: 1.0,
      xanchor: 'left', yanchor: 'bottom', showarrow: false,
      text: '⚠ MRO provisional (density bug)',
      font: { size: 10, color: '#f0b541' },
    }] : [],
    xaxis: {
      title: '',
      gridcolor: '#2a2f3a',
      zerolinecolor: '#2a2f3a',
      tickmode: 'array',
      tickvals: xTickPositions,
      // Flag the MRO tick as provisional (known density bug).
      ticktext: present.map((r) => (r === 'MRO' ? 'MRO ⚠' : r)),
      tickangle: -20,
      range: [-0.55, nR - 1 + 0.55],
    },
    yaxis: {
      title: 'MACE E/atom (eV)',
      gridcolor: '#2a2f3a',
      zerolinecolor: '#2a2f3a',
    },
  };

  await window.Plotly.newPlot(plotDiv, traces, layout, {
    displaylogo: false, responsive: true,
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
  });
  // Pointer cursor when hovering a marker → reinforces that they're
  // clickable navigation targets.  Plotly renders markers inside SVG
  // `<path>` elements under `.scatter .points path`.
  const style = document.createElement('style');
  style.textContent = '#regimes-plot .scatterlayer .trace .points path { cursor: pointer; }';
  plotDiv.appendChild(style);

  plotDiv.on('plotly_click', (ev) => {
    const pt = ev.points && ev.points[0];
    if (!pt) return;
    const target = pt.customdata;
    if (target) window.location.href = `structure.html?id=${encodeURIComponent(target)}`;
  });
}
