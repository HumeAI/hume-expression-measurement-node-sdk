// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type * as ExpressionMeasurement from "../api/index.js";
import type { VideoClient } from "../api/resources/video/client/Client.js";
import type { VideoSocket } from "../api/resources/video/client/Socket.js";
import type { Media } from "../reconnect/media.js";
import { ReconnectingSession } from "../reconnect/ReconnectingSession.js";

// The 8 frames the server accepts at once.
const MAX_QUEUED_FRAMES = 8;

export declare namespace connectVideo {
    export interface Options extends ReconnectingSession.Options<VideoSocket.Response> {
        /** Sent at the start of every server session, including each one after a reconnect. */
        sessionUpdate?: ExpressionMeasurement.VideoSessionUpdate;
        /** Passed to `client.video.connect` for each connection. */
        connectArgs?: Omit<VideoClient.ConnectArgs, "reconnectAttempts" | "shouldReconnect" | "abortSignal">;
    }
}

/** A realtime video session that reconnects when the server restarts or the connection drops. */
export class ReconnectingVideoSession extends ReconnectingSession<
    VideoSocket.Response,
    ExpressionMeasurement.VideoSessionUpdate,
    Media,
    VideoSocket
> {
    /** Sends a JPEG frame, or queues it while reconnecting. The queue holds 8 frames and drops the oldest beyond that. */
    public sendImageFrame(frame: Media): void {
        this.sendMedia(frame);
    }
}

/**
 * Opens a realtime video session that reconnects on its own when the server restarts (close code
 * 1012), the connection drops (1006), or the server is overloaded (1013, or HTTP 503 on the
 * handshake). Each reconnect starts a new server session with a new session ID, sends it the last
 * `session.update`, then sends the frames queued in the meantime.
 *
 * Frames the old session had not answered get no reply, so on `onReconnect` clear any queue that
 * pairs replies with frames. Face IDs restart in the new session.
 *
 * It does not reconnect after `session.close`, an idle timeout, a session-ending error, or a
 * rejected API key. Resolves once the first session has started.
 */
export async function connectVideo(
    video: VideoClient,
    options: connectVideo.Options = {},
): Promise<ReconnectingVideoSession> {
    const { sessionUpdate, connectArgs, ...sessionOptions } = options;
    const session = new ReconnectingVideoSession(
        {
            connect: () => video.connect({ ...connectArgs, reconnectAttempts: 0, shouldReconnect: () => false }),
            sendUpdate: (socket, update) => socket.sendVideoSessionUpdate(update),
            sendClose: (socket) => socket.sendVideoSessionClose({ type: "session.close" }),
            sendMedia: (socket, frame) => socket.sendImageFrame(frame),
            mediaCost: () => 1,
            maxQueued: MAX_QUEUED_FRAMES,
        },
        sessionOptions,
        sessionUpdate,
    );
    await session.start();
    return session;
}
