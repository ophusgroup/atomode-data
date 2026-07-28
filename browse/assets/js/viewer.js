// Thin wrapper around 3Dmol.js for single-snapshot extxyz rendering.
//
// 3Dmol is loaded globally from <script> tag in structure.html, exposed as
// `window.$3Dmol`.
//
// Orthographic projection is on by default — perspective foreshortening
// breaks lattice-edge alignment, which is the only reason this viewer
// exists.  Cell box is parsed from the `Lattice="..."` token in the
// extxyz comment line and drawn as a wireframe.

import { fetchXYZQ } from './binfmt.js?v=24';
import { DATA_BASE } from './config.js?v=1';

const ELEMENT_COLORS = {
  H:  0xffffff, He: 0xd9ffff, Li: 0xcc80ff, Be: 0xc2ff00, B:  0xffb5b5,
  C:  0x909090, N:  0x3050f8, O:  0xff0d0d, F:  0x90e050, Na: 0xab5cf2,
  Mg: 0x8aff00, Al: 0xbfa6a6, Si: 0xf0c8a0, P:  0xff8000, S:  0xffff30,
  Cl: 0x1ff01f, K:  0x8f40d4, Ca: 0x3dff00, Ti: 0xbfc2c7, Fe: 0xe06633,
  Ni: 0x50d050, Cu: 0xc88033, Zn: 0x7d80b0, Ga: 0xc28f8f, Ba: 0x00c900,
};

function parseLatticeFromXYZ(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return null;
  const m = lines[1].match(/Lattice\s*=\s*"([^"]+)"/i);
  if (!m) return null;
  const v = m[1].split(/\s+/).map(Number);
  if (v.length < 9) return null;
  return [
    [v[0], v[1], v[2]],
    [v[3], v[4], v[5]],
    [v[6], v[7], v[8]],
  ];
}

function cellCorners(lattice) {
  const [a, b, c] = lattice;
  return [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ].map(([fa, fb, fc]) => ({
    x: fa * a[0] + fb * b[0] + fc * c[0],
    y: fa * a[1] + fb * b[1] + fc * c[1],
    z: fa * a[2] + fb * b[2] + fc * c[2],
  }));
}

function addLatticeBox(viewer, corners) {
  // addLine is sub-pixel-thin at large cell scales (100+ Å) and effectively
  // invisible.  addCylinder draws a real 3D primitive whose radius scales
  // with cell size, so it stays visible whatever the structure size.
  const edges = [
    [0, 1], [0, 2], [0, 3], [1, 4], [1, 5],
    [2, 4], [2, 6], [3, 5], [3, 6], [4, 7],
    [5, 7], [6, 7],
  ];
  let maxExtent = 0;
  for (const p of corners) {
    maxExtent = Math.max(maxExtent, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
  }
  const radius = Math.max(0.05, maxExtent * 0.0008);
  for (const [i, j] of edges) {
    viewer.addCylinder({
      start: corners[i],
      end:   corners[j],
      radius,
      color: 0x9aa0aa,
      fromCap: 1,
      toCap:   1,
    });
  }
}

function addGhostCornerAtoms(viewer, corners) {
  // 3Dmol's zoomTo() fits to the atoms, not to added lines. For sparse
  // structures the cell wireframe falls outside the auto-zoom. Inject 8
  // invisible "X" atoms at the cell corners so the bounding box includes
  // the whole cell; they get hidden by setStyle below.
  const xyz = [String(corners.length), 'ghost'].concat(
    corners.map((p) => `X ${p.x.toFixed(4)} ${p.y.toFixed(4)} ${p.z.toFixed(4)}`)
  ).join('\n');
  viewer.addModel(xyz, 'xyz');
}

function parseAtomsFromXYZ(text) {
  // Return an array of {sym, x, y, z} for every atom.  Skip the two
  // header lines (n_atoms + comment/lattice line).  Parse tolerantly:
  // whitespace-split, any extra columns ignored.
  const lines = text.split('\n');
  const n = parseInt(lines[0].trim(), 10) || 0;
  const atoms = new Array(n);
  for (let i = 0; i < n; i++) {
    const parts = (lines[i + 2] || '').split(/\s+/).filter(Boolean);
    if (parts.length < 4) { atoms[i] = null; continue; }
    atoms[i] = {
      sym: parts[0],
      x: parseFloat(parts[1]),
      y: parseFloat(parts[2]),
      z: parseFloat(parts[3]),
    };
  }
  return atoms.filter(Boolean);
}

function xyzTextFromAtoms(atoms, comment) {
  // Emit a minimal XYZ (n + comment + atoms).  Fixed 4-decimal precision
  // — cheaper string building than sprintf, plenty for viewer.
  const out = new Array(atoms.length + 2);
  out[0] = String(atoms.length);
  out[1] = comment || '';
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    out[i + 2] = `${a.sym} ${a.x.toFixed(4)} ${a.y.toFixed(4)} ${a.z.toFixed(4)}`;
  }
  return out.join('\n');
}

export class StructureViewer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!window.$3Dmol) throw new Error('3Dmol.js not loaded');
    this.viewer = window.$3Dmol.createViewer(this.container, {
      backgroundColor: 'black',
      orthographic: true,
    });
    if (typeof this.viewer.setProjection === 'function') {
      this.viewer.setProjection('orthographic');
    }
    if (typeof this.viewer.setBackgroundColor === 'function') {
      this.viewer.setBackgroundColor('black');
    }
    // Right-drag = pan.  In this 3Dmol build the right button drives zoom,
    // not translate, so panning is implemented here: swallow the context
    // menu, grab the right-button mousedown in the CAPTURE phase so 3Dmol
    // never starts its own zoom-drag (its move handler no-ops while
    // isDragging stays false), then translate the view by the pointer delta.
    this.container.addEventListener('contextmenu', (e) => e.preventDefault());
    let pan = null;
    this.container.addEventListener('mousedown', (e) => {
      if (e.button !== 2) return;                 // right button only
      e.preventDefault();
      e.stopImmediatePropagation();               // hide the down-event from 3Dmol
      pan = { x: e.clientX, y: e.clientY };
    }, true);
    window.addEventListener('mousemove', (e) => {
      if (!pan) return;
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      pan.x = e.clientX; pan.y = e.clientY;
      this.viewer.translate(dx, -dy, 0);          // pan by pointer delta (y inverted)
    }, true);
    window.addEventListener('mouseup', (e) => { if (e.button === 2) pan = null; }, true);
    this.xyzText   = null;
    this.atoms     = null;   // parsed atom list (Array<{sym,x,y,z}>)
    this.lattice   = null;
    this.atomStyle = 'sphere';
    this.atomScale = 0.35;
    // Per-axis slice ranges — each is [lo, hi] in Å, or null for "no
    // clipping" on that axis.  All three apply simultaneously, so the
    // rendered set is the intersection of the active axis windows.
    this.slice = { x: null, y: null, z: null };
  }

  async loadXYZ(url) {
    // Prefer the quantized binary (deploy format); fall back to raw .xyz text.
    const qData = await fetchXYZQ(DATA_BASE + url.replace(/\.xyz$/, '.xyzq.gz')).catch(() => null);
    if (qData) {
      this.xyzText = null;
      this.atoms   = qData.atoms;
      this.lattice = qData.lattice;
    } else {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      this.xyzText = await r.text();
      this.atoms   = parseAtomsFromXYZ(this.xyzText);
      this.lattice = parseLatticeFromXYZ(this.xyzText);
    }
    // Start unclipped; the parent controls (structure.js) push the
    // per-axis ranges via setSlice3() right after load.
    this.slice = { x: null, y: null, z: null };
    this.render({ resetView: true });
  }

  getBounds() {
    // Bounds derived from the LATTICE, not the atom cloud — the lattice
    // is the ground truth for the cell dimensions and the slice needs
    // to snap to it so the wireframe extents match.
    const L = this.lattice || [[1,0,0],[0,1,0],[0,0,1]];
    const axLen = (v) => Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
    return { x: [0, axLen(L[0])], y: [0, axLen(L[1])], z: [0, axLen(L[2])] };
  }

  setSlice3(ranges) {
    // Called by the UI on any slider tick.  `ranges` is {x,y,z} where
    // each entry is [lo, hi] in Å (or null / omitted = no clip on that
    // axis).  All active axes apply at once.  Camera is preserved (no
    // zoomTo / rotate) so scrubbing doesn't reset the view.
    this.slice = {
      x: ranges && ranges.x ? ranges.x : null,
      y: ranges && ranges.y ? ranges.y : null,
      z: ranges && ranges.z ? ranges.z : null,
    };
    this.render({ resetView: false });
  }

  _slicedAtoms() {
    if (!this.atoms) return [];
    const s = this.slice;
    const axes = ['x', 'y', 'z'].filter((ax) => s[ax]);
    if (!axes.length) return this.atoms;
    return this.atoms.filter((a) => {
      for (const ax of axes) {
        const [lo, hi] = s[ax];
        if (lo != null && a[ax] < lo) return false;
        if (hi != null && a[ax] > hi) return false;
      }
      return true;
    });
  }

  render({ resetView = false } = {}) {
    if (!this.atoms) return;
    const sliced = this._slicedAtoms();
    const modelText = xyzTextFromAtoms(sliced, '');
    this.viewer.clear();
    this.viewer.addModel(modelText, 'xyz');
    if (this.lattice) {
      const corners = cellCorners(this.lattice);
      addLatticeBox(this.viewer, corners);
      addGhostCornerAtoms(this.viewer, corners);
    }
    this._applyStyle();
    if (resetView) {
      this.viewer.zoomTo();
      // Default 3Dmol camera looks down -z; rotate so +x → into screen
      // (yz plane visible) — matches the atomode docs orientation.
      this.viewer.rotate(90, 'y', 0);
    }
    this.viewer.render();
  }

  _applyStyle() {
    const colorscheme = { prop: 'elem', map: ELEMENT_COLORS };
    const real = { not: { elem: 'X' } };
    if (this.atomStyle === 'sphere') {
      this.viewer.setStyle(real, { sphere: { scale: this.atomScale, colorscheme } });
    } else if (this.atomStyle === 'stick') {
      this.viewer.setStyle(real, { stick: { radius: 0.15, colorscheme } });
    } else {
      this.viewer.setStyle(real, {
        sphere: { scale: this.atomScale * 0.6, colorscheme },
        stick:  { radius: 0.12, colorscheme },
      });
    }
    this.viewer.setStyle({ elem: 'X' }, {});   // hide ghost corner atoms
  }

  setStyle(style) { this.atomStyle = style; this.render(); }
}
