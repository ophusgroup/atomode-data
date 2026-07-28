// Shared decoders for the deploy binary formats (see site/tools/build_derived_proof.py).
//
// All formats are gzipped on the wire and inflated client-side with the
// native DecompressionStream API, so the storage host never has to serve
// Content-Encoding: gzip (dodges the HF Xet Range/CORS gap — these are
// whole-file GETs).
//
//   *.pdf.f16.gz / *.g3_4d.f16.gz  — packed float16:
//        uint32LE skelLen | skel_json (utf8, even-padded) | float16 blob
//        skel_json = {scale, lengths:[...], root:<payload with {"__f16":idx}>}
//   *.xyzq.gz — quantized structure:
//        "XYZQ" | u8 ver | u32 n | u8 nSpecies | (u8 len + label)* |
//        f32×9 lattice | f32×6 bbox(xmn,xmx,ymn,ymx,zmn,zmx) |
//        u16×n qx | u16×n qy | u16×n qz | u8×n speciesIdx   (atoms z-sorted)

export async function gunzip(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function halfToFloat(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

function f16ToFloat32(buffer, byteOffset, count) {
  if (typeof Float16Array !== 'undefined') {
    // byteOffset is 2-byte aligned by construction (skel is even-padded).
    return Float32Array.from(new Float16Array(buffer, byteOffset, count));
  }
  const dv = new DataView(buffer, byteOffset, count * 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = halfToFloat(dv.getUint16(i * 2, true));
  return out;
}

// Rehydrate a gunzipped packed-f16 buffer back into the original payload.
export function unpackF16(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const skelLen = dv.getUint32(0, true);
  const skel = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + skelLen)));
  const total = skel.lengths.reduce((a, b) => a + b, 0);
  const flat = f16ToFloat32(u8.buffer, u8.byteOffset + 4 + skelLen, total);
  const scale = skel.scale;
  const offs = []; let o = 0;
  for (const l of skel.lengths) { offs.push(o); o += l; }
  const rehydrate = (node) => {
    if (node && typeof node === 'object' && !Array.isArray(node) && '__f16' in node) {
      const i = node.__f16, off = offs[i], len = skel.lengths[i];
      const out = new Array(len);
      for (let k = 0; k < len; k++) out[k] = flat[off + k] * scale;
      return out;
    }
    if (Array.isArray(node)) return node.map(rehydrate);
    if (node && typeof node === 'object') {
      const r = {}; for (const k in node) r[k] = rehydrate(node[k]); return r;
    }
    return node;
  };
  return rehydrate(skel.root);
}

// fetch + gunzip + unpack. Returns null on 404 so callers can fall back.
export async function fetchPackedF16(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  return unpackF16(await gunzip(new Uint8Array(await r.arrayBuffer())));
}

// Parse a gunzipped .xyzq buffer -> {atoms:[{sym,x,y,z}], lattice:[[3],[3],[3]]}.
export function parseXYZQ(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'XYZQ') {
    throw new Error('bad xyzq magic');
  }
  let p = 4;
  p += 1;                                  // version
  const n = dv.getUint32(p, true); p += 4;
  const nsp = dv.getUint8(p); p += 1;
  const labels = [];
  for (let i = 0; i < nsp; i++) {
    const len = dv.getUint8(p); p += 1;
    labels.push(new TextDecoder().decode(u8.subarray(p, p + len))); p += len;
  }
  const lat = [];
  for (let i = 0; i < 3; i++) {
    lat.push([dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)]);
    p += 12;
  }
  const bb = [];
  for (let i = 0; i < 6; i++) { bb.push(dv.getFloat32(p, true)); p += 4; }
  const [xmn, xmx, ymn, ymx, zmn, zmx] = bb;
  // .slice() copies into fresh 0-offset buffers -> guaranteed Uint16 alignment.
  const qx = new Uint16Array(u8.slice(p, p + n * 2).buffer); p += n * 2;
  const qy = new Uint16Array(u8.slice(p, p + n * 2).buffer); p += n * 2;
  const qz = new Uint16Array(u8.slice(p, p + n * 2).buffer); p += n * 2;
  const sp = u8.subarray(p, p + n);
  const sx = (xmx - xmn) / 65535, sy = (ymx - ymn) / 65535, sz = (zmx - zmn) / 65535;
  const atoms = new Array(n);
  for (let i = 0; i < n; i++) {
    atoms[i] = { sym: labels[sp[i]], x: xmn + qx[i] * sx, y: ymn + qy[i] * sy, z: zmn + qz[i] * sz };
  }
  return { atoms, lattice: lat };
}

// fetch + gunzip + parse .xyzq. Returns null on 404.
export async function fetchXYZQ(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  return parseXYZQ(await gunzip(new Uint8Array(await r.arrayBuffer())));
}
