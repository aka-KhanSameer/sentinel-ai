import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('actual PDF upload reaches the configured private-service adapter and returns its report', async t => {
  let submitted;
  const space = createHttpServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/gradio_api/call/score') {
      const body = [];
      for await (const part of req) body.push(part);
      submitted = JSON.parse(Buffer.concat(body).toString());
      assert.equal(req.headers.authorization, 'Bearer test-only-token');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"event_id":"pdf-job"}');
    }
    if (req.method === 'GET' && req.url === '/gradio_api/call/score/pdf-job') {
      const [text] = submitted.data;
      const start = text.indexOf('Ignore all previous instructions');
      assert.ok(start >= 0, 'the actual PDF extraction should include the prompt-injection test payload');
      const result = {
        status: 'available', mode: 'zerogpu_classifier',
        model: 'protectai/deberta-v3-base-prompt-injection-v2',
        revision: '90c9989b1a342275dd0d1a95aad283c04e075671', threshold: 0.5,
        all_assessments: [{ start, end: Math.min(text.length, start + 100), token_count: 35, injection_score: 0.99, label: 'INJECTION' }],
        coverage: { characters: text.length, total_characters: text.length, ratio: 1 },
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(`event: complete\ndata: ${JSON.stringify([result])}\n\n`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => space.listen(0, '127.0.0.1', resolve));
  t.after(() => space.close());
  const spaceUrl = `http://127.0.0.1:${space.address().port}`;
  const port = await freePort();
  const host = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_DEMO_MODE: 'true',
      REQUIRE_LOCAL_CLASSIFIER: 'false', REQUIRE_DATABASE: 'false', HF_SPACE_URL: spaceUrl,
      HF_TOKEN: 'test-only-token', MAX_UPLOAD_BYTES: '2097152', MAX_PROCESSING_MS: '20000' },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${host}/api/v1/health`)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, 'local API should start');
  const caps = await (await fetch(`${host}/api/v1/capabilities`)).json();
  assert.equal(caps.features.ml_provider, 'huggingface_zerogpu');
  assert.equal(caps.features.ml_status, 'remote_configured_unverified');

  const pdf = await readFile('tests/fixtures/prompt_injection_test_suite.pdf');
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'prompt_injection_test_suite.pdf');
  const response = await fetch(`${host}/api/v1/scans`, { method: 'POST', body: form });
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.equal(report.summary.format, 'pdf');
  assert.equal(report.summary.classifier.mode, 'zerogpu_classifier');
  assert.equal(report.summary.classifier.provider, 'huggingface_zerogpu');
  assert.equal(report.summary.parser_status, 'completed');
  assert.equal(report.detector_diagnostics.find(x => x.stage === 'remote_zerogpu_classifier').status, 'completed');
  const remoteFinding = report.findings.flatMap(f => [f, ...(f.supporting_findings || [])]).find(f => f.detector === 'remote-ml-classifier');
  assert.ok(remoteFinding, 'source-aligned remote model evidence must reach the report');
  assert.ok(remoteFinding.location.start >= 0 && remoteFinding.location.end > remoteFinding.location.start);
  assert.ok(report.limitations.some(x => /transmitted to that service/i.test(x)));
  assert.ok(!JSON.stringify(report).includes('test-only-token'));
  assert.ok(submitted.data[1] === null || Array.isArray(submitted.data[1]));
});
