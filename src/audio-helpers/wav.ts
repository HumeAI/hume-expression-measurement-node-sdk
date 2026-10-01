// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type { FileHandle } from "fs/promises";
import { FrameBuffer, MIN_SAMPLE_RATE } from "./pcm.js";
import { Resampler } from "./Resampler.js";

export declare namespace iterWavFrames {
    export interface Options {
        /** Duration of each frame in milliseconds, from 1 to 10000. 100 by default. */
        frameMs?: number;
    }
}

const FFMPEG_COMMAND = "ffmpeg -i input.wav -ac 1 -ar 16000 -sample_fmt s16 output.wav";

const PCM = 0x0001;
const IEEE_FLOAT = 0x0003;
const EXTENSIBLE = 0xfffe;
// An extensible header's subformat GUID is the format tag it stands for followed by these bytes.
const SUBFORMAT_GUID_SUFFIX = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
// Writers that cannot seek back to fill in the size, such as ffmpeg writing to a pipe, leave this.
const UNKNOWN_SIZE = 0xffffffff;
const SAMPLE_WIDTHS: Record<number, number[]> = { [PCM]: [1, 2, 3, 4], [IEEE_FLOAT]: [4, 8] };
const SKIP_READ_BYTES = 64 * 1024;
// The read size follows from the header's sample rate and channel count, so a crafted header
// could otherwise request an enormous read.
const MAX_READ_BYTES = 1024 * 1024;
// The extensible header is all the reader parses. The rest of a longer fmt chunk is skipped,
// because its size comes from the file and can be arbitrarily large.
const FMT_READ_BYTES = 40;

interface Format {
    tag: number;
    channels: number;
    sampleRate: number;
    sampleWidth: number;
}

/**
 * Reads a WAV file and yields it as frames ready to send with `sendAudioFrame`.
 *
 * The audio is converted to signed 16-bit little-endian PCM, mono, 16 kHz, from any sample rate
 * of 1 kHz or more and any channel count. Integer PCM (8, 16, 24 or 32-bit, and narrower depths
 * such as 12 or 20-bit stored in those widths) and floating point (32 or 64-bit) are supported,
 * with either the basic or the extensible WAV header. Every frame holds `frameMs` milliseconds of
 * audio except the last, which holds what remains. No frame is empty.
 *
 * An interrupted recording is read as far as it goes: up to the last whole sample if the file
 * ends partway through one, and to the end of the file if its header still declares an empty
 * file, as libsndfile leaves a recording it never closed.
 *
 * Frames are produced as fast as the file can be read. The realtime voice endpoint accepts the
 * first 30 seconds of audio at once and then 2 seconds of audio per second, so pace the sends
 * for a longer file.
 *
 * The file is opened when iteration starts, so errors about the file itself are thrown by the
 * first `next()` rather than by this call.
 *
 * @param path Path to the WAV file. A named pipe works too.
 *
 * @throws {TypeError} frameMs is not an integer.
 * @throws {RangeError} frameMs is out of range.
 * @throws {Error} From iteration, if the file is not a WAV file this reader supports, such as a
 * compressed or RF64 file. Convert other files first, for example with
 * `ffmpeg -i input.wav -ac 1 -ar 16000 -sample_fmt s16 output.wav`.
 *
 * @example
 * import { iterWavFrames } from "@humeai/expression-measurement-node/audio-helpers";
 *
 * for await (const frame of iterWavFrames("speech.wav")) {
 *     socket.sendAudioFrame(frame);
 * }
 */
export function iterWavFrames(
    path: string | URL,
    { frameMs = 100 }: iterWavFrames.Options = {},
): AsyncGenerator<Uint8Array, void, undefined> {
    return readFrames(path, frameMs, new FrameBuffer(frameMs));
}

async function* readFrames(
    path: string | URL,
    frameMs: number,
    frames: FrameBuffer,
): AsyncGenerator<Uint8Array, void, undefined> {
    const fs = await import("fs");
    const reader = await Reader.open(fs.promises, path);
    try {
        const [format, dataSize] = await readHeader(reader, String(path));
        const resampler = new Resampler({
            sampleRate: format.sampleRate,
            channels: format.channels,
            sampleFormat: "float64",
        });
        const frameBytes = format.sampleWidth * format.channels;
        const samplesPerRead = Math.min(
            Math.max(1, Math.floor((format.sampleRate * frameMs) / 1000)),
            Math.max(1, Math.floor(MAX_READ_BYTES / frameBytes)),
        );
        const blockBytes = samplesPerRead * frameBytes;
        let remaining = dataSize;
        while (true) {
            const data = await reader.read(remaining === undefined ? blockBytes : Math.min(blockBytes, remaining));
            if (remaining !== undefined) {
                remaining -= data.length;
            }
            const usable = data.length - (data.length % frameBytes);
            if (usable > 0) {
                yield* frames.push(resampler.process(toFloat64(data.subarray(0, usable), format)));
            }
            if (data.length < blockBytes) {
                break;
            }
        }
        yield* frames.push(resampler.flush());
    } finally {
        await reader.close();
    }
    const rest = frames.finish();
    if (rest !== undefined) {
        yield rest;
    }
}

class Reader {
    private constructor(
        private readonly handle: FileHandle,
        // The offset of the next read in a regular file. A pipe cannot seek, so it is read in order.
        private position: number | undefined,
    ) {}

    public static async open(fs: typeof import("fs").promises, path: string | URL): Promise<Reader> {
        const handle = await fs.open(path, "r");
        try {
            return new Reader(handle, (await handle.stat()).isFile() ? 0 : undefined);
        } catch (error) {
            await handle.close();
            throw error;
        }
    }

    // Returns fewer bytes than requested only at the end of the file. A single read from a pipe can
    // return less while more is still coming.
    public async read(size: number): Promise<Uint8Array> {
        const buffer = new Uint8Array(size);
        let filled = 0;
        while (filled < size) {
            const { bytesRead } = await this.handle.read(buffer, filled, size - filled, this.position ?? null);
            if (bytesRead === 0) {
                break;
            }
            filled += bytesRead;
            if (this.position !== undefined) {
                this.position += bytesRead;
            }
        }
        return buffer.subarray(0, filled);
    }

    public async skip(size: number): Promise<void> {
        if (this.position !== undefined) {
            this.position += size;
            return;
        }
        // Read in pieces, so a large chunk stays out of memory.
        let left = size;
        while (left > 0) {
            const skipped = (await this.read(Math.min(left, SKIP_READ_BYTES))).length;
            if (skipped === 0) {
                return;
            }
            left -= skipped;
        }
    }

    public close(): Promise<void> {
        return this.handle.close();
    }
}

async function readHeader(reader: Reader, path: string): Promise<[Format, number | undefined]> {
    const riff = await reader.read(12);
    const riffId = ascii(riff.subarray(0, 4));
    if (riffId === "RF64") {
        throw unsupported(path, "RF64 files are not supported");
    }
    if (riff.length < 12 || riffId !== "RIFF" || ascii(riff.subarray(8, 12)) !== "WAVE") {
        throw unsupported(path, "no RIFF WAVE header");
    }
    const riffSize = view(riff).getUint32(4, true);
    let offset = riff.length;
    let format: Format | undefined;
    while (true) {
        const header = await reader.read(8);
        if (header.length < 8) {
            throw unsupported(path, "no data chunk");
        }
        offset += header.length;
        const chunkId = ascii(header.subarray(0, 4));
        const size = view(header).getUint32(4, true);
        if (chunkId === "data") {
            if (format === undefined) {
                throw unsupported(path, "the data chunk comes before the fmt chunk");
            }
            // Writers such as libsndfile fill in the sizes only when they close the file, so a recording
            // that was never closed declares no audio in a RIFF chunk that ends before it. Any other file
            // that declares no audio has none, including one whose RIFF size is unknown, because chunks
            // such as metadata can follow the data.
            const unclosed = size === 0 && 8 + riffSize <= offset;
            return [format, unclosed || size === UNKNOWN_SIZE ? undefined : size];
        }
        // Chunks with an odd size are followed by a padding byte.
        const paddedSize = size + (size % 2);
        offset += paddedSize;
        if (chunkId === "fmt ") {
            const body = await reader.read(Math.min(size, FMT_READ_BYTES));
            format = parseFormat(body, path);
            await reader.skip(paddedSize - body.length);
        } else {
            await reader.skip(paddedSize);
        }
    }
}

function parseFormat(body: Uint8Array, path: string): Format {
    if (body.length < 16) {
        throw unsupported(path, "the fmt chunk is too short");
    }
    const fields = view(body);
    let tag = fields.getUint16(0, true);
    const channels = fields.getUint16(2, true);
    const sampleRate = fields.getUint32(4, true);
    const blockAlign = fields.getUint16(12, true);
    const bits = fields.getUint16(14, true);
    if (tag === EXTENSIBLE) {
        if (body.length < 40 || SUBFORMAT_GUID_SUFFIX.some((byte, i) => body[26 + i] !== byte)) {
            throw unsupported(path, "unknown extensible subformat");
        }
        tag = fields.getUint16(24, true);
    }
    const widths = SAMPLE_WIDTHS[tag];
    if (widths === undefined) {
        throw unsupported(
            path,
            `format tag 0x${tag.toString(16).toUpperCase().padStart(4, "0")} is compressed or unknown`,
        );
    }
    // Integer samples narrower than their container, such as 12-bit audio in 16 bits, fill its
    // high bits and leave the low bits zero, so they decode correctly at the container's width.
    const sampleWidth = Math.floor((bits + 7) / 8);
    if (widths.indexOf(sampleWidth) === -1 || (tag === IEEE_FLOAT && bits !== sampleWidth * 8)) {
        throw unsupported(path, `${bits}-bit ${tag === PCM ? "PCM" : "floating point"}`);
    }
    // The reader does not need the block size, and some writers leave it at 0 or 1. A block larger
    // than one sample per channel means padded samples, which would be decoded wrongly.
    if (channels < 1 || blockAlign > sampleWidth * channels) {
        throw unsupported(path, "the fmt chunk is inconsistent");
    }
    if (sampleRate < MIN_SAMPLE_RATE) {
        throw unsupported(path, `${sampleRate} Hz is below the minimum of ${MIN_SAMPLE_RATE} Hz`);
    }
    return { tag, channels, sampleRate, sampleWidth };
}

function unsupported(path: string, reason: string): Error {
    return new Error(
        `${path} is not a supported WAV file (${reason}). Convert it first, for example with: ${FFMPEG_COMMAND}`,
    );
}

function ascii(bytes: Uint8Array): string {
    return String.fromCharCode(...bytes);
}

function view(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
}

function toFloat64(data: Uint8Array, format: Format): Float64Array {
    const read = sampleReader(view(data), format);
    const samples = new Float64Array(data.length / format.sampleWidth);
    for (let i = 0; i < samples.length; i++) {
        samples[i] = read(i * format.sampleWidth);
    }
    return samples;
}

function sampleReader(bytes: DataView, format: Format): (offset: number) => number {
    if (format.tag === IEEE_FLOAT) {
        return format.sampleWidth === 4
            ? (offset) => bytes.getFloat32(offset, true)
            : (offset) => bytes.getFloat64(offset, true);
    }
    switch (format.sampleWidth) {
        case 1:
            // 8-bit WAV samples are unsigned, centered on 128.
            return (offset) => (bytes.getUint8(offset) - 128) / 128;
        case 2:
            return (offset) => bytes.getInt16(offset, true) / 32768;
        case 3:
            return (offset) => ((bytes.getInt8(offset + 2) << 16) | bytes.getUint16(offset, true)) / 2 ** 23;
        default:
            return (offset) => bytes.getInt32(offset, true) / 2 ** 31;
    }
}
