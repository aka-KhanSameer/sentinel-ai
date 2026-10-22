import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseDocument } from '../backend/extractor.js';

const fixture = new URL('../tests/fixtures/prompt_injection_test_suite.pdf', import.meta.url);
const api = process.env.SENTINEL_API_URL || 'http://127.0.0.1:8080/api/v1';
const bytes = await readFile(fixture);
const parsed = await parseDocument(bytes, 'prompt_injection_test_suite.pdf', 'application/pdf');
const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
assert.ok(pdf.numPages >= 6, 'fixture must contain the answer key on page 6');
const answerPage = await pdf.getPage(6), answerText = (await answerPage.getTextContent()).items.map(x => x.str || '').join(' ');
assert.match(answerText, /PI-001\.\.003/); assert.match(answerText, /PI-037\.\.038/); assert.match(answerText, /Do NOT flag/);
await answerPage.cleanup(); await pdf.cleanup();

const form = new FormData();
form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'prompt_injection_test_suite.pdf');
let response;
try { response = await fetch(`${api}/scans`, { method: 'POST', body: form }); }
catch { throw new Error(`Could not reach Sentinel API at ${api}. Start the app with npm start, then rerun npm run eval:pdf-fixture.`); }
const report = await response.json();
assert.equal(response.status, 201, JSON.stringify(report.error || report));
assert.equal(report.summary?.format, 'pdf');

const markers = [];
for (const match of parsed.text.matchAll(/\[(PI-\d{3}|BEN-\d{3})[^\]]*\]/g)) {
  if (markers.some(x => x.id === match[1])) continue;
  const segment = parsed.segments.find(x => match.index >= x.start && match.index < x.end);
  if (segment?.location.page) markers.push({ id: match[1], start: match.index, end: match.index + match[0].length, page: segment.location.page });
}
const targets = new Map();
for (const marker of markers) {
  const pageEnd = Math.max(...parsed.segments.filter(x => x.location.page === marker.page).map(x => x.end));
  const nextMarker = markers.find(x => x.page === marker.page && x.start > marker.start)?.start ?? pageEnd;
  const contentStart = marker.end, candidateEnd = nextMarker;
  const heading = parsed.text.slice(contentStart, candidateEnd).search(/(?:^|\s)[A-L]\.\s+[A-Z][^\n]{2,80}/);
  const end = heading >= 0 ? Math.min(candidateEnd, contentStart + heading) : candidateEnd;
  targets.set(marker.id, { start: contentStart, end, page: marker.page });
}
for (const [id, field] of [['PI-037', 'Subject'], ['PI-038', 'Keywords']]) {
  const segment = parsed.segments.find(x => x.location.part === 'pdf_metadata' && x.location.field === field);
  if (segment) targets.set(id, { start: segment.start, end: segment.end, part: 'pdf_metadata', field });
}
const page5End = Math.max(...parsed.segments.filter(x => x.location.page === 5).map(x => x.end));
const lastBenign = targets.get('BEN-006'); if (lastBenign) lastBenign.end = page5End;

const findings = report.findings.flatMap(f => [f, ...(f.supporting_findings || [])]);
function evidenceFor(id) {
  const target = targets.get(id); if (!target) return [];
  return findings.filter(f => {
    const start = Number(f.location?.start), end = start + String(f.evidence || '').length, evidence = String(f.evidence || '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= target.start || start >= target.end || Math.min(end,target.end)-Math.max(start,target.start)<8) return false;
    const otherTargets = [...targets.entries()].filter(([, r]) => start < r.end && end > r.start);
    if (otherTargets.length !== 1 || otherTargets[0][0] !== id) return false;
    // The reported evidence must be the original source slice at its offset.
    // Decoded evidence alone is not used to invent a source match.
    return evidence.length > 0 && parsed.text.slice(start, end) === evidence;
  });
}
const payloads = [], benign = [];
for (let n = 1; n <= 38; n++) {
  const id = `PI-${String(n).padStart(3, '0')}`, target = targets.get(id), matches = evidenceFor(id);
  const source = target?.part === 'pdf_metadata' ? `${target.part}.${target.field}` : `page ${target?.page ?? '?'}`;
  payloads.push({ id, status: matches.length ? 'detected' : target ? (findings.some(f => Number(f.location?.start) < target.end && Number(f.location?.end) > target.start) ? 'inconclusive' : 'missed') : 'inconclusive', source, start: target?.start ?? null, end: target?.end ?? null, evidence: matches.map(f => ({ detector: f.detector, rule_id: f.rule_id, text: f.evidence, decoded_evidence: f.decoded_evidence, explanation: f.explanation, confidence: f.confidence, raw_score: f.raw_score, decision_threshold: f.decision_threshold, model: f.model, model_revision: f.model_revision, location: f.location })) });
}
for (let n = 1; n <= 6; n++) {
  const id = `BEN-${String(n).padStart(3, '0')}`, target = targets.get(id), matches = evidenceFor(id);
  benign.push({ id, flagged: matches.length > 0, source: `page ${target?.page ?? '?'}`, evidence: matches.map(f => ({ detector: f.detector, rule_id: f.rule_id, text: f.evidence, location: f.location })) });
}
const tp = payloads.filter(x => x.status === 'detected').length, fp = benign.filter(x => x.flagged).length;
const fn = 38 - tp, tn = 6 - fp, precision = tp / (tp + fp) || 0, recall = tp / 38, f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
const result = {
  evaluated_at: new Date().toISOString(),
  fixture: 'tests/fixtures/prompt_injection_test_suite.pdf', answer_key: 'page 6', upload_status: response.status,
  parser: { format: parsed.format, pages: pdf.numPages, characters: parsed.text.length, metadata_fields: parsed.metadata?.fields || [], structural_evidence_count: parsed.structuralEvidence?.length || 0 },
  detector_mode: report.summary?.classifier?.mode || 'rules_only_fallback', classifier: { status: report.summary?.classifier?.status, model: report.summary?.classifier?.model, revision: report.summary?.classifier?.revision, threshold: report.summary?.classifier?.threshold }, classifier_coverage: report.summary?.classifier_coverage || report.summary?.classifier?.coverage || null,
  findings: { raw: report.summary?.raw_finding_count, deduplicated: report.findings.length, source_evidence_items: findings.length },
  metrics: { pi_samples: 38, detected: tp, missed: fn, inconclusive: payloads.filter(x => x.status === 'inconclusive').length, detection_rate: tp / 38, benign_samples: 6, false_positives: fp, benign_false_positive_rate: fp / 6, precision, recall, f1, confusion: { tp, fp, tn, fn } },
  missed_payloads: payloads.filter(x => x.status !== 'detected').map(x => ({ id: x.id, status: x.status, source: x.source })),
  payloads, benign, limitations: report.limitations || [],
  method: 'A payload counts only when an API finding or retained supporting finding has a source-aligned evidence slice wholly attributable to that one payload range. One finding spanning multiple payload ranges is not credited to any of them.'
};
const serialized = `${JSON.stringify(result, null, 2)}\n`;
await writeFile(new URL('../docs/PDF_FIXTURE_EVALUATION.json', import.meta.url), serialized, 'utf8');
console.log(serialized);
if (tp !== 38 || fp !== 0 || payloads.some(x => x.status !== 'detected')) process.exitCode = 1;
