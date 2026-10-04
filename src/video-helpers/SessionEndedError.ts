// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type * as ExpressionMeasurement from "../api/index.js";

/**
 * Thrown by `streamVideo` when the session ends before the frames do: because of a session-ending
 * error, because the server shut down or closed an idle session, or because the connection closed
 * without the session closing first. A session cannot be resumed; open a new connection to continue.
 */
export class SessionEndedError extends Error {
    /** The server's last message, with the reason the session ended and its totals. Absent when the connection closed without it. */
    public readonly closed: ExpressionMeasurement.VideoSessionClosed | undefined;
    /** The code of the error that ended the session, when `closed.reason` is "error". */
    public readonly code: ExpressionMeasurement.ErrorCode | undefined;

    constructor(
        message: string,
        closed: ExpressionMeasurement.VideoSessionClosed | undefined,
        code: ExpressionMeasurement.ErrorCode | undefined,
    ) {
        super(message);
        this.name = "SessionEndedError";
        this.closed = closed;
        this.code = code;
    }
}
