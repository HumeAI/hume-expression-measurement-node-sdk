import type * as events from "./events.js";
import * as ws from "./ws.js";

export type ReconnectingWebSocket = typeof ws.ReconnectingWebSocket;
export declare namespace ReconnectingWebSocket {
    export type Event = events.Event;
    export type CloseEvent = events.CloseEvent;
    export type ErrorEvent = events.ErrorEvent;
}

/**
 * The values of a realtime socket's `readyState`. Sending throws unless it is `OPEN`.
 */
export type ReadyState = ws.ReconnectingWebSocket.ReadyState;
export const ReadyState: typeof ws.ReconnectingWebSocket.ReadyState = ws.ReconnectingWebSocket.ReadyState;
