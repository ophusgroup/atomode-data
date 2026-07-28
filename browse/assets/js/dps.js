// Diffraction-pattern viewer.
//
// Reads data/dps/{structure_id}/manifest.json (written by
// tools/enrich_dps.py).  Section stays hidden if the manifest is
// missing — DPs may not have been transferred/generated yet.
//
// UI layout:
//   [ thickness ▏ 50   100   150   ...   400 Å ]
//   [ probe                                    ]     [ big DP image ]
//   [   6×6 grid of gpos buttons                ]
//
// PNGs come from tools/enrich_dps.py.  Each is a 256×256 grayscale
// log-intensity display; the browser stretches to the panel width.
// Cached by URL, so switching probe/thickness after the first load is
// instant.

// Format sim knobs so the panel is copy-paste-friendly for an abtem
// replication script.  Grouped: beam / probe / detector / multislice.
function renderSimPanel(sim) {
  if (!sim) return '';
  const b = sim.beam || {};
  const p = sim.probe || {};
  const d = sim.detector || {};
  const m = sim.multislice || {};
  const s = sim.scan || {};
  const fmt = (v, dp) => (v == null || Number.isNaN(v)) ? '—'
                        : (typeof v === 'number' ? v.toFixed(dp) : v);
  // ms_detector_shape/half_size come from params_ms.json as [[a,b],[c,d]]
  // — two detectors per config.  Collapse to a single row if both entries
  // are identical (usually the case).
  const detShape = Array.isArray(d.shape_px) ? d.shape_px : null;
  const detShapeStr = detShape
    ? (JSON.stringify(detShape[0]) === JSON.stringify(detShape[1])
        ? `${detShape[0][0]} × ${detShape[0][1]} px`
        : detShape.map((sh) => sh.join(' × ')).join(' | '))
    : '—';
  const detSize = Array.isArray(d.half_size_mrad) ? d.half_size_mrad : null;
  const detSizeStr = detSize
    ? (JSON.stringify(detSize[0]) === JSON.stringify(detSize[1])
        ? `± ${detSize[0][0]} mrad`
        : detSize.map((sz) => `± ${sz.join(', ')} mrad`).join(' | '))
    : '—';
  const nGridSide = (sim.n_gpos_side) || null;   // populated by caller if known
  return `
    <details class="dps-sim">
      <summary>sim params (for abtem replication)</summary>
      <div class="dps-sim-grid">
        <div class="dps-sim-group">
          <div class="dps-sim-title">probe</div>
          <dl>
            <dt>energy</dt><dd>${fmt(b.energy_keV, 1)} keV</dd>
            <dt>λ</dt><dd>${fmt(b.wavelength_pm, 4)} pm</dd>
            <dt>semiangle α</dt><dd>${fmt(p.semiangle_mrad, 3)} mrad
              ${Array.isArray(p.semiangle_range_mrad) ? `<span class="dps-sim-hint">(drawn from ${p.semiangle_range_mrad.join('–')} mrad)</span>` : ''}
            </dd>
            <dt>defocus</dt><dd>${fmt(p.defocus_A, 1)} Å</dd>
            <dt>rolloff</dt><dd>${fmt(p.rolloff, 2)}</dd>
            <dt>edge pad</dt><dd>${fmt(p.edge_pad_A, 1)} Å</dd>
          </dl>
        </div>
        <div class="dps-sim-group">
          <div class="dps-sim-title">detector</div>
          <dl>
            <dt>shape</dt><dd>${detShapeStr}</dd>
            <dt>collection</dt><dd>${detSizeStr}</dd>
            <dt>dk</dt><dd>${fmt(d.difamp_sampling_invA, 5)} Å⁻¹/px</dd>
            <dt>FOV</dt><dd>${fmt(d.fov_invA, 3)} Å⁻¹</dd>
          </dl>
        </div>
        <div class="dps-sim-group">
          <div class="dps-sim-title">multislice</div>
          <dl>
            <dt>potential</dt><dd>${m.pot_parametrization ?? '—'}</dd>
            <dt>projection</dt><dd>${m.pot_projection ?? '—'}</dd>
            <dt>pot. sampling</dt><dd>${fmt(m.pot_sampling_A, 3)} Å</dd>
            <dt>slice</dt><dd>${fmt(m.slice_thickness_A, 2)} Å</dd>
            <dt>save every</dt><dd>${fmt(m.save_every_A, 1)} Å</dd>
            <dt>phonons</dt><dd>${fmt(m.n_phonons, 0)}</dd>
          </dl>
        </div>
        <div class="dps-sim-group">
          <div class="dps-sim-title">scan</div>
          <dl>
            <dt>grid step ≥</dt><dd>max(α·r<sub>probe</sub>·${fmt(s.probe_min_sampling_fac, 2)},
              1.5·${fmt(s.rdf_cutoff_A, 1)} Å) </dd>
            <dt>thicknesses</dt><dd>${(sim.sample_thicknesses_A||[]).join(', ')} Å</dd>
          </dl>
        </div>
      </div>
    </details>
  `;
}


export async function renderDPs(structureId, hostElId) {
  const host = document.getElementById(hostElId);
  if (!host) return;

  const base = `data/dps/${encodeURIComponent(structureId)}`;
  let manifest = null;
  try {
    const r = await fetch(`${base}/manifest.json`, { cache: 'no-store' });
    if (r.ok) manifest = await r.json();
  } catch { /* silence — treated as no DPs */ }
  if (!manifest || !manifest.n_gpos || !manifest.n_thk) {
    // No DPs available yet — leave the section blank so page layout
    // isn't disrupted, but log so the user knows this is expected.
    host.innerHTML = '';
    console.info(`[dps] no manifest for ${structureId}`);
    return;
  }

  const gposList = manifest.gpos_indices;
  const thkList  = manifest.thicknesses_A;
  const ext      = manifest.ext || 'png';   // 'webp'/'avif' for deploy-format DPs

  host.innerHTML = `
    <div class="dps-header">
      <span class="ctrl-label">Diffraction patterns</span>
      <span class="dps-meta">${manifest.n_gpos} probe positions ·
        ${manifest.n_thk} thicknesses</span>
    </div>
    <div class="dps-grid">
      <div class="dps-image-wrap">
        <img class="dps-image" alt="DP">
        <div class="dps-caption"></div>
      </div>
      <div class="dps-controls">
        <div class="dps-ctl-row">
          <span class="ctrl-label">thickness</span>
          <div class="dps-thk-buttons"></div>
        </div>
        <div class="dps-ctl-row">
          <span class="ctrl-label">probe position</span>
          <div class="dps-probe-buttons"></div>
        </div>
      </div>
      ${renderSimPanel(manifest.sim)}
    </div>
  `;

  const state = { thk: thkList[0], gpos: gposList[0] };
  const img     = host.querySelector('.dps-image');
  const cap     = host.querySelector('.dps-caption');
  const thkRow  = host.querySelector('.dps-thk-buttons');
  const probeEl = host.querySelector('.dps-probe-buttons');

  // Thickness buttons
  for (const t of thkList) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn';
    b.textContent = `${t} Å`;
    b.dataset.thk = String(t);
    if (t === state.thk) b.classList.add('active');
    b.addEventListener('click', () => {
      state.thk = t;
      thkRow.querySelectorAll('button').forEach((x) =>
        x.classList.toggle('active', Number(x.dataset.thk) === t));
      render();
    });
    thkRow.appendChild(b);
  }

  // Probe position — a simple row of buttons, one per sampled gpos.
  for (const g of gposList) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn';
    b.textContent = String(g);
    b.dataset.gpos = String(g);
    if (g === state.gpos) b.classList.add('active');
    b.addEventListener('click', () => {
      state.gpos = g;
      probeEl.querySelectorAll('button').forEach((x) =>
        x.classList.toggle('active', Number(x.dataset.gpos) === g));
      render();
    });
    probeEl.appendChild(b);
  }

  function render() {
    const g   = String(state.gpos).padStart(2, '0');
    const t   = String(state.thk).padStart(3, '0');
    img.src   = `${base}/gpos${g}_thk${t}A.${ext}`;
    cap.textContent = `gpos${g} · thk ${state.thk} Å`;
  }
  render();
}
