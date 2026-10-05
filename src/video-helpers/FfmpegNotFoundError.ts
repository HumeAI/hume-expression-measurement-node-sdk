// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

/**
 * Thrown when the ffmpeg executable a video helper runs is not at the given path or on `PATH`.
 * The message says how to install it.
 */
export class FfmpegNotFoundError extends Error {
    /** The error from starting the process. */
    public readonly cause: unknown;

    constructor(message: string, cause: unknown) {
        super(message);
        this.name = "FfmpegNotFoundError";
        this.cause = cause;
    }
}
