// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { checkInteger, describe, MIN_SAMPLE_RATE, SAMPLE_RATE } from "./pcm.js";

export type SampleFormat = "int16" | "float32" | "float64";

export declare namespace Resampler {
    export interface Options {
        /** Sample rate of the input, in Hz, at least 1000. Need not be an integer. */
        sampleRate: number;
        /** Number of channels in the input. */
        channels: number;
        /**
         * Encoding of the input, "int16" by default. "int16" is signed 16-bit PCM, and "float32"
         * and "float64" are floating point with full scale at -1.0 and 1.0.
         */
        sampleFormat?: SampleFormat;
    }
}

// The largest rate a WAV header can declare.
const MAX_SAMPLE_RATE = 2 ** 32 - 1;

const SAMPLE_FORMATS: readonly SampleFormat[] = ["int16", "float32", "float64"];

const SAMPLE_BYTES: Record<SampleFormat, number> = { int16: 2, float32: 4, float64: 8 };

const EMPTY_BYTES = new Uint8Array(0);

/**
 * Converts PCM audio at any sample rate from 1 kHz and any channel count to the format the
 * realtime voice endpoint accepts: signed 16-bit little-endian PCM, mono, 16 kHz.
 *
 * Pass successive blocks of one stream to `process`, then call `flush` once after the last block.
 * Filter state carries over between calls, so a stream converts to the same bytes whether it
 * arrives in one block or many. After `flush` the resampler is ready for a new stream.
 *
 * Channels are averaged to mono before resampling. The result is rounded and clipped to 16 bits.
 *
 * @example
 * import { Resampler } from "@humeai/expression-measurement-node/audio";
 *
 * const resampler = new Resampler({ sampleRate: 48000, channels: 2 });
 * for await (const block of blocks) {
 *     const pcm = resampler.process(block);
 *     if (pcm.length > 0) {
 *         socket.sendAudioFrame(pcm);
 *     }
 * }
 * const rest = resampler.flush();
 * if (rest.length > 0) {
 *     socket.sendAudioFrame(rest);
 * }
 */
export class Resampler {
    private readonly channels: number;
    private readonly sampleFormat: SampleFormat;
    private readonly frameBytes: number;
    // Bytes left over from a block that ended partway through a sample frame.
    private pending: Uint8Array = EMPTY_BYTES;
    private readonly filter: Filter | undefined;

    constructor({ sampleRate, channels, sampleFormat = "int16" }: Resampler.Options) {
        if (typeof sampleRate !== "number") {
            throw new TypeError(`sampleRate must be a number, got ${describe(sampleRate)}.`);
        }
        // Written so that NaN fails the check.
        if (!(sampleRate >= MIN_SAMPLE_RATE && sampleRate <= MAX_SAMPLE_RATE)) {
            throw new RangeError(
                `sampleRate must be between ${MIN_SAMPLE_RATE} and ${MAX_SAMPLE_RATE}, got ${sampleRate}.`,
            );
        }
        checkInteger("channels", channels);
        if (channels < 1) {
            throw new RangeError(`channels must be at least 1, got ${channels}.`);
        }
        if (SAMPLE_FORMATS.indexOf(sampleFormat) === -1) {
            throw new TypeError(`sampleFormat must be "int16", "float32" or "float64", got ${describe(sampleFormat)}.`);
        }
        this.channels = channels;
        this.sampleFormat = sampleFormat;
        this.frameBytes = SAMPLE_BYTES[sampleFormat] * channels;
        this.filter = sampleRate === SAMPLE_RATE ? undefined : new Filter(sampleRate);
    }

    /**
     * Converts the next block of the stream.
     *
     * @param audio Interleaved PCM. Bytes, as an `ArrayBuffer`, `Uint8Array` or `Buffer`, are read
     * as little-endian and may end partway through a sample frame. An `Int16Array`, `Float32Array`
     * or `Float64Array` must match `sampleFormat` and hold whole frames.
     *
     * @returns Signed 16-bit little-endian PCM, mono, 16 kHz. The resampler holds back 64 samples at
     * the lower of the input rate and 16 kHz as filter history: 4 ms at input rates of 16 kHz and
     * above, 8 ms at 8 kHz, and 64 ms at 1 kHz. The result can therefore be shorter than the input
     * or empty. The realtime voice endpoint rejects empty frames and frames longer than 10 seconds,
     * so check the result before sending it, and pass a long recording in blocks of about 100 ms
     * rather than in one call. The endpoint accepts the first 30 seconds of audio at once and then
     * 2 seconds of audio per second, so pace the sends for a longer recording.
     */
    public process(audio: ArrayBuffer | Uint8Array | Int16Array | Float32Array | Float64Array): Uint8Array {
        const mono = this.toMono(audio);
        return toPcm16(this.filter === undefined ? mono : this.filter.push(mono));
    }

    /**
     * Converts the audio held back as filter history and ends the stream.
     *
     * @returns The rest of the stream as signed 16-bit little-endian PCM, mono, 16 kHz. Can be empty.
     *
     * @throws {Error} The input ended partway through a sample frame. The resampler is reset either way.
     */
    public flush(): Uint8Array {
        const leftover = this.pending.length;
        const rest = this.filter === undefined ? new Float64Array(0) : this.filter.finish();
        this.pending = EMPTY_BYTES;
        if (leftover > 0) {
            throw new Error(
                `The input ended ${leftover} bytes into a sample frame of ${this.frameBytes} bytes. ` +
                    "Every frame holds one sample per channel.",
            );
        }
        return toPcm16(rest);
    }

    private toMono(audio: ArrayBuffer | Uint8Array | Int16Array | Float32Array | Float64Array): Float64Array {
        if (audio instanceof Int16Array || audio instanceof Float32Array || audio instanceof Float64Array) {
            return this.samplesToMono(audio);
        }
        if (audio instanceof ArrayBuffer) {
            return this.bytesToMono(new Uint8Array(audio));
        }
        if (audio instanceof Uint8Array) {
            return this.bytesToMono(audio);
        }
        throw new TypeError(
            "audio must be an ArrayBuffer, Uint8Array, Buffer, Int16Array, Float32Array or Float64Array, " +
                `got ${describe(audio)}.`,
        );
    }

    private samplesToMono(samples: Int16Array | Float32Array | Float64Array): Float64Array {
        const expected = { int16: Int16Array, float32: Float32Array, float64: Float64Array }[this.sampleFormat];
        if (!(samples instanceof expected)) {
            throw new TypeError(
                `An array passed to a Resampler with sampleFormat "${this.sampleFormat}" must be an ` +
                    `${expected.name}, got ${samples.constructor.name}.`,
            );
        }
        if (this.pending.length > 0) {
            throw new Error(
                "The previous block of bytes ended partway through a sample frame, so the next block must be " +
                    "bytes that complete it, not an array.",
            );
        }
        if (samples.length % this.channels !== 0) {
            throw new RangeError(
                `An array must hold whole frames of ${this.channels} samples, got ${samples.length} samples.`,
            );
        }
        const scale = this.sampleFormat === "int16" ? 1 / 32768 : 1;
        const mono = new Float64Array(samples.length / this.channels);
        for (let frame = 0; frame < mono.length; frame++) {
            let sum = 0;
            for (let channel = 0; channel < this.channels; channel++) {
                sum += samples[frame * this.channels + channel];
            }
            mono[frame] = (sum / this.channels) * scale;
        }
        return mono;
    }

    private bytesToMono(bytes: Uint8Array): Float64Array {
        let data = bytes;
        if (this.pending.length > 0) {
            data = new Uint8Array(this.pending.length + bytes.length);
            data.set(this.pending);
            data.set(bytes, this.pending.length);
        }
        const frames = Math.floor(data.length / this.frameBytes);
        const usable = frames * this.frameBytes;
        // Copied, because the caller may reuse its buffer for the next block.
        this.pending = data.slice(usable);
        const view = new DataView(data.buffer, data.byteOffset, usable);
        const read = {
            int16: (offset: number) => view.getInt16(offset, true) / 32768,
            float32: (offset: number) => view.getFloat32(offset, true),
            float64: (offset: number) => view.getFloat64(offset, true),
        }[this.sampleFormat];
        const sampleBytes = SAMPLE_BYTES[this.sampleFormat];
        const mono = new Float64Array(frames);
        for (let frame = 0; frame < frames; frame++) {
            let sum = 0;
            for (let channel = 0; channel < this.channels; channel++) {
                sum += read(frame * this.frameBytes + channel * sampleBytes);
            }
            mono[frame] = sum / this.channels;
        }
        return mono;
    }
}

// The filter passes frequencies up to 90% of the Nyquist frequency of the lower of the two rates
// and attenuates by about 100 dB from that Nyquist frequency up. The kernel is a Kaiser-windowed
// sinc reaching HALF_WIDTH samples of the lower rate either side of each output sample.
const CUTOFF = 0.95;
const HALF_WIDTH = 64;
const KAISER_BETA = 10;
// Kernel values per sample of the lower rate. Positions between them are interpolated linearly.
const TABLE_STEPS = 1024;

let kernel: Float64Array | undefined;

function getKernel(): Float64Array {
    if (kernel === undefined) {
        // The two extra entries are zero, so interpolation at the edge of the kernel stays in bounds.
        kernel = new Float64Array(HALF_WIDTH * TABLE_STEPS + 2);
        const scale = besselI0(KAISER_BETA);
        for (let i = 0; i <= HALF_WIDTH * TABLE_STEPS; i++) {
            const x = i / TABLE_STEPS;
            const window = besselI0(KAISER_BETA * Math.sqrt(1 - (x / HALF_WIDTH) ** 2)) / scale;
            const sinc = i === 0 ? 1 : Math.sin(Math.PI * CUTOFF * x) / (Math.PI * CUTOFF * x);
            kernel[i] = CUTOFF * sinc * window;
        }
    }
    return kernel;
}

function besselI0(x: number): number {
    let sum = 1;
    let term = 1;
    for (let k = 1; term > sum * 1e-17; k++) {
        term *= (x / (2 * k)) ** 2;
        sum += term;
    }
    return sum;
}

// Resamples a mono stream to 16 kHz. Output sample k sits at input position k * step, so each output
// depends only on the input around that position and a stream converts to the same samples however
// it is split into blocks.
class Filter {
    private readonly kernel: Float64Array = getKernel();
    // Input samples per output sample.
    private readonly step: number;
    // Converts a distance in input samples to a distance in samples of the lower rate.
    private readonly scale: number;
    // How many input samples either side of an output sample the kernel reaches.
    private readonly reach: number;
    // Input from absolute sample index `historyStart` on, kept while an unproduced output needs it.
    private history: Float64Array = new Float64Array(0);
    private historyStart = 0;
    private received = 0;
    private produced = 0;

    constructor(sampleRate: number) {
        this.step = sampleRate / SAMPLE_RATE;
        this.scale = Math.min(1, SAMPLE_RATE / sampleRate);
        this.reach = HALF_WIDTH / this.scale;
    }

    public push(samples: Float64Array): Float64Array {
        const keepFrom = Math.max(this.historyStart, Math.ceil(this.produced * this.step - this.reach));
        const kept = this.history.subarray(keepFrom - this.historyStart);
        this.history = new Float64Array(kept.length + samples.length);
        this.history.set(kept);
        this.history.set(samples, kept.length);
        this.historyStart = keepFrom;
        this.received += samples.length;
        const outputs: number[] = [];
        // An output is ready once the input reaches past the far edge of its kernel.
        while (this.produced * this.step + this.reach < this.received) {
            outputs.push(this.output(this.produced));
            this.produced++;
        }
        return Float64Array.from(outputs);
    }

    // Produces every output that falls within the input, reading silence past its end, and resets.
    public finish(): Float64Array {
        const outputs: number[] = [];
        while (this.produced * this.step < this.received) {
            outputs.push(this.output(this.produced));
            this.produced++;
        }
        this.history = new Float64Array(0);
        this.historyStart = 0;
        this.received = 0;
        this.produced = 0;
        return Float64Array.from(outputs);
    }

    private output(index: number): number {
        const position = index * this.step;
        const first = Math.max(Math.ceil(position - this.reach), 0);
        const last = Math.min(Math.floor(position + this.reach), this.received - 1);
        let sum = 0;
        for (let n = first; n <= last; n++) {
            const offset = Math.abs(position - n) * this.scale * TABLE_STEPS;
            const i = Math.floor(offset);
            const weight = this.kernel[i] + (this.kernel[i + 1] - this.kernel[i]) * (offset - i);
            sum += this.history[n - this.historyStart] * weight;
        }
        return sum * this.scale;
    }
}

function toPcm16(samples: Float64Array): Uint8Array {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i++) {
        view.setInt16(i * 2, Math.min(Math.max(roundHalfToEven(samples[i] * 32768), -32768), 32767), true);
    }
    return bytes;
}

// Halves round to even, as in the Python SDK, so both convert audio that needs no resampling to the
// same bytes.
function roundHalfToEven(value: number): number {
    const rounded = Math.round(value);
    return rounded - value === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded;
}
