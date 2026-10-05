// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type { AddressInfo } from "net";
import { type WebSocket, WebSocketServer } from "ws";
import type { AudioSocket } from "../../src/api/resources/audio/exports";
import type { VideoSocket } from "../../src/api/resources/video/exports";
import { ExpressionMeasurementClient, ReadyState } from "../../src/index";

type Endpoint = "audio" | "video";

interface FakeSession {
    client: WebSocket;
    // Each text message parsed, and "frame" for each binary one.
    received: unknown[];
}

// Plays the server's side of realtime sessions, one session per connection. Handshakes are refused
// with the statuses passed to `refuseNext`, in order.
class FakeServer {
    public readonly sessions: FakeSession[] = [];
    public attempts = 0;
    private readonly refusals: number[] = [];
    private readonly server: WebSocketServer;
    private changed = (): void => {};

    constructor(port = 0) {
        this.server = new WebSocketServer({
            host: "127.0.0.1",
            port,
            verifyClient: (_info, done) => {
                this.attempts++;
                const status = this.refusals.shift();
                done(status === undefined, status);
                this.changed();
            },
        });
        this.server.on("connection", (client) => {
            const session: FakeSession = { client, received: [] };
            this.sessions.push(session);
            client.on("message", (data, isBinary) => {
                session.received.push(isBinary ? "frame" : JSON.parse(data.toString()));
                this.changed();
            });
            this.changed();
        });
    }

    public get port(): Promise<number> {
        return new Promise((resolve) => {
            const resolvePort = () => resolve((this.server.address() as AddressInfo).port);
            if (this.server.address() !== null) {
                resolvePort();
            } else {
                this.server.once("listening", resolvePort);
            }
        });
    }

    public refuseNext(...statuses: number[]): void {
        this.refusals.push(...statuses);
    }

    // Resolves once `condition` holds, checking after every handshake and message.
    public async until(condition: () => boolean): Promise<void> {
        while (!condition()) {
            await new Promise<void>((resolve) => {
                this.changed = resolve;
            });
        }
    }

    public close(): Promise<void> {
        for (const client of this.server.clients) {
            client.terminate();
        }
        return new Promise((resolve) => this.server.close(() => resolve()));
    }
}

const UPDATE = { type: "session.update", measurementTimerMs: 500 } as const;
const UPDATE_ON_WIRE = { type: "session.update", measurement_timer_ms: 500 };

function sessionClosed(endpoint: Endpoint, reason: string): string {
    return JSON.stringify({
        type: "session.closed",
        session_id: "session-1",
        reason,
        received: endpoint === "audio" ? { audio_duration_ms: 0, frames: 0 } : { frames: 0 },
        produced: endpoint === "audio" ? { utterances: 0, measurements: 0 } : { measurements: 0 },
    });
}

// Ends the session the way the server does after a session-ending error.
function endWithError(endpoint: Endpoint, session: FakeSession, code: string): void {
    session.client.send(JSON.stringify({ type: "error", code, message: `${code} message`, retryable: false }));
    session.client.send(sessionClosed(endpoint, "error"));
    session.client.close(1008);
}

function endWithReason(session: FakeSession, reason: string): void {
    session.client.send(sessionClosed("audio", reason));
    session.client.close(1000);
}

function sendInvalidFrame(session: FakeSession): void {
    session.client.send(Buffer.from([0xff]), { binary: false });
}

function next(socket: AudioSocket | VideoSocket, event: "close" | "error"): Promise<void> {
    return new Promise((resolve) => socket.on(event, () => resolve()));
}

// Skips the reconnect delay, which is at least a second.
async function reopened(socket: AudioSocket | VideoSocket): Promise<void> {
    const open = socket.waitForOpen();
    await vi.advanceTimersToNextTimerAsync();
    await open;
}

async function expectStopped(socket: AudioSocket | VideoSocket): Promise<void> {
    await expect(socket.waitForOpen()).rejects.toThrow("WebSocket closed before the connection was opened");
}

describe("realtime reconnects", () => {
    let server: FakeServer;
    let client: ExpressionMeasurementClient;
    const sockets: (AudioSocket | VideoSocket)[] = [];

    beforeEach(async () => {
        // Leaves the sockets' I/O on real time.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        server = new FakeServer();
        client = new ExpressionMeasurementClient({
            apiKey: "test-key",
            baseUrl: `ws://127.0.0.1:${await server.port}`,
        });
    });

    afterEach(async () => {
        for (const socket of sockets.splice(0)) {
            socket.close();
        }
        vi.useRealTimers();
        await server.close();
    });

    // The first connection attempt waits on a timer too, with no delay. Waiting for the open starts
    // first, since the connection can open or fail while the timer runs.
    async function connected<T extends AudioSocket | VideoSocket>(
        connecting: Promise<T>,
    ): Promise<{
        socket: T;
        failure: Promise<unknown>;
    }> {
        const socket = await connecting;
        sockets.push(socket);
        const failure = socket.waitForOpen().then(
            () => undefined,
            (e: unknown) => e,
        );
        await vi.advanceTimersByTimeAsync(0);
        return { socket, failure };
    }

    async function opened<T extends AudioSocket | VideoSocket>(connecting: Promise<T>): Promise<T> {
        const { socket, failure } = await connected(connecting);
        expect(await failure).toBeUndefined();
        return socket;
    }

    async function openWithUpdate(): Promise<AudioSocket> {
        const socket = await opened(client.audio.connect());
        socket.sendAudioSessionUpdate(UPDATE);
        await server.until(() => server.sessions[0].received.length === 1);
        return socket;
    }

    it.each<[string, (session: FakeSession) => void]>([
        ["close code 1001", (session) => session.client.close(1001)],
        ["close code 1011", (session) => session.client.close(1011)],
        ["close code 1012", (session) => session.client.close(1012)],
        ["close code 1013", (session) => session.client.close(1013)],
        ["a dropped connection", (session) => session.client.terminate()],
        ["session.closed with reason server_shutdown and close code 1000", (s) => endWithReason(s, "server_shutdown")],
        ["an internal error", (session) => endWithError("audio", session, "internal_error")],
    ])("reconnects after %s and sends the session.update again", async (_, end) => {
        const socket = await openWithUpdate();

        const closed = next(socket, "close");
        end(server.sessions[0]);
        await closed;
        await reopened(socket);

        await server.until(() => server.sessions[1]?.received.length === 1);
        expect(server.sessions[1].received).toEqual([UPDATE_ON_WIRE]);
    });

    it.each<[string, (session: FakeSession) => void]>([
        ["close code 1000", (session) => session.client.close(1000)],
        ["session.closed with reason idle_timeout", (session) => endWithReason(session, "idle_timeout")],
        ["a session-ending error other than an internal error", (s) => endWithError("audio", s, "config_invalid")],
        ["close code 1008 with no internal error", (session) => session.client.close(1008)],
        ["close code 4000", (session) => session.client.close(4000)],
    ])("does not reconnect after %s", async (_, end) => {
        const socket = await openWithUpdate();

        const closed = next(socket, "close");
        end(server.sessions[0]);
        await closed;

        await expectStopped(socket);
    });

    it("sends the last session.update to a new session before what the caller's open handler sends", async () => {
        const socket = await opened(client.audio.connect());
        socket.sendAudioSessionUpdate({ type: "session.update", measurementTimerMs: 250 });
        socket.sendAudioSessionUpdate(UPDATE);
        socket.on("open", () => socket.sendAudioFrame(new Uint8Array(2)));
        await server.until(() => server.sessions[0].received.length === 2);

        const closed = next(socket, "close");
        server.sessions[0].client.close(1012);
        await closed;
        await reopened(socket);

        await server.until(() => server.sessions[1]?.received.length === 2);
        expect(server.sessions[1].received).toEqual([UPDATE_ON_WIRE, "frame"]);
    });

    it("lets a send loop skip frames until the socket reopens, by comparing readyState with ReadyState", async () => {
        const socket = await openWithUpdate();
        const sendIfOpen = () => {
            if (socket.readyState === ReadyState.OPEN) {
                socket.sendAudioFrame(new Uint8Array(2));
            }
        };

        const closed = next(socket, "close");
        server.sessions[0].client.close(1012);
        await closed;
        sendIfOpen();
        await reopened(socket);
        sendIfOpen();

        await server.until(() => server.sessions[1]?.received.length === 2);
        expect(server.sessions[1].received).toEqual([UPDATE_ON_WIRE, "frame"]);
    });

    it("reconnects a video session and sends its session.update again", async () => {
        const socket = await opened(client.video.connect());
        socket.sendVideoSessionUpdate({ type: "session.update", face: { threshold: 0.5 } });
        await server.until(() => server.sessions[0].received.length === 1);

        const closed = next(socket, "close");
        server.sessions[0].client.close(1012);
        await closed;
        await reopened(socket);

        await server.until(() => server.sessions[1]?.received.length === 1);
        expect(server.sessions[1].received).toEqual([{ type: "session.update", face: { threshold: 0.5 } }]);
    });

    it("does not reconnect a video session that ends after internal errors", async () => {
        const socket = await opened(client.video.connect());

        const closed = next(socket, "close");
        endWithError("video", server.sessions[0], "internal_error");
        await closed;

        await expectStopped(socket);
    });

    it.each<[string, (session: FakeSession) => void, number]>([
        ["reason server_shutdown", (session) => endWithReason(session, "server_shutdown"), 1000],
        ["internal error", (session) => endWithError("audio", session, "internal_error"), 1008],
    ])("does not carry a session's %s over to the next session", async (_, end, nextCode) => {
        const socket = await opened(client.audio.connect());
        let closed = next(socket, "close");
        end(server.sessions[0]);
        await closed;
        await reopened(socket);

        closed = next(socket, "close");
        server.sessions[1].client.close(nextCode);
        await closed;

        await expectStopped(socket);
    });

    it("does not reconnect after the caller sends session.close, even when the server then restarts", async () => {
        const socket = await opened(client.audio.connect());
        socket.sendAudioSessionClose({ type: "session.close" });
        await server.until(() => server.sessions[0].received.length === 1);

        const closed = next(socket, "close");
        server.sessions[0].client.close(1012);
        await closed;

        await expectStopped(socket);
    });

    it("reconnects after the connection fails, unless the caller sent session.close", async () => {
        const socket = await openWithUpdate();
        let failed = next(socket, "error");
        sendInvalidFrame(server.sessions[0]);
        await failed;
        await reopened(socket);
        await server.until(() => server.sessions[1]?.received.length === 1);

        socket.sendAudioSessionClose({ type: "session.close" });
        await server.until(() => server.sessions[1].received.length === 2);
        failed = next(socket, "error");
        sendInvalidFrame(server.sessions[1]);
        await failed;

        await expectStopped(socket);
    });

    it("does not reconnect after the caller closes the socket", async () => {
        const socket = await opened(client.audio.connect());

        socket.close();

        await expectStopped(socket);
    });

    it("lets the caller's shouldReconnect decide which closes reconnect", async () => {
        const socket = await opened(client.audio.connect({ shouldReconnect: (event) => event.code === 1000 }));
        socket.sendAudioSessionUpdate(UPDATE);
        await server.until(() => server.sessions[0].received.length === 1);

        let closed = next(socket, "close");
        server.sessions[0].client.close(1000);
        await closed;
        await reopened(socket);
        await server.until(() => server.sessions[1]?.received.length === 1);
        expect(server.sessions[1].received).toEqual([UPDATE_ON_WIRE]);

        closed = next(socket, "close");
        server.sessions[1].client.close(1012);
        await closed;
        await expectStopped(socket);
    });

    it.each([400, 401, 403, 404])("stops when the server refuses a reconnect with %i", async (status) => {
        const socket = await opened(client.audio.connect());
        server.refuseNext(status);

        const closed = next(socket, "close");
        server.sessions[0].client.close(1012);
        await closed;
        const refused = next(socket, "error");
        await vi.advanceTimersToNextTimerAsync();
        await refused;

        await expectStopped(socket);
        expect(server.attempts).toBe(2);
    });

    it.each([408, 429, 500, 503])("retries a reconnect the server refuses with %i", async (status) => {
        const socket = await openWithUpdate();
        server.refuseNext(status);

        const closed = next(socket, "close");
        server.sessions[0].client.close(1012);
        await closed;
        const refused = next(socket, "error");
        await vi.advanceTimersToNextTimerAsync();
        await refused;
        await reopened(socket);

        await server.until(() => server.sessions[1]?.received.length === 1);
        expect(server.sessions[1].received).toEqual([UPDATE_ON_WIRE]);
    });

    it("keeps reconnecting while the server restarts", async () => {
        const socket = await openWithUpdate();
        const port = await server.port;

        const closed = next(socket, "close");
        await server.close();
        await closed;
        const refused = next(socket, "error");
        await vi.advanceTimersToNextTimerAsync();
        await refused;
        server = new FakeServer(port);
        await server.port;
        await reopened(socket);

        await server.until(() => server.sessions[0]?.received.length === 1);
        expect(server.sessions[0].received).toEqual([UPDATE_ON_WIRE]);
    });

    it.each([401, 503])("does not retry a first connection the server refuses with %i", async (status) => {
        server.refuseNext(status);

        const { socket, failure } = await connected(client.audio.connect());

        expect(await failure).toMatchObject({ message: `Unexpected server response: ${status}` });
        await expectStopped(socket);
        expect(server.attempts).toBe(1);
    });

    it("does not retry a first connection that cannot reach the server", async () => {
        await server.close();

        const { socket, failure } = await connected(client.audio.connect());

        expect(await failure).toMatchObject({ message: expect.stringContaining("ECONNREFUSED") });
        await expectStopped(socket);
    });
});
