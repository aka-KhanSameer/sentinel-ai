import pg from 'pg';

const { Pool } = pg;
let pool;
export const databaseConfigured = () => Boolean(process.env.DATABASE_URL);

function getPool() {
  if (!databaseConfigured()) return null;
  if (!pool) {
    const sslMode = process.env.DATABASE_SSL || 'verify-full';
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_MAX || 5),
      connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 3000),
      idleTimeoutMillis: 10000,
      query_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 5000),
      ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode !== 'require' }
    });
    pool.on('error', () => {}); // Never log a driver error that could contain connection details.
  }
  return pool;
}

export async function checkDatabaseReady() {
  const p = getPool();
  if (!p) return { configured: false, ready: true, mode: 'session_ephemeral' };
  try {
    await p.query('SELECT version FROM sentinel_schema_migrations ORDER BY version DESC LIMIT 1');
    return { configured: true, ready: true, mode: 'postgres_metadata_only' };
  } catch {
    return { configured: true, ready: false, mode: 'postgres_metadata_only', reason: 'Database connection or migration is unavailable.' };
  }
}

export async function insertScanMetadata(row) {
  const p = getPool();
  if (!p) return false;
  const client=await p.connect();
  try { await client.query('BEGIN');await client.query(`INSERT INTO sentinel_scans
    (scan_id, session_hash, created_at, file_type, file_size_bytes, scan_status, detector_mode,
     risk_score, risk_category, finding_count, severity_counts, extracted_characters,
     extraction_coverage, processing_duration_ms)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
  [row.scan_id,row.session_hash,row.created_at,row.file_type,row.file_size_bytes,row.scan_status,row.detector_mode,
    row.risk_score,row.risk_category,row.finding_count,JSON.stringify(row.severity_counts),row.extracted_characters,
    row.extraction_coverage,row.processing_duration_ms]);await client.query("DELETE FROM sentinel_scans WHERE created_at < now() - interval '30 days'");await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
  return true;
}

export async function listScanMetadata(sessionHash, limit = 100) {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(`SELECT scan_id,created_at,file_type,file_size_bytes,scan_status,detector_mode,
    risk_score,risk_category,finding_count,severity_counts,extracted_characters,extraction_coverage,processing_duration_ms
    FROM sentinel_scans WHERE session_hash=$1 ORDER BY created_at DESC LIMIT $2`, [sessionHash,limit]);
  return rows.map(r => ({ scan_id:r.scan_id,created_at:r.created_at,summary:{format:r.file_type,scan_status:r.scan_status,chars_scanned:r.extracted_characters,classifier:{mode:r.detector_mode},classifier_coverage:{ratio:Number(r.extraction_coverage)||0},finding_count:r.finding_count,metadata_only:true},risk:{score:r.risk_score,category:r.risk_category,action:'review'},findings:[],limitations:['Only scan metadata is retained. Evidence and document content are not stored; the full report is no longer available.'] }));
}

export async function deleteScanMetadata(sessionHash) {
  const p = getPool();
  if (!p) return 0;
  const result = await p.query('DELETE FROM sentinel_scans WHERE session_hash=$1', [sessionHash]);
  return result.rowCount || 0;
}

export async function closeDatabase() {
  if (pool) { const p=pool; pool=undefined; await p.end(); }
}
