import { MODEL_ID, MODEL_REVISION } from './zerogpu-model.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 65_000;

export function zeroGpuConfiguration(env = process.env) {
  const rawUrl = env.HF_SPACE_URL?.trim();
  const token = env.HF_TOKEN?.trim();
  if (!rawUrl || !token) return { configured: false, reason: 'Hugging Face ZeroGPU is not configured; deterministic and structural detectors remain active.' };
  try {
    const url = new URL(rawUrl);
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error();
    return { configured: true, url: `${url.origin}${url.pathname.replace(/\/$/, '')}`, token };
  } catch {
    return { configured: false, reason: 'Hugging Face ZeroGPU configuration is invalid; deterministic and structural detectors remain active.' };
  }
}

function unavailable(text, reason, transferAttempted = false) {
  return {
    status: 'unavailable', mode: 'rules_only_fallback', provider: 'huggingface_zerogpu',
    model: MODEL_ID, revision: MODEL_REVISION, reason,
    limitations: [
      'Remote ZeroGPU inference was unavailable for this scan; only deterministic and structural findings were used.',
      ...(transferAttempted ? ['The backend attempted to send extracted document text and source ranges to the configured Hugging Face Space.'] : []),
    ],
    findings: [], assessments: [], coverage: { characters: 0, total_characters: text.length, ratio: 0 },
  };
}

function parseCompletion(body) {
  let eventName = '';
  let dataLines = [];
  let completion;
  const consume = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    if (eventName === 'error') throw new Error('remote_error');
    if (eventName === 'complete') completion = JSON.parse(data);
    eventName = '';
    dataLines = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (!line) { consume(); continue; }
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  consume();
  if (completion === undefined) throw new Error('missing_completion');
  if (Array.isArray(completion) && completion.length === 1) return completion[0];
  if (completion && typeof completion === 'object' && Array.isArray(completion.data) && completion.data.length === 1) return completion.data[0];
  return completion;
}

export async function classifyWithZeroGpu(text, regions, {
  env = process.env, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const config = zeroGpuConfiguration(env);
  if (!config.configured) return unavailable(text, config.reason);
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return unavailable(text, 'Extracted text exceeds the remote ZeroGPU adapter 2 MiB limit; deterministic and structural detectors were used.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const headers = { authorization: `Bearer ${config.token}` };
  const endpoint = `${config.url}/gradio_api/call/score`;
  let transferAttempted = false;
  try {
    transferAttempted = true;
    const queued = await fetchImpl(endpoint, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ data: [text, regions ?? null] }), signal: controller.signal,
    });
    if (!queued.ok) return unavailable(text, queued.status === 429 || queued.status === 503
      ? 'Hugging Face ZeroGPU is queued, rate-limited, sleeping, or out of quota; deterministic and structural detectors were used.'
      : 'Hugging Face ZeroGPU rejected the request; deterministic and structural detectors were used.', true);
    const { event_id: eventId } = await queued.json();
    if (typeof eventId !== 'string' || !/^[\w-]{1,200}$/.test(eventId)) return unavailable(text, 'Hugging Face ZeroGPU returned an invalid queue response; deterministic and structural detectors were used.', true);
    const completed = await fetchImpl(`${endpoint}/${encodeURIComponent(eventId)}`, { headers, signal: controller.signal });
    if (!completed.ok) return unavailable(text, completed.status === 429 || completed.status === 503
      ? 'Hugging Face ZeroGPU is queued, rate-limited, sleeping, or out of quota; deterministic and structural detectors were used.'
      : 'Hugging Face ZeroGPU could not complete the queued scan; deterministic and structural detectors were used.', true);
    const result = parseCompletion(await completed.text());
    if (!result || result.model !== MODEL_ID || result.revision !== MODEL_REVISION || !Array.isArray(result.all_assessments)) {
      return unavailable(text, 'Hugging Face ZeroGPU returned an incompatible result; deterministic and structural detectors were used.', true);
    }
    const assessments = result.all_assessments;
    if (assessments.length > 256 || assessments.some(a => !Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) || a.start < 0 || a.end > text.length || a.end <= a.start || !Number.isFinite(a.injection_score) || a.injection_score < 0 || a.injection_score > 1)) {
      return unavailable(text, 'Hugging Face ZeroGPU returned invalid source offsets or scores; deterministic and structural detectors were used.', true);
    }
    const threshold = 0.5;
    const findings = assessments.filter(a => a.injection_score >= threshold).map(a => ({
      rule_id: 'classifier_prompt_injection', severity: 'high', confidence: a.injection_score,
      confidence_note: 'Raw DeBERTa softmax score; it is not a calibrated probability.',
      evidence: text.slice(a.start, Math.min(a.end, a.start + 240)),
      location: { start: a.start, end: a.end },
      explanation: 'The pinned ProtectAI prompt-injection classifier scored this chunk above the configured threshold.',
      detector: 'remote-ml-classifier', model: MODEL_ID, model_revision: MODEL_REVISION,
      raw_score: a.injection_score, decision_threshold: threshold,
    }));
    return {
      ...result, status: result.status === 'partial' ? 'partial' : 'available',
      mode: result.mode, provider: 'huggingface_zerogpu', findings,
      assessments: assessments.slice(0, 32), all_assessments: undefined,
      limitations: [
        'Inference uses the pinned ProtectAI checkpoint through Hugging Face ZeroGPU; extracted document text is transmitted to that service.',
        'Free ZeroGPU is quota-limited and queued; unavailable requests fall back to deterministic and structural detectors.',
        'The English-focused model returns raw, uncalibrated softmax scores and is not a safety guarantee.',
      ],
    };
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? 'Hugging Face ZeroGPU did not respond before the queue timeout; deterministic and structural detectors were used.'
      : 'Hugging Face ZeroGPU could not be reached; deterministic and structural detectors were used.';
    return unavailable(text, reason, transferAttempted);
  } finally {
    clearTimeout(timer);
  }
}

export const zeroGpuInternals = { parseCompletion, MAX_TEXT_BYTES };
