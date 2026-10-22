import { readFile, writeFile } from 'node:fs/promises';
import { scanText } from '../backend/scanner.js';

const dataset = JSON.parse(await readFile(new URL('../datasets/northwind-unseen.json', import.meta.url), 'utf8'));
const samples = dataset.samples.map(sample => {
  const report = scanText(sample.text, { source: sample.id, format: 'text', classifier: { status: 'unavailable', mode: 'rules_only_fallback', reason: 'Held-out rules evaluation.' } });
  const findings = report.findings.flatMap(f => [f, ...(f.supporting_findings || [])]);
  return { id: sample.id, label: sample.label, detected: findings.some(f => f.detector === 'deterministic-rules'), findings: findings.map(f => ({ rule_id: f.rule_id, evidence: f.evidence, decoded_evidence: f.decoded_evidence })) };
});
const tp = samples.filter(x => x.label === 'malicious' && x.detected).length;
const fn = samples.filter(x => x.label === 'malicious' && !x.detected).length;
const fp = samples.filter(x => x.label === 'benign' && x.detected).length;
const tn = samples.filter(x => x.label === 'benign' && !x.detected).length;
const precision = tp / (tp + fp) || 0, recall = tp / (tp + fn) || 0;
const result = { dataset_id: dataset.dataset_id, provenance: dataset.provenance, detector_mode: 'rules_only_fallback', sample_count: samples.length, confusion: { tp, fp, tn, fn }, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0, false_positive_rate: fp / (fp + tn) || 0, samples };
await writeFile(new URL('../docs/NORTHWIND_UNSEEN_EVALUATION.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
