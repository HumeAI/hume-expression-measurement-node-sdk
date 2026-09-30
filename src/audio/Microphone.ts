// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { MissingDependencyError } from "./MissingDependencyError.js";
import { checkFrameMs, FrameBuffer } from "./pcm.js";
import { Resampler } from "./Resampler.js";

export declare namespace Microphone {
    export interface Options {
        /**
         * The input device, as an index from decibri's `Microphone.devices()` or a case-insensitive
         * substring of its name. A name that matches one device exactly selects it even if it is
         * also part of other names. The system's default input device when omitted.
         */
        device?: number | string;
        /** Duration of each frame in milliseconds, from 1 to 10000. 100 by default. */
        frameMs?: number;
    }
}

const INSTALL_COMMAND = "npm install decibri";

const NATIVE_ADDON_MISSING =
    "decibri is installed, but its native addon for this platform could not be loaded. decibri provides " +
    "one for Windows and Linux (glibc) on x64 and arm64 and for macOS on arm64. On Linux, the addon also " +
    "needs the ALSA library: `sudo apt-get install libasound2t64` on Ubuntu 24.04, Debian 13 and later, " +
    "or `sudo apt-get install libasound2` on earlier releases of Debian and Ubuntu. On a " +
    "supported platform, reinstall decibri with optional dependencies enabled.";

// decibri keeps delivering audio when the loop falls behind, so the audio waiting for it needs a cap.
const MAX_BACKLOG_SECONDS = 10;

// decibri's default of 1600 frames per block is 200 ms at 8 kHz, which would delay every frame.
const BLOCK_SECONDS = 0.02;

// A token only `Microphone.open` holds, so the constructor cannot be called from outside this module.
const OPEN = Symbol("Microphone.open");

// The parts of decibri 5 this helper uses. It ships its own types, but it is an optional peer
// dependency, so the SDK compiles without it.
interface DecibriDevice {
    index: number;
    name: string;
    id: string;
    defaultSampleRate: number;
    isDefault: boolean;
}

interface DecibriStream {
    on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
    on(event: "close", listener: () => void): unknown;
    stop(): void;
    destroy(): unknown;
    readonly overrunCount: number;
}

interface Decibri {
    Microphone: {
        devices(): DecibriDevice[];
        open(options: {
            device: number | { id: string };
            sampleRate: number;
            channels: number;
            dtype: "float32";
            framesPerBuffer: number;
        }): Promise<DecibriStream>;
    };
}

interface Iteration {
    id: number;
    resampler: Resampler;
    frames: FrameBuffer;
    ready: Uint8Array[];
    flushed: boolean;
    reading: boolean;
    ended: boolean;
}

/**
 * Records from an input device and yields frames ready to send with `sendAudioFrame`: signed
 * 16-bit little-endian PCM, mono, 16 kHz. Recording goes through the decibri package, an optional
 * peer dependency: `npm install decibri`.
 *
 * The device is opened at its own default sample rate and converted with `Resampler`, so any
 * microphone works whatever its native format. A device with more than one channel is recorded as
 * the average of its channels.
 *
 * Open one with `Microphone.open` and close it with `close` when done.
 *
 * Each `for await` loop yields only audio recorded after it starts, and starting a new one ends
 * any earlier one. A running loop yields everything recorded while its body runs, including while
 * it waits, so a push-to-talk loop that skips the audio between presses starts a new `for await`
 * for each press. After `close`, a loop that is still running yields the rest of the audio and
 * then ends. If the recording stops on its own before then, which some audio systems do when the
 * device is disconnected, the loop throws. Others stop delivering audio without reporting it, as
 * macOS does when a Bluetooth device switches off, and the loop then waits until `close`. To bound
 * a recording, call `close` from a timer. The loop also throws if more than 10 seconds of recorded
 * audio builds up waiting for it, and the waiting audio is discarded.
 *
 * On macOS the first recording triggers a permission prompt for the terminal or app running Node.
 * If access is denied, recording fails or records silence.
 *
 * @example
 * import { Microphone } from "@humeai/expression-measurement-node/audio";
 *
 * const microphone = await Microphone.open();
 * try {
 *     for await (const frame of microphone) {
 *         socket.sendAudioFrame(frame);
 *     }
 * } finally {
 *     await microphone.close();
 * }
 */
export class Microphone implements AsyncIterable<Uint8Array> {
    /** Name of the input device being recorded. */
    public readonly deviceName: string;
    /** Sample rate, in Hz, the device records at before conversion to 16 kHz. */
    public readonly deviceSampleRate: number;

    private readonly source: DecibriStream;
    private readonly frameMs: number;
    private readonly maxBacklog: number;
    // Numbers each `for await`, so an earlier one can tell it was replaced.
    private iteration = 0;
    // Blocks of float32 samples in the order decibri delivered them.
    private blocks: Uint8Array[] = [];
    private backlog = 0;
    private overflowed = false;
    // decibri's count reads 0 once the recording stops, so the highest value seen is kept.
    private overruns = 0;
    private finished = false;
    private closing = false;
    private stopError: Error | undefined;
    private waiters: Array<() => void> = [];
    private readonly closed: Promise<void>;
    private resolveClosed: () => void = () => {};

    // Private, and guarded by a token for JavaScript callers, because a Microphone must be opened.
    private constructor(token: symbol, source: DecibriStream, device: DecibriDevice, frameMs: number) {
        if (token !== OPEN) {
            throw new TypeError("Open a Microphone with `await Microphone.open()`.");
        }
        this.source = source;
        this.deviceName = device.name;
        this.deviceSampleRate = device.defaultSampleRate;
        this.frameMs = frameMs;
        this.maxBacklog = device.defaultSampleRate * MAX_BACKLOG_SECONDS;
        this.closed = new Promise((resolve) => {
            this.resolveClosed = resolve;
        });
        source.on("data", (chunk) => this.onData(chunk));
        source.on("error", (error) => {
            this.stopError = error;
        });
        source.on("close", () => this.onClose());
    }

    /**
     * Starts recording.
     *
     * @throws {MissingDependencyError} decibri is not installed, or its native addon cannot load on
     * this platform.
     * @throws {TypeError} frameMs is not an integer.
     * @throws {RangeError} frameMs is out of range.
     * @throws {Error} The device does not exist, or its name matches more than one device. The
     * message lists the available input devices. The device list is read on every call, so a
     * device connected since the last call is found. An error from decibri itself means the device
     * exists but could not be opened.
     */
    public static async open({ device, frameMs = 100 }: Microphone.Options = {}): Promise<Microphone> {
        checkFrameMs(frameMs);
        const decibri = await loadDecibri();
        const info = findInputDevice(decibri.Microphone.devices(), device);
        const source = await decibri.Microphone.open({
            // A device with no stable ID can only be selected by index.
            device: info.id !== "" ? { id: info.id } : info.index,
            sampleRate: info.defaultSampleRate,
            channels: 1,
            dtype: "float32",
            framesPerBuffer: Math.min(Math.max(Math.round(info.defaultSampleRate * BLOCK_SECONDS), 64), 65536),
        });
        const microphone = new Microphone(OPEN, source, info, frameMs);
        // decibri starts capture once a data listener is attached and reports a failure to start as
        // an error event, which arrives before the next turn of the event loop.
        await new Promise((resolve) => setImmediate(resolve));
        if (microphone.finished && microphone.stopError !== undefined) {
            throw microphone.stopError;
        }
        return microphone;
    }

    /**
     * Number of blocks of audio decibri dropped since the microphone opened because its thread that
     * passes audio from the device to Node fell behind, which can happen when the computer is busy.
     * A slow `for await` loop does not cause these drops. Gaps the operating system's audio system
     * causes are not counted. The frames do not show where a gap was. The count keeps its value
     * after `close`.
     */
    public get inputOverflows(): number {
        return this.countOverruns();
    }

    /**
     * Stops recording. A `for await` loop that is still running yields the audio recorded before
     * this call and then ends.
     *
     * @throws {Error} decibri failed to stop. The recording is released either way.
     */
    public async close(): Promise<void> {
        const recording = !this.finished && !this.closing;
        this.closing = true;
        if (recording) {
            this.countOverruns();
            try {
                this.source.stop();
            } catch (error) {
                this.source.destroy();
                this.onClose();
                throw error;
            }
        }
        await this.closed;
    }

    public [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
        this.iteration++;
        this.blocks = [];
        this.backlog = 0;
        this.overflowed = false;
        this.wake();
        const state: Iteration = {
            id: this.iteration,
            // A resampler or frame buffer reused from an earlier iteration would yield some of its audio first.
            resampler: new Resampler({ sampleRate: this.deviceSampleRate, channels: 1, sampleFormat: "float32" }),
            frames: new FrameBuffer(this.frameMs),
            ready: [],
            flushed: false,
            reading: false,
            ended: false,
        };
        const iterator: AsyncIterableIterator<Uint8Array> = {
            next: () => this.next(state),
            return: async () => {
                state.ended = true;
                this.wake();
                return { done: true, value: undefined };
            },
            [Symbol.asyncIterator]: () => iterator,
        };
        return iterator;
    }

    private async next(state: Iteration): Promise<IteratorResult<Uint8Array, undefined>> {
        if (state.ended) {
            return { done: true, value: undefined };
        }
        if (state.reading) {
            throw new Error(
                `Another caller is already waiting for a frame from ${this.deviceName}, ` +
                    "and only one caller at a time can read from a microphone.",
            );
        }
        state.reading = true;
        try {
            const frame = await this.read(state);
            if (frame === undefined) {
                state.ended = true;
                return { done: true, value: undefined };
            }
            return { done: false, value: frame };
        } catch (error) {
            state.ended = true;
            throw error;
        } finally {
            state.reading = false;
        }
    }

    private async read(state: Iteration): Promise<Uint8Array | undefined> {
        while (true) {
            // Checked before every frame, so an iteration that was returned, replaced or overflowed
            // yields none of the frames it has already converted.
            if (state.ended || state.id !== this.iteration) {
                return undefined;
            }
            if (this.overflowed) {
                throw new Error(
                    `More than ${MAX_BACKLOG_SECONDS} seconds of audio from ${this.deviceName} built up waiting ` +
                        "for the `for await` loop, which means the loop body is too slow for live audio.",
                );
            }
            const frame = state.ready.shift();
            if (frame !== undefined) {
                return frame;
            }
            // Taken only once the converted frames are used up, so audio the loop has not reached
            // stays in the backlog and counts toward the cap.
            const block = this.blocks.shift();
            if (block !== undefined) {
                this.backlog -= block.length / 4;
                state.ready.push(...state.frames.push(state.resampler.process(block)));
            } else if (!this.finished) {
                await new Promise<void>((resolve) => this.waiters.push(resolve));
            } else if (!state.flushed) {
                state.flushed = true;
                state.ready.push(...state.frames.push(state.resampler.flush()));
                const rest = state.frames.finish();
                if (rest !== undefined) {
                    state.ready.push(rest);
                }
            } else if (this.closing) {
                return undefined;
            } else {
                const reported = this.stopError === undefined ? "" : ` decibri reported: ${this.stopError.message}`;
                throw new Error(
                    `The audio stream from ${this.deviceName} stopped, for example because the device was ` +
                        `disconnected.${reported}`,
                );
            }
        }
    }

    private onData(chunk: Uint8Array): void {
        this.countOverruns();
        if (this.overflowed) {
            return;
        }
        const samples = chunk.length / 4;
        if (this.backlog + samples > this.maxBacklog) {
            // Released here, because a loop that fell behind may never read again.
            this.blocks = [];
            this.backlog = 0;
            this.overflowed = true;
        } else {
            this.blocks.push(chunk);
            this.backlog += samples;
        }
        this.wake();
    }

    private countOverruns(): number {
        this.overruns = Math.max(this.overruns, this.source.overrunCount);
        return this.overruns;
    }

    private onClose(): void {
        this.finished = true;
        this.resolveClosed();
        this.wake();
    }

    private wake(): void {
        const waiters = this.waiters;
        this.waiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }
}

async function loadDecibri(): Promise<Decibri> {
    try {
        // The name is not a literal, so the SDK type-checks without decibri installed.
        const name: string = "decibri";
        return (await import(name)) as Decibri;
    } catch (error) {
        const code = (error as { code?: unknown }).code;
        const message = error instanceof Error ? error.message : "";
        if ((code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") && message.includes("'decibri'")) {
            throw new MissingDependencyError(
                `The \`decibri\` package is required to record from a microphone. Install it: ${INSTALL_COMMAND}`,
                error,
            );
        }
        if (message.startsWith("Cannot find native binding")) {
            throw new MissingDependencyError(NATIVE_ADDON_MISSING, error);
        }
        throw error;
    }
}

function findInputDevice(devices: DecibriDevice[], device: number | string | undefined): DecibriDevice {
    let matches: DecibriDevice[];
    let reason: string;
    if (device === undefined) {
        matches = devices.filter((info) => info.isDefault);
        reason = "There is no default input device";
    } else if (typeof device === "number") {
        matches = devices.filter((info) => info.index === device);
        reason = `There is no input device with index ${device}`;
    } else {
        const query = device.toLowerCase();
        const exact = devices.filter((info) => info.name.toLowerCase() === query);
        matches = exact.length === 1 ? exact : devices.filter((info) => info.name.toLowerCase().includes(query));
        reason =
            matches.length === 0
                ? `No input device matches ${JSON.stringify(device)}`
                : `${JSON.stringify(device)} matches more than one input device`;
    }
    if (matches.length === 1) {
        return matches[0];
    }
    const available =
        devices.length === 0
            ? "No input devices are available."
            : `Available input devices: ${devices.map((info) => `${info.index}: ${info.name}`).join("; ")}.`;
    throw new Error(`${reason}. ${available}`);
}
