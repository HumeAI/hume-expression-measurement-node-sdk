// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

export const SAMPLE_RATE = 16000;

// Every input sample becomes 16000 / rate output samples, so a small WAV file declaring a rate of
// 1 Hz would expand into a stream thousands of times its size.
export const MIN_SAMPLE_RATE = 1000;

export function checkInteger(name: string, value: number): number {
    if (!Number.isInteger(value)) {
        throw new TypeError(`${name} must be an integer, got ${describe(value)}.`);
    }
    return value;
}

export function describe(value: unknown): string {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
}
