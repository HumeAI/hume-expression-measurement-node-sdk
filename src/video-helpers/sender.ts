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
         * A live frame that the send rate or the server's capacity has no room for is dropped, so
         * that results keep up with the source. A recorded frame waits and is sent again, so that
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

// The server's send rate is the first 30 frames at once, then 30 per second. It also lets unused
// allowance build up while the client pauses, but how far is not documented, so the client allows
// no more than the first burst. The client keeps 3 frames of that in reserve: frames sent at
// exactly the rate arrive unevenly, and the reserve absorbs up to 100 ms of that unevenness.
const BURST_FRAMES = 27;
const FRAMES_PER_SECOND = 30;

const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 2000;

// Every frame gets exactly one reply, in the order the frames were sent: a result or one of these
// errors. Other errors answer text messages or end the session.
const FRAME_ERRORS: ReadonlySet<string> = new Set([
    "invalid_image_frame",
    "rate_limited",
    "overloaded",
    "internal_error",
]);

interface Entry {
    // Position in the input, counting only frames that are sent or rejected before sending.
    index: number;
    frame: VideoFrame;
    sentAt: number;
    resent: boolean;
}

/**
 * Streams frames to a realtime video session and yields the reply to each frame, paired with that
 * frame's `timestampMs`.
 *
 * Frames are sent no faster than the session's send rate allows. Frames the server rejects with
 * `rate_limited` or `overloaded` are dropped from a live source and sent again from a recording,
 * after a wait that grows from 100 ms to 2 s while rejections continue. A recorded frame that
 * fails with a retryable `internal_error` is sent once more. A frame over the 2 MB message limit
 * would end the session, so it is not sent and is yielded as a `message_too_large` error.
 *
 * Replies are yielded in the order of the frames. When the frames run out, the session is closed,
 * the remaining replies are yielded, and the socket is closed. `closed` then holds the session's
 * totals.
 *
 * The stream takes over the socket's `message` handler, and closes the socket when it ends for any
 * reason, including leaving the loop early. Send any `session.update` before streaming, because
 * the configuration locks at the first frame.
 *
 * @param socket A socket from `client.video.connect()`, open or still opening.
 * @param frames The frames to send, such as from `iterVideoFrames` or `Camera`.
 *
 * @throws {SessionEndedError} From iteration, if the session ends before the frames do, or the
 * connection closes without the session closing first.
 * @throws {Error} From iteration, if the connection does not open, for example because the API key
 * is not valid. Errors from `frames` are thrown as they are.
 *
 * @example
 * import { iterVideoFrames, streamVideo } from "@humeai/expression-measurement-node/video-helpers";
 *
 * const socket = await client.video.connect();
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
        let socketClosed = false;
        const closeSocket = () => {
            if (!socketClosed) {
                socketClosed = true;
                socket.close();
            }
        };
        socket.on("message", (message) => {
            messages.push(message);
            // Closed at once, because the socket would otherwise reconnect after a session-ending
            // error closes the connection with code 1008, and a new connection is a new session.
            if (message.type === "session.closed") {
                closeSocket();
            }
            this.wake();
        });
        const onClose = (event: core.CloseEvent) => {
            closeCode ??= event.code;
            this.wake();
        };
        socket.socket.addEventListener("close", onClose);

        const input = this.frames[Symbol.asyncIterator]();
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
        let backoffMs = 0;
        let backoffStartedAt = Number.NEGATIVE_INFINITY;
        let backoffUntil = 0;

        const send = (entry: Entry) => {
            entry.sentAt = Date.now();
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
                reject({ index: nextIndex++, frame, sentAt: 0, resent: false }, tooLarge(frame));
            } else if (!this.live) {
                waiting.push({ index: nextIndex++, frame, sentAt: 0, resent: false });
            } else if (allowance.take(Date.now())) {
                send({ index: nextIndex++, frame, sentAt: 0, resent: false });
            } else {
                this.dropped++;
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
                    if (entry.sentAt >= backoffStartedAt) {
                        backoffMs = 0;
                    }
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
            const busy = message.code === "rate_limited" || message.code === "overloaded";
            if (!this.live && busy) {
                // Frames sent before the wait began were rejected for the same reason, so they
                // do not lengthen it.
                if (entry.sentAt >= backoffStartedAt) {
                    backoffMs = backoffMs === 0 ? INITIAL_BACKOFF_MS : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
                    backoffStartedAt = Date.now();
                    backoffUntil = backoffStartedAt + backoffMs;
                }
                sendLater(entry);
            } else if (!this.live && message.code === "internal_error" && message.retryable && !entry.resent) {
                entry.resent = true;
                sendLater(entry);
            } else {
                reject(entry, message);
            }
        };

        try {
            if (socket.readyState !== core.ReconnectingWebSocket.ReadyState.OPEN) {
                await socket.waitForOpen().catch((event: unknown) => {
                    // The socket rejects with its error event, which is not an Error.
                    const detail = (event as { message?: unknown } | undefined)?.message;
                    throw new Error(`The connection did not open${typeof detail === "string" ? `: ${detail}` : "."}`);
                });
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
                        `The connection closed with code ${closeCode} before the session ended.`,
                        undefined,
                        undefined,
                    );
                }
                if (inputFailure !== undefined) {
                    throw inputFailure.error;
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
                    const now = Date.now();
                    waitMs = Math.max(backoffUntil - now, allowance.delay(now));
                    const entry = waiting[0];
                    if (waitMs <= 0) {
                        waiting.shift();
                        allowance.take(now);
                        send(entry);
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

                await new Promise<void>((resolve) => {
                    const timer = waitMs === undefined ? undefined : setTimeout(resolve, waitMs);
                    this.wake = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                });
            }
        } finally {
            this.wake = () => {};
            socket.socket.removeEventListener("close", onClose);
            closeSocket();
            if (!inputDone && inputFailure === undefined) {
                // Not awaited, because an async generator returns only after a pending `next`
                // settles, and a live source can take a while to produce its next frame.
                input.return?.().catch(() => {});
            }
        }
    }
}

// Mirrors the server's allowance, so that frames are not sent only to be rejected.
class Allowance {
    private frames = BURST_FRAMES;
    private updatedAt = Date.now();

    public delay(now: number): number {
        this.refill(now);
        return this.frames >= 1 ? 0 : Math.ceil(((1 - this.frames) * 1000) / FRAMES_PER_SECOND);
    }

    public take(now: number): boolean {
        this.refill(now);
        if (this.frames < 1) {
            return false;
        }
        this.frames -= 1;
        return true;
    }

    private refill(now: number): void {
        this.frames = Math.min(BURST_FRAMES, this.frames + ((now - this.updatedAt) * FRAMES_PER_SECOND) / 1000);
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
