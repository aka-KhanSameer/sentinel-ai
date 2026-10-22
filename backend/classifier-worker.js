import { parentPort } from 'node:worker_threads';
import { analyzeWithClassifier } from './classifier.js';

parentPort.on('message', async ({ id, text, regions }) => {
  try {
  const result = await analyzeWithClassifier(text, { regions });
    parentPort.postMessage({ id, result });
  } catch {
    parentPort.postMessage({ id, result: { status: 'unavailable', mode: 'rules_only_fallback', findings: [], assessments: [], reason: 'Local classifier failed; other detectors remain active.' } });
  }
});
