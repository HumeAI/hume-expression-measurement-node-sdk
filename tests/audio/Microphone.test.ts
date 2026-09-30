// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { Microphone } from "../../src/audio/index";
import { type FakeDevice, type FakeStream, fake } from "../__mocks__/decibri";

vi.mock("decibri");

function device(name: string, overrides: Partial<FakeDevice> = {}): FakeDevice {
    return {
        index: 0,
        name,
        id: `coreaudio:${name}`,
        maxInputChannels: 1,
        defaultSampleRate: 48000,
        isDefault: true,
        ...overrides,
    };
}

function tone(seconds = 1): Float32Array {
    return Float32Array.from(
        { length: Math.floor(48000 * seconds) },
        (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000),
    );
}

function constant(value: number, samples = 160): Float32Array {
    return new Float32Array(samples).fill(value);
}

function pcm(value: number): Uint8Array {
    return new Uint8Array(new Int16Array(160).fill(Math.round(value * 32768)).buffer);
}

function stream(): FakeStream {
    return fake.streams[0];
}

function withTimeout<T>(promise: Promise<T>, ms = 1000): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)),
    ]);
}

async function nextFrame(frames: AsyncIterator<Uint8Array>): Promise<Uint8Array> {
    const result = await withTimeout(frames.next());
    if (result.done) {
        throw new Error("The iteration ended.");
    }
    return result.value;
}

async function collect(microphone: Microphone): Promise<Uint8Array[]> {
    const frames: Uint8Array[] = [];
    for await (const frame of microphone) {
        frames.push(frame);
    }
    return frames;
}

function tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function amplitudeAt(frequency: number, pcm: Uint8Array): number {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
    let inPhase = 0;
    let quadrature = 0;
    const count = pcm.length / 2;
    for (let i = 0; i < count; i++) {
        const sample = view.getInt16(i * 2, true) / 32768;
        inPhase += sample * Math.cos((2 * Math.PI * frequency * i) / 16000);
        quadrature += sample * Math.sin((2 * Math.PI * frequency * i) / 16000);
    }
    return (2 * Math.hypot(inPhase, quadrature)) / count;
}

describe("Microphone", () => {
    let microphone: Microphone | undefined;

    beforeEach(() => {
        fake.reset([device("Built-in Microphone")]);
        microphone = undefined;
    });

    afterEach(async () => {
        fake.failOnStop = undefined;
        await microphone?.close();
    });

    async function open(options: Microphone.Options = {}): Promise<Microphone> {
        microphone = await Microphone.open(options);
        return microphone;
    }

    function at16k(): void {
        fake.reset([device("Built-in Microphone", { defaultSampleRate: 16000 })]);
    }

    it("yields 16 kHz frames of the recorded audio", async () => {
        const mic = await open({ frameMs: 100 });
        expect([mic.deviceName, mic.deviceSampleRate]).toEqual(["Built-in Microphone", 48000]);
        const frames = mic[Symbol.asyncIterator]();
        const audio = tone();
        for (let start = 0; start < audio.length; start += 480) {
            stream().record(audio.subarray(start, start + 480));
        }
        const received: Uint8Array[] = [];
        for (let i = 0; i < 9; i++) {
            received.push(await nextFrame(frames));
        }
        await mic.close();

        expect(received.map((frame) => frame.length)).toEqual(Array(9).fill(3200));
        expect(amplitudeAt(1000, Buffer.concat(received.slice(1)))).toBeCloseTo(0.5, 2);
        expect(stream().options).toEqual({
            device: { id: "coreaudio:Built-in Microphone" },
            sampleRate: 48000,
            channels: 1,
            dtype: "float32",
            framesPerBuffer: 960,
        });
        expect(stream().stopped).toBe(true);
    });

    it("wakes a waiting iteration when audio arrives", async () => {
        at16k();
        const frames = (await open({ frameMs: 10 }))[Symbol.asyncIterator]();
        setTimeout(() => stream().record(constant(0.25)), 50);

        expect(await nextFrame(frames)).toEqual(pcm(0.25));
    });

    it("yields all recorded audio before iteration ends on close", async () => {
        const mic = await open({ frameMs: 100 });
        const collecting = collect(mic);
        await tick();
        const audio = tone(0.82);
        for (let start = 0; start < audio.length; start += 480) {
            stream().record(audio.subarray(start, start + 480));
        }
        await mic.close();
        const frames = await withTimeout(collecting);

        expect(frames.every((frame) => frame.length > 0)).toBe(true);
        expect(Math.abs(frames.reduce((total, frame) => total + frame.length, 0) - 0.82 * 32000)).toBeLessThanOrEqual(
            2,
        );
    });

    it("yields only audio recorded after an iteration starts", async () => {
        at16k();
        const mic = await open({ frameMs: 10 });
        stream().record(constant(0.25));
        setImmediate(() => stream().record(constant(0.5)));
        const first = await nextFrame(mic[Symbol.asyncIterator]());
        stream().record(constant(0.75));
        setImmediate(() => stream().record(constant(-0.5)));
        const second = await nextFrame(mic[Symbol.asyncIterator]());

        expect([first, second]).toEqual([pcm(0.5), pcm(-0.5)]);
    });

    it("yields no audio held back by an earlier iteration", async () => {
        // The resampler holds back audio only when it converts the sample rate, so the device records at 48 kHz.
        const mic = await open({ frameMs: 10 });
        const record100Ms = (value: number) => {
            for (let i = 0; i < 10; i++) {
                stream().record(constant(value, 480));
            }
        };
        setImmediate(() => record100Ms(0.5));
        await nextFrame(mic[Symbol.asyncIterator]());
        setImmediate(() => record100Ms(0));

        expect(await nextFrame(mic[Symbol.asyncIterator]())).toEqual(pcm(0));
    });

    it("ends an earlier iteration when a new one starts", async () => {
        const mic = await open();
        const older = collect(mic);
        await tick();
        mic[Symbol.asyncIterator]();

        expect(await withTimeout(older)).toEqual([]);
    });

    it("ends a replaced iteration without yielding its waiting audio", async () => {
        at16k();
        const mic = await open({ frameMs: 10 });
        const older = mic[Symbol.asyncIterator]();
        // A 30 ms block converts to three frames, so two are still unread when the new iteration starts.
        stream().record(constant(0.25, 480));
        stream().record(constant(0.25));
        expect(await nextFrame(older)).toEqual(pcm(0.25));
        mic[Symbol.asyncIterator]();

        expect(await withTimeout(older.next())).toEqual({ done: true, value: undefined });
    });

    it("ends a waiting read when its iteration is returned", async () => {
        at16k();
        const frames = (await open({ frameMs: 10 }))[Symbol.asyncIterator]();
        const waiting = frames.next();
        await frames.return?.();
        stream().record(constant(0.25));

        expect(await withTimeout(waiting)).toEqual({ done: true, value: undefined });
    });

    it("rejects a second read while one is waiting", async () => {
        at16k();
        const frames = (await open({ frameMs: 10 }))[Symbol.asyncIterator]();
        const waiting = frames.next();

        await expect(frames.next()).rejects.toThrow(
            "Another caller is already waiting for a frame from Built-in Microphone",
        );
        stream().record(constant(0.25));
        expect((await withTimeout(waiting)).value).toEqual(pcm(0.25));
    });

    it("ends iteration when the microphone closes", async () => {
        const mic = await open();
        const collecting = collect(mic);
        await tick();
        await mic.close();

        expect(await withTimeout(collecting)).toEqual([]);
        expect(await withTimeout(collect(mic))).toEqual([]);
    });

    it("ends iteration and releases the recording when stopping fails", async () => {
        const mic = await open();
        const collecting = collect(mic);
        await tick();
        fake.failOnStop = new Error("Failed to stop");

        await expect(mic.close()).rejects.toThrow("Failed to stop");
        expect(await withTimeout(collecting)).toEqual([]);
        expect(stream().destroyed).toBe(true);
    });

    it("does not count audio left behind by ended iterations toward the cap", async () => {
        at16k();
        const mic = await open({ frameMs: 10 });
        const recordOneSecond = () => {
            for (let i = 0; i < 100; i++) {
                stream().record(constant(0.25));
            }
        };
        // Each iteration leaves 0.99 seconds unread, so 20 of them would exceed the cap if kept.
        for (let i = 0; i < 20; i++) {
            setImmediate(recordOneSecond);
            expect(await nextFrame(mic[Symbol.asyncIterator]())).toEqual(pcm(0.25));
        }
    });

    it("throws when the stream stops on its own", async () => {
        const mic = await open();
        setImmediate(() => stream().fail(new Error("decibri: audio device error: The device is no longer available")));

        await expect(withTimeout(collect(mic))).rejects.toThrow(
            "The audio stream from Built-in Microphone stopped, for example because the device was disconnected. " +
                "decibri reported: decibri: audio device error: The device is no longer available",
        );
    });

    it("throws when more than 10 seconds of audio builds up", async () => {
        at16k();
        const mic = await open({ frameMs: 10 });
        const frames = mic[Symbol.asyncIterator]();
        // Exactly 10 seconds, which is within the cap: a 30 ms block that converts to three frames,
        // then 997 blocks of 10 ms.
        stream().record(constant(0.25, 480));
        for (let i = 0; i < 997; i++) {
            stream().record(constant(0.25));
        }
        expect(await nextFrame(frames)).toEqual(pcm(0.25));
        for (let i = 0; i < 10; i++) {
            stream().record(constant(0.25));
        }

        // Thrown even though two frames of the 30 ms block are still unread.
        await expect(frames.next()).rejects.toThrow("More than 10 seconds of audio from Built-in Microphone");
        expect(await frames.next()).toEqual({ done: true, value: undefined });
        stream().record(constant(0.5));
        setImmediate(() => stream().record(constant(-0.5)));
        expect(await nextFrame(mic[Symbol.asyncIterator]())).toEqual(pcm(-0.5));
    });

    it("throws when frames shorter than blocks let the loop fall behind", async () => {
        at16k();
        const frames = (await open({ frameMs: 10 }))[Symbol.asyncIterator]();

        // Each 100 ms block converts to ten frames and the loop reads one frame per block, so it
        // falls another 90 ms behind with every block.
        await expect(
            (async () => {
                for (let i = 0; i < 200; i++) {
                    stream().record(constant(0.25, 1600));
                    await nextFrame(frames);
                }
            })(),
        ).rejects.toThrow("More than 10 seconds of audio");
    });

    it("counts audio decibri discarded without ending the iteration", async () => {
        at16k();
        const mic = await open({ frameMs: 10 });
        const frames = mic[Symbol.asyncIterator]();
        stream().record(constant(0.25));
        stream().overrunCount = 1;
        stream().record(constant(0.5));

        expect([await nextFrame(frames), await nextFrame(frames)]).toEqual([pcm(0.25), pcm(0.5)]);
        expect(mic.inputOverflows).toBe(1);
        await mic.close();
        expect(mic.inputOverflows).toBe(1);
    });

    it("counts audio decibri discarded after the last block it delivered", async () => {
        const mic = await open();
        stream().record(constant(0.25));
        stream().overrunCount = 2;
        await mic.close();

        expect(mic.inputOverflows).toBe(2);
    });

    it("keeps the count of discarded audio after the device fails", async () => {
        const mic = await open();
        stream().overrunCount = 3;
        stream().record(constant(0.25));
        stream().fail(new Error("decibri: audio device error: The device is no longer available"));

        expect(mic.inputOverflows).toBe(3);
    });

    it.each([
        [5, "There is no input device with index 5"],
        ["Studio", 'No input device matches "Studio"'],
        ["microphone", '"microphone" matches more than one input device'],
        [undefined, "There is no default input device"],
    ])("lists the input devices when %s cannot be used", async (selected, reason) => {
        fake.reset([
            device("Built-in Microphone", { isDefault: false }),
            device("USB Microphone", { index: 1, isDefault: false }),
        ]);

        await expect(Microphone.open({ device: selected })).rejects.toThrow(
            `${reason}. Available input devices: 0: Built-in Microphone; 1: USB Microphone.`,
        );
        expect(fake.streams).toEqual([]);
    });

    it("says so when there are no input devices", async () => {
        fake.reset([]);

        await expect(Microphone.open()).rejects.toThrow(
            "There is no default input device. No input devices are available.",
        );
    });

    it("selects a device whose whole name matches even if other names contain it", async () => {
        fake.reset([device("Microphone"), device("USB Microphone", { index: 1, isDefault: false })]);

        expect((await open({ device: "microphone" })).deviceName).toBe("Microphone");
        expect(stream().options.device).toEqual({ id: "coreaudio:Microphone" });
    });

    it("selects a device without a stable ID by index", async () => {
        fake.reset([device("Built-in Microphone"), device("USB Microphone", { index: 1, id: "", isDefault: false })]);

        expect((await open({ device: "usb" })).deviceName).toBe("USB Microphone");
        expect(stream().options.device).toBe(1);
    });

    it("rejects with decibri's error when the device fails to start", async () => {
        const failure = new Error("Failed to open audio stream: the device is busy");
        fake.failOnStart = failure;

        await expect(Microphone.open()).rejects.toBe(failure);
        expect(stream().destroyed).toBe(true);
    });

    it.each([0, 10001])("rejects a frame duration of %i before opening the device", async (frameMs) => {
        await expect(Microphone.open({ frameMs })).rejects.toThrow("frameMs must be between 1 and 10000");
        expect(fake.streams).toEqual([]);
    });

    it("points to open when constructed directly", () => {
        expect(() => Reflect.construct(Microphone, [])).toThrow("await Microphone.open()");
    });
});
