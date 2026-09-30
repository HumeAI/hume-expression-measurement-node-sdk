// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { iterWavFrames } from "../../src/audio/index";

interface WavOptions {
    tag: number;
    sampleRate: number;
    channels: number;
    bits: number;
    data: Uint8Array;
    extensible?: boolean;
    fmtExtra?: Uint8Array;
    dataSize?: number;
    afterData?: Uint8Array;
    blockAlign?: number;
    riffSize?: number;
    // An odd-sized chunk before the data exercises the padding byte that follows it.
    oddChunk?: boolean;
}

function uint32(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
}

function wavBytes({
    tag,
    sampleRate,
    channels,
    bits,
    data,
    extensible = false,
    fmtExtra = new Uint8Array(0),
    dataSize,
    afterData = new Uint8Array(0),
    blockAlign = channels * Math.ceil(bits / 8),
    riffSize,
    oddChunk = true,
}: WavOptions): Buffer {
    const fields = Buffer.alloc(16);
    fields.writeUInt16LE(extensible ? 0xfffe : tag, 0);
    fields.writeUInt16LE(channels, 2);
    fields.writeUInt32LE(sampleRate, 4);
    // The reader ignores the byte rate, so an overflowing value is truncated to fit its field.
    fields.writeUInt32LE((sampleRate * blockAlign) % 2 ** 32, 8);
    fields.writeUInt16LE(blockAlign, 12);
    fields.writeUInt16LE(bits, 14);
    const parts: Uint8Array[] = [fields];
    if (extensible) {
        const extension = Buffer.alloc(24);
        extension.writeUInt16LE(22, 0);
        extension.writeUInt16LE(bits, 2);
        extension.writeUInt16LE(tag, 8);
        Buffer.from("000000001000800000aa00389b71", "hex").copy(extension, 10);
        parts.push(extension);
    }
    parts.push(fmtExtra);
    const fmt = Buffer.concat(parts);
    const info = Buffer.from("INFOISFT\x05\x00\x00\x00Lavf\x00", "latin1");
    const body = Buffer.concat([
        Buffer.from("WAVEfmt ", "latin1"),
        uint32(fmt.length),
        fmt,
        Buffer.alloc(fmt.length % 2),
        oddChunk
            ? Buffer.concat([Buffer.from("LIST", "latin1"), uint32(info.length), info, Buffer.alloc(1)])
            : Buffer.alloc(0),
        Buffer.from("data", "latin1"),
        uint32(dataSize ?? data.length),
        data,
        afterData,
    ]);
    return Buffer.concat([Buffer.from("RIFF", "latin1"), uint32(riffSize ?? body.length), body]);
}

// The header Python's wave module and most other writers produce: fmt and data chunks only.
function basicWavBytes(sampleRate: number, channels: number, sampleWidth: number, data: Uint8Array): Buffer {
    return wavBytes({ tag: 1, sampleRate, channels, bits: sampleWidth * 8, data, oddChunk: false });
}

function int16Bytes(samples: number[]): Uint8Array {
    return new Uint8Array(new Int16Array(samples).buffer);
}

function range(start: number, end: number): number[] {
    return Array.from({ length: end - start }, (_, i) => start + i);
}

function seededBytes(length: number, seed: number): Uint8Array {
    let state = seed;
    return Uint8Array.from({ length }, () => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return state >>> 24;
    });
}

function toSamples(pcm: Uint8Array): number[] {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
    return Array.from({ length: pcm.length / 2 }, (_, i) => view.getInt16(i * 2, true));
}

async function collect(frames: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
    const collected: Uint8Array[] = [];
    for await (const frame of frames) {
        collected.push(frame);
    }
    return collected;
}

async function readAll(path: string, frameMs?: number): Promise<Uint8Array> {
    return Buffer.concat(await collect(iterWavFrames(path, { frameMs })));
}

describe("iterWavFrames", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "wav-test-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function write(name: string, bytes: Uint8Array): string {
        const path = join(dir, name);
        writeFileSync(path, bytes);
        return path;
    }

    it("splits a 16 kHz mono 16-bit file into frames unchanged", async () => {
        const pcm = seededBytes(8000, 0);
        const path = write("speech.wav", basicWavBytes(16000, 1, 2, pcm));

        const frames = await collect(iterWavFrames(path));

        expect(frames.map((frame) => frame.length)).toEqual([3200, 3200, 1600]);
        expect(Buffer.concat(frames)).toEqual(Buffer.from(pcm));
    });

    it("converts a 48 kHz stereo 24-bit file to 16 kHz mono", async () => {
        const data = Buffer.alloc(48000 * 2 * 3);
        for (let i = 0; i < 48000; i++) {
            const sample = Math.round(0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000) * 2 ** 23);
            data.writeIntLE(sample, i * 6, 3);
            data.writeIntLE(sample, i * 6 + 3, 3);
        }
        const path = write("speech.wav", basicWavBytes(48000, 2, 3, data));

        const frames = await collect(iterWavFrames(path, { frameMs: 250 }));
        const out = toSamples(Buffer.concat(frames));

        expect(frames.slice(0, -1).every((frame) => frame.length === 8000)).toBe(true);
        expect(frames[frames.length - 1].length).toBeGreaterThan(0);
        expect(frames[frames.length - 1].length).toBeLessThanOrEqual(8000);
        expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
        expect(Math.max(...out.map(Math.abs)) / (0.5 * 32768)).toBeCloseTo(1, 2);
    });

    it("reads 8-bit samples as unsigned", async () => {
        const path = write("speech.wav", basicWavBytes(16000, 1, 1, new Uint8Array([128, 255, 0])));

        expect(toSamples(await readAll(path))).toEqual([0, 32512, -32768]);
    });

    it("reads an extensible header like the basic header", async () => {
        const data = seededBytes(48000 * 2 * 3, 1);
        const basic = write("basic.wav", basicWavBytes(48000, 2, 3, data));
        const extensible = write(
            "extensible.wav",
            wavBytes({ tag: 1, sampleRate: 48000, channels: 2, bits: 24, data, extensible: true }),
        );

        expect(await collect(iterWavFrames(extensible))).toEqual(await collect(iterWavFrames(basic)));
    });

    it("skips bytes after the format fields", async () => {
        const data = int16Bytes(range(-800, 800));
        const path = write(
            "long-fmt.wav",
            wavBytes({
                tag: 1,
                sampleRate: 16000,
                channels: 1,
                bits: 16,
                data,
                extensible: true,
                fmtExtra: Uint8Array.from(range(0, 21)),
            }),
        );

        expect(await readAll(path)).toEqual(Buffer.from(data));
    });

    it.each([
        [32, false],
        [64, true],
    ])("converts %i-bit floating point samples, extensible %s", async (bits, extensible) => {
        const values = [0, 0.25, -0.5, 1.5];
        const samples = bits === 32 ? new Float32Array(values) : new Float64Array(values);
        const path = write(
            "float.wav",
            wavBytes({
                tag: 3,
                sampleRate: 16000,
                channels: 1,
                bits,
                data: new Uint8Array(samples.buffer),
                extensible,
            }),
        );

        expect(toSamples(await readAll(path))).toEqual([0, 8192, -16384, 32767]);
    });

    it("does not read chunks after the data as audio", async () => {
        const pcm = int16Bytes(range(-800, 800));
        const id3 = Buffer.concat([Buffer.from("id3 ", "latin1"), uint32(64), Uint8Array.from(range(0, 64))]);
        const path = write(
            "tagged.wav",
            wavBytes({ tag: 1, sampleRate: 16000, channels: 1, bits: 16, data: pcm, afterData: id3 }),
        );

        expect(await readAll(path)).toEqual(Buffer.from(pcm));
    });

    it("reads data of unknown size to the end of the file", async () => {
        const pcm = int16Bytes(range(-800, 800));
        const path = write(
            "piped.wav",
            wavBytes({ tag: 1, sampleRate: 16000, channels: 1, bits: 16, data: pcm, dataSize: 0xffffffff }),
        );

        expect(await readAll(path)).toEqual(Buffer.from(pcm));
    });

    it("reads a recording that was never closed to the end of the file", async () => {
        const pcm = int16Bytes(range(-800, 800));
        // libsndfile writes a RIFF size of 8 and a data size of 0 when it opens a file, and the real sizes
        // when it closes it.
        const path = write(
            "killed.wav",
            wavBytes({ tag: 1, sampleRate: 16000, channels: 1, bits: 16, data: pcm, dataSize: 0, riffSize: 8 }),
        );

        expect(await readAll(path)).toEqual(Buffer.from(pcm));
    });

    it.each([
        undefined,
        0xffffffff,
    ])("gives no frames for an empty data chunk followed by metadata, RIFF size %s", async (riffSize) => {
        const id3 = Buffer.concat([Buffer.from("id3 ", "latin1"), uint32(64), Uint8Array.from(range(0, 64))]);
        const path = write(
            "tagged.wav",
            wavBytes({
                tag: 1,
                sampleRate: 16000,
                channels: 1,
                bits: 16,
                data: new Uint8Array(0),
                afterData: id3,
                riffSize,
            }),
        );

        expect(await collect(iterWavFrames(path))).toEqual([]);
    });

    it.skipIf(process.platform === "win32")("reads a WAV from a named pipe", async () => {
        const pcm = int16Bytes(range(-800, 800));
        const wav = wavBytes({ tag: 1, sampleRate: 16000, channels: 1, bits: 16, data: pcm, dataSize: 0xffffffff });
        const fifo = join(dir, "pipe");
        execFileSync("mkfifo", [fifo]);

        const writing = writeFile(fifo, wav);
        const out = await readAll(fifo);
        await writing;

        expect(out).toEqual(Buffer.from(pcm));
    });

    it("reads a file ending partway through a sample to the last whole sample", async () => {
        const pcm = int16Bytes([100, -200, 300]);
        const path = write("interrupted.wav", basicWavBytes(16000, 1, 2, pcm));
        writeFileSync(path, readFileSync(path).subarray(0, -1));

        expect(await readAll(path)).toEqual(Buffer.from(pcm.subarray(0, 4)));
    });

    it("reads 12-bit samples from the high bits of 16-bit containers", async () => {
        const data = int16Bytes([0, 1024, -2048, 2047].map((sample) => sample << 4));
        const path = write("12-bit.wav", wavBytes({ tag: 1, sampleRate: 16000, channels: 1, bits: 12, data }));

        expect(toSamples(await readAll(path))).toEqual([0, 16384, -32768, 32752]);
    });

    it("rejects a sample rate below 1 kHz with a conversion command", async () => {
        const path = write(
            "crafted.wav",
            wavBytes({ tag: 1, sampleRate: 999, channels: 1, bits: 16, data: new Uint8Array(100) }),
        );

        await expect(readAll(path)).rejects.toThrow(/999 Hz is below the minimum of 1000 Hz.*ffmpeg -i input.wav/);
    });

    it.each([0, 1])("ignores a block size left at %i", async (blockAlign) => {
        const pcm = int16Bytes(range(-800, 800));
        const path = write(
            "speech.wav",
            wavBytes({ tag: 1, sampleRate: 16000, channels: 1, bits: 16, data: pcm, blockAlign }),
        );

        expect(await readAll(path)).toEqual(Buffer.from(pcm));
    });

    it("rejects a block size larger than one sample per channel", async () => {
        const path = write(
            "padded.wav",
            wavBytes({ tag: 1, sampleRate: 16000, channels: 2, bits: 24, data: new Uint8Array(64), blockAlign: 8 }),
        );

        await expect(readAll(path)).rejects.toThrow("the fmt chunk is inconsistent");
    });

    it("rejects a floating point depth other than 32 or 64 bits", async () => {
        const path = write(
            "float.wav",
            wavBytes({ tag: 3, sampleRate: 16000, channels: 1, bits: 31, data: new Uint8Array(16) }),
        );

        await expect(readAll(path)).rejects.toThrow("31-bit floating point");
    });

    it("reads a header declaring an enormous sample rate in bounded pieces", async () => {
        // Reading 100 ms at this rate and channel count at once would need an allocation of hundreds of
        // gigabytes, which fails.
        const path = write(
            "crafted.wav",
            wavBytes({
                tag: 1,
                sampleRate: 0xffffffff,
                channels: 32767,
                bits: 16,
                data: new Uint8Array(32767 * 2 * 4),
                dataSize: 0xffffffff,
            }),
        );

        expect(await collect(iterWavFrames(path))).toEqual([]);
    });

    it("rejects a compressed WAV with a conversion command", async () => {
        const path = write(
            "adpcm.wav",
            wavBytes({ tag: 2, sampleRate: 16000, channels: 1, bits: 4, data: new Uint8Array(100) }),
        );

        await expect(readAll(path)).rejects.toThrow(
            /format tag 0x0002.*ffmpeg -i input.wav -ac 1 -ar 16000 -sample_fmt s16/,
        );
    });

    it("rejects an RF64 file with a conversion command", async () => {
        const wav = wavBytes({ tag: 1, sampleRate: 16000, channels: 1, bits: 16, data: new Uint8Array(100) });
        wav.write("RF64", 0, "latin1");
        const path = write("long.wav", wav);

        await expect(readAll(path)).rejects.toThrow(
            /RF64 files are not supported.*ffmpeg -i input.wav -ac 1 -ar 16000 -sample_fmt s16/,
        );
    });

    it.each([0, 10001])("rejects a frame duration of %i at call time", (frameMs) => {
        expect(() => iterWavFrames(join(dir, "unused.wav"), { frameMs })).toThrow(
            "frameMs must be between 1 and 10000",
        );
    });

    it("rejects a frame duration that is not an integer at call time", () => {
        expect(() => iterWavFrames(join(dir, "unused.wav"), { frameMs: 20.5 })).toThrow(
            "frameMs must be an integer, got 20.5.",
        );
    });
});
