// Getting instrument stems for a song, two ways:
//
//  1. Split in the browser with Demucs (Meta's htdemucs model, run by ONNX Runtime Web on
//     WebGPU): drums, bass, vocals, other. The ~180 MB model is downloaded the first time
//     and kept in the browser's Cache Storage after that.
//  2. Import stem files made elsewhere (Demucs on your PC via tools/split_stems.py, UVR,
//     Moises, …). Instruments are matched by file name, and 6-stem Demucs adds guitar + keys.

import { resample, decodeStem } from './stemCodec.js';

// htdemucs exported to ONNX (MIT, from facebookresearch/demucs), hosted on Hugging Face.
export const MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
const MODEL_BYTES = 180_534_758;
const MODEL_CACHE = 'kysync-models-v1';

export const AUDIO_FILE = /\.(wav|mp3|flac|ogg|oga|opus|m4a|aac|webm)$/i;

/** Which instrument a stem file holds, from its name. null = not a stem (probably the full song). */
export function stemFromFilename(name) {
  const base = name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[_\-.()[\]]+/g, ' ');
  if (/\b(no ?vocals?|instrumental|inst|karaoke|accompaniment|backing)\b/.test(base)) return 'other';
  if (/\b(vocals?|vox|voice|acapella|a cappella|singing)\b/.test(base)) return 'vocals';
  if (/\b(drums?|percussion|perc|kit)\b/.test(base)) return 'drums';
  if (/\bbass\b/.test(base)) return 'bass';
  if (/\b(guitars?|gtr)\b/.test(base)) return 'guitar';
  if (/\b(piano|keys|keyboards?)\b/.test(base)) return 'piano';
  if (/\b(other|lead|melody|rest)\b/.test(base)) return 'other';
  return null;
}

/** Is there a WebGPU adapter? Without one, Demucs runs on the CPU (much slower). */
export async function hasWebGPU() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

/** The model file, from Cache Storage if we've downloaded it before. */
async function fetchModel(onProgress) {
  let cache = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(MODEL_URL);
    if (hit) {
      onProgress(1);
      return await hit.arrayBuffer();
    }
  } catch { /* no Cache Storage (e.g. http): just download */ }

  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`couldn't download the splitter model (HTTP ${res.status})`);
  const total = Number(res.headers.get('Content-Length')) || MODEL_BYTES;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(Math.min(1, loaded / total));
  }
  const blob = new Blob(chunks);
  try {
    await cache?.put(MODEL_URL, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }));
  } catch (err) {
    console.warn('Could not cache the splitter model:', err);
  }
  return blob.arrayBuffer();
}

/** Has the model already been downloaded? (So we can skip the size warning.) */
export async function modelIsCached() {
  try {
    return !!(await (await caches.open(MODEL_CACHE)).match(MODEL_URL));
  } catch {
    return false;
  }
}

/**
 * Split a decoded song into { drums, bass, other, vocals } AudioBuffers (44.1 kHz stereo).
 * onStatus(text, progress 0..1) drives the loading screen.
 */
export async function splitInBrowser(buffer, onStatus) {
  onStatus('Loading the instrument splitter…', 0);
  const [ort, { DemucsProcessor, CONSTANTS }] = await Promise.all([
    import('onnxruntime-web'),
    import('demucs-web'),
  ]);
  // Multithreaded WASM needs a cross-origin isolated page; GitHub Pages isn't, so one thread.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

  const cached = await modelIsCached();
  const model = await fetchModel((p) => onStatus(
    cached ? 'Loading the instrument splitter…' : `Downloading the instrument splitter (one time, 180 MB)… ${Math.round(p * 100)}%`,
    p * 0.2,
  ));

  const gpu = await hasWebGPU();
  onStatus('Starting the instrument splitter…', 0.21);
  const processor = new DemucsProcessor({
    ort,
    sessionOptions: { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'] },
    onProgress: ({ progress }) => onStatus(
      `Splitting into drums, bass, vocals and lead${gpu ? '' : ' (no WebGPU, so this is slow)'}… ${Math.round(progress * 100)}%`,
      0.22 + progress * 0.58,
    ),
  });
  await processor.loadModel(model);

  const pcm = await resample(buffer, CONSTANTS.SAMPLE_RATE, 2);
  const out = await processor.separate(pcm.getChannelData(0), pcm.getChannelData(1));
  try { await processor.session?.release?.(); } catch { /* fine */ }

  const stems = {};
  for (const name of ['drums', 'bass', 'other', 'vocals']) {
    const b = new AudioBuffer({ numberOfChannels: 2, length: pcm.length, sampleRate: CONSTANTS.SAMPLE_RATE });
    b.copyToChannel(out[name].left, 0);
    b.copyToChannel(out[name].right, 1);
    out[name] = null; // let the big arrays go as we go
    stems[name] = b;
  }
  return stems;
}

export const ANALYSIS_RATE = 22050;

/**
 * Mono copy of a buffer at exactly 22.05 kHz: all the charting needs, small enough to send
 * to a worker, and the same rate for every stem even if they were decoded at different rates.
 */
export function analysisSamples(buffer) {
  const chans = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(buffer.getChannelData(c));
  const step = buffer.sampleRate / ANALYSIS_RATE;
  const out = new Float32Array(Math.floor(buffer.length / step));
  for (let i = 0; i < out.length; i++) {
    // box filter over the source samples this output sample covers
    const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step));
    let s = 0;
    for (const ch of chans) for (let j = a; j < b; j++) s += ch[j];
    out[i] = s / ((b - a) * chans.length);
  }
  return out;
}

/** Decode a song's stored stems into AudioBuffers. */
export async function decodeStems(stored, onProgress = () => {}) {
  const names = Object.keys(stored);
  const out = {};
  for (let i = 0; i < names.length; i++) {
    out[names[i]] = await decodeStem(stored[names[i]]);
    onProgress((i + 1) / names.length);
  }
  return out;
}
