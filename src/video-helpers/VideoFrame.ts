// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

/** One video frame, ready to send with `sendImageFrame`. */
export interface VideoFrame {
    /** One complete JPEG image. */
    data: Uint8Array;
    /**
     * When the frame was captured, in milliseconds: media time for a file, and time since capture
     * started for a live source.
     */
    timestampMs: number;
}
