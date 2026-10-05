// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type { AddressInfo, Socket } from "net";
import { type WebSocket, WebSocketServer } from "ws";
import { ExpressionMeasurementClient } from "../../src/index";
import { SessionEndedError, streamVideo, type VideoFrame } from "../../src/video-helpers/index";

type Reply = Record<string, unknown>;

// Plays the server's side of a realtime video session. `respond` returns the messages to send for
// each frame received, given the frame's first byte and how many times that frame has arrived.
// A `session.close` is answered with `session.closed` and a normal close. With `refuse`, every
// connection is refused with a 401, as for an invalid API key. `onAttempt` runs as each connection
// request arrives, while the client is still opening.
class FakeServer {
    public readonly received: number[] = [];
    public readonly arrivals: number[] = [];
    public attempts = 0;
    public connections = 0;
    public closeCodes: number[] = [];
    private readonly server: WebSocketServer;
    private results = 0;

    constructor(
        private readonly respond: (frame: number, attempt: number, client: WebSocket) => Reply[],
        { refuse = false, onAttempt }: { refuse?: boolean; onAttempt?: () => void } = {},
    ) {
        this.server = new WebSocketServer({
            host: "127.0.0.1",
            port: 0,
            verifyClient: () => {
                this.attempts++;
                onAttempt?.();
                return !refuse;
            },
        });
        this.server.on("connection", (client) => {
            this.connections++;
            client.on("close", (code) => this.closeCodes.push(code));
            client.on("message", (data, isBinary) => {
                if (!isBinary) {
                    if (JSON.parse(data.toString()).type === "session.close") {
                        this.closeSession(client, "client_request", 1000);
                    }
                    return;
                }
                const frame = (data as Buffer)[0];
                this.received.push(frame);
                this.arrivals.push(Date.now());
                const attempt = this.received.filter((f) => f === frame).length;
                for (const message of this.respond(frame, attempt, client)) {
                    if (message.type === "measurement.result") {
                        message.frame_id = this.results++;
                    }
                    client.send(JSON.stringify(message));
                }
            });
        });
    }

    public get url(): Promise<string> {
        return new Promise((resolve) => {
            const resolveUrl = () => resolve(`ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`);
            if (this.server.address() !== null) {
                resolveUrl();
            } else {
                this.server.once("listening", resolveUrl);
            }
        });
    }

    public closeSession(client: WebSocket, reason: string, code: number): void {
        client.send(
            JSON.stringify({
                type: "session.closed",
                session_id: "session-1",
                reason,
                received: { frames: this.results },
                produced: { measurements: this.results },
            }),
        );
        client.close(code);
    }

    public close(): Promise<void> {
        for (const client of this.server.clients) {
            client.terminate();
        }
        return new Promise((resolve) => this.server.close(() => resolve()));
    }
}

const RESULT: Reply = { type: "measurement.result", faces: [] };

function error(code: string, retryable = true): Reply {
    return { type: "error", code, message: `${code} message`, retryable };
}

// Each frame's first byte identifies it to the fake server, and its timestamp is 100 times that.
function frame(id: number, size = 1): VideoFrame {
    const data = new Uint8Array(size);
    data[0] = id;
    return { data, timestampMs: id * 100 };
}

async function* framesOf(...frames: VideoFrame[]): AsyncGenerator<VideoFrame> {
    yield* frames;
}

function describeReplies(replies: { timestampMs: number; result?: unknown; error?: { code: string } }[]): string[] {
    return replies.map((reply) => `${reply.timestampMs} ${reply.error?.code ?? "result"}`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Answers like a server whose send rate is lower than documented: a burst of `burst` frames, then
// `perSecond` frames per second, rejecting the rest with `rate_limited`.
function limitedTo(perSecond: number, burst: number): () => Reply[] {
    let allowance = burst;
    let updatedAt = Date.now();
    return () => {
        const now = Date.now();
        allowance = Math.min(burst, allowance + ((now - updatedAt) * perSecond) / 1000);
        updatedAt = now;
        if (allowance < 1) {
            return [error("rate_limited")];
        }
        allowance -= 1;
        return [RESULT];
    };
}

// Writes a close frame with `code` to the client without closing the connection, as when the
// server's close is still on its way. The server stops reading, so it never answers the client's
// own close frame.
function sendCloseFrame(client: WebSocket, code: number): Socket {
    const socket = (client as unknown as { _socket: Socket })._socket;
    socket.pause();
    socket.write(Buffer.from([0x88, 0x02, code >> 8, code & 0xff]));
    return socket;
}

async function* liveFrames(count: number, intervalMs: number): AsyncGenerator<VideoFrame> {
    for (let id = 0; id < count; id++) {
        yield frame(id);
        await sleep(intervalMs);
    }
}

describe("streamVideo", () => {
    let server: FakeServer | undefined;

    afterEach(async () => {
        vi.useRealTimers();
        await server?.close();
        server = undefined;
    });

    async function connect(
        respond: (frame: number, attempt: number, client: WebSocket) => Reply[],
        serverOptions: ConstructorParameters<typeof FakeServer>[1] = {},
        connectArgs: Parameters<ExpressionMeasurementClient["video"]["connect"]>[0] = {},
    ) {
        server = new FakeServer(respond, serverOptions);
        const client = new ExpressionMeasurementClient({ apiKey: "test-key", baseUrl: await server.url });
        return client.video.connect(connectArgs);
    }

    async function collect(stream: AsyncIterable<unknown>): Promise<string[]> {
        const replies = [];
        for await (const reply of stream) {
            replies.push(reply);
        }
        return describeReplies(replies as Parameters<typeof describeReplies>[0]);
    }

    it("pairs each reply with its frame when rejections are interleaved", async () => {
        const replies: Record<number, Reply[]> = {
            1: [error("invalid_image_frame")],
            // Answers a text message, so it consumes no frame.
            2: [error("message_invalid"), RESULT],
            3: [error("internal_error", false)],
        };
        const socket = await connect((id) => replies[id] ?? [RESULT]);

        const stream = streamVideo(socket, framesOf(frame(0), frame(1), frame(2), frame(3), frame(4)), { live: true });

        expect(await collect(stream)).toEqual([
            "0 result",
            "100 invalid_image_frame",
            "200 result",
            "300 internal_error",
            "400 result",
        ]);
    });

    it("closes the session when the frames run out and exposes its totals", async () => {
        const socket = await connect(() => [RESULT]);

        const stream = streamVideo(socket, framesOf(frame(0), frame(1)));
        await collect(stream);

        expect(stream.closed).toMatchObject({ reason: "client_request", received: { frames: 2 } });
        expect(stream.droppedFrames).toBe(0);
        await vi.waitFor(() => expect(server?.closeCodes).toEqual([1000]));
    });

    it("drops a live frame rejected with rate_limited", async () => {
        const socket = await connect((id) => (id === 1 ? [error("rate_limited")] : [RESULT]));

        const replies = await collect(streamVideo(socket, framesOf(frame(0), frame(1), frame(2)), { live: true }));

        expect(replies).toEqual(["0 result", "100 rate_limited", "200 result"]);
        expect(server?.received).toEqual([0, 1, 2]);
    });

    it("sends rejected recorded frames again after a wait, and yields replies in frame order", async () => {
        const socket = await connect((id, attempt) => {
            if (id === 1 && attempt === 1) {
                return [error("rate_limited")];
            }
            if (id === 2 && attempt === 1) {
                return [error("rate_limited")];
            }
            return [RESULT];
        });

        const replies = await collect(streamVideo(socket, framesOf(frame(0), frame(1), frame(2), frame(3))));

        expect(replies).toEqual(["0 result", "100 result", "200 result", "300 result"]);
        expect(server?.received).toEqual([0, 1, 2, 3, 1, 2]);
        // The first rejection halves the rate to 2 frames per second, so the first resend waits
        // one frame at that rate. The second frame was sent before the first rejection arrived,
        // so its rejection does not halve the rate again, which would double the wait.
        const arrivals = server?.arrivals ?? [];
        expect(arrivals[4] - arrivals[1]).toBeGreaterThanOrEqual(450);
        expect(arrivals[4] - arrivals[1]).toBeLessThan(900);
    });

    it("slows a recording to a server rate lower than documented, rather than resending most frames", async () => {
        const socket = await connect(limitedTo(2, 2));
        const frames = Array.from({ length: 10 }, (_, id) => frame(id));

        const replies = await collect(streamVideo(socket, framesOf(...frames)));

        expect(replies).toEqual(frames.map((f) => `${f.timestampMs} result`));
        // The first 7 frames go out before any reply, and the 5 beyond the server's burst are
        // rejected. After that, few frames are sent only to be rejected.
        expect(server?.received.length).toBeLessThanOrEqual(10 + 5 + 3);
    }, 10_000);

    it("drops live frames before sending them when the server rate is lower than documented", async () => {
        const socket = await connect(limitedTo(2, 2));

        const stream = streamVideo(socket, liveFrames(60, 33), { live: true });
        const replies = await collect(stream);

        const rejected = replies.filter((reply) => reply.endsWith("rate_limited")).length;
        expect(rejected).toBeLessThan(8);
        expect(stream.droppedFrames).toBeGreaterThan(45);
    });

    it("sends a recorded frame once more after a retryable internal error, but not a live one", async () => {
        const respond = (id: number) => (id === 1 ? [error("internal_error", true)] : [RESULT]);

        const recorded = await collect(streamVideo(await connect(respond), framesOf(frame(0), frame(1), frame(2))));
        const recordedFrames = server?.received;
        await server?.close();
        const live = await collect(
            streamVideo(await connect(respond), framesOf(frame(0), frame(1), frame(2)), { live: true }),
        );

        expect(recorded).toEqual(["0 result", "100 internal_error", "200 result"]);
        expect(recordedFrames).toEqual([0, 1, 2, 1]);
        expect(live).toEqual(["0 result", "100 internal_error", "200 result"]);
        expect(server?.received).toEqual([0, 1, 2]);
    });

    it("sends a frame of 2,000,000 bytes but never a larger one, which would end the session", async () => {
        const socket = await connect(() => [RESULT]);

        const replies = await collect(
            streamVideo(socket, framesOf(frame(0, 2_000_000), frame(1, 2_000_001), frame(2))),
        );

        expect(replies).toEqual(["0 result", "100 message_too_large", "200 result"]);
        expect(server?.received).toEqual([0, 2]);
    });

    it("throws the code of a session-ending error after the replies before it", async () => {
        const socket = await connect((id, _attempt, client) => {
            if (id === 1) {
                client.send(JSON.stringify(error("config_invalid", false)));
                server?.closeSession(client, "error", 1008);
                return [];
            }
            return [RESULT];
        });
        const replies: string[] = [];

        const thrown = await (async () => {
            for await (const reply of streamVideo(socket, framesOf(frame(0), frame(1), frame(2)))) {
                replies.push(...describeReplies([reply]));
            }
        })().catch((e: unknown) => e);

        expect(replies).toEqual(["0 result"]);
        expect(thrown).toBeInstanceOf(SessionEndedError);
        expect(thrown).toMatchObject({ code: "config_invalid", closed: { reason: "error" } });
    });

    it.each([
        "idle_timeout",
        "server_shutdown",
    ])("throws when the session ends with %s before the frames do", async (reason) => {
        const socket = await connect((_id, _attempt, client) => {
            setTimeout(() => server?.closeSession(client, reason, 1000), 50);
            return [RESULT];
        });
        async function* frames(): AsyncGenerator<VideoFrame> {
            yield frame(0);
            await new Promise(() => {});
        }
        const replies: string[] = [];

        const thrown = await (async () => {
            for await (const reply of streamVideo(socket, frames())) {
                replies.push(...describeReplies([reply]));
            }
        })().catch((e: unknown) => e);

        expect(replies).toEqual(["0 result"]);
        expect(thrown).toBeInstanceOf(SessionEndedError);
        expect(thrown).toMatchObject({ code: undefined, closed: { reason } });
    });

    // The socket reconnects after a server shutdown, starting a new session, unless it is closed
    // first. Its first reconnect waits at least a second, so this checks the close itself.
    it("closes the socket as soon as the session ends, while the caller still holds a reply", async () => {
        const socket = await connect((id, _attempt, client) => {
            if (id === 1) {
                server?.closeSession(client, "server_shutdown", 1000);
                return [];
            }
            return [RESULT];
        });
        const close = vi.spyOn(socket.socket, "close");
        const replies = streamVideo(socket, framesOf(frame(0), frame(1)))[Symbol.asyncIterator]();

        await replies.next();

        await vi.waitFor(() => expect(close).toHaveBeenCalled());
        await expect(replies.next()).rejects.toBeInstanceOf(SessionEndedError);
    });

    // The socket reconnects after an unexpected close, starting a new session, unless it is closed
    // first. Its first reconnect waits at least a second, so this checks the close itself.
    it("closes the socket as soon as the connection drops, while the caller still holds a reply", async () => {
        const socket = await connect((id, _attempt, client) => {
            if (id === 1) {
                client.close(1011);
                return [];
            }
            return [RESULT];
        });
        const close = vi.spyOn(socket.socket, "close");
        const replies = streamVideo(socket, framesOf(frame(0), frame(1)))[Symbol.asyncIterator]();

        await replies.next();

        await vi.waitFor(() => expect(close).toHaveBeenCalled());
        const thrown = await replies.next().catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(SessionEndedError);
        expect(thrown).toMatchObject({
            closed: undefined,
            message: "The connection closed with code 1011 before the session ended.",
        });
    });

    it("throws the cause of a connection error rather than the close it reports", async () => {
        const socket = await connect((_id, _attempt, client) => {
            client.send(Buffer.from([0xff]), { binary: false });
            return [];
        });

        const thrown = await collect(streamVideo(socket, framesOf(frame(0)))).catch((e: unknown) => e);

        expect(thrown).toBeInstanceOf(SessionEndedError);
        expect((thrown as Error).message).toBe(
            "The connection failed before the session ended: Invalid WebSocket frame: invalid UTF-8 sequence",
        );
    });

    it("waits for the close rather than sending while the connection is closing", async () => {
        const socket = await connect((id, _attempt, client) => {
            if (id === 0) {
                const raw = sendCloseFrame(client, 1011);
                setTimeout(() => raw.destroy(), 400);
            }
            return [];
        });
        const frames = Array.from({ length: 9 }, (_, id) => frame(id));

        const thrown = await collect(streamVideo(socket, framesOf(...frames))).catch((e: unknown) => e);

        expect(thrown).toBeInstanceOf(SessionEndedError);
        expect((thrown as Error).message).toContain("code 1011");
    });

    it("throws an Error when the connection does not open", async () => {
        const socket = await connect(() => [RESULT], { refuse: true });

        const thrown = await collect(streamVideo(socket, framesOf(frame(0)))).catch((e: unknown) => e);

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe("The connection did not open: Unexpected server response: 401");
    });

    it("leaves the caller's error and close handlers to see a failed connection once", async () => {
        const socket = await connect(() => [RESULT], { refuse: true });
        const onError = vi.fn();
        const onClose = vi.fn();
        socket.on("error", onError);
        socket.on("close", onClose);

        await collect(streamVideo(socket, framesOf(frame(0)))).catch(() => {});

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0]).toMatchObject({ message: "Unexpected server response: 401" });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("throws an Error when the connection is aborted while opening", async () => {
        const controller = new AbortController();
        const socket = await connect(
            () => [RESULT],
            { onAttempt: () => controller.abort() },
            { abortSignal: controller.signal },
        );

        const thrown = await collect(streamVideo(socket, framesOf(frame(0)))).catch((e: unknown) => e);

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe("The connection did not open: aborted");
    });

    it("throws an Error when the socket was closed by an earlier stream", async () => {
        const socket = await connect(() => [RESULT]);
        await collect(streamVideo(socket, framesOf(frame(0))));

        const thrown = await collect(streamVideo(socket, framesOf(frame(1)))).catch((e: unknown) => e);

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe("The connection did not open, because the socket is already closed.");
    });

    it("throws a TypeError when called with frames that are not an async iterable", async () => {
        const socket = await connect(() => [RESULT]);

        expect(() => streamVideo(socket, [frame(0)] as unknown as AsyncIterable<VideoFrame>)).toThrow(TypeError);
    });

    it("can be iterated only once", async () => {
        const socket = await connect(() => [RESULT]);
        const stream = streamVideo(socket, framesOf(frame(0)));

        await collect(stream);

        expect(() => stream[Symbol.asyncIterator]()).toThrow("A video stream can be iterated only once.");
    });

    it("throws an error from the frames unchanged and closes the socket", async () => {
        const socket = await connect(() => [RESULT]);
        const failure = new Error("The camera disconnected.");
        async function* frames(): AsyncGenerator<VideoFrame> {
            yield frame(0);
            throw failure;
        }

        const thrown = await collect(streamVideo(socket, frames())).catch((e: unknown) => e);

        expect(thrown).toBe(failure);
        await vi.waitFor(() => expect(server?.closeCodes).toEqual([1000]));
    });

    it("drops live frames that arrive with no send allowance left", async () => {
        const socket = await connect(() => [RESULT]);
        await socket.waitForOpen();
        vi.useFakeTimers({ toFake: ["performance"] });
        const frames = Array.from({ length: 10 }, (_, id) => frame(id));

        const stream = streamVideo(socket, framesOf(...frames), { live: true });
        const replies = await collect(stream);

        expect(replies).toHaveLength(7);
        expect(stream.droppedFrames).toBe(3);
        expect(server?.received).toEqual(frames.slice(0, 7).map((_, id) => id));
    });

    it("sends the first 7 recorded frames at once and paces the rest to 4 per second", async () => {
        const socket = await connect(() => [RESULT]);
        const frames = Array.from({ length: 9 }, (_, id) => frame(id));

        const replies = await collect(streamVideo(socket, framesOf(...frames)));

        expect(replies).toHaveLength(9);
        const arrivals = server?.arrivals ?? [];
        expect(arrivals[6] - arrivals[0]).toBeLessThan(100);
        expect(arrivals[8] - arrivals[0]).toBeGreaterThanOrEqual(450);
    });

    it("keeps pacing frames when the system clock is set back", async () => {
        const socket = await connect(() => [RESULT]);
        vi.useFakeTimers({ toFake: ["Date"] });
        const frames = Array.from({ length: 9 }, (_, id) => frame(id));
        const replies: unknown[] = [];

        for await (const reply of streamVideo(socket, framesOf(...frames))) {
            if (replies.push(reply) === 1) {
                vi.setSystemTime(Date.now() - 10 * 60 * 1000);
            }
        }

        expect(replies).toHaveLength(9);
    });

    it("closes the socket and stops the frames when the loop ends early", async () => {
        const socket = await connect(() => [RESULT]);
        let stopped = false;
        async function* frames(): AsyncGenerator<VideoFrame> {
            try {
                for (let id = 0; ; id++) {
                    yield frame(id % 256);
                    await sleep(5);
                }
            } finally {
                stopped = true;
            }
        }

        for await (const _ of streamVideo(socket, frames(), { live: true })) {
            break;
        }

        await vi.waitFor(() => expect(server?.closeCodes).toEqual([1000]));
        await vi.waitFor(() => expect(stopped).toBe(true));
    });
});
