import { scanText } from '../backend/scanner.js';

let rawInput = '';
for await (const chunk of process.stdin) rawInput += chunk;
const input = JSON.parse(rawInput);
const threshold = Number(input.threshold ?? 0.5);
const results = [];
for (const sample of input.samples) {
  const assessments = sample.chunks || [];
  const mlFindings = assessments
    .filter(x => Number(x.injection_score) >= threshold)
    .map(x => ({
      rule_id: 'classifier_prompt_injection',
      severity: 'high',
      confidence: Number(x.injection_score),
      confidence_note: 'Raw DeBERTa softmax score; it is not a calibrated probability.',
      evidence: sample.text.slice(x.start, Math.min(x.end, x.start + 240)),
      location: { start: x.start, end: x.end },
      explanation: 'The local prompt-injection classifier scored this chunk above the configured threshold.',
      detector: 'local-ml-classifier',
      model: 'protectai/deberta-v3-base-prompt-injection-v2',
      model_revision: '90c9989b1a342275dd0d1a95aad283c04e075671',
      raw_score: Number(x.injection_score),
      decision_threshold: threshold,
    }));
  const structuralEvidence = sample.structural_kind
    ? [{ kind: sample.structural_kind, text: sample.text, location: { source: 'synthetic evaluation fixture' } }]
    : [];
  const classifier = {
    status: 'available', mode: 'local_classifier', threshold,
    model: 'protectai/deberta-v3-base-prompt-injection-v2',
    revision: '90c9989b1a342275dd0d1a95aad283c04e075671',
    findings: mlFindings, assessments,
    coverage: { characters: sample.text.length, total_characters: sample.text.length, ratio: 1 },
  };
  const report = scanText(sample.text, { structuralEvidence, mlFindings, classifier });
  const findings = report.findings.flatMap(f => [f, ...(f.supporting_findings || [])]);
  results.push({
    id: sample.id,
    detected: findings.length > 0,
    finding_ids: [...new Set(findings.map(x => x.rule_id))],
    classifier_candidates: report.classifier_candidates.map(x => ({
      rule_id: x.rule_id, raw_score: x.raw_score, adjudication_reason: x.adjudication_reason,
    })),
    corroborated_classifier_findings: findings.filter(x => x.detector === 'local-ml-classifier').length,
  });
}
console.log(JSON.stringify({ samples: results }));
