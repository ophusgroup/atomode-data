// Interactive g(r) + ADF + g₃ plots — loads the per-structure JSON written
// by tools/enrich_pdf_adf.py and renders with Plotly (loaded globally via
// <script> tag in structure.html).
//
// Defaults match what's most useful at first glance:
//   g(r), ADF   → Total only (concentration-weighted sum of partials)
//   g₃          → first triplet, single-select
// Per-plot selectors let the user surface partials on demand.

import { fetchPackedF16 } from './binfmt.js?v=24';
import { DATA_BASE } from './config.js?v=1';

const PLOTLY_CONFIG = {
  displaylogo: false,
  responsive:  true,
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
};

const LAYOUT_BASE = {
  paper_bgcolor: '#171a21',
  plot_bgcolor:  '#0f1115',
  font: {
    family: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    color:  '#e6e8ec',
    size:   12,
  },
  margin: { l: 48, r: 12, t: 24, b: 36 },
  legend: { bgcolor: 'rgba(0,0,0,0)', font: { size: 11 } },
  hovermode: 'closest',
  xaxis: { gridcolor: '#2a2f3a', zerolinecolor: '#2a2f3a' },
  yaxis: { gridcolor: '#2a2f3a', zerolinecolor: '#2a2f3a' },
};

const PALETTE = [
  '#4f8cff', '#65d6ad', '#f0b541', '#ff8a80',
  '#ce93d8', '#80cbc4', '#ffd54f', '#82b1ff',
];
const TOTAL_COLOR = '#e6e8ec';

function colorAt(i) { return PALETTE[i % PALETTE.length]; }

// Triplet labelling: A–B–C with B at the apex (center).  Standard
// crystallography/chemistry convention; supersedes the JSON's stored
// `B(A–C)` style so we can change format without re-enriching.
function tripletLabel(payload, p) {
  const s = payload.species_label;
  return `${s[p.n1]}–${s[p.center]}–${s[p.n2]}`;
}


// ─── Concentration-weighted totals ─────────────────────────────────────────


function concentrations(payload) {
  const N = payload.species_count.reduce((a, b) => a + b, 0);
  return payload.species_count.map((n) => n / N);
}

function totalGr(payload) {
  const c = concentrations(payload);
  const out = new Array(payload.r_grid.length).fill(0);
  let totW = 0;
  for (const p of payload.pdf) {
    const w = (p.i === p.j) ? c[p.i] * c[p.i] : 2 * c[p.i] * c[p.j];
    totW += w;
    for (let k = 0; k < out.length; k++) out[k] += w * p.y[k];
  }
  return out.map((v) => v / Math.max(totW, 1e-12));
}

function totalAdf(payload) {
  const c = concentrations(payload);
  const out = new Array(payload.phi_grid_deg.length).fill(0);
  let totW = 0;
  for (const p of payload.adf) {
    const w = c[p.center] * c[p.n1] * c[p.n2] * (p.n1 === p.n2 ? 1 : 2);
    totW += w;
    for (let k = 0; k < out.length; k++) out[k] += w * p.y[k];
  }
  return out.map((v) => v / Math.max(totW, 1e-12));
}

function totalG3(payload) {
  if (!payload.g3 || !payload.g3.length) return null;
  const c = concentrations(payload);
  const nPhi = payload.g3[0].z.length;
  const nR   = payload.g3[0].z[0].length;
  const out = Array.from({ length: nPhi }, () => new Array(nR).fill(0));
  let totW = 0;
  for (const p of payload.g3) {
    const w = c[p.center] * c[p.n1] * c[p.n2] * (p.n1 === p.n2 ? 1 : 2);
    totW += w;
    for (let i = 0; i < nPhi; i++) {
      const row = p.z[i];
      const oRow = out[i];
      for (let j = 0; j < nR; j++) oRow[j] += w * row[j];
    }
  }
  const inv = 1 / Math.max(totW, 1e-12);
  for (let i = 0; i < nPhi; i++) {
    for (let j = 0; j < nR; j++) out[i][j] *= inv;
  }
  return out;
}


// ─── Client-side g3 re-slicing (movable shell range) ──────────────────────

function sliceG3PerTriplet(counts, shellMask, rGrid, phiDeg) {
  // counts: nested [n_r][n_r][n_phi] int array
  // returns (n_phi × n_r) Float32Array (row-major: phi outer, r inner)
  const nR   = rGrid.length;
  const nPhi = phiDeg.length;
  const img = new Float64Array(nPhi * nR);
  for (let r = 0; r < nR; r++) {
    for (let s = 0; s < nR; s++) {
      if (shellMask[s]) {
        const planeRow = counts[s][r];
        const planeCol = counts[r][s];
        for (let ip = 0; ip < nPhi; ip++) {
          img[ip * nR + r] += planeRow[ip] + planeCol[ip];
        }
      }
    }
  }
  // Divide by sin(φ) · r² Jacobian.
  for (let ip = 0; ip < nPhi; ip++) {
    const sinPhi = Math.max(Math.sin(phiDeg[ip] * Math.PI / 180), 1e-3);
    for (let r = 0; r < nR; r++) {
      const r2 = Math.max(rGrid[r] * rGrid[r], 1e-12);
      img[ip * nR + r] /= sinPhi * r2;
    }
  }
  // Rescale by asymptotic tail mean (r > 0.6 · r_max) so the bulk → 1.
  const rTail = 0.6 * rGrid[nR - 1];
  let sum = 0, count = 0;
  for (let r = 0; r < nR; r++) {
    if (rGrid[r] > rTail) {
      for (let ip = 0; ip < nPhi; ip++) {
        const v = img[ip * nR + r];
        if (Number.isFinite(v)) { sum += v; count++; }
      }
    }
  }
  const scale = count > 0 ? sum / count : 1.0;
  const inv = scale > 1e-12 ? 1.0 / scale : 1.0;
  for (let k = 0; k < img.length; k++) img[k] *= inv;
  return img;
}

function sliceG34D(payload, shellLoA, shellHiA, total /* bool */, tripletIdx) {
  // Compute either the Total or a single-triplet slice from the 4D data
  // for the requested shell range.  Returns 2-D z (n_phi rows × n_r cols).
  const g4 = payload.g3_4d;
  if (!g4) return null;
  const rGrid  = g4.r_grid;
  const phiDeg = g4.phi_grid_deg;
  const nR     = rGrid.length;
  const nPhi   = phiDeg.length;

  const shellMask = rGrid.map((r) => r >= shellLoA && r <= shellHiA);
  if (!shellMask.some(Boolean)) shellMask[Math.floor(nR * 0.2)] = true;

  // Per-triplet slice
  function tripletSlice(idx) {
    return sliceG3PerTriplet(g4.triplets[idx].counts, shellMask, rGrid, phiDeg);
  }

  let flat;
  if (total) {
    const c = concentrations(payload);
    const out = new Float64Array(nPhi * nR);
    let totW = 0;
    for (let ti = 0; ti < g4.triplets.length; ti++) {
      const t = g4.triplets[ti];
      const w = c[t.center] * c[t.n1] * c[t.n2] * (t.n1 === t.n2 ? 1 : 2);
      totW += w;
      const slc = tripletSlice(ti);
      for (let k = 0; k < out.length; k++) out[k] += w * slc[k];
    }
    const inv = 1 / Math.max(totW, 1e-12);
    for (let k = 0; k < out.length; k++) out[k] *= inv;
    flat = out;
  } else {
    flat = tripletSlice(tripletIdx);
  }
  // Reshape flat (n_phi × n_r) → nested array Plotly expects (rows = phi).
  const z = new Array(nPhi);
  for (let ip = 0; ip < nPhi; ip++) {
    z[ip] = Array.from(flat.subarray(ip * nR, (ip + 1) * nR));
  }
  return { z, rGrid, phiDeg };
}


// ─── Reusable controls ─────────────────────────────────────────────────────


function renderCheckboxControls(ctlEl, items, defaultSelected, onChange) {
  ctlEl.innerHTML = `
    <span class="ctrl-label">curves</span>
    ${items.map((it) => `
      <label>
        <input type="checkbox" data-key="${it.key}"
               ${defaultSelected.has(it.key) ? 'checked' : ''}>
        ${it.label}
      </label>
    `).join('')}`;
  ctlEl.querySelectorAll('input').forEach((cb) => {
    cb.addEventListener('change', () => {
      const set = new Set();
      ctlEl.querySelectorAll('input:checked').forEach((c) => {
        const k = c.dataset.key;
        set.add(k === 'total' ? 'total' : Number(k));
      });
      onChange(set);
    });
  });
}


// ─── g(r) ──────────────────────────────────────────────────────────────────


function pdfTraces(payload, selection) {
  const traces = [];
  if (selection.has('total')) {
    traces.push({
      type: 'scatter', mode: 'lines',
      x: payload.r_grid, y: totalGr(payload),
      name: 'Total',
      line: { color: TOTAL_COLOR, width: 2 },
      hovertemplate: 'r : %{x:.2f} Å<br>g(r) : %{y:.2f}<extra></extra>',
    });
  }
  payload.pdf.forEach((p, idx) => {
    if (selection.has(idx)) {
      traces.push({
        type: 'scatter', mode: 'lines',
        x: payload.r_grid, y: p.y,
        name: p.label,
        line: { color: colorAt(idx), width: 1.6 },
        hovertemplate: 'r : %{x:.2f} Å<br>g(r) : %{y:.2f}<extra></extra>',
      });
    }
  });
  return traces;
}

// g₃ shell shading on g(r) is hidden while g₃ is deferred (not yet computed).
// Flip SHOW_G3_SHELL to true to restore the yellow root-bond shell + "g₃ shell" label.
const SHOW_G3_SHELL = false;

function pdfShapesAndAnnotations(payload, shell) {
  const shapes = [{
    type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1,
    y0: 1, y1: 1, line: { color: '#9aa0aa', width: 0.7, dash: 'dot' },
  }];
  const annotations = [];
  const sLo = shell?.lo ?? payload.root_bond_lo_A;
  const sHi = shell?.hi ?? payload.root_bond_hi_A;
  if (SHOW_G3_SHELL && sLo != null && sHi != null) {
    shapes.push({
      type: 'rect', xref: 'x', yref: 'paper',
      x0: sLo, x1: sHi,
      y0: 0, y1: 1,
      fillcolor: 'rgba(240, 181, 65, 0.22)',
      line: { color: 'rgba(240, 181, 65, 0.55)', width: 1 },
      layer: 'below',
    });
    annotations.push({
      x: (sLo + sHi) / 2, y: 1.02,
      xref: 'x', yref: 'paper',
      text: `g₃ shell ${sLo.toFixed(2)}–${sHi.toFixed(2)} Å`,
      showarrow: false,
      font: { size: 10, color: '#f0b541' },
    });
  }
  return { shapes, annotations };
}

function pdfLayout(payload, shell) {
  const { shapes, annotations } = pdfShapesAndAnnotations(payload, shell);
  const rMax = payload.r_grid[payload.r_grid.length - 1];
  return {
    ...LAYOUT_BASE,
    // Header dropped — axis labels + the section title in the meta
    // panel already carry the identity; the header was redundant.
    height: 220,
    margin: { ...LAYOUT_BASE.margin, t: 8 },
    // dragmode:false kills Plotly's box-zoom so our mousedown handler
    // can drive the shell range instead.  fixedrange on both axes
    // suppresses the cursor change and any double-click-to-autoscale.
    dragmode: false,
    xaxis: { ...LAYOUT_BASE.xaxis, title: 'r (Å)', range: [0, rMax * 0.9], fixedrange: true },
    yaxis: { ...LAYOUT_BASE.yaxis, title: 'g(r)', fixedrange: true },
    shapes, annotations,
  };
}

function pdfPlot(divId, payload, selection, shell) {
  return window.Plotly.react(divId, pdfTraces(payload, selection),
                              pdfLayout(payload, shell), PLOTLY_CONFIG);
}

// Cheap shell-only update: just patches the rectangle + annotation on
// the existing plot.  Avoids the full Plotly.react diff during drag.
function pdfRelayoutShell(divId, payload, shell) {
  const { shapes, annotations } = pdfShapesAndAnnotations(payload, shell);
  return window.Plotly.relayout(divId, { shapes, annotations });
}


// ─── ADF ───────────────────────────────────────────────────────────────────


function adfTraces(payload, selection) {
  const traces = [];
  if (selection.has('total')) {
    traces.push({
      type: 'scatter', mode: 'lines',
      x: payload.phi_grid_deg, y: totalAdf(payload),
      name: 'Total',
      line: { color: TOTAL_COLOR, width: 2 },
      hovertemplate: 'φ : %{x:.1f}°<br>ADF : %{y:.4f}<extra></extra>',
    });
  }
  payload.adf.forEach((p, idx) => {
    if (selection.has(idx)) {
      const lab = tripletLabel(payload, p);
      traces.push({
        type: 'scatter', mode: 'lines',
        x: payload.phi_grid_deg, y: p.y,
        name: lab,
        line: { color: colorAt(idx), width: 1.6 },
        hovertemplate: 'φ : %{x:.1f}°<br>ADF : %{y:.4f}<extra></extra>',
      });
    }
  });
  return traces;
}

function adfLayout() {
  return {
    ...LAYOUT_BASE,
    height: 220,
    margin: { ...LAYOUT_BASE.margin, t: 8 },
    dragmode: false,
    xaxis: { ...LAYOUT_BASE.xaxis, title: 'bond angle φ (deg)',
             range: [0, 180], fixedrange: true },
    yaxis: { ...LAYOUT_BASE.yaxis, title: 'ADF(φ)  [area-normalised]',
             fixedrange: true },
  };
}

function adfPlot(divId, payload, selection) {
  return window.Plotly.react(divId, adfTraces(payload, selection),
                              adfLayout(), PLOTLY_CONFIG);
}


// ─── g₃ ────────────────────────────────────────────────────────────────────


const G3_SCALE = [
  [0.00, '#1f4e79'],
  [0.25, '#88b4d1'],
  [0.50, '#f7f7f7'],
  [0.75, '#f4a261'],
  [1.00, '#b2182b'],
];

function g3Plot(divId, payload, tripletKey, zMax, shell) {
  if (!payload.g3 || !payload.g3.length) {
    const el = document.getElementById(divId);
    el.innerHTML = '<div class="plots-empty">g₃ unavailable — not yet computed</div>';
    el.style.minHeight = '0';   // collapse the empty box (esp. on mobile)
    return Promise.resolve();
  }
  let label, z, r_g3, phi;
  // If 4D data is shipped AND the user is on a custom shell range,
  // slice live; otherwise fall back to the pre-baked 2D heatmap.
  const useLive = payload.g3_4d && shell && (
    shell.lo !== payload.root_bond_lo_A || shell.hi !== payload.root_bond_hi_A
  );
  if (useLive) {
    const isTotal = (tripletKey === 'total');
    const idx = isTotal ? 0 : Number(tripletKey);
    const sliced = sliceG34D(payload, shell.lo, shell.hi, isTotal, idx);
    if (sliced) {
      z = sliced.z;
      r_g3 = sliced.rGrid;
      phi  = sliced.phiDeg;
      label = isTotal ? 'Total' : tripletLabel(payload, payload.g3[idx]);
    }
  }
  if (z == null) {
    r_g3 = payload.r_grid_g3 ?? payload.r_grid;
    phi  = payload.phi_grid_deg;
    if (tripletKey === 'total') {
      label = 'Total';
      z = totalG3(payload);
    } else {
      const p = payload.g3[tripletKey];
      label = tripletLabel(payload, p);
      z = p.z;
    }
  }
  const trace = {
    type: 'heatmap',
    x: r_g3, y: phi, z,
    colorscale: G3_SCALE,
    zmin: 0.0, zmid: 1.0, zmax: zMax,
    zsmooth: 'fast',
    showscale: true,
    colorbar: {
      title: 'density', thickness: 12, len: 0.9,
      x: 1.02, xanchor: 'left', outlinewidth: 0,
    },
    name: label,
    hovertemplate: 'r=%{x:.2f} Å, φ=%{y:.1f}°, density=%{z:.2f}<extra>' + label + '</extra>',
  };
  const layout = {
    ...LAYOUT_BASE,
    margin: { ...LAYOUT_BASE.margin, r: 60 },
    title: { text: `g₃(r, φ) — ${label}`, x: 0.01, font: { size: 13, color: '#9aa0aa' } },
    height: 220,
    xaxis: { ...LAYOUT_BASE.xaxis, title: 'r (Å)' },
    yaxis: { ...LAYOUT_BASE.yaxis, title: 'φ (deg)', range: [0, 180] },
  };
  return window.Plotly.react(divId, [trace], layout, PLOTLY_CONFIG);
}


// ─── Lazy fetch for the 4D g3 (shipped separately to keep first paint light)


function ensureG34D(payload, baseUrl, statusEl) {
  // Returns a Promise that resolves once payload.g3_4d is populated.
  // Three cases:
  //   1. payload.g3_4d already present (inline / old JSONs) → no-op
  //   2. payload.has_g3_4d → fetch <stem>.g3_4d.json once, cache promise
  //   3. neither → resolve null
  if (payload.g3_4d) return Promise.resolve(payload.g3_4d);
  if (!payload.has_g3_4d) return Promise.resolve(null);
  if (payload._g3_4d_promise) return payload._g3_4d_promise;
  if (statusEl) statusEl.textContent = '· loading 4D g₃ …';
  // Prefer packed float16 (deploy format); fall back to legacy .g3_4d.json.
  const f16Url  = baseUrl.replace(/\.pdf\.json$/, '.g3_4d.f16.gz');
  const jsonUrl = baseUrl.replace(/\.pdf\.json$/, '.g3_4d.json');
  payload._g3_4d_promise = fetchPackedF16(f16Url)
    .catch(() => null)
    .then((data) => data || fetch(jsonUrl).then((r) => (r.ok ? r.json() : null)))
    .then((data) => {
      payload.g3_4d = data;
      if (statusEl) statusEl.textContent = data ? '' : '· g₃ not yet computed';
      return data;
    })
    .catch(() => {
      payload._g3_4d_promise = null;
      if (statusEl) statusEl.textContent = '· g₃ not yet computed';
      return null;
    });
  return payload._g3_4d_promise;
}


// ─── Drag-to-set g₃ shell on g(r) ───────────────────────────────────────


function attachShellDrag(divId, payload, shellState, onMove, onCommit) {
  const div = document.getElementById(divId);
  if (!div) return;
  const rMax = payload.r_grid[payload.r_grid.length - 1];
  let dragging = false;
  let startX = null;
  let pendingFrame = null;
  const MIN_DRAG_PX = 3;       // ignore single clicks (no drag)
  let downClientX = 0;

  // Convert (clientX, clientY) → data X, using Plotly's axis offset/length
  // so it works regardless of whether .nsewdrag was instantiated (Plotly
  // may skip it when both axes have fixedrange:true).  Also returns null
  // if the pointer is outside the plot area, so clicks on titles / legends
  // are ignored.
  function inside(clientX, clientY) {
    const divRect = div.getBoundingClientRect();
    const fl = div._fullLayout;
    const ax = fl?.xaxis;
    const ay = fl?.yaxis;
    if (!ax || !ay || ax._offset == null || ay._offset == null) return null;
    const px = clientX - divRect.left;
    const py = clientY - divRect.top;
    if (px < ax._offset || px > ax._offset + ax._length) return null;
    if (py < ay._offset || py > ay._offset + ay._length) return null;
    const frac = (px - ax._offset) / ax._length;
    return ax.range[0] + frac * (ax.range[1] - ax.range[0]);
  }

  function scheduleMove() {
    if (pendingFrame != null) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      onMove();
    });
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    const x = inside(e.clientX, e.clientY);
    if (x == null) return;
    dragging = true;
    downClientX = e.clientX;
    startX = Math.max(0, Math.min(rMax, x));
    e.preventDefault();
  }
  function onMouseMove(e) {
    if (!dragging) return;
    if (Math.abs(e.clientX - downClientX) < MIN_DRAG_PX) return;
    const x = inside(e.clientX, e.clientY) ??
              // outside vertically? still allow the drag — clamp x by
              // recomputing from clientX using axis bounds only:
              (() => {
                const divRect = div.getBoundingClientRect();
                const ax = div._fullLayout?.xaxis;
                if (!ax) return null;
                const frac = (e.clientX - divRect.left - ax._offset) / ax._length;
                return ax.range[0] + Math.max(0, Math.min(1, frac)) *
                                      (ax.range[1] - ax.range[0]);
              })();
    if (x == null) return;
    const xc = Math.max(0, Math.min(rMax, x));
    shellState.lo = Math.min(startX, xc);
    shellState.hi = Math.max(startX, xc);
    scheduleMove();
  }
  function onMouseUp(e) {
    if (!dragging) return;
    dragging = false;
    if (pendingFrame != null) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
    // Only commit if the user actually dragged — bare clicks shouldn't
    // collapse the shell to a 0-width range.
    if (Math.abs(e.clientX - downClientX) >= MIN_DRAG_PX) {
      onCommit();
    }
  }

  div.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}


// ─── Entry point ──────────────────────────────────────────────────────────


export async function renderPlotsForXYZ(xyzPath, hostElId) {
  const jsonUrl = DATA_BASE + xyzPath.replace(/\.xyz$/, '.pdf.json');
  const host = document.getElementById(hostElId);
  if (!host) return;

  const resp = await fetch(jsonUrl);
  if (!resp.ok) {
    host.innerHTML = `
      <div class="plots-empty">
        no enrichment data yet — run
        <code>python site/tools/enrich_pdf_adf.py</code>
        to compute g(r), ADF, g₃ for this structure.
      </div>`;
    return;
  }
  const payload = await resp.json();
  if (!window.Plotly) throw new Error('Plotly not loaded');

  // Regimes cell sits in the 2×2 grid alongside g3 (row 2, col 2)
  // so the previously-empty tile is used.  structure.js's
  // renderRegimePanel targets #regimes-plot inside this cell.
  host.innerHTML = `
    <div class="plots-grid">
      <div class="plot-row plot-pdf-cell">
        <div id="plot-pdf" class="plot"></div>
        <div id="plot-pdf-controls" class="plot-controls"></div>
      </div>
      <div class="plot-row plot-adf-cell">
        <div id="plot-adf" class="plot"></div>
        <div id="plot-adf-controls" class="plot-controls"></div>
      </div>
      <div class="plot-row plot-g3-cell">
        <div id="plot-g3" class="plot"></div>
        <div id="plot-g3-controls" class="plot-controls"></div>
      </div>
      <div class="plot-row plot-regimes-cell">
        <div class="regimes-title">
          <span class="ctrl-label">MACE energy across disorder regimes</span>
          <span class="regimes-mp"></span>
        </div>
        <div id="regimes-plot" class="regimes-plot"></div>
      </div>
    </div>
  `;

  // Shell state shared by the g(r) band overlay and the g₃ slice.  Defaults
  // to the root-bond window the enrichment writer detected; user-editable
  // by click-dragging on the g(r) plot.  When 4D data is present, dragging
  // re-slices g₃ on release.
  const shellState = {
    lo: payload.root_bond_lo_A ?? 1.0,
    hi: payload.root_bond_hi_A ?? 2.5,
  };
  const G3_ZMAX_DEFAULT = 10;
  const g3State = { key: 'total', zMax: G3_ZMAX_DEFAULT };

  function refreshPdfBand(selection) {
    pdfPlot('plot-pdf', payload, selection, shellState);
  }
  function refreshG3() {
    g3Plot('plot-g3', payload, g3State.key, g3State.zMax, shellState);
  }

  // ── g(r) ────────────────────────────────────────────────────────────────
  const pdfSelection = new Set(['total']);
  await pdfPlot('plot-pdf', payload, pdfSelection, shellState);
  const pdfCtl = document.getElementById('plot-pdf-controls');
  renderCheckboxControls(
    pdfCtl,
    [{ key: 'total', label: 'Total' },
     ...payload.pdf.map((p, idx) => ({ key: String(idx), label: p.label }))],
    new Set(['total']),
    (sel) => {
      pdfSelection.clear();
      for (const k of sel) pdfSelection.add(k);
      refreshPdfBand(pdfSelection);
    }
  );

  // ── Reset button for the shell (drag sets it; reset returns to default)
  let shellStatusEl = null;
  if (payload.root_bond_lo_A != null) {
    const wrap = document.createElement('span');
    wrap.className = 'shell-controls';
    wrap.innerHTML = `
      <span class="ctrl-divider"></span>
      <span class="ctrl-label">g₃ shell</span>
      <button type="button" class="seg-btn" data-shell-reset>reset</button>
      <span class="shell-status"></span>
    `;
    pdfCtl.appendChild(wrap);
    shellStatusEl = wrap.querySelector('.shell-status');
    wrap.querySelector('button[data-shell-reset]').addEventListener('click', () => {
      shellState.lo = payload.root_bond_lo_A;
      shellState.hi = payload.root_bond_hi_A;
      refreshPdfBand(pdfSelection);
      refreshG3();
    });
  }

  // Drag handler — yellow band moves live during drag (cheap relayout),
  // g₃ heatmap re-slices on mouseup (one expensive render).  First drag
  // triggers the 4D fetch if not yet loaded; subsequent drags hit cache.
  attachShellDrag(
    'plot-pdf', payload, shellState,
    /* onMove */ () => pdfRelayoutShell('plot-pdf', payload, shellState),
    /* onCommit */ async () => {
      pdfRelayoutShell('plot-pdf', payload, shellState);
      await ensureG34D(payload, jsonUrl, shellStatusEl);
      refreshG3();
    }
  );

  // ── ADF ─────────────────────────────────────────────────────────────────
  const adfSelection = new Set(['total']);
  await adfPlot('plot-adf', payload, adfSelection);
  renderCheckboxControls(
    document.getElementById('plot-adf-controls'),
    [{ key: 'total', label: 'Total' },
     ...payload.adf.map((p, idx) => ({ key: String(idx), label: tripletLabel(payload, p) }))],
    new Set(['total']),
    (sel) => { adfPlot('plot-adf', payload, sel); }
  );

  // ── g₃ (single-select triplet + max + shell-driven re-slice) ──────────
  await g3Plot('plot-g3', payload, g3State.key, g3State.zMax, shellState);

  const g3Ctl = document.getElementById('plot-g3-controls');
  if (payload.g3 && payload.g3.length) {
    g3Ctl.innerHTML = `
      <label>triplet
        <select>
          <option value="total" selected>Total</option>
          ${payload.g3.map((p, i) =>
            `<option value="${i}">${tripletLabel(payload, p)}</option>`
          ).join('')}
        </select>
      </label>
      <label>max <input type="number" value="${G3_ZMAX_DEFAULT}" step="1" min="1" max="500"></label>`;
    const sel = g3Ctl.querySelector('select');
    const inp = g3Ctl.querySelector('input');
    sel.addEventListener('change', () => {
      g3State.key = sel.value === 'total' ? 'total' : Number(sel.value);
      refreshG3();
    });
    inp.addEventListener('input', () => {
      g3State.zMax = Math.max(1, Number(inp.value) || G3_ZMAX_DEFAULT);
      window.Plotly.restyle('plot-g3', { zmax: g3State.zMax }).then(() =>
        window.Plotly.relayout('plot-g3', { 'margin.r': 60 })
      );
    });
  }
}
