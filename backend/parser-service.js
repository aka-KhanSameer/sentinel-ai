import { Worker } from 'node:worker_threads';

export function parseInWorker(buffer, filename, mime, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const bytes = Uint8Array.from(buffer);
    const oldHeapMb = Number(process.env.PARSER_OLD_HEAP_MB || 384);
    const youngHeapMb = Number(process.env.PARSER_YOUNG_HEAP_MB || 64);
    if (!Number.isSafeInteger(oldHeapMb) || oldHeapMb < 64 || oldHeapMb > 1024 || !Number.isSafeInteger(youngHeapMb) || youngHeapMb < 16 || youngHeapMb > 256) {
      reject(new Error('Parser worker heap limits are invalid.'));
      return;
    }
    const worker = new Worker(new URL('./extractor-worker.js', import.meta.url), {
      workerData: { bytes, filename, mime },
      transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: oldHeapMb, maxYoungGenerationSizeMb: youngHeapMb, stackSizeMb: 8 },
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, Object.assign(new Error('Document processing timed out; no clean scan result was produced.'), { status: 408, code: 'processing_timeout' }));
      void worker.terminate();
    }, timeoutMs);
    worker.once('message', (message) => {
      void worker.terminate();
      if (message.ok) finish(resolve, message.parsed);
      else finish(reject, Object.assign(new Error(message.error.message), { status: message.error.status, code: message.error.code }));
    });
    worker.once('error', () => {
      finish(reject, Object.assign(new Error('Document parser failed; no clean scan result was produced.'), { status: 422, code: 'parse_failed' }));
    });
    worker.once('exit', (code) => {
      if (!settled) finish(reject, Object.assign(new Error(`Document parser stopped unexpectedly (${code}); no clean scan result was produced.`), { status: 422, code: 'parse_failed' }));
    });
  });
}
