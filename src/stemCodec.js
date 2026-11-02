// Compact storage for instrument stems in IndexedDB.
//
// Raw stems are big (a 4-minute stereo stem is ~85 MB as floats), so each one is
// encoded to Opus at 128 kbps with WebCodecs (~4 MB). Browsers without WebCodecs
// audio fall back to 16-bit PCM, which is bigger but lossless and needs no decoder.

const RATE = 48000; // Opus only runs at 48 kHz
const OPUS = { codec: 'opus', sampleRate: RATE, numberOfChannels: 2, bitrate: 128000 };

let supportPromise = null;
function opusSupported() {
  supportPromise ??= (async () => {
    if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') return false;
    try {
      const e = await AudioEncoder.isConfigSupported(OPUS);
      const d = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: RATE, numberOfChannels: 2 });
      return !!(e.supported && d.supported);
    } catch {
      return false;
    }
  })();
  return supportPromise;
}

/** Stereo copy of a buffer at another sample rate (mono is spread to both sides). */
export async function resample(buffer, rate, channels = 2) {
  if (buffer.sampleRate === rate && buffer.numberOfChannels === channels) return buffer;
  const ctx = new OfflineAudioContext(channels, Math.ceil(buffer.duration * rate), rate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

const yieldToPage = () => new Promise((r) => setTimeout(r, 0));

async function encodeOpusRaw(pcm) {
  const packets = [];
  let description = null, failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push({ bytes, ts: chunk.timestamp });
      const desc = meta?.decoderConfig?.description;
      if (desc && !description) description = new Uint8Array(desc.buffer ?? desc).slice().buffer;
    },
    error: (e) => { failure = e; },
  });
  enc.configure(OPUS);
  const L = pcm.getChannelData(0), R = pcm.getChannelData(1);
  const BLOCK = RATE / 2;
  for (let i = 0; i < pcm.length; i += BLOCK) {
    const n = Math.min(BLOCK, pcm.length - i);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(i, i + n), 0);
    data.set(R.subarray(i, i + n), n);
    const frame = new AudioData({
      format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: 2,
      timestamp: Math.round((i / RATE) * 1e6), data,
    });
    enc.encode(frame);
    frame.close();
    if (enc.encodeQueueSize > 8) await yieldToPage();
    if (failure) break;
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;

  const total = packets.reduce((s, p) => s + p.bytes.length, 0);
  const data = new Uint8Array(total);
  const sizes = new Uint32Array(packets.length);
  const timestamps = new Float64Array(packets.length);
  let o = 0;
  packets.forEach((p, i) => { data.set(p.bytes, o); o += p.bytes.length; sizes[i] = p.bytes.length; timestamps[i] = p.ts; });
  return { codec: 'opus', sampleRate: RATE, length: pcm.length, data: data.buffer, sizes, timestamps, description };
}

/** Decode packets into planar channel arrays, `shift` samples earlier than their timestamps. */
async function decodeOpusRaw(rec, shift, makeChannels) {
  const [L, R] = makeChannels(rec.length);
  let failure = null;
  const tmp = { buf: new Float32Array(RATE) };
  const dec = new AudioDecoder({
    output: (frame) => {
      const n = frame.numberOfFrames;
      if (tmp.buf.length < n) tmp.buf = new Float32Array(n);
      const at = Math.round((frame.timestamp / 1e6) * RATE) - shift;
      const chans = frame.numberOfChannels;
      [L, R].forEach((dst, c) => {
        frame.copyTo(tmp.buf, { planeIndex: Math.min(c, chans - 1), format: 'f32-planar' });
        const from = Math.max(0, -at), to = Math.min(n, dst.length - at);
        if (to > from) dst.set(tmp.buf.subarray(from, to), at + from);
      });
      frame.close();
    },
    error: (e) => { failure = e; },
  });
  dec.configure({
    codec: 'opus', sampleRate: RATE, numberOfChannels: 2,
    ...(rec.description ? { description: rec.description } : {}),
  });
  const bytes = new Uint8Array(rec.data);
  let o = 0;
  for (let i = 0; i < rec.sizes.length; i++) {
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: rec.timestamps[i], data: bytes.subarray(o, o + rec.sizes[i]) }));
    o += rec.sizes[i];
    if (dec.decodeQueueSize > 32) await yieldToPage();
    if (failure) break;
  }
  await dec.flush();
  dec.close();
  if (failure) throw failure;
}

// Encoders add a little priming delay, and browsers differ on whether the decoder
// trims it. Measure it once with a test blip so stems stay sample-aligned with the chart.
let delayPromise = null;
function opusDelay() {
  delayPromise ??= (async () => {
    const n = RATE, mid = RATE / 2;
    const probe = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: RATE });
    for (let c = 0; c < 2; c++) {
      const d = probe.getChannelData(c);
      for (let i = -96; i <= 96; i++) d[mid + i] = Math.sin((2 * Math.PI * 1500 * i) / RATE) * Math.exp(-((i / 40) ** 2));
    }
    const rec = await encodeOpusRaw(probe);
    let out;
    await decodeOpusRaw(rec, 0, (len) => (out = [new Float32Array(len + RATE), new Float32Array(len + RATE)]));
    let best = 0, at = mid;
    for (let i = 0; i < out[0].length; i++) {
      const v = Math.abs(out[0][i]);
      if (v > best) { best = v; at = i; }
    }
    return at - mid;
  })();
  return delayPromise;
}

/** AudioBuffer → a record that can be stored in IndexedDB. */
export async function encodeStem(buffer) {
  if (await opusSupported()) {
    try {
      return await encodeOpusRaw(await resample(buffer, RATE, 2));
    } catch (err) {
      console.warn('Opus encoding failed, storing PCM instead:', err);
    }
  }
  const channels = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    const src = buffer.getChannelData(c);
    const out = new Int16Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(src[i] * 32767)));
    channels.push(out);
  }
  return { codec: 'pcm16', sampleRate: buffer.sampleRate, length: buffer.length, channels };
}

/** Stored record → AudioBuffer ready to play (no AudioContext needed). */
export async function decodeStem(rec) {
  if (rec.codec === 'opus') {
    const shift = await opusDelay();
    let buf;
    await decodeOpusRaw(rec, shift, (len) => {
      buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: RATE });
      return [buf.getChannelData(0), buf.getChannelData(1)];
    });
    return buf;
  }
  const buf = new AudioBuffer({ numberOfChannels: rec.channels.length, length: rec.length, sampleRate: rec.sampleRate });
  rec.channels.forEach((ch, c) => {
    const d = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) d[i] = ch[i] / 32767;
  });
  return buf;
}
