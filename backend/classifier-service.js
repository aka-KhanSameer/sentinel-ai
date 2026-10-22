import { Worker } from 'node:worker_threads';
import { getClassifierStatus } from './classifier.js';

const timeoutMs = Math.max(1_000, Number(process.env.SENTINEL_ML_TIMEOUT_MS || 120_000));
let worker;
let active;
let nextId = 1;
let queue = Promise.resolve();

function fallback(text, reason = 'Local classifier model is not installed; deterministic and structural detectors remain active.') {
  const model = getClassifierStatus();
  return { status: 'unavailable', mode: 'rules_only_fallback', model: model.id, revision: model.revision, reason, findings: [], assessments: [], coverage: { characters: 0, total_characters: text.length, ratio: 0 } };
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./classifier-worker.js', import.meta.url));
  worker.on('message', ({ id, result }) => {
    if (active?.id !== id) return;
    clearTimeout(active.timer);
    active.resolve(result);
    active = undefined;
  });
  const failWorker = () => {
    const failed = worker;
    worker = undefined;
    if (active) {
      clearTimeout(active.timer);
      active.resolve(fallback(active.text, 'Local classifier worker failed; deterministic and structural detectors remain active.'));
      active = undefined;
    }
    if (failed) void failed.terminate();
  };
  worker.on('error', failWorker);
  worker.on('exit', (code) => { if (code !== 0 || active) failWorker(); if (worker) worker = undefined; });
  return worker;
}

function runOne(text, regions) {
  if (getClassifierStatus().missing.length) return Promise.resolve(fallback(text));
  const current = ensureWorker();
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (active?.id !== id) return;
      active = undefined;
      const timedOut = worker;
      worker = undefined;
      resolve(fallback(text, 'Local classifier timed out; deterministic and structural detectors remain active.'));
      if (timedOut) void timedOut.terminate();
    }, timeoutMs);
    active = { id, text, resolve, timer };
    current.postMessage({ id, text, regions });
  });
}

export function classifyInWorker(text, regions) {
  const job = queue.then(() => runOne(text, regions));
  queue = job.then(() => undefined, () => undefined);
  return job;
}

export async function shutdownClassifierWorker() {
  const current = worker;
  worker = undefined;
  if (active) {
    clearTimeout(active.timer);
    active.resolve(fallback(active.text, 'Classifier worker was shut down.'));
    active = undefined;
  }
  if (current) await current.terminate();
}
