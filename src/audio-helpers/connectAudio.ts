// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type * as ExpressionMeasurement from "../api/index.js";
import type { AudioClient } from "../api/resources/audio/client/Client.js";
import type { AudioSocket } from "../api/resources/audio/client/Socket.js";
import { byteLength, type Media } from "../reconnect/media.js";
import { ReconnectingSession } from "../reconnect/ReconnectingSession.js";

// The 30 seconds of audio the server accepts at once: 16 kHz, 2 bytes a sample.
const MAX_QUEUED_AUDIO_BYTES = 30 * 16_000 * 2;

export declare namespace connectAudio {
    export interface Options extends ReconnectingSession.Options<AudioSocket.Response> {
        /** Sent at the start of every server session, including each one after a reconnect. */
        sessionUpdate?: ExpressionMeasurement.AudioSessionUpdate;
        /** Passed to `client.audio.connect` for each connection. */
        connectArgs?: Omit<AudioClient.ConnectArgs, "reconnectAttempts" | "shouldReconnect" | "abortSignal">;
    }
}

/** A realtime audio session that reconnects when the server restarts or the connection drops. */
export class ReconnectingAudioSession extends ReconnectingSession<
    AudioSocket.Response,
    ExpressionMeasurement.AudioSessionUpdate,
    Media,
    AudioSocket
> {
    /**
     * Sends PCM audio, or queues it while reconnecting. The queue holds 30 seconds of audio and
     * drops the oldest beyond that.
     */
    public sendAudioFrame(frame: Media): void {
        this.sendMedia(frame);
    }
}

/**
 * Opens a realtime audio session that reconnects on its own when the server restarts (close code
 * 1012), the connection drops (1006), or the server is overloaded (1013, or HTTP 503 on the
 * handshake). Each reconnect starts a new server session with a new session ID, sends it the last
 * `session.update`, then sends the audio queued in the meantime. Audio the old session had not
 * measured yet gets no result.
 *
 * It does not reconnect after `session.close`, an idle timeout, a session-ending error, or a
 * rejected API key. Resolves once the first session has started.
 *
 * @example
 * const session = await connectAudio(client.audio, {
 *     sessionUpdate: { type: "session.update", measurementTimerMs: 5000 },
 *     onMessage: (message) => console.log(message.type),
 *     onReconnect: ({ sessionId }) => console.log(`new session ${sessionId}`),
 *     onClose: ({ code }) => console.log(`ended with ${code}`),
 * });
 * session.sendAudioFrame(pcm);
 */
export async function connectAudio(
    audio: AudioClient,
    options: connectAudio.Options = {},
): Promise<ReconnectingAudioSession> {
    const { sessionUpdate, connectArgs, ...sessionOptions } = options;
    const session = new ReconnectingAudioSession(
        {
            connect: () => audio.connect({ ...connectArgs, reconnectAttempts: 0, shouldReconnect: () => false }),
            sendUpdate: (socket, update) => socket.sendAudioSessionUpdate(update),
            sendClose: (socket) => socket.sendAudioSessionClose({ type: "session.close" }),
            sendMedia: (socket, frame) => socket.sendAudioFrame(frame),
            mediaCost: byteLength,
            maxQueued: MAX_QUEUED_AUDIO_BYTES,
        },
        sessionOptions,
        sessionUpdate,
    );
    await session.start();
    return session;
}
