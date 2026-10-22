import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { scanText } from '../backend/scanner.js';
import { classifyInWorker, shutdownClassifierWorker } from '../backend/classifier-service.js';
import { getClassifierStatus } from '../backend/classifier.js';

const corpus = JSON.parse(await readFile(new URL('../datasets/evaluation.json', import.meta.url), 'utf8'));
const threshold = Number(process.env.SENTINEL_ML_THRESHOLD || 0.5);
const unavailable = { status: 'unavailable', mode: 'rules_only_fallback', reason: 'Rules-only comparison.' };
const flattened = report => report.findings.flatMap(f => [f, ...(f.supporting_findings || [])]);
const samples = [];
let tp = 0, fp = 0, tn = 0, fn = 0;

try {
  for (const sample of corpus.samples) {
    const expected = sample.label === 'attack';
    const structuralEvidence = sample.structural_kind
      ? [{ kind: sample.structural_kind, text: sample.text, location: { source: 'synthetic evaluation fixture' } }]
      : [];
    const started = performance.now();
    const classifier = await classifyInWorker(sample.text);
    const inferenceMs = performance.now() - started;
    const combined = scanText(sample.text, { structuralEvidence, mlFindings: classifier.findings, classifier });
    const rules = scanText(sample.text, { structuralEvidence, classifier: unavailable });
    const ruleFindings = flattened(rules);
    const allFindings = flattened(combined);
    const detected = allFindings.length > 0;
    if (expected && detected) tp++; else if (expected) fn++; else if (detected) fp++; else tn++;
    samples.push({
      id: sample.id, category: sample.category, label: sample.label, text: sample.text,
      inference_ms: Number(inferenceMs.toFixed(3)),
      chunks: (classifier.assessments || []).map(x => ({ start: x.start, end: x.end, token_count: x.token_count, injection_score: x.injection_score, label: x.label })),
      rule_detected: ruleFindings.length > 0,
      rule_finding_ids: [...new Set(ruleFindings.map(x => x.rule_id))],
      baseline_detected: detected,
      baseline_finding_ids: [...new Set(allFindings.map(x => x.rule_id))],
    });
  }
} finally {
  await shutdownClassifierWorker();
}

const precision = tp / (tp + fp) || 0, recall = tp / (tp + fn) || 0;
console.log(JSON.stringify({
  dataset_id: corpus.dataset_id,
  model_status: getClassifierStatus().missing.length ? 'unavailable' : 'local_classifier',
  model: 'protectai/deberta-v3-base-prompt-injection-v2',
  revision: '90c9989b1a342275dd0d1a95aad283c04e075671',
  threshold,
  confusion: { tp, fp, tn, fn },
  precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
  false_positive_rate: fp / (fp + tn) || 0,
  samples,
}, null, 2));
