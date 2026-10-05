// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type * as ExpressionMeasurement from "../api/index.js";
import type { VideoSocket } from "../api/resources/video/client/Socket.js";
import * as core from "../core/index.js";
import { SessionEndedError } from "./SessionEndedError.js";
import type { VideoFrame } from "./VideoFrame.js";

export declare namespace streamVideo {
    export interface Options {
        /**
         * Whether the frames come from a live source, such as a camera, rather than a recording.
         * A live frame that the send rate has no room for is dropped, so that results keep up
         * with the source. A recorded frame waits and is sent again, so that
         * every frame is measured. False by default.
         */
        live?: boolean;
    }

    /** The reply to one frame: its measurements, or the error that rejected it. */
    export type Reply =
        | { timestampMs: number; result: ExpressionMeasurement.VideoMeasurementResult; error?: undefined }
        | { timestampMs: number; error: ExpressionMeasurement.Error_; result?: undefined };
}

// A larger message ends the session. The limit is documented as 2 MB without saying whether that
// is 2,000,000 or 2,097,152 bytes, so the smaller is used.
const MAX_MESSAGE_BYTES = 2_000_000;

// The documented send rate is the first 8 frames at once, then 4 per second. The server also lets
// unused allowance build up while the client pauses, but how far is not documented, so the client
// allows no more than the first burst. The client keeps 1 frame of that in reserve: frames sent at
// exactly the rate arrive unevenly, and the reserve absorbs up to 250 ms of that unevenness.
const BURST_FRAMES = 7;
const FRAMES_PER_SECOND = 4;

// The slowest rate the client falls back to, so that a recorded frame waits at most 2 seconds
// before it is sent again.
const MIN_FRAMES_PER_SECOND = 0.5;

// Every frame gets exactly one reply, in the order the frames were sent: a result or one of these
// errors. Other errors answer text messages or end the session.
const FRAME_ERRORS: ReadonlySet<string> = new Set(["invalid_image_frame", "rate_limited", "internal_error"]);

interface Entry {
    // Position in the input, counting only frames that are sent or rejected before sending.
    index: number;
    frame: VideoFrame;
    // Which send this was, counting from 1, or 0 before the frame is sent.
    sendNumber: number;
    resent: boolean;
}

/**
 * Streams frames to a realtime video session and yields the reply to each frame, paired with that
 * frame's `timestampMs`.
 *
 * Frames are sent no faster than the session's send rate allows. When the server rejects a frame
 * with `rate_limited`, the rate is halved, down to one frame every 2 seconds, and
 * it climbs back by one frame per second for each second of frames the server accepts. The
 * rejected frame is dropped from a live source and sent again from a recording. A recorded frame
 * that fails with a retryable `internal_error` is sent once more. A frame over the 2 MB message
 * limit would end the session, so it is not sent and is yielded as a `message_too_large` error.
 *
 * Replies are yielded in the order of the frames. When the frames run out, the session is closed,
 * the remaining replies are yielded, and the socket is closed. `closed` then holds the session's
 * totals.
 *
 * The stream takes over the socket's `message` handler, and closes the socket when it ends for any
 * reason, including leaving the loop early. Send any `session.update` before streaming, because
 * the configuration locks at the first frame.
 *
 * @param socket A socket from `client.video.connect()`, open or still opening. A socket serves one
 * stream, because a new connection is a new session.
 * @param frames The frames to send, such as from `iterVideoFrames`.
 *
 * @throws {TypeError} If `frames` is not an async iterable.
 * @throws {SessionEndedError} From iteration, if the session ends before the frames do, or the
 * connection closes without the session closing first.
 * @throws {Error} From iteration, if the connection does not open, for example because the API key
 * is not valid or the socket is already closed. Errors from `frames` are thrown as they are.
 *
 * @example
 * import { iterVideoFrames, streamVideo } from "@humeai/expression-measurement-node/video-helpers";
 *
 * const socket = await client.video.connect({ reconnectAttempts: 0 });
 * const stream = streamVideo(socket, iterVideoFrames("interview.mp4"));
 * for await (const reply of stream) {
 *     if (reply.result) {
 *         console.log(reply.timestampMs, reply.result.faces);
 *     } else {
 *         console.log(reply.timestampMs, reply.error.code);
 *     }
 * }
 * console.log(stream.closed?.produced.measurements);
 */
export function streamVideo(
    socket: VideoSocket,
    frames: AsyncIterable<VideoFrame>,
    { live = false }: streamVideo.Options = {},
): VideoStream {
    if (typeof (frames as Partial<AsyncIterable<VideoFrame>> | undefined)?.[Symbol.asyncIterator] !== "function") {
        throw new TypeError("frames must be an async iterable of frames, such as from iterVideoFrames.");
    }
    return new VideoStream(socket, frames, live);
}

/** The replies to a stream of frames, from `streamVideo`. It can be iterated once. */
export class VideoStream implements AsyncIterable<streamVideo.Reply> {
    private iterated = false;
    private dropped = 0;
    private closedMessage: ExpressionMeasurement.VideoSessionClosed | undefined;

    // Signals the run loop that a message, a close, a frame or a timer needs handling.
    private wake: () => void = () => {};

    /** @internal Use `streamVideo`. */
    constructor(
        private readonly socket: VideoSocket,
        private readonly frames: AsyncIterable<VideoFrame>,
        private readonly live: boolean,
    ) {}

    /** Live frames that were not sent because the send rate had no room for them. */
    public get droppedFrames(): number {
        return this.dropped;
    }

    /** The server's last message, with why the session ended and its totals. Set once the session has ended. */
    public get closed(): ExpressionMeasurement.VideoSessionClosed | undefined {
        return this.closedMessage;
    }

    public [Symbol.asyncIterator](): AsyncIterator<streamVideo.Reply> {
        if (this.iterated) {
            throw new Error("A video stream can be iterated only once.");
        }
        this.iterated = true;
        return this.run();
    }

    private async *run(): AsyncGenerator<streamVideo.Reply, void, undefined> {
        const socket = this.socket;
        const messages: VideoSocket.Response[] = [];
        let closeCode: number | undefined;
        let closeDetail: string | undefined;
        let socketClosed = false;
        const closeSocket = () => {
            if (!socketClosed) {
                socketClosed = true;
                socket.close();
            }
        };
        const onMessage = (message: VideoSocket.Response) => {
            messages.push(message);
            // Closed at once, because the socket would otherwise reconnect after a session-ending
            // error closes the connection with code 1008, and a new connection is a new session.
            if (message.type === "session.closed") {
                closeSocket();
            }
            this.wake();
        };
        const onOpen = () => this.wake();
        const onClose = (event: core.CloseEvent) => {
            closeCode ??= event.code;
            closeDetail ??= event.reason || undefined;
            // Closed at once, because the socket would otherwise reconnect when the connection drops
            // while the caller's loop is busy with a reply, and a new connection is a new session.
            closeSocket();
            this.wake();
        };
        // On a connection error, the socket reports a close with code 1000 and then the error, so
        // the error is the better explanation.
        const onError = (event: core.ErrorEvent) => {
            closeDetail = event.message;
            this.wake();
        };
        const waitForWake = (ms?: number) =>
            new Promise<void>((resolve) => {
                const timer = ms === undefined ? undefined : setTimeout(resolve, ms);
                this.wake = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });

        let input: AsyncIterator<VideoFrame> | undefined;
        let pulling = false;
        let pulled: IteratorResult<VideoFrame> | undefined;
        let inputFailure: { error: unknown } | undefined;
        let inputDone = false;

        const allowance = new Allowance();
        const replies = new Map<number, streamVideo.Reply>();
        // Recorded frames waiting to be sent, in input order.
        const waiting: Entry[] = [];
        const inFlight: Entry[] = [];
        let nextIndex = 0;
        let nextReply = 0;
        let closeSent = false;
        let lastError: ExpressionMeasurement.Error_ | undefined;

        const send = (entry: Entry, sendNumber: number) => {
            entry.sendNumber = sendNumber;
            socket.sendImageFrame(entry.frame.data);
            inFlight.push(entry);
        };
        const reject = (entry: Entry, error: ExpressionMeasurement.Error_) => {
            replies.set(entry.index, { timestampMs: entry.frame.timestampMs, error });
        };
        const sendLater = (entry: Entry) => {
            let at = waiting.length;
            while (at > 0 && waiting[at - 1].index > entry.index) {
                at--;
            }
            waiting.splice(at, 0, entry);
        };
        const accept = (frame: VideoFrame) => {
            if (frame.data.length > MAX_MESSAGE_BYTES) {
                reject({ index: nextIndex++, frame, sendNumber: 0, resent: false }, tooLarge(frame));
            } else if (!this.live) {
                waiting.push({ index: nextIndex++, frame, sendNumber: 0, resent: false });
            } else {
                const sendNumber = allowance.take(performance.now());
                if (sendNumber === undefined) {
                    this.dropped++;
                } else {
                    send({ index: nextIndex++, frame, sendNumber: 0, resent: false }, sendNumber);
                }
            }
        };
        const handle = (message: VideoSocket.Response) => {
            if (message.type === "session.closed") {
                this.closedMessage = message;
                return;
            }
            if (message.type === "measurement.result") {
                const entry = inFlight.shift();
                if (entry !== undefined) {
                    replies.set(entry.index, { timestampMs: entry.frame.timestampMs, result: message });
                    allowance.speedUp(entry.sendNumber, performance.now());
                }
                return;
            }
            if (message.type !== "error") {
                return;
            }
            lastError = message;
            if (!FRAME_ERRORS.has(message.code)) {
                return;
            }
            const entry = inFlight.shift();
            if (entry === undefined) {
                return;
            }
            const limited = message.code === "rate_limited";
            if (limited) {
                allowance.slowDown(entry.sendNumber, performance.now());
            }
            if (!this.live && limited) {
                sendLater(entry);
            } else if (!this.live && message.code === "internal_error" && message.retryable && !entry.resent) {
                entry.resent = true;
                sendLater(entry);
            } else {
                reject(entry, message);
            }
        };

        const ReadyState = core.ReconnectingWebSocket.ReadyState;
        try {
            socket.on("message", onMessage);
            socket.socket.addEventListener("open", onOpen);
            socket.socket.addEventListener("close", onClose);
            socket.socket.addEventListener("error", onError);
            input = this.frames[Symbol.asyncIterator]();

            if (socket.readyState === ReadyState.CLOSING || socket.readyState === ReadyState.CLOSED) {
                throw new Error("The connection did not open, because the socket is already closed.");
            }
            // The socket's own wait for an open does not end when the connection closes instead,
            // for example when the abort signal fires.
            while (socket.readyState !== ReadyState.OPEN) {
                if (closeCode !== undefined) {
                    throw new Error(
                        `The connection did not open${closeDetail === undefined ? "." : `: ${closeDetail}`}`,
                    );
                }
                await waitForWake();
            }
            while (true) {
                for (const message of messages.splice(0)) {
                    handle(message);
                }

                const next = replies.get(nextReply);
                if (next !== undefined) {
                    replies.delete(nextReply);
                    nextReply++;
                    yield next;
                    continue;
                }

                if (this.closedMessage !== undefined) {
                    if (closeSent && this.closedMessage.reason === "client_request") {
                        return;
                    }
                    throw sessionEnded(this.closedMessage, lastError);
                }
                if (closeCode !== undefined) {
                    throw new SessionEndedError(
                        `The connection closed with code ${closeCode} before the session ended${closeDetail === undefined ? "." : `: ${closeDetail}`}`,
                        undefined,
                        undefined,
                    );
                }
                if (inputFailure !== undefined) {
                    throw inputFailure.error;
                }
                // After the server's close frame arrives, the socket is closing for about one round
                // trip before its close event, and sending in that time throws.
                if (socket.readyState !== ReadyState.OPEN) {
                    await waitForWake();
                    continue;
                }

                if (pulled !== undefined) {
                    if (pulled.done) {
                        inputDone = true;
                    } else {
                        accept(pulled.value);
                    }
                    pulled = undefined;
                    continue;
                }

                let waitMs: number | undefined;
                if (waiting.length > 0) {
                    const now = performance.now();
                    waitMs = allowance.delay(now);
                    const entry = waiting[0];
                    const sendNumber = waitMs <= 0 ? allowance.take(now) : undefined;
                    if (sendNumber !== undefined) {
                        waiting.shift();
                        send(entry, sendNumber);
                        continue;
                    }
                } else if (!inputDone && !pulling) {
                    pulling = true;
                    input.next().then(
                        (result) => {
                            pulling = false;
                            pulled = result;
                            this.wake();
                        },
                        (error: unknown) => {
                            pulling = false;
                            inputFailure = { error };
                            this.wake();
                        },
                    );
                } else if (inputDone && inFlight.length === 0 && !closeSent) {
                    socket.sendVideoSessionClose({ type: "session.close" });
                    closeSent = true;
                }

                await waitForWake(waitMs);
            }
        } finally {
            this.wake = () => {};
            socket.socket.removeEventListener("open", onOpen);
            socket.socket.removeEventListener("close", onClose);
            socket.socket.removeEventListener("error", onError);
            closeSocket();
            if (input !== undefined && !inputDone && inputFailure === undefined) {
                // Not awaited, because an async generator returns only after a pending `next`
                // settles, and a live source can take a while to produce its next frame.
                input.return?.().catch(() => {});
            }
        }
    }
}

// Mirrors the server's allowance, so that frames are not sent only to be rejected. It starts at
// the documented rate and adapts to the rate the server accepts: it halves on each rejection and
// climbs back slowly while frames are accepted, so a server whose limit is lower than documented
// rejects a few frames rather than most of them.
class Allowance {
    private rate = FRAMES_PER_SECOND;
    private frames = BURST_FRAMES;
    // A monotonic clock, so that a change to the system clock cannot stall sending.
    private updatedAt = performance.now();
    private sends = 0;
    // The number of sends before the last slowdown. Replies to those frames say nothing about the
    // rate since then. Send numbers are used rather than times, which can tie.
    private slowedAfter = 0;

    public delay(now: number): number {
        this.refill(now);
        return this.frames >= 1 ? 0 : Math.ceil(((1 - this.frames) * 1000) / this.rate);
    }

    // Returns the send's number, counting from 1, or undefined when there is no room for it.
    public take(now: number): number | undefined {
        this.refill(now);
        if (this.frames < 1) {
            return undefined;
        }
        this.frames -= 1;
        return ++this.sends;
    }

    // A rejection means the server's allowance was empty when the frame arrived.
    public slowDown(sendNumber: number, now: number): void {
        if (sendNumber <= this.slowedAfter) {
            return;
        }
        this.rate = Math.max(MIN_FRAMES_PER_SECOND, this.rate / 2);
        this.frames = 0;
        this.updatedAt = now;
        this.slowedAfter = this.sends;
    }

    // Adds one frame per second for each second of accepted frames.
    public speedUp(sendNumber: number, now: number): void {
        if (sendNumber <= this.slowedAfter || this.rate >= FRAMES_PER_SECOND) {
            return;
        }
        this.refill(now);
        this.rate = Math.min(FRAMES_PER_SECOND, this.rate + 1 / this.rate);
    }

    private refill(now: number): void {
        // Once slowed, the client allows a burst of at most one second, since the server's burst
        // may be as small as its rate.
        const slowed = this.slowedAfter > 0;
        const capacity = slowed ? Math.min(BURST_FRAMES, Math.max(1, this.rate)) : BURST_FRAMES;
        this.frames = Math.min(capacity, this.frames + ((now - this.updatedAt) * this.rate) / 1000);
        this.updatedAt = now;
    }
}

function tooLarge(frame: VideoFrame): ExpressionMeasurement.Error_ {
    return {
        type: "error",
        code: "message_too_large",
        message: `The frame is ${frame.data.length} bytes, over the ${MAX_MESSAGE_BYTES}-byte message limit, and was not sent, because sending it would end the session.`,
        retryable: false,
    };
}

function sessionEnded(
    closed: ExpressionMeasurement.VideoSessionClosed,
    lastError: ExpressionMeasurement.Error_ | undefined,
): SessionEndedError {
    if (closed.reason === "error" && lastError !== undefined) {
        return new SessionEndedError(
            `The session ended with error ${lastError.code}: ${lastError.message}`,
            closed,
            lastError.code,
        );
    }
    return new SessionEndedError(
        `The session ended before the frames did, with reason ${closed.reason}.`,
        closed,
        undefined,
    );
}
