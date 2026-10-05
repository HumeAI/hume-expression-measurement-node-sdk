// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

const MARKER = 0xff;
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const TEM = 0x01;
const RST0 = 0xd0;
const RST7 = 0xd7;
// Markers from 0x02 to 0xbf are reserved and never appear in a valid image.
const FIRST_SEGMENT_MARKER = 0xc0;

const EMPTY_BYTES = new Uint8Array(0);

type State = "seek" | "marker" | "scan";

/**
 * Splits a stream of concatenated JPEG images, such as ffmpeg's `image2pipe` output or the body
 * of an MJPEG stream, into single images ready to send with `sendImageFrame`.
 *
 * Pass successive chunks of the stream to `push`, which returns the images completed so far and
 * holds back a partial one until the rest arrives. Images are found by walking the JPEG marker
 * structure rather than by searching for end markers, so a thumbnail embedded in EXIF data does
 * not split an image, and progressive images with several scans come out whole.
 *
 * Bytes before an image's start marker are discarded. An image whose structure is broken is
 * dropped, and splitting resumes at the next start marker.
 *
 * @example
 * import { JpegSplitter, streamVideo, type VideoFrame } from "@humeai/expression-measurement-node/video-helpers";
 *
 * async function* framesFrom(mjpeg: AsyncIterable<Uint8Array>): AsyncGenerator<VideoFrame> {
 *     const splitter = new JpegSplitter();
 *     const start = Date.now();
 *     for await (const chunk of mjpeg) {
 *         for (const data of splitter.push(chunk)) {
 *             yield { data, timestampMs: Date.now() - start };
 *         }
 *     }
 * }
 *
 * for await (const reply of streamVideo(socket, framesFrom(mjpeg), { live: true })) {
 *     console.log(reply.timestampMs, reply.result?.faces.length ?? reply.error?.code);
 * }
 */
export class JpegSplitter {
    // Starts at the current image's start marker once one is found. It is either the end of the
    // used part of `storage` or an array of its own.
    private buffer: Uint8Array = EMPTY_BYTES;
    // Holds `buffer` with room to grow, so that a push copies only its own chunk. The bytes after
    // `buffer` are free.
    private storage: Uint8Array = EMPTY_BYTES;
    // Where parsing resumes in `buffer`. It can pass the end of `buffer` while a segment that
    // need not be read is still arriving.
    private offset = 0;
    private state: State = "seek";

    public push(chunk: Uint8Array): Uint8Array[] {
        if (chunk.length > 0) {
            this.append(chunk);
        }
        const images: Uint8Array[] = [];
        while (this.step(images)) {}
        return images;
    }

    private append(chunk: Uint8Array): void {
        const held = this.buffer;
        const start = held.buffer === this.storage.buffer ? held.byteOffset - this.storage.byteOffset : -1;
        const end = start + held.length;
        if (start >= 0 && end + chunk.length <= this.storage.length) {
            this.storage.set(chunk, end);
            this.buffer = this.storage.subarray(start, end + chunk.length);
            return;
        }
        // Doubling the room keeps the total copying in proportion to the bytes pushed, however
        // small the chunks are.
        const storage = new Uint8Array(Math.max(held.length + chunk.length, 2 * held.length));
        storage.set(held);
        storage.set(chunk, held.length);
        this.storage = storage;
        this.buffer = storage.subarray(0, held.length + chunk.length);
    }

    // Advances the parse once, returning false when more input is needed.
    private step(images: Uint8Array[]): boolean {
        const buffer = this.buffer;
        switch (this.state) {
            case "seek": {
                const start = findStartMarker(buffer);
                if (start < 0) {
                    // A marker byte at the end may be the first half of a start marker.
                    this.buffer = buffer[buffer.length - 1] === MARKER ? buffer.slice(-1) : EMPTY_BYTES;
                    return false;
                }
                this.buffer = buffer.subarray(start);
                this.offset = 2;
                this.state = "marker";
                return true;
            }
            case "marker": {
                let at = this.offset;
                if (at >= buffer.length) {
                    return false;
                }
                if (buffer[at] !== MARKER) {
                    this.resync();
                    return true;
                }
                // Any number of 0xff fill bytes may precede a marker.
                while (at + 1 < buffer.length && buffer[at + 1] === MARKER) {
                    at++;
                }
                if (at + 1 >= buffer.length) {
                    this.offset = at;
                    return false;
                }
                const marker = buffer[at + 1];
                if (marker === EOI) {
                    // Copied, so that each image's `buffer` holds that image alone.
                    images.push(buffer.slice(0, at + 2));
                    this.buffer = buffer.subarray(at + 2);
                    this.state = "seek";
                    return true;
                }
                if (marker === SOI) {
                    // The previous image was cut short, and a new one starts here.
                    this.buffer = buffer.subarray(at);
                    this.offset = 2;
                    return true;
                }
                if (marker === TEM || (marker >= RST0 && marker <= RST7)) {
                    this.offset = at + 2;
                    return true;
                }
                if (marker < FIRST_SEGMENT_MARKER) {
                    this.resync();
                    return true;
                }
                if (at + 4 > buffer.length) {
                    this.offset = at;
                    return false;
                }
                const length = (buffer[at + 2] << 8) | buffer[at + 3];
                // The length counts its own two bytes.
                if (length < 2) {
                    this.resync();
                    return true;
                }
                this.offset = at + 2 + length;
                if (marker === SOS) {
                    this.state = "scan";
                }
                return true;
            }
            case "scan": {
                // In entropy-coded data, 0xff is followed by 0x00 for a literal 0xff byte, by a
                // restart marker, or by fill bytes. Anything else is a marker that ends the scan.
                let at = this.offset;
                while (true) {
                    at = buffer.indexOf(MARKER, at);
                    if (at < 0) {
                        this.offset = Math.max(this.offset, buffer.length);
                        return false;
                    }
                    if (at + 1 >= buffer.length) {
                        this.offset = at;
                        return false;
                    }
                    const next = buffer[at + 1];
                    if (next === 0x00 || (next >= RST0 && next <= RST7)) {
                        at += 2;
                    } else if (next === MARKER) {
                        at += 1;
                    } else {
                        this.offset = at;
                        this.state = "marker";
                        return true;
                    }
                }
            }
        }
    }

    // Drops the current image and looks for the next start marker after its own.
    private resync(): void {
        this.buffer = this.buffer.subarray(1);
        this.offset = 0;
        this.state = "seek";
    }
}

function findStartMarker(buffer: Uint8Array): number {
    let at = buffer.indexOf(MARKER);
    while (at >= 0 && at + 1 < buffer.length) {
        if (buffer[at + 1] === SOI) {
            return at;
        }
        at = buffer.indexOf(MARKER, at + 1);
    }
    return -1;
}
