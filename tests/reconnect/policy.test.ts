// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { DEFAULT_BACKOFF, delayFor, followupFor, handshakeStatus } from "../../src/reconnect/policy";

const opened = { opened: true, clientClosing: false };

describe("followupFor", () => {
    it.each([
        [1012, "immediate"],
        [1006, "immediate"],
        [1001, "immediate"],
        [1013, "backoff"],
        [1011, "backoff"],
        [1014, "backoff"],
        [1000, "stop"],
        [1008, "stop"],
        [1009, "stop"],
        [4000, "stop"],
        [4999, "stop"],
    ])("close code %i: %s", (code, followup) => {
        expect(followupFor({ ...opened, code })).toBe(followup);
    });

    it.each([
        [503, "backoff"],
        [502, "backoff"],
        [429, "backoff"],
        [401, "stop"],
        [403, "stop"],
        [404, "stop"],
    ])("handshake status %i: %s", (httpStatus, followup) => {
        expect(followupFor({ code: 1006, httpStatus, opened: false, clientClosing: false })).toBe(followup);
    });

    it("reconnects after server_shutdown whatever the close code", () => {
        expect(followupFor({ ...opened, code: 1000, sessionClosedReason: "server_shutdown" })).toBe("immediate");
    });

    it("backs off when the connection fails before opening", () => {
        expect(followupFor({ code: 1006, opened: false, clientClosing: false })).toBe("backoff");
    });

    it("stops once the client has asked to close", () => {
        expect(followupFor({ ...opened, code: 1012, clientClosing: true })).toBe("stop");
    });
});

describe("delayFor", () => {
    it("waits under 250 ms before the first attempt after a restart", () => {
        expect(delayFor(1, "immediate", DEFAULT_BACKOFF, () => 0.999)).toBe(249);
    });

    it("doubles with each attempt, within half and all of the ceiling, up to the maximum", () => {
        expect(delayFor(1, "backoff", DEFAULT_BACKOFF, () => 0)).toBe(500);
        expect(delayFor(2, "immediate", DEFAULT_BACKOFF, () => 0.999)).toBe(1999);
        expect(delayFor(3, "backoff", DEFAULT_BACKOFF, () => 0)).toBe(2000);
        expect(delayFor(10, "backoff", DEFAULT_BACKOFF, () => 0.999)).toBe(29_985);
    });
});

describe("handshakeStatus", () => {
    it("reads the status of a rejected handshake", () => {
        expect(handshakeStatus("Unexpected server response: 503")).toBe(503);
        expect(handshakeStatus("connect ECONNREFUSED 127.0.0.1:1")).toBeUndefined();
        expect(handshakeStatus(undefined)).toBeUndefined();
    });
});
