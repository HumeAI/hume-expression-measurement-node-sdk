// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { JpegSplitter } from "../../src/video-helpers/index";

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

function segment(marker: number, payload: number[]): number[] {
    const length = payload.length + 2;
    return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

// The splitter reads only the marker structure, so the segment payloads and scan data need not
// decode to a picture. The quantization table holds an end marker's bytes, which the splitter
// must skip by the segment's length.
function jpeg({ segments = [] as number[][], scans = [[0x12, 0x34, 0x56]] } = {}): Uint8Array {
    const bytes = [
        ...SOI,
        ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
        ...segments.flat(),
        ...segment(0xdb, [0x00, 0xff, 0xd9, 0x10, 0x20]),
        ...segment(0xc0, [0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00]),
    ];
    scans.forEach((scan, index) => {
        bytes.push(...segment(0xc4, [index, 0x01, 0x02]));
        bytes.push(...segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), ...scan);
    });
    bytes.push(...EOI);
    return new Uint8Array(bytes);
}

function exif(thumbnail: Uint8Array): number[] {
    return segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...thumbnail]);
}

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
    return new Uint8Array(parts.flatMap((part) => Array.from(part)));
}

function split(...chunks: Uint8Array[]): Uint8Array[] {
    const splitter = new JpegSplitter();
    return chunks.flatMap((chunk) => splitter.push(chunk));
}

const WITH_EXIF = jpeg({ segments: [exif(jpeg())], scans: [[0x01, 0xff, 0x00, 0x02, 0xff, 0xd0, 0x03, 0xff, 0xff]] });
const PROGRESSIVE = jpeg({ scans: [[0x0a, 0xff, 0x00], [0x0b], [0x0c, 0xff, 0xd7, 0x0d]] });

describe("JpegSplitter", () => {
    it("splits images pushed in one chunk", () => {
        expect(split(concat(WITH_EXIF, PROGRESSIVE))).toEqual([WITH_EXIF, PROGRESSIVE]);
    });

    it("returns the same images wherever the stream is cut", () => {
        const stream = concat([0x00, 0xff, 0x01], WITH_EXIF, [0xff], PROGRESSIVE);
        for (let cut = 0; cut <= stream.length; cut++) {
            expect(split(stream.subarray(0, cut), stream.subarray(cut))).toEqual([WITH_EXIF, PROGRESSIVE]);
        }
    });

    it("returns the same images when the stream arrives one byte at a time", () => {
        const stream = concat(WITH_EXIF, PROGRESSIVE);
        const bytes = Array.from(stream, (byte) => new Uint8Array([byte]));
        expect(split(...bytes)).toEqual([WITH_EXIF, PROGRESSIVE]);
    });

    it("keeps an image whole when a thumbnail in its EXIF data has its own end marker", () => {
        expect(split(WITH_EXIF)).toEqual([WITH_EXIF]);
    });

    it("reads past stuffed bytes, restart markers and fill bytes in the scan", () => {
        const image = jpeg({ scans: [[0xff, 0x00, 0xff, 0xd0, 0xff, 0x00, 0xff, 0xff, 0xff, 0xd7, 0x01]] });
        expect(split(image, image)).toEqual([image, image]);
    });

    it("keeps every scan of a progressive image", () => {
        expect(split(PROGRESSIVE)).toEqual([PROGRESSIVE]);
    });

    it("accepts fill bytes before a marker between segments", () => {
        const image = concat(SOI, [0xff, 0xff], segment(0xe0, [0x00]), segment(0xda, [0x00]), [0x01], [0xff], EOI);
        expect(split(image)).toEqual([image]);
    });

    it("discards bytes before an image and between images", () => {
        const stream = concat([0x00, 0xff, 0xd9, 0xff], WITH_EXIF, [0x0a, 0xff, 0x00], PROGRESSIVE);
        expect(split(stream)).toEqual([WITH_EXIF, PROGRESSIVE]);
    });

    // Copying everything held back on each push takes about a second here, and grows with
    // the square of the number of chunks. Copying only each new chunk takes a few milliseconds.
    it("splits an image near the 2 MB message limit from small chunks in time proportional to its size", () => {
        const empty = jpeg({ scans: [[]] });
        const image = new Uint8Array(empty.length + 2_000_000).fill(0x12);
        image.set(empty.subarray(0, empty.length - EOI.length));
        image.set(EOI, image.length - EOI.length);
        const splitter = new JpegSplitter();
        const images: Uint8Array[] = [];

        const start = performance.now();
        for (let at = 0; at < image.length; at += 256) {
            images.push(...splitter.push(image.subarray(at, at + 256)));
        }
        const elapsedMs = performance.now() - start;

        expect(images).toHaveLength(1);
        expect(Buffer.compare(images[0], image)).toBe(0);
        expect(elapsedMs).toBeLessThan(100);
    });

    it("holds back a partial image until the rest arrives", () => {
        const splitter = new JpegSplitter();
        const cut = PROGRESSIVE.length - 1;

        expect(splitter.push(concat(WITH_EXIF, PROGRESSIVE.subarray(0, cut)))).toEqual([WITH_EXIF]);
        expect(splitter.push(PROGRESSIVE.subarray(cut))).toEqual([PROGRESSIVE]);
    });

    it("drops an image cut short in its scan by the start of the next image", () => {
        const truncated = WITH_EXIF.subarray(0, WITH_EXIF.length - 4);
        expect(split(concat(truncated, PROGRESSIVE))).toEqual([PROGRESSIVE]);
    });

    it("drops an image whose structure is broken and continues with the next", () => {
        const broken = concat(SOI, [0x12, 0x34], segment(0xda, [0x00]), EOI);
        expect(split(concat(broken, PROGRESSIVE))).toEqual([PROGRESSIVE]);
    });

    it("drops an image with a reserved marker or an impossible segment length", () => {
        const reserved = concat(SOI, [0xff, 0x02], EOI);
        const shortLength = concat(SOI, [0xff, 0xe0, 0x00, 0x01], EOI);
        expect(split(concat(reserved, shortLength, PROGRESSIVE))).toEqual([PROGRESSIVE]);
    });
});
