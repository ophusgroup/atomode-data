// Base URL prefix for PER-STRUCTURE data files (xyzq.gz, pdf.json, g3 sidecars).
//
// Set `window.ATOMODE_DATA_BASE` in each page's <head> BEFORE the module scripts:
//   ''  (empty)  → same-origin: all data served from this host (local dev)
//   'https://huggingface.co/datasets/<user>/<repo>/resolve/main/'
//                → GitHub Pages (UI) + HuggingFace (data) split deploy
//                  (trailing slash required)
//
// The metadata (dataset.parquet, dataset.csv) ALWAYS stays same-origin — it
// ships with the UI on GitHub Pages — so only the big per-structure fetches
// get this prefix.
export const DATA_BASE = (globalThis.ATOMODE_DATA_BASE || '');
