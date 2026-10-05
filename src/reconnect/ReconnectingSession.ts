// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type * as core from "../core/index.js";
import { type Backoff, DEFAULT_BACKOFF, delayFor, type Followup, followupFor, handshakeStatus } from "./policy.js";

/** A session that reconnects carries on in a new server session; it is not resumed. */
export declare namespace ReconnectingSession {
    export interface Options<Message> {
        /** Consecutive reconnect attempts allowed before the session ends. 6 by default. */
        maxAttempts?: number;
        /** The backoff before the first retry after an overload or failure, doubling with each attempt. 1000 ms by default. */
        initialDelayMs?: number;
        /** The longest backoff. 30000 ms by default. */
        maxDelayMs?: number;
        /** Ends the session when it fires. */
        abortSignal?: AbortSignal;
        onMessage?: (message: Message) => void;
        /** A connection ended and another will be opened after `delayMs`. */
        onReconnecting?: (event: ReconnectingEvent) => void;
        /** A new server session started after a reconnect, under a new session ID (run ID), with the configuration resent. */
        onReconnect?: (event: ReconnectEvent) => void;
        /** The session ended for good. Called once. */
        onClose?: (event: CloseEvent) => void;
        onError?: (error: Error) => void;
    }

    export interface ReconnectingEvent {
        /** The close code of the connection that ended; 1006 when it dropped without a close frame. */
        code: number;
        /** The HTTP status, when a handshake was rejected. */
        httpStatus?: number;
        /** Counting from 1 since the last session that stayed up. */
        attempt: number;
        delayMs: number;
    }

    export interface ReconnectEvent {
        previousSessionId: string | undefined;
        sessionId: string;
        /** The close code that ended the previous connection. */
        code: number;
        attempts: number;
    }

    export interface CloseEvent {
        code: number;
        httpStatus?: number;
        /** The `reason` of the last `session.closed`, when one arrived before the close. */
        sessionClosedReason?: string;
        /** The connection error, when there was one. */
        error?: string;
        /** Whether the session ended because the reconnect attempts ran out. */
        gaveUp: boolean;
    }

    /** Opens connections and sends messages for one endpoint. */
    export interface Driver<Socket, Update, Media> {
        connect(): Promise<Socket>;
        sendUpdate(socket: Socket, update: Update): void;
        sendClose(socket: Socket): void;
        sendMedia(socket: Socket, media: Media): void;
        /** The size of queued media, in the units of `maxQueued`. */
        mediaCost(media: Media): number;
        maxQueued: number;
    }

    export interface Socket<Message> {
        readonly socket: core.ReconnectingWebSocket;
        on(event: "message", callback: (message: Message) => void): void;
        on(event: "error", callback: (error: Error) => void): void;
    }
}

interface Connection {
    // Absent when opening the connection failed before a socket existed.
    socket?: ReconnectingSession.Socket<unknown>;
    opened: boolean;
    closeCode?: number;
    errorMessage?: string;
    sessionClosedReason?: string;
    settled: boolean;
}

// A session that stays up this long resets the attempt count, so a session that keeps failing soon
// after it starts still runs out of attempts.
const STABLE_SESSION_MS = 10_000;

const CLIENT_CLOSE_CODE = 1000;
const OPEN = 1;

export class ReconnectingSession<
    Message extends { type: string },
    Update,
    Media,
    Socket extends ReconnectingSession.Socket<Message> = ReconnectingSession.Socket<Message>,
> {
    private readonly backoff: Backoff;
    private connection: Connection | undefined;
    private update: Update | undefined;
    private currentSessionId: string | undefined;
    private establishedAt: number | undefined;
    private ready = false;
    private attempts = 0;
    private lastEnding: { code: number } | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private clientClosing = false;
    private ended = false;
    private queue: Media[] = [];
    private queued = 0;
    private dropped = 0;
    private firstSession: { resolve: () => void; reject: (error: Error) => void } | undefined;

    /** @internal Use `connectAudio` or `connectVideo`. */
    constructor(
        private readonly driver: ReconnectingSession.Driver<Socket, Update, Media>,
        private readonly options: ReconnectingSession.Options<Message>,
        sessionUpdate: Update | undefined,
    ) {
        this.update = sessionUpdate;
        this.backoff = {
            maxAttempts: options.maxAttempts ?? DEFAULT_BACKOFF.maxAttempts,
            initialDelayMs: options.initialDelayMs ?? DEFAULT_BACKOFF.initialDelayMs,
            maxDelayMs: options.maxDelayMs ?? DEFAULT_BACKOFF.maxDelayMs,
        };
    }

    /** @internal Resolves once the first server session has started. */
    public start(): Promise<void> {
        const started = new Promise<void>((resolve, reject) => {
            this.firstSession = { resolve, reject };
        });
        const signal = this.options.abortSignal;
        if (signal?.aborted) {
            this.close();
        } else {
            signal?.addEventListener("abort", () => this.close(), { once: true });
            void this.open();
        }
        return started;
    }

    /** The ID of the current server session, which is also its run ID. Changes on each reconnect. */
    public get sessionId(): string | undefined {
        return this.currentSessionId;
    }

    /** Whether media sent now is queued rather than sent, because no server session is ready. */
    public get reconnecting(): boolean {
        return !this.ready && !this.ended;
    }

    /** Media dropped from the queue while reconnecting, because the queue was full. */
    public get droppedMedia(): number {
        return this.dropped;
    }

    /**
     * Sends the configuration and keeps it, so that every new server session after a reconnect
     * gets it too. Send it before the first media, as the configuration locks at the first frame.
     */
    public sendSessionUpdate(update: Update): void {
        this.assertNotEnded();
        this.update = update;
        const socket = this.openSocket();
        if (socket !== undefined) {
            this.driver.sendUpdate(socket, update);
        }
    }

    /** Asks the server to end the session after the media already sent. No reconnect follows. */
    public sendSessionClose(): void {
        this.assertNotEnded();
        this.clientClosing = true;
        const socket = this.openSocket();
        if (socket !== undefined) {
            this.driver.sendClose(socket);
        } else if (!this.ready) {
            this.close();
        }
        // Otherwise the connection is already closing, and its close ends the session.
    }

    /** Closes the connection at once, discarding anything the server had not yet sent. */
    public close(): void {
        if (this.ended) {
            return;
        }
        this.clientClosing = true;
        const connection = this.connection;
        this.finish({ code: connection?.closeCode ?? CLIENT_CLOSE_CODE }, false);
        connection?.socket?.socket.close();
    }

    protected sendMedia(media: Media): void {
        this.assertNotEnded();
        if (this.clientClosing) {
            throw new Error("The session is closing.");
        }
        const socket = this.openSocket();
        if (socket !== undefined) {
            this.driver.sendMedia(socket, media);
            return;
        }
        this.queue.push(media);
        this.queued += this.driver.mediaCost(media);
        while (this.queued > this.driver.maxQueued && this.queue.length > 0) {
            this.queued -= this.driver.mediaCost(this.queue.shift() as Media);
            this.dropped++;
        }
    }

    // After the server's close frame the socket is closing until its close event, and sending then throws.
    private openSocket(): Socket | undefined {
        const socket = this.connection?.socket as Socket | undefined;
        return this.ready && socket?.socket.readyState === OPEN ? socket : undefined;
    }

    private assertNotEnded(): void {
        if (this.ended) {
            throw new Error("The session has ended.");
        }
    }

    private async open(): Promise<void> {
        let socket: Socket;
        try {
            socket = await this.driver.connect();
        } catch (error) {
            const connection: Connection = {
                opened: false,
                errorMessage: error instanceof Error ? error.message : String(error),
                settled: false,
            };
            this.connection = connection;
            this.settle(connection);
            return;
        }
        if (this.ended) {
            socket.socket.close();
            return;
        }
        const connection: Connection = { socket, opened: false, settled: false };
        this.connection = connection;
        const raw = socket.socket;
        raw.addEventListener("open", () => {
            connection.opened = true;
        });
        // The socket reports a connection error as a close with code 1000 followed by the error,
        // so the ending is settled only once both have been seen.
        raw.addEventListener("close", (event) => {
            connection.closeCode ??= event.code;
            queueMicrotask(() => this.settle(connection));
        });
        raw.addEventListener("error", (event) => {
            connection.errorMessage ??= event.message ?? "connection error";
            queueMicrotask(() => this.settle(connection));
        });
        socket.on("message", (message) => this.handleMessage(connection, message));
        socket.on("error", (error) => this.options.onError?.(error));
    }

    private handleMessage(connection: Connection, message: Message): void {
        if (connection !== this.connection || this.ended) {
            return;
        }
        if (message.type === "session.created") {
            // A message missing a field the schema requires reaches the caller unconverted.
            const created = message as unknown as { sessionId?: string; session_id?: string };
            this.startSession(connection, created.sessionId ?? created.session_id ?? "");
        } else if (message.type === "session.closed") {
            connection.sessionClosedReason = (message as unknown as { reason: string }).reason;
        }
        this.options.onMessage?.(message);
    }

    private startSession(connection: Connection, sessionId: string): void {
        const socket = connection.socket as Socket;
        const previousSessionId = this.currentSessionId;
        this.currentSessionId = sessionId;
        this.establishedAt = Date.now();
        if (this.update !== undefined) {
            this.driver.sendUpdate(socket, this.update);
        }
        for (const media of this.queue) {
            this.driver.sendMedia(socket, media);
        }
        this.queue = [];
        this.queued = 0;
        this.ready = true;
        if (previousSessionId !== undefined) {
            this.options.onReconnect?.({
                previousSessionId,
                sessionId,
                code: this.lastEnding?.code ?? 1006,
                attempts: this.attempts,
            });
        }
        this.firstSession?.resolve();
        this.firstSession = undefined;
    }

    private settle(connection: Connection): void {
        if (connection.settled || connection !== this.connection || this.ended) {
            return;
        }
        connection.settled = true;
        this.ready = false;
        connection.socket?.socket.close();

        const errored = connection.errorMessage !== undefined;
        const ending = {
            code: errored ? 1006 : (connection.closeCode ?? 1006),
            httpStatus: handshakeStatus(connection.errorMessage),
            opened: connection.opened,
            sessionClosedReason: connection.sessionClosedReason,
            clientClosing: this.clientClosing,
        };
        const closeEvent: ReconnectingSession.CloseEvent = {
            code: ending.code,
            httpStatus: ending.httpStatus,
            sessionClosedReason: ending.sessionClosedReason,
            error: connection.errorMessage,
            gaveUp: false,
        };
        const followup: Followup = followupFor(ending);
        if (followup === "stop") {
            this.finish(closeEvent, false);
            return;
        }
        if (this.establishedAt !== undefined && Date.now() - this.establishedAt >= STABLE_SESSION_MS) {
            this.attempts = 0;
        }
        this.establishedAt = undefined;
        this.attempts++;
        if (this.attempts > this.backoff.maxAttempts) {
            this.finish(closeEvent, true);
            return;
        }
        this.lastEnding = { code: ending.code };
        const delayMs = delayFor(this.attempts, followup, this.backoff);
        this.options.onReconnecting?.({
            code: ending.code,
            httpStatus: ending.httpStatus,
            attempt: this.attempts,
            delayMs,
        });
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.open();
        }, delayMs);
    }

    private finish(event: Omit<ReconnectingSession.CloseEvent, "gaveUp">, gaveUp: boolean): void {
        if (this.ended) {
            return;
        }
        this.ended = true;
        this.ready = false;
        clearTimeout(this.timer);
        this.queue = [];
        this.queued = 0;
        const closeEvent = { ...event, gaveUp };
        this.options.onClose?.(closeEvent);
        if (this.firstSession !== undefined) {
            const detail =
                event.httpStatus !== undefined
                    ? `the handshake was rejected with HTTP ${event.httpStatus}`
                    : event.error !== undefined
                      ? event.error
                      : `the connection closed with code ${event.code}`;
            this.firstSession.reject(new Error(`The session did not start: ${detail}.`));
            this.firstSession = undefined;
        }
    }
}
