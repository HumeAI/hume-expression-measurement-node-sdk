// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

/**
 * Thrown when a package an audio helper needs is not installed or cannot load on this platform.
 * The message says how to install what is missing.
 */
export class MissingDependencyError extends Error {
    /** The error from loading the package. */
    public readonly cause: unknown;

    constructor(message: string, cause: unknown) {
        super(message);
        this.name = "MissingDependencyError";
        this.cause = cause;
    }
}
