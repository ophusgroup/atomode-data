// Client-side single-structure .xyz download.
//
// The full float64 .xyz files (~13 MB each, ~300 GB total) aren't hosted. Instead
// we rebuild a standard extended-XYZ in the browser from the xyzq.gz that the 3D
// viewer already downloads. Positions are therefore DISPLAY PRECISION (uint16-
// quantized, ~0.005 Å worst case — well below thermal displacement, but NOT exact
// float64). Exact structures / the full dataset: email ehrdt@stanford.edu.

import { fetchXYZQ } from './binfmt.js?v=24';
import { DATA_BASE } from './config.js?v=1';

export function xyzqUrlFor(xyzPath) {
  return DATA_BASE + xyzPath.replace(/\.xyz$/, '.xyzq.gz');
}

export function xyzqToExtxyz({ atoms, lattice }, structureId = '') {
  const lat = lattice.flat().map((v) => Number(v).toFixed(6)).join(' ');
  const header =
    `Lattice="${lat}" Properties=species:S:1:pos:R:3` +
    (structureId ? ` structure_id=${structureId}` : '') +
    ' precision="display (~0.005A quantized) — email ehrdt@stanford.edu for exact float64"';
  const out = [String(atoms.length), header];
  for (const a of atoms) {
    out.push(`${a.sym} ${a.x.toFixed(4)} ${a.y.toFixed(4)} ${a.z.toFixed(4)}`);
  }
  return out.join('\n') + '\n';
}

// Fetch the structure's xyzq, rebuild a standard .xyz, trigger a browser download.
export async function downloadStructureXYZ(xyzqUrl, structureId) {
  const parsed = await fetchXYZQ(xyzqUrl);
  if (!parsed) throw new Error(`structure data not found (${xyzqUrl})`);
  const blob = new Blob([xyzqToExtxyz(parsed, structureId)], { type: 'chemical/x-xyz' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${structureId}.xyz`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
