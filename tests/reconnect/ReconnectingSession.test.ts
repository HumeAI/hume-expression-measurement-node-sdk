// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type { AddressInfo } from "net";
import { type WebSocket, WebSocketServer } from "ws";
import { connectAudio } from "../../src/audio-helpers/index";
import { ExpressionMeasurementClient } from "../../src/index";
import type { ReconnectingSession } from "../../src/reconnect/ReconnectingSession";
import { connectVideo } from "../../src/video-helpers/index";

type Received = { json: Record<string, unknown> } | { binary: number };

interface Connection {
    client: WebSocket;
    sessionId: string;
    received: Received[];
}

// Plays the server's side of realtime sessions: `session.created` on connect, `session.updated` for
// each `session.update`, and, unless `answerClose` is off, `session.closed` then 1000 for
// `session.close`. Handshakes are
// rejected with the statuses in `rejections`, one per attempt, or always with `rejectAll`.
class FakeServer {
    public readonly connections: Connection[] = [];
    public handshakes = 0;
    public rejections: number[] = [];
    public rejectAll: number | undefined;
    public answerClose = true;
    private readonly server: WebSocketServer;

    constructor() {
        this.server = new WebSocketServer({
            host: "127.0.0.1",
            port: 0,
            verifyClient: (_info, done) => {
                this.handshakes++;
                const status = this.rejectAll ?? this.rejections.shift();
                if (status === undefined) {
                    done(true);
                } else {
                    done(false, status);
                }
            },
        });
        this.server.on("connection", (client, request) => {
            const connection: Connection = {
                client,
                sessionId: `session-${this.connections.length + 1}`,
                received: [],
            };
            this.connections.push(connection);
            const config = request.url?.includes("/video/")
                ? { image: { type: "jpeg" }, face: { threshold: 0.5, min_size: 0 } }
                : {
                      audio: { type: "raw", encoding: "pcm_s16le", sample_rate: 16000, channels: 1 },
                      measurement_timer_ms: 3000,
                  };
            client.send(JSON.stringify({ type: "session.created", session_id: connection.sessionId, ...config }));
            client.on("message", (data, isBinary) => {
                if (isBinary) {
                    connection.received.push({ binary: (data as Buffer)[0] });
                    return;
                }
                const json = JSON.parse(data.toString());
                connection.received.push({ json });
                if (json.type === "session.update") {
                    client.send(JSON.stringify({ ...json, type: "session.updated", session_id: connection.sessionId }));
                } else if (json.type === "session.close" && this.answerClose) {
                    this.endSession(connection, "client_request", 1000);
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

    public get latest(): Connection {
        return this.connections[this.connections.length - 1];
    }

    public endSession(connection: Connection, reason: string, code: number): void {
        connection.client.send(
            JSON.stringify({
                type: "session.closed",
                session_id: connection.sessionId,
                reason,
                received: {},
                produced: {},
            }),
        );
        connection.client.close(code);
    }

    public close(): Promise<void> {
        for (const client of this.server.clients) {
            client.terminate();
        }
        return new Promise((resolve) => this.server.close(() => resolve()));
    }
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error("timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function frame(id: number): Uint8Array {
    return new Uint8Array([id, 0]);
}

describe("connectAudio", () => {
    let server: FakeServer;
    let client: ExpressionMeasurementClient;

    beforeEach(async () => {
        server = new FakeServer();
        client = new ExpressionMeasurementClient({ apiKey: "test-key", baseUrl: await server.url });
    });

    afterEach(async () => {
        await server.close();
    });

    function record(options: Partial<ReconnectingSession.Options<unknown>> = {}) {
        const events = {
            reconnecting: [] as ReconnectingSession.ReconnectingEvent[],
            reconnects: [] as ReconnectingSession.ReconnectEvent[],
            closes: [] as ReconnectingSession.CloseEvent[],
            messages: [] as string[],
        };
        return {
            events,
            options: {
                initialDelayMs: 40,
                maxDelayMs: 200,
                onMessage: (message: { type: string }) => events.messages.push(message.type),
                onReconnecting: (event: ReconnectingSession.ReconnectingEvent) => events.reconnecting.push(event),
                onReconnect: (event: ReconnectingSession.ReconnectEvent) => events.reconnects.push(event),
                onClose: (event: ReconnectingSession.CloseEvent) => events.closes.push(event),
                ...options,
            },
        };
    }

    const UPDATE = { type: "session.update", measurementTimerMs: 5000 } as const;

    it("on 1012 opens a new session at once and sends it the last session.update", async () => {
        const { events, options } = record();
        const session = await connectAudio(client.audio, { ...options, sessionUpdate: UPDATE });
        session.sendAudioFrame(frame(1));
        await until(() => server.latest.received.length === 2);

        server.endSession(server.latest, "server_shutdown", 1012);
        await until(() => events.reconnects.length === 1);
        session.sendAudioFrame(frame(2));
        await until(() => server.connections[1].received.length === 2);

        expect(server.connections[1].received).toEqual([
            { json: { type: "session.update", measurement_timer_ms: 5000 } },
            { binary: 2 },
        ]);
        expect(events.reconnecting).toEqual([
            { code: 1012, httpStatus: undefined, attempt: 1, delayMs: expect.any(Number) },
        ]);
        expect(events.reconnecting[0].delayMs).toBeLessThan(250);
        expect(events.reconnects).toEqual([
            { previousSessionId: "session-1", sessionId: "session-2", code: 1012, attempts: 1 },
        ]);
        expect(session.sessionId).toBe("session-2");
        expect(events.closes).toEqual([]);
        session.close();
    });

    it("reconnects after server_shutdown closed with 1000, as servers before 1012 do", async () => {
        const { events, options } = record();
        const session = await connectAudio(client.audio, options);
        server.endSession(server.latest, "server_shutdown", 1000);
        await until(() => events.reconnects.length === 1);
        expect(events.reconnects[0].code).toBe(1000);
        session.close();
    });

    it("reconnects when the connection drops without a close frame", async () => {
        const { events, options } = record();
        const session = await connectAudio(client.audio, { ...options, sessionUpdate: UPDATE });
        server.latest.client.terminate();
        await until(() => events.reconnects.length === 1);
        expect(events.reconnecting[0].code).toBe(1006);
        await until(() => server.connections[1].received.length === 1);
        expect(server.connections[1].received[0]).toEqual({
            json: { type: "session.update", measurement_timer_ms: 5000 },
        });
        session.close();
    });

    it("backs off exponentially on 1013 and on a 503 handshake", async () => {
        const { events, options } = record();
        const session = await connectAudio(client.audio, options);
        server.rejections = [503, 503];
        server.latest.client.close(1013);
        await until(() => events.reconnects.length === 1);

        expect(events.reconnecting.map((event) => [event.code, event.httpStatus, event.attempt])).toEqual([
            [1013, undefined, 1],
            [1006, 503, 2],
            [1006, 503, 3],
        ]);
        // Each wait is between half and all of 40 ms doubled per attempt.
        events.reconnecting.forEach((event, index) => {
            expect(event.delayMs).toBeGreaterThanOrEqual(20 * 2 ** index);
            expect(event.delayMs).toBeLessThanOrEqual(40 * 2 ** index);
        });
        expect(events.reconnects[0].attempts).toBe(3);
        session.close();
    });

    it("gives up after maxAttempts", async () => {
        const { events, options } = record({ maxAttempts: 2 });
        await connectAudio(client.audio, options);
        server.rejectAll = 503;
        server.latest.client.close(1012);
        await until(() => events.closes.length === 1);

        expect(server.handshakes).toBe(3);
        expect(events.closes).toEqual([
            { code: 1006, httpStatus: 503, sessionClosedReason: undefined, error: expect.any(String), gaveUp: true },
        ]);
    });

    it.each([
        ["idle_timeout", 1000],
        ["error", 1008],
        [undefined, 4001],
    ])("does not reconnect after %s with %i", async (reason, code) => {
        const { events, options } = record();
        await connectAudio(client.audio, options);
        if (reason === undefined) {
            server.latest.client.close(code);
        } else {
            server.endSession(server.latest, reason, code);
        }
        await until(() => events.closes.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(server.connections).toHaveLength(1);
        expect(events.reconnecting).toEqual([]);
        expect(events.closes[0]).toMatchObject({ code, sessionClosedReason: reason, gaveUp: false });
    });

    it("does not reconnect after session.close, even if the server then restarts", async () => {
        const { events, options } = record();
        const session = await connectAudio(client.audio, options);
        server.answerClose = false;
        session.sendSessionClose();
        await until(() => server.latest.received.length === 1);
        server.endSession(server.latest, "server_shutdown", 1012);
        await until(() => events.closes.length === 1);

        expect(server.connections).toHaveLength(1);
        expect(events.closes[0]).toMatchObject({ code: 1012, gaveUp: false });
    });

    it("rejects without retrying when the API key is refused", async () => {
        const { events, options } = record();
        server.rejectAll = 401;
        await expect(connectAudio(client.audio, options)).rejects.toThrow("HTTP 401");
        expect(server.handshakes).toBe(1);
        expect(events.closes[0]).toMatchObject({ httpStatus: 401, gaveUp: false });
    });

    it("queues audio sent while reconnecting and sends it after the configuration", async () => {
        const { events, options } = record({ initialDelayMs: 100 });
        const session = await connectAudio(client.audio, { ...options, sessionUpdate: UPDATE });
        server.latest.client.close(1013);
        await until(() => events.reconnecting.length === 1);

        expect(session.reconnecting).toBe(true);
        session.sendAudioFrame(frame(7));
        session.sendAudioFrame(frame(8));
        await until(() => server.connections[1]?.received.length === 3);

        expect(server.connections[1].received).toEqual([
            { json: { type: "session.update", measurement_timer_ms: 5000 } },
            { binary: 7 },
            { binary: 8 },
        ]);
        expect(session.reconnecting).toBe(false);
        session.close();
    });

    it("passes the new session's messages through after the reconnect event", async () => {
        const { events, options } = record();
        const order: string[] = [];
        const session = await connectAudio(client.audio, {
            ...options,
            onMessage: (message) => order.push(message.type),
            onReconnect: () => order.push("reconnect"),
        });
        server.endSession(server.latest, "server_shutdown", 1012);
        await until(() => order.length === 4);

        expect(order).toEqual(["session.created", "session.closed", "reconnect", "session.created"]);
        expect(events.closes).toEqual([]);
        session.close();
    });
});

describe("connectVideo", () => {
    it("sends the last session.update to the session after a restart", async () => {
        const server = new FakeServer();
        const client = new ExpressionMeasurementClient({ apiKey: "test-key", baseUrl: await server.url });
        const reconnects: string[] = [];
        const session = await connectVideo(client.video, {
            onReconnect: ({ sessionId }) => reconnects.push(sessionId),
        });
        session.sendSessionUpdate({ type: "session.update", face: { threshold: 0.8 } });
        server.endSession(server.latest, "server_shutdown", 1012);
        await until(() => server.connections[1]?.received.length === 1);

        expect(server.connections[1].received).toEqual([
            { json: { type: "session.update", face: { threshold: 0.8 } } },
        ]);
        expect(reconnects).toEqual(["session-2"]);
        session.close();
        await server.close();
    });
});
