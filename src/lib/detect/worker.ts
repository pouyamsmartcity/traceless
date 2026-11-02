/// <reference lib="webworker" />
/**
 * Runs the detection models off the main thread. Receives ready-made input tensors,
 * returns decoded boxes in model-input pixels. Never touches the network: models and the
 * runtime are loaded from this site's own files (and the page's CSP forbids anything else).
 */
import * as ort from 'onnxruntime-web/wasm';
import { MODELS, decodePlates, decodeYunet, type ModelId, type RawBox } from './models';

export type WorkerRequest =
  | { type: 'init'; base: string }
  | { type: 'run'; id: number; model: ModelId; tensor: Float32Array };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; boxes: RawBox[] }
  | { type: 'error'; id?: number; message: string };

const sessions = new Map<ModelId, Promise<ort.InferenceSession>>();
let base = '';

function session(model: ModelId): Promise<ort.InferenceSession> {
  let s = sessions.get(model);
  if (!s) {
    s = ort.InferenceSession.create(new URL(MODELS[model].file, base).href, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    // Let a failed load be retried later instead of caching the failure.
    s.catch(() => sessions.delete(model));
    sessions.set(model, s);
  }
  return s;
}

async function run(model: ModelId, tensor: Float32Array): Promise<RawBox[]> {
  const spec = MODELS[model];
  const s = await session(model);
  const input = new ort.Tensor('float32', tensor, [1, 3, spec.size, spec.size]);
  const results = await s.run({ [spec.inputName]: input });
  try {
    if (model === 'face') {
      const out: Record<string, Float32Array> = {};
      for (const [k, v] of Object.entries(results)) out[k] = v.data as Float32Array;
      return decodeYunet(out, spec.size, spec.threshold);
    }
    const first = results[s.outputNames[0]!];
    if (!first) throw new Error('plate model returned nothing');
    return decodePlates(first.data as Float32Array, spec.threshold);
  } finally {
    input.dispose();
    for (const v of Object.values(results)) v.dispose();
  }
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    base = msg.base;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { wasm: new URL('ort/ort-wasm-simd-threaded.wasm', base).href };
    ort.env.logLevel = 'error';
    scope.postMessage({ type: 'ready' } satisfies WorkerResponse);
    return;
  }
  try {
    const boxes = await run(msg.model, msg.tensor);
    scope.postMessage({ type: 'result', id: msg.id, boxes } satisfies WorkerResponse);
  } catch (err) {
    scope.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
