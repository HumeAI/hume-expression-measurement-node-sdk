// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { Resampler } from "../../src/audio/index";

function tone(frequency: number, sampleRate: number, seconds = 1, amplitude = 0.5): Float32Array {
    const samples = new Float32Array(Math.floor(sampleRate * seconds));
    for (let i = 0; i < samples.length; i++) {
        samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    }
    return samples;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
    }
    return joined;
}

function toSamples(pcm: Uint8Array): number[] {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
    return Array.from({ length: pcm.length / 2 }, (_, i) => view.getInt16(i * 2, true));
}

function convert(resampler: Resampler, audio: Parameters<Resampler["process"]>[0]): number[] {
    return toSamples(concat(resampler.process(audio), resampler.flush()));
}

function middle(samples: number[]): number[] {
    const cut = Math.floor(samples.length / 10);
    return samples.slice(cut, samples.length - cut).map((sample) => sample / 32768);
}

function rms(samples: number[]): number {
    return Math.sqrt(samples.reduce((total, sample) => total + sample * sample, 0) / samples.length);
}

function amplitudeAt(frequency: number, samples: number[]): number {
    let inPhase = 0;
    let quadrature = 0;
    samples.forEach((sample, i) => {
        inPhase += sample * Math.cos((2 * Math.PI * frequency * i) / 16000);
        quadrature += sample * Math.sin((2 * Math.PI * frequency * i) / 16000);
    });
    return (2 * Math.hypot(inPhase, quadrature)) / samples.length;
}

function seededNoise(length: number, seed: number): Float32Array {
    let state = seed;
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        samples[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
    }
    return samples;
}

describe("Resampler", () => {
    it.each([8000, 11025, 44100, 48000])("keeps the frequency, level and duration of a tone at %i Hz", (sampleRate) => {
        const out = convert(
            new Resampler({ sampleRate, channels: 1, sampleFormat: "float32" }),
            tone(1000, sampleRate),
        );

        expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
        expect(amplitudeAt(1000, middle(out))).toBeCloseTo(0.5, 2);
        expect(rms(middle(out)) / (0.5 / Math.SQRT2)).toBeCloseTo(1, 2);
    });

    it("removes a tone above the output Nyquist frequency", () => {
        const out = convert(
            new Resampler({ sampleRate: 48000, channels: 1, sampleFormat: "float32" }),
            tone(10000, 48000),
        );

        expect(rms(middle(out))).toBeLessThan(1e-3);
    });

    it("converts a stream split into blocks to the same bytes as the whole stream", () => {
        const audio = seededNoise(48000, 0);
        const whole = new Resampler({ sampleRate: 48000, channels: 1, sampleFormat: "float32" });
        const split = new Resampler({ sampleRate: 48000, channels: 1, sampleFormat: "float32" });

        const expected = concat(whole.process(audio), whole.flush());
        const actual = concat(
            ...[0, 1000, 1001, 5800].map((start, i, starts) => split.process(audio.subarray(start, starts[i + 1]))),
            split.flush(),
        );

        expect(actual).toEqual(expected);
    });

    it("holds back 64 samples at the lower of the input rate and 16 kHz", () => {
        const heldBack = (sampleRate: number) => {
            const resampler = new Resampler({ sampleRate, channels: 1, sampleFormat: "float32" });
            return 1600 - resampler.process(tone(100, sampleRate, 0.1)).length / 2;
        };

        expect(heldBack(1000)).toBe(1024);
        expect(heldBack(8000)).toBe(128);
        expect(heldBack(48000)).toBe(64);
    });

    it("passes 16 kHz mono int16 through unchanged", () => {
        const pcm = Uint8Array.from(seededNoise(3200, 1), (sample) => Math.floor((sample + 0.5) * 256));
        const resampler = new Resampler({ sampleRate: 16000, channels: 1 });

        expect(concat(resampler.process(pcm), resampler.flush())).toEqual(pcm);
    });

    it("averages channels and accepts bytes that split a frame", () => {
        const stereo = new Uint8Array(new Int16Array([1000, 3000, -32768, -32768, 101, 100]).buffer);
        const resampler = new Resampler({ sampleRate: 16000, channels: 2 });

        const pcm = concat(
            resampler.process(stereo.subarray(0, 3)),
            resampler.process(stereo.subarray(3)),
            resampler.flush(),
        );

        expect(toSamples(pcm)).toEqual([2000, -32768, 100]);
    });

    it("converts float64 arrays and float32 bytes like float32 arrays", () => {
        const left = tone(1000, 44100);
        const right = tone(300, 44100);
        const stereo = new Float32Array(left.length * 2);
        left.forEach((sample, i) => {
            stereo[i * 2] = sample;
            stereo[i * 2 + 1] = right[i];
        });
        const expected = convert(new Resampler({ sampleRate: 44100, channels: 2, sampleFormat: "float32" }), stereo);

        const float64 = convert(
            new Resampler({ sampleRate: 44100, channels: 2, sampleFormat: "float64" }),
            Float64Array.from(stereo),
        );
        const bytes = convert(
            new Resampler({ sampleRate: 44100, channels: 2, sampleFormat: "float32" }),
            new Uint8Array(stereo.buffer),
        );

        expect(float64).toEqual(expected);
        expect(bytes).toEqual(expected);
    });

    it("clips float input beyond full scale", () => {
        const resampler = new Resampler({ sampleRate: 16000, channels: 1, sampleFormat: "float32" });

        expect(convert(resampler, new Float32Array([1.5, -1.5, 0.25]))).toEqual([32767, -32768, 8192]);
    });

    it("rejects a stream that ends partway through a frame at flush and resets", () => {
        const resampler = new Resampler({ sampleRate: 16000, channels: 2 });
        resampler.process(new Uint8Array([1, 2, 3]));

        expect(() => resampler.flush()).toThrow("3 bytes into a sample frame of 4 bytes");
        expect(concat(resampler.process(new Uint8Array(4)), resampler.flush())).toEqual(new Uint8Array(2));
    });

    it("takes a new stream after flush", () => {
        const resampler = new Resampler({ sampleRate: 48000, channels: 1, sampleFormat: "float32" });
        const first = convert(resampler, tone(1000, 48000));

        expect(convert(resampler, tone(1000, 48000))).toEqual(first);
    });

    it("takes a new stream after a flush that throws", () => {
        const resampler = new Resampler({ sampleRate: 48000, channels: 1, sampleFormat: "float32" });
        const audio = new Uint8Array(tone(1000, 48000).buffer);
        resampler.process(audio);
        resampler.process(new Uint8Array(1));

        expect(() => resampler.flush()).toThrow("1 bytes into a sample frame of 4 bytes");
        const expected = convert(new Resampler({ sampleRate: 48000, channels: 1, sampleFormat: "float32" }), audio);
        expect(convert(resampler, audio)).toEqual(expected);
    });

    it("rejects an array of the wrong type or holding a partial frame", () => {
        const resampler = new Resampler({ sampleRate: 16000, channels: 2 });

        expect(() => resampler.process(new Float32Array(8))).toThrow(TypeError);
        expect(() => resampler.process(new Float32Array(8))).toThrow("must be an Int16Array, got Float32Array");
        expect(() => resampler.process(new Int16Array(3))).toThrow("whole frames of 2 samples, got 3 samples");
    });

    it("accepts a sample rate that is not an integer", () => {
        const out = convert(
            new Resampler({ sampleRate: 47999.5, channels: 1, sampleFormat: "float32" }),
            tone(1000, 47999.5),
        );

        expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
        expect(amplitudeAt(1000, middle(out))).toBeCloseTo(0.5, 2);
    });

    it.each([999, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY])("rejects a sample rate of %d", (sampleRate) => {
        expect(() => new Resampler({ sampleRate, channels: 1 })).toThrow(
            "sampleRate must be between 1000 and 4294967295",
        );
    });

    it("rejects a sample rate that is not a number", () => {
        expect(() => new Resampler({ sampleRate: "48000" as unknown as number, channels: 1 })).toThrow(
            'sampleRate must be a number, got "48000".',
        );
    });

    it("rejects a channel count that is not an integer", () => {
        expect(() => new Resampler({ sampleRate: 48000, channels: 2.5 })).toThrow(
            "channels must be an integer, got 2.5.",
        );
    });
});
