// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

/** How a connection that ended is followed up: not at all, at once, or after a backoff. */
export type Followup = "stop" | "immediate" | "backoff";

/** How a connection ended, as far as the client could see. */
export interface Ending {
    /** The close code. 1006 when the connection dropped without a close frame. */
    code: number;
    /** The HTTP status of a rejected handshake, when the handshake was rejected. */
    httpStatus?: number;
    /** Whether the handshake completed. */
    opened: boolean;
    /** The `reason` of the session's `session.closed`, when one arrived. */
    sessionClosedReason?: string;
    /** Whether the client asked for the session to end. */
    clientClosing: boolean;
}

export function followupFor(ending: Ending): Followup {
    if (ending.clientClosing) {
        return "stop";
    }
    if (ending.httpStatus !== undefined) {
        const status = ending.httpStatus;
        return status >= 500 || status === 408 || status === 429 ? "backoff" : "stop";
    }
    if (!ending.opened) {
        return "backoff";
    }
    // Servers released before close code 1012 end a drained session with 1000.
    if (ending.sessionClosedReason === "server_shutdown") {
        return "immediate";
    }
    switch (ending.code) {
        case 1001:
        case 1006:
        case 1012:
            return "immediate";
        case 1011:
        case 1013:
        case 1014:
            return "backoff";
        default:
            return "stop";
    }
}

export interface Backoff {
    /** Consecutive attempts allowed before giving up. */
    maxAttempts: number;
    /** The backoff before the first retry, which doubles with each further attempt. */
    initialDelayMs: number;
    maxDelayMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { maxAttempts: 6, initialDelayMs: 1000, maxDelayMs: 30_000 };

// Spreads the reconnects of every session a restarting server drains at once.
const IMMEDIATE_JITTER_MS = 250;

/** The wait before `attempt`, counting from 1. */
export function delayFor(
    attempt: number,
    followup: Followup,
    backoff: Backoff,
    random: () => number = Math.random,
): number {
    if (followup === "immediate" && attempt === 1) {
        return Math.floor(random() * IMMEDIATE_JITTER_MS);
    }
    const ceiling = Math.min(backoff.maxDelayMs, backoff.initialDelayMs * 2 ** (attempt - 1));
    return Math.floor(ceiling * (0.5 + random() / 2));
}

/** Reads the HTTP status from the error the Node `ws` package reports for a rejected handshake. */
export function handshakeStatus(message: string | undefined): number | undefined {
    const match = message === undefined ? null : /Unexpected server response: (\d{3})/.exec(message);
    return match === null ? undefined : Number(match[1]);
}
