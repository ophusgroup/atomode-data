// DuckDB-Wasm bootstrap.  Loads the bundle from jsDelivr (no build step),
// registers the local dataset.parquet as a virtual file, and exposes a
// `query(sql)` helper that returns plain arrays-of-objects.
//
// Usage:
//   import { initDB, query } from './db.js';
//   await initDB('data/dataset.parquet');
//   const rows = await query('select * from dataset limit 10');

import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm';

let _db = null;
let _conn = null;

export async function initDB(parquetUrl) {
  if (_conn) return _conn;

  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

  const worker_url = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(worker_url);
  const logger = new duckdb.ConsoleLogger();
  _db = new duckdb.AsyncDuckDB(logger, worker);
  await _db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(worker_url);

  // Fetch the whole parquet up front and register it as a buffer.  Python's
  // http.server (and many static hosts) don't honour HTTP Range requests,
  // so DuckDB-Wasm's HTTP backend reads garbage and overflows when it tries
  // to seek.  At <2 MB this is fine; revisit if the file ever gets large.
  const absUrl = new URL(parquetUrl, window.location.href).toString();
  const resp = await fetch(absUrl, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`fetch dataset.parquet: ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  await _db.registerFileBuffer('dataset.parquet', buf);
  _conn = await _db.connect();
  await _conn.query(`
    create or replace view dataset as
    select * from read_parquet('dataset.parquet');
  `);
  return _conn;
}

export async function query(sql, params = []) {
  if (!_conn) throw new Error('initDB() must be called first');
  const stmt = await _conn.prepare(sql);
  const result = params.length ? await stmt.query(...params) : await stmt.query();
  await stmt.close();
  return result.toArray().map((r) => r.toJSON());
}
