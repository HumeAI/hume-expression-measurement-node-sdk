// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

// Stands in for decibri 5 wherever a test calls `vi.mock("decibri")`. It delivers audio only when a
// test calls `record`, and ends a stream the way decibri does.

import { EventEmitter } from "events";

// Read when this module loads, so a test can make loading decibri fail the way a broken install does.
const loadError = (globalThis as { decibriLoadError?: Error }).decibriLoadError;
if (loadError !== undefined) {
    throw loadError;
}

export interface FakeDevice {
    index: number;
    name: string;
    id: string;
    maxInputChannels: number;
    defaultSampleRate: number;
    isDefault: boolean;
}

export interface OpenOptions {
    device: number | { id: string };
    sampleRate: number;
    channels: number;
    dtype: string;
    framesPerBuffer: number;
}

export const fake = {
    devices: [] as FakeDevice[],
    streams: [] as FakeStream[],
    failOnStart: undefined as Error | undefined,
    failOnStop: undefined as Error | undefined,
    reset(devices: FakeDevice[]): void {
        fake.devices = devices;
        fake.streams = [];
        fake.failOnStart = undefined;
        fake.failOnStop = undefined;
    },
};

export class FakeStream extends EventEmitter {
    public stopped = false;
    public destroyed = false;
    public overrunCount = 0;

    constructor(public readonly options: OpenOptions) {
        super();
        // decibri starts capture when a data listener makes the stream flow, and reports a failure to
        // start as an error event.
        this.on("newListener", (event) => {
            if (event === "data" && fake.failOnStart !== undefined) {
                const error = fake.failOnStart;
                process.nextTick(() => this.fail(error));
            }
        });
    }

    public record(samples: Float32Array): void {
        this.emit("data", Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    }

    // Ends the stream the way decibri does when the device fails.
    public fail(error: Error): void {
        this.destroyed = true;
        this.overrunCount = 0;
        this.emit("error", error);
        this.emit("close");
    }

    public stop(): void {
        if (fake.failOnStop !== undefined) {
            throw fake.failOnStop;
        }
        this.stopped = true;
        // decibri releases the stream its count lives on.
        this.overrunCount = 0;
        setImmediate(() => {
            this.emit("end");
            this.emit("close");
        });
    }

    public destroy(): void {
        this.destroyed = true;
        process.nextTick(() => this.emit("close"));
    }
}

export const Microphone = {
    devices(): FakeDevice[] {
        return fake.devices;
    },
    async open(options: OpenOptions): Promise<FakeStream> {
        const stream = new FakeStream(options);
        fake.streams.push(stream);
        return stream;
    },
};
