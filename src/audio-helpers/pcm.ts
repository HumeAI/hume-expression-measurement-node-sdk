// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

export const SAMPLE_RATE = 16000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

// The realtime audio endpoint rejects a frame holding more than 10 seconds of audio.
const MAX_FRAME_MS = 10_000;

// Every input sample becomes 16000 / rate output samples, so a small WAV file declaring a rate of
// 1 Hz would expand into a stream thousands of times its size.
export const MIN_SAMPLE_RATE = 1000;

export function checkInteger(name: string, value: number): number {
    if (!Number.isInteger(value)) {
        throw new TypeError(`${name} must be an integer, got ${describe(value)}.`);
    }
    return value;
}

export function checkFrameMs(frameMs: number): number {
    checkInteger("frameMs", frameMs);
    if (frameMs < 1 || frameMs > MAX_FRAME_MS) {
        throw new RangeError(`frameMs must be between 1 and ${MAX_FRAME_MS}, got ${frameMs}.`);
    }
    return frameMs;
}

export function describe(value: unknown): string {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
}

// Cuts a stream of 16 kHz mono s16le bytes into frames of a fixed duration.
export class FrameBuffer {
    private readonly frameBytes: number;
    private buffer: Uint8Array = new Uint8Array(0);

    constructor(frameMs: number) {
        this.frameBytes = checkFrameMs(frameMs) * BYTES_PER_MS;
    }

    public push(pcm: Uint8Array): Uint8Array[] {
        const data = new Uint8Array(this.buffer.length + pcm.length);
        data.set(this.buffer);
        data.set(pcm, this.buffer.length);
        const frames: Uint8Array[] = [];
        let offset = 0;
        while (data.length - offset >= this.frameBytes) {
            // Copied, so that each frame's `buffer` holds that frame alone.
            frames.push(data.slice(offset, offset + this.frameBytes));
            offset += this.frameBytes;
        }
        this.buffer = data.slice(offset);
        return frames;
    }

    public finish(): Uint8Array | undefined {
        const rest = this.buffer;
        this.buffer = new Uint8Array(0);
        return rest.length > 0 ? rest : undefined;
    }
}
