import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const configured = (process.env.PUBLIC_API_BASE_URL || '/api/v1').trim();
let apiBase = '/api/v1';
if (configured !== '/api/v1') {
  let url;
  try { url = new URL(configured); } catch { throw new Error('PUBLIC_API_BASE_URL must be /api/v1 or an absolute HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('PUBLIC_API_BASE_URL must be an HTTPS URL without credentials, query, or fragment.');
  apiBase = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}
const output = `window.SENTINEL_API_BASE=${JSON.stringify(apiBase)};\n`;
await writeFile(resolve('frontend/runtime-config.js'), output, { encoding: 'utf8', mode: 0o644 });
console.log(`Built static frontend configuration for ${apiBase === '/api/v1' ? 'same-origin API' : new URL(apiBase).origin}.`);
