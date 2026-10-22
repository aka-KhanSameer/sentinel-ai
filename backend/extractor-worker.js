import { parentPort, workerData } from 'node:worker_threads';
import { parseDocument } from './extractor.js';

try {
  const { bytes, filename, mime } = workerData;
  const parsed = await parseDocument(Buffer.from(bytes), filename, mime);
  parentPort.postMessage({ ok: true, parsed });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      message: error?.message || 'Document parsing failed.',
      status: Number(error?.status) || 422,
      code: error?.code || 'parse_failed',
    },
  });
}
