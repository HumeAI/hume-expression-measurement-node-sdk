// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type { AddressInfo } from "net";
import { type WebSocket, WebSocketServer } from "ws";
import { ExpressionMeasurementClient } from "../../src/index";
import { SessionEndedError, streamVideo, type VideoFrame } from "../../src/video-helpers/index";

type Reply = Record<string, unknown>;

// Plays the server's side of a realtime video session. `respond` returns the messages to send for
// each frame received, given the frame's first byte and how many times that frame has arrived.
// A `session.close` is answered with `session.closed` and a normal close. With `refuse`, every
// connection is refused with a 401, as for an invalid API key.
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
        refuse = false,
    ) {
        this.server = new WebSocketServer({
            host: "127.0.0.1",
            port: 0,
            verifyClient: () => {
                this.attempts++;
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

describe("streamVideo", () => {
    let server: FakeServer | undefined;

    afterEach(async () => {
        vi.useRealTimers();
        await server?.close();
        server = undefined;
    });

    async function connect(respond: (frame: number, attempt: number, client: WebSocket) => Reply[], refuse = false) {
        server = new FakeServer(respond, refuse);
        const client = new ExpressionMeasurementClient({ apiKey: "test-key", baseUrl: await server.url });
        return client.video.connect();
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

    it.each(["rate_limited", "overloaded"])("drops a live frame rejected with %s", async (code) => {
        const socket = await connect((id) => (id === 1 ? [error(code)] : [RESULT]));

        const replies = await collect(streamVideo(socket, framesOf(frame(0), frame(1), frame(2)), { live: true }));

        expect(replies).toEqual(["0 result", `100 ${code}`, "200 result"]);
        expect(server?.received).toEqual([0, 1, 2]);
    });

    it("sends rejected recorded frames again after a wait, and yields replies in frame order", async () => {
        const socket = await connect((id, attempt) => {
            if (id === 1 && attempt === 1) {
                return [error("rate_limited")];
            }
            if (id === 2 && attempt === 1) {
                return [error("overloaded")];
            }
            return [RESULT];
        });

        const replies = await collect(streamVideo(socket, framesOf(frame(0), frame(1), frame(2), frame(3))));

        expect(replies).toEqual(["0 result", "100 result", "200 result", "300 result"]);
        expect(server?.received).toEqual([0, 1, 2, 3, 1, 2]);
        const arrivals = server?.arrivals ?? [];
        expect(arrivals[4] - arrivals[1]).toBeGreaterThanOrEqual(90);
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

    it("never sends a frame over 2 MB, which would end the session", async () => {
        const socket = await connect(() => [RESULT]);

        const replies = await collect(streamVideo(socket, framesOf(frame(0), frame(1, 2_000_001), frame(2))));

        expect(replies).toEqual(["0 result", "100 message_too_large", "200 result"]);
        expect(server?.received).toEqual([0, 2]);
    });

    it("throws the code of a session-ending error after the replies before it, without reconnecting", async () => {
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
        await sleep(200);
        expect(server?.connections).toBe(1);
    });

    // The socket reconnects after a 1008 close, starting a new session, unless it is closed first.
    // Its first reconnect waits at least a second, so this checks the close itself.
    it("closes the socket as soon as the session ends, while the caller still holds a reply", async () => {
        const socket = await connect((id, _attempt, client) => {
            if (id === 1) {
                client.send(JSON.stringify(error("config_invalid", false)));
                server?.closeSession(client, "error", 1008);
                return [];
            }
            return [RESULT];
        });
        const close = vi.spyOn(socket, "close");
        const replies = streamVideo(socket, framesOf(frame(0), frame(1)))[Symbol.asyncIterator]();

        await replies.next();

        await vi.waitFor(() => expect(close).toHaveBeenCalled());
        await expect(replies.next()).rejects.toBeInstanceOf(SessionEndedError);
    });

    it("throws when the connection closes without the session closing, without reconnecting", async () => {
        const socket = await connect((id, _attempt, client) => {
            if (id === 1) {
                client.close(1011);
                return [];
            }
            return [RESULT];
        });

        const thrown = await collect(streamVideo(socket, framesOf(frame(0), frame(1), frame(2)))).catch(
            (e: unknown) => e,
        );

        expect(thrown).toBeInstanceOf(SessionEndedError);
        expect(thrown).toMatchObject({ closed: undefined, message: expect.stringContaining("code 1011") });
        await sleep(200);
        expect(server?.connections).toBe(1);
    });

    it("throws an Error when the connection does not open, without retrying", async () => {
        const socket = await connect(() => [RESULT], true);

        const thrown = await collect(streamVideo(socket, framesOf(frame(0)))).catch((e: unknown) => e);

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe("The connection did not open: Unexpected server response: 401");
        await sleep(200);
        expect(server?.attempts).toBe(1);
    });

    it("drops live frames that arrive with no send allowance left", async () => {
        const socket = await connect(() => [RESULT]);
        await socket.waitForOpen();
        vi.useFakeTimers({ toFake: ["Date"] });
        const frames = Array.from({ length: 40 }, (_, id) => frame(id));

        const stream = streamVideo(socket, framesOf(...frames), { live: true });
        const replies = await collect(stream);

        expect(replies).toHaveLength(27);
        expect(stream.droppedFrames).toBe(13);
        expect(server?.received).toEqual(frames.slice(0, 27).map((_, id) => id));
    });

    it("sends the first 27 recorded frames at once and paces the rest to 30 per second", async () => {
        const socket = await connect(() => [RESULT]);
        const frames = Array.from({ length: 36 }, (_, id) => frame(id));

        const replies = await collect(streamVideo(socket, framesOf(...frames)));

        expect(replies).toHaveLength(36);
        const arrivals = server?.arrivals ?? [];
        expect(arrivals[26] - arrivals[0]).toBeLessThan(100);
        expect(arrivals[35] - arrivals[0]).toBeGreaterThanOrEqual(250);
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
