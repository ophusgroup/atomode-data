// Structure detail page: load metadata from DuckDB, render single-snapshot 3D.

// Cache busters on imports — without them, browsers cache the *modules*
// independently of the entry-point script's ?v=N, so plots.js/regimes.js
// edits don't take effect even after a hard reload.  Bump VER below to
// force a full module-graph refetch.
import { initDB, query } from './db.js?v=24';
import { renderPlotsForXYZ } from './plots.js?v=29';
import { renderRegimePanel } from './regimes.js?v=27';
import { StructureViewer } from './viewer.js?v=30';
import { renderDPs } from './dps.js?v=30';
import { downloadStructureXYZ, xyzqUrlFor } from './xyzdl.js?v=2';

const PARQUET_PATH = 'data/dataset.parquet';

// Diffraction patterns are kept OUT of the shared/deployed browser for now
// (only ~41% of structures have them; personal-use only). The code, the
// dps-host section, and the data all remain — flip SHOW_DPS to true to
// re-enable locally. When deploying, also exclude site/data/dps/ from upload.
const SHOW_DPS = false;

function getStructureId() {
  const p = new URLSearchParams(window.location.search);
  return p.get('id');
}

function renderMetadata(row) {
  document.getElementById('title').textContent =
    `${row.composition} · ${row.mp_id}`;
  document.getElementById('subtitle').textContent = row.structure_id;
  document.title = `atomode browser — ${row.structure_id}`;

  const badges = document.getElementById('badges');
  badges.innerHTML = '';   // regime + seed now live in the dl below

  // MRO known-issue banner (incorrect relative density, will be regenerated).
  const mroBanner = document.getElementById('mro-banner');
  if (mroBanner) {
    mroBanner.innerHTML = row.regime === 'MRO'
      ? '<div class="caveat page" role="note"><span class="caveat-icon">⚠</span>'
        + '<div><strong>MRO regime — known issue.</strong> This structure was generated with an '
        + 'incorrect relative density (0.88 instead of the intended 0.92). Its structure, g(r)/ADF, '
        + 'energies and diffraction are <strong>provisional and will be regenerated</strong>.</div></div>'
      : '';
  }

  const dl = document.getElementById('meta-dl');
  dl.innerHTML = '';
  const fmtNum = (v, unit, dp = 3) =>
    (v == null || Number.isNaN(v) ? 'NaN' : Number(v).toFixed(dp)) + (unit ? ` ${unit}` : '');
  const fmtPlusMinus = (m, s, unit, dp = 3) => {
    const mt = (m == null || Number.isNaN(m)) ? 'NaN' : Number(m).toFixed(dp);
    const st = (s == null || Number.isNaN(s)) ? 'NaN' : Number(s).toFixed(dp);
    return `${mt} ± ${st}${unit ? ` ${unit}` : ''}`;
  };
  const rows = [
    ['Composition',         row.composition],
    ['MP-ID',               row.mp_id],
    ['Regime',              row.regime === 'MRO' ? 'MRO ⚠ (provisional)' : row.regime],
    ['N atoms',             Number(row.n_atoms).toLocaleString()],
    ['Cell (Å)',           `${row.cell_a.toFixed(2)} × ${row.cell_b.toFixed(2)} × ${row.cell_c.toFixed(2)}`],
    ['ρ',                  `${row.density.toFixed(4)} at/Å³`],
    ['Seed',                row.seed],
    ['Iterations',          row.n_iter],
    ['MACE E/atom',        fmtPlusMinus(row.mace_energy_per_atom_eV_mean,
                                        row.mace_energy_per_atom_eV_std, 'eV')],
    ['MACE |F|_max',       fmtNum(row.mace_fmax_eV_per_A_max, 'eV/Å')],
    ['MACE |F|_mean',      fmtNum(row.mace_fmax_eV_per_A_mean, 'eV/Å')],
    ['Generated',           row.generated_at],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }

  // Rebuild a standard .xyz client-side from the hosted xyzq (display precision;
  // exact float64 via email — see the note under the button).
  const dlBtn = document.getElementById('download-xyz');
  dlBtn.href = '#';
  dlBtn.removeAttribute('download');
  dlBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const prev = dlBtn.textContent;
    dlBtn.textContent = '↓ building…';
    try {
      await downloadStructureXYZ(xyzqUrlFor(row.xyz_path), row.structure_id);
    } catch (err) {
      console.error(err);
      alert('Download failed: ' + err.message);
    }
    dlBtn.textContent = prev;
  });
}

// Polyhedra view: still uses the atomode Three.js template served in an
// iframe (that's the visualisation the user liked for grain boundaries).
// Files above this byte-count are gated behind a click since the atomode
// template parses the whole atom set into a Three.js InstancedMesh
// synchronously — 40+ MB inline JSON freezes the tab on load.
//
// Atoms view: 3Dmol.js impostor renderer — handles 300k atoms fine
// without a gate (billboarded quads instead of full sphere meshes).
const VIEWER_HEAVY_BYTES = 5 * 1024 * 1024;

async function loadStructureViewer(row) {
  const xyzPath = row.xyz_path;
  const state = { view: 'atoms', camera: 'persp', armed: false };
  const bust = (new URLSearchParams(window.location.search)).get('_') || '';
  const frame  = document.getElementById('viewer-frame');
  const dmDiv  = document.getElementById('viewer-3dmol');
  if (!frame || !dmDiv) return;

  const wrap = frame.parentElement;   // .viewer-wrap
  let gateEl = null;
  let dmol = null;                    // lazy StructureViewer instance

  function polyUrl() {
    const url = xyzPath.replace(/\.xyz$/, '.poly.html');
    // Cache-bust on every viewer template change — the atomode Three.js
    // template patches change occasionally (slice postMessage, low-poly,
    // outline drop) and Chrome caches 40 MB iframe HTMLs aggressively.
    // Bump the `v` value whenever build_viewer_html.py's template
    // patches change.
    const params = new URLSearchParams({ camera: state.camera, v: '23' });
    if (bust) params.set('_', bust);
    return `${url}?${params.toString()}`;
  }

  async function polyStatus() {
    // Returns {ok: bool, bytes: number|null}.  ok=false means the file
    // isn't prebuilt — only S / SiO2 have .poly.html in the current
    // dataset since generating one 42 MB HTML per structure across 32 k
    // rows isn't feasible.
    try {
      const r = await fetch(polyUrl(), { method: 'HEAD', cache: 'no-store' });
      if (!r.ok) return { ok: false, bytes: null };
      const n = Number(r.headers.get('content-length'));
      return { ok: true, bytes: Number.isFinite(n) ? n : null };
    } catch { return { ok: false, bytes: null }; }
  }

  function showGate(bodyHtml) {
    // Generic overlay: default is the "Load polyhedra viewer" button
    // that triggers the iframe fetch, but the caller can pass custom
    // HTML (e.g. a "not available" message) for the not-prebuilt case.
    frame.src = 'about:blank';
    if (gateEl) gateEl.remove();
    gateEl = document.createElement('div');
    gateEl.className = 'viewer-gate';
    gateEl.innerHTML = bodyHtml ??
      '<button class="viewer-gate-btn" type="button">Load polyhedra viewer</button>';
    wrap.appendChild(gateEl);
    const btn = gateEl.querySelector('.viewer-gate-btn[data-load]');
    if (btn) {
      btn.addEventListener('click', () => {
        state.armed = true;
        gateEl.remove();
        gateEl = null;
        frame.src = polyUrl();
      });
      return;
    }
    // Default button (no data-load attr) still loads the iframe.
    const defaultBtn = gateEl.querySelector('button');
    if (defaultBtn) {
      defaultBtn.addEventListener('click', () => {
        state.armed = true;
        gateEl.remove();
        gateEl = null;
        frame.src = polyUrl();
      });
    }
  }

  function clearGate() {
    if (gateEl) { gateEl.remove(); gateEl = null; }
  }

  async function showPoly() {
    // Polyhedra ALWAYS goes through the gate — the atomode Three.js
    // template renders instanced meshes for every atom + polyhedron,
    // which can take 5-60 s to first-frame at production scale.  The
    // gate makes the "I meant to trigger this heavy render" explicit.
    dmDiv.style.display = 'none';
    frame.style.display = 'block';
    // Every time the iframe finishes loading (either initial poly load
    // or a subsequent switch), forward the current slice so the patched
    // template's postMessage listener picks it up.  Fresh listener each
    // load so `once:true` never fires more than intended.
    const forward = () => {
      try {
        frame.contentWindow?.postMessage(
          { type: 'slice', axis: sliceState.axis, lo: sliceState.lo, hi: sliceState.hi },
          '*'
        );
      } catch { /* cross-origin quirk — ignore */ }
    };
    frame.addEventListener('load', forward, { once: true });
    if (state.armed) {
      clearGate();
      frame.src = polyUrl();
      return;
    }
    const st = await polyStatus();
    if (!st.ok) {
      // .poly.html not prebuilt for this structure — show a helpful
      // gate message instead of silently switching to atoms.  Users can
      // still flip back to the atoms tab; keeping poly enabled preserves
      // the invitation to view it once the file gets built.
      showGate(
        '<div class="viewer-gate-msg">' +
        '  <div class="viewer-gate-title">Polyhedra viewer not yet built</div>' +
        '  <div class="viewer-gate-hint">' +
        '    Only a small curated set of structures has the polyhedra' +
        '    viewer prebuilt (it is a 40 MB HTML per structure).' +
        '    Switch to <b>atoms</b> to view this cell now.' +
        '  </div>' +
        '</div>'
      );
      return;
    }
    // File exists — always gate the load (heavy render, up to 42 MB
    // inline JSON parse + 100 M+ triangles).  Prior behaviour skipped
    // the gate for small files; standardising on the gate keeps the
    // "you sure? this is slow" affordance consistent for all polyhedra
    // clicks.
    const mb = st.bytes ? (st.bytes / 1e6).toFixed(1) : null;
    const size = mb ? ` (${mb} MB)` : '';
    showGate(
      `<button class="viewer-gate-btn" type="button">Load polyhedra viewer${size}</button>`
    );
  }

  async function showAtoms() {
    clearGate();
    frame.style.display = 'none';
    frame.src = 'about:blank';
    dmDiv.style.display = 'block';
    if (!dmol) {
      if (!window.$3Dmol) {
        dmDiv.innerHTML =
          '<div style="color:#eee;padding:40px;text-align:center;font-family:monospace">'
          + '3Dmol.js failed to load</div>';
        return;
      }
      dmol = new StructureViewer('viewer-3dmol');
      await dmol.loadXYZ(xyzPath);
      // dmol's own bounds now available — apply the current UI slice
      // so the 3Dmol view matches whatever the user already set while
      // in the polyhedra view.
      dmol.setSlice3(slice3);
    }
    applyCameraToDmol();
  }

  function applyCameraToDmol() {
    if (!dmol || !dmol.viewer || !dmol.viewer.setProjection) return;
    dmol.viewer.setProjection(state.camera === 'ortho' ? 'orthographic' : 'perspective');
    dmol.viewer.render();
  }

  async function refresh() {
    if (state.view === 'atoms') {
      await showAtoms();
    } else {
      await showPoly();
    }
  }

  // Per-axis slice ranges kept in this outer closure so showAtoms +
  // showPoly can read them without needing dmol to exist.  All three
  // axes apply at once; `editAxis` is only which one the sliders
  // currently drive.  Bounds come from the metadata row (cell_a/b/c),
  // available immediately, so the slicer works before atoms is visited.
  const slice3 = { x: [0, 0], y: [0, 0], z: [0, 0] };
  const sliceBounds = { x: [0, 0], y: [0, 0], z: [0, 0] };
  let editAxis = 'z';

  function wireSliceControls(row) {
    // Bounds come from the metadata row's cell diagonal (site parquet).
    // For non-orthogonal cells this loses shear info, but the slicer's
    // job is to hide atoms along a Cartesian axis — cell_a/b/c ≈ axis
    // extent is a good-enough proxy for the production 100×100×400
    // orthogonal cells.
    sliceBounds.x = [0, Number(row.cell_a)];
    sliceBounds.y = [0, Number(row.cell_b)];
    sliceBounds.z = [0, Number(row.cell_c)];

    // Every axis starts at its full extent (no clipping on any axis).
    for (const ax of ['x', 'y', 'z']) slice3[ax] = [...sliceBounds[ax]];

    const bar      = document.getElementById('viewer-controls');
    const loInput  = document.getElementById('slice-lo');
    const hiInput  = document.getElementById('slice-hi');
    const readout  = document.getElementById('slice-readout');
    const resetBtn = document.getElementById('slice-reset');
    let raf = null;

    function broadcast() {
      // Atoms viewer takes the full per-axis range object directly.
      if (dmol) dmol.setSlice3(slice3);
      // Polyhedra iframe: send multi-axis `ranges` (new template) PLUS
      // legacy single-axis {axis,lo,hi} for the edited axis, so pre-existing
      // poly.html (old handler) keeps working until it is rebuilt.
      try {
        frame.contentWindow?.postMessage({
          type: 'slice',
          ranges: slice3,
          axis: editAxis, lo: slice3[editAxis][0], hi: slice3[editAxis][1],
        }, '*');
      } catch { /* iframe on about:blank — showPoly's onload re-sends */ }
    }
    function isClipped(ax) {
      const [blo, bhi] = sliceBounds[ax];
      const [lo, hi] = slice3[ax];
      return lo > blo + 1e-6 || hi < bhi - 1e-6;
    }
    function markButtons() {
      bar.querySelectorAll('[data-slice-axis]').forEach((b) => {
        const ax = b.dataset.sliceAxis;
        b.classList.toggle('active', ax === editAxis);      // which axis edits
        b.classList.toggle('clipped', isClipped(ax));       // which axes clip
      });
    }
    function updateReadout() {
      readout.textContent =
        `${editAxis}: ${Number(loInput.value).toFixed(1)} – ${Number(hiInput.value).toFixed(1)} Å`;
    }
    function loadAxisIntoSliders(ax) {
      const [blo, bhi] = sliceBounds[ax];
      const step = Math.max(0.1, (bhi - blo) / 400);
      for (const el of [loInput, hiInput]) {
        el.min = blo.toFixed(2); el.max = bhi.toFixed(2); el.step = step.toFixed(2);
      }
      const [lo, hi] = slice3[ax];
      loInput.value = lo.toFixed(2);
      hiInput.value = hi.toFixed(2);
      updateReadout();
    }
    function pushSchedule() {
      if (raf == null) raf = requestAnimationFrame(() => {
        raf = null;
        slice3[editAxis] = [Number(loInput.value), Number(hiInput.value)];
        markButtons();
        broadcast();
      });
    }
    // Switching axis only changes which axis the sliders edit — the other
    // axes' ranges are preserved and still applied.
    function selectEditAxis(ax) {
      editAxis = ax;
      loadAxisIntoSliders(ax);
      markButtons();
    }

    selectEditAxis('z');
    broadcast();

    bar.querySelectorAll('[data-slice-axis]').forEach((btn) => {
      btn.addEventListener('click', () => selectEditAxis(btn.dataset.sliceAxis));
    });
    function onInput(who) {
      const lo = Number(loInput.value);
      const hi = Number(hiInput.value);
      if (lo > hi) {
        if (who === 'lo') hiInput.value = loInput.value;
        else              loInput.value = hiInput.value;
      }
      updateReadout();
      pushSchedule();
    }
    loInput.addEventListener('input', () => onInput('lo'));
    hiInput.addEventListener('input', () => onInput('hi'));
    // Reset clears clipping on ALL axes (full-cell view).
    resetBtn.addEventListener('click', () => {
      for (const ax of ['x', 'y', 'z']) slice3[ax] = [...sliceBounds[ax]];
      loadAxisIntoSliders(editAxis);
      markButtons();
      broadcast();
    });
  }

  const wire = (attr, key) => {
    document.querySelectorAll(`#viewer-controls [data-${attr}]`).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const v = btn.dataset[attr];
        if (state[key] === v) return;
        state[key] = v;
        document.querySelectorAll(`#viewer-controls [data-${attr}]`)
          .forEach((b) => b.classList.toggle('active', b.dataset[attr] === v));
        if (attr === 'camera' && state.view === 'atoms') {
          // In-place camera switch on the 3Dmol viewer — no reload needed.
          applyCameraToDmol();
        } else {
          await refresh();
        }
      });
    });
  };
  wire('view',   'view');
  wire('camera', 'camera');
  // Wire slice bar immediately with row-derived bounds so it's live in
  // both the poly iframe and the atoms view.
  wireSliceControls(row);
  await refresh();
}

// requestIdleCallback fallback — Safari and a few older browsers don't
// expose it.  setTimeout(0) still yields the current task and lets the
// iframe's Three.js init grab the main thread first.
const idle = window.requestIdleCallback
  ? (fn) => window.requestIdleCallback(fn, { timeout: 800 })
  : (fn) => setTimeout(fn, 0);

(async () => {
  const id = getStructureId();
  if (!id) {
    document.getElementById('title').textContent = 'no structure id';
    return;
  }
  try {
    await initDB(PARQUET_PATH);
    const rows = await query(`select * from dataset where structure_id = '${id.replace(/'/g, "''")}'`);
    if (!rows.length) {
      document.getElementById('title').textContent = 'not found';
      document.getElementById('subtitle').textContent = id;
      return;
    }
    const row = rows[0];
    renderMetadata(row);

    // Start the iframe FIRST so its Three.js init runs in parallel with
    // our plot/regime work below.  Then defer everything else off the
    // critical path: plots + regime fetch their own data and only need
    // the main thread for parse/render, which happens once the iframe
    // has finished its initial layout.
    loadStructureViewer(row);

    // renderRegimePanel targets #regimes-plot, which lives INSIDE the
    // plots-grid now (created by renderPlotsForXYZ).  Chain regime off
    // the plots promise so its host div exists when we ask for it.
    idle(async () => {
      try {
        await renderPlotsForXYZ(row.xyz_path, 'plots-host');
        await renderRegimePanel(row, 'regimes-plot');
      } catch (e) { console.error('plots+regime', e); }
    });
    if (SHOW_DPS) {
      idle(() => {
        renderDPs(row.structure_id, 'dps-host')
          .catch((e) => console.error('dps', e));
      });
    } else {
      const dh = document.getElementById('dps-host');
      if (dh) dh.style.display = 'none';   // DPs disabled — hide the empty panel
    }
  } catch (err) {
    console.error(err);
    document.getElementById('title').textContent = 'error';
    document.getElementById('subtitle').textContent = err.message;
  }
})();
