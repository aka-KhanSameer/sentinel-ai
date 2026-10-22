import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to run migrations.');
const pool = new pg.Pool({ connectionString:process.env.DATABASE_URL, max:1, connectionTimeoutMillis:5000, ssl:process.env.DATABASE_SSL==='disable'?false:{rejectUnauthorized:process.env.DATABASE_SSL!=='require'} });
try {
  await pool.query('CREATE TABLE IF NOT EXISTS sentinel_schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  await pool.query('SELECT pg_advisory_lock(713892051)');
  const names=(await readdir(resolve('migrations'))).filter(n=>/^\d+_[a-z0-9_-]+\.sql$/.test(n)).sort();
  for(const name of names){
    const version=Number(name.split('_')[0]),sql=await readFile(resolve('migrations',name),'utf8'),checksum=createHash('sha256').update(sql).digest('hex');
    const previous=await pool.query('SELECT name,checksum FROM sentinel_schema_migrations WHERE version=$1',[version]);
    if(previous.rowCount){if(previous.rows[0].name!==name||previous.rows[0].checksum!==checksum)throw new Error(`Migration ${name} differs from the already-applied migration.`);continue;}
    const client=await pool.connect();try{await client.query('BEGIN');await client.query(sql);await client.query('INSERT INTO sentinel_schema_migrations(version,name,checksum) VALUES($1,$2,$3)',[version,name,checksum]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    console.log(`Applied migration ${name}`);
  }
} finally { try{await pool.query('SELECT pg_advisory_unlock(713892051)')}catch{} await pool.end(); }
