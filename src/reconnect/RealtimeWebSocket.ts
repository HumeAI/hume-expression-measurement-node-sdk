// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import * as core from "../core/index.js";
import { fromJson } from "../core/json.js";

type Endpoint = "audio" | "video";

// Going away, a dropped connection, a server error, a restart, and try again later.
const RECONNECT_CODES = new Set([1001, 1006, 1011, 1012, 1013]);

// A request timeout or a rate limit can clear by the next attempt. Other 4xx statuses, such as the
// one for an invalid API key, fail the same way every time.
const RETRYABLE_HANDSHAKE_STATUSES = new Set([408, 429]);

// `ws` reports the status of a refused handshake only in this message. Browsers report no status,
// so there a refused reconnect is retried until the attempts run out.
const REFUSED_HANDSHAKE = /^Unexpected server response: (\d+)$/;

interface Message {
    type?: unknown;
    reason?: unknown;
    code?: unknown;
}

// What the current session reported before it ended. Cleared when a new session opens.
class Session {
    public closedReason: unknown;
    public errorCode: unknown;
    public closeSent = false;

    constructor(private readonly endpoint: Endpoint) {}

    public reset(): void {
        this.closedReason = undefined;
        this.errorCode = undefined;
        this.closeSent = false;
    }

    public readonly shouldReconnect = (event: core.CloseEvent): boolean => {
        if (this.closeSent) {
            return false;
        }
        // A server that is shutting down may close with code 1000, which otherwise means the
        // session ended for good.
        if (this.closedReason === "server_shutdown") {
            return true;
        }
        // The API reference says to open a new connection after an audio internal error. The other
        // session-ending errors, such as an invalid config, need a change from the caller first,
        // and a video session ends on internal errors only after five in a row.
        if (event.code === 1008) {
            return this.endpoint === "audio" && this.errorCode === "internal_error";
        }
        return RECONNECT_CODES.has(event.code);
    };
}

/**
 * Reconnects only after closes and errors that a new session can recover from, and starts each new
 * session with the caller's last `session.update`, since a new session otherwise runs the default
 * config.
 */
export class RealtimeWebSocket extends core.ReconnectingWebSocket {
    private readonly session: Session;
    private sessionUpdate: string | undefined;
    private opened = false;

    constructor(endpoint: Endpoint, args: core.ReconnectingWebSocket.Args) {
        const session = new Session(endpoint);
        super({
            ...args,
            options: { ...args.options, shouldReconnect: args.options?.shouldReconnect ?? session.shouldReconnect },
        });
        this.session = session;
        // Registered before the socket wrapper's listeners, so a new session receives its config
        // before anything the caller sends from an open handler.
        this.addEventListener("open", this.handleOpen);
        this.addEventListener("message", this.handleMessage);
        this.addEventListener("error", this.handleError);
    }

    public override send(data: core.ReconnectingWebSocket.Message): void {
        if (typeof data === "string") {
            const type = parseMessage(data)?.type;
            if (type === "session.update") {
                this.sessionUpdate = data;
            } else if (type === "session.close") {
                this.session.closeSent = true;
            }
        }
        super.send(data);
    }

    private readonly handleOpen = (): void => {
        this.session.reset();
        if (this.opened && this.sessionUpdate !== undefined) {
            super.send(this.sessionUpdate);
        }
        this.opened = true;
    };

    private readonly handleMessage = (event: MessageEvent): void => {
        const message = typeof event.data === "string" ? parseMessage(event.data) : undefined;
        if (message?.type === "session.closed") {
            this.session.closedReason = message.reason;
        } else if (message?.type === "error") {
            this.session.errorCode = message.code;
        }
    };

    // Errors are retried without consulting `shouldReconnect`. Until a session has opened, an
    // error may come from the caller's settings rather than an outage, and `waitForOpen` rejects on
    // it either way, so a retry would only open a session nobody is waiting for.
    private readonly handleError = (event: core.ErrorEvent): void => {
        if (!this.opened || this.session.closeSent || isPermanentRefusal(event.message)) {
            this.close();
        }
    };
}

// Never throws, since a listener that throws keeps the listeners after it from running.
function parseMessage(text: string): Message | undefined {
    try {
        const message = fromJson(text);
        return typeof message === "object" && message !== null ? message : undefined;
    } catch {
        return undefined;
    }
}

function isPermanentRefusal(message: string): boolean {
    const match = REFUSED_HANDSHAKE.exec(message);
    if (match === null) {
        return false;
    }
    const status = Number(match[1]);
    return status >= 400 && status < 500 && !RETRYABLE_HANDSHAKE_STATUSES.has(status);
}
