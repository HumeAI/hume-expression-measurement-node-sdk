// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FfmpegNotFoundError, iterVideoFrames, type VideoFrame } from "../../src/video-helpers/index";

// The smallest byte sequence the splitter accepts as an image: start, scan header, scan data, end.
function jpeg(fill: number): Uint8Array {
    return new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x03, 0x00, fill, fill, 0xff, 0xd9]);
}

async function collect(frames: AsyncIterable<VideoFrame>): Promise<VideoFrame[]> {
    const collected: VideoFrame[] = [];
    for await (const frame of frames) {
        collected.push(frame);
    }
    return collected;
}

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe("iterVideoFrames", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "video-file-test-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    // Writes a Node script that stands in for ffmpeg. It saves its arguments to args.json, and its
    // body runs with `fs`, the test's directory as `dir`, and `images` concatenated as `images`.
    function fakeFfmpeg(body: string, images: Uint8Array[] = []): string {
        writeFileSync(join(dir, "images.jpg"), Buffer.concat(images));
        const path = join(dir, "ffmpeg");
        writeFileSync(
            path,
            [
                "#!/usr/bin/env node",
                'const fs = require("fs");',
                `const dir = ${JSON.stringify(dir)};`,
                `fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));`,
                `const images = fs.readFileSync(${JSON.stringify(join(dir, "images.jpg"))});`,
                body,
            ].join("\n"),
            { mode: 0o755 },
        );
        return path;
    }

    function ffmpegArgs(): string[] {
        return JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
    }

    it("yields each image ffmpeg writes with its time in the video", async () => {
        const images = [jpeg(1), jpeg(2), jpeg(3)];
        const ffmpegPath = fakeFfmpeg("process.stdout.write(images);", images);

        const frames = await collect(iterVideoFrames("interview.mp4", { fps: 2, ffmpegPath }));

        expect(frames).toEqual([
            { data: images[0], timestampMs: 0 },
            { data: images[1], timestampMs: 500 },
            { data: images[2], timestampMs: 1000 },
        ]);
    });

    it("asks ffmpeg for JPEG images of the file at the requested rate and width", async () => {
        const ffmpegPath = fakeFfmpeg("");

        await collect(iterVideoFrames("interview.mp4", { fps: 2.5, maxWidth: 640, ffmpegPath }));
        const args = ffmpegArgs();

        expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", "interview.mp4"]);
        expect(args[args.indexOf("-vf") + 1]).toBe("fps=2.5,scale='min(iw,640)':-2");
        expect(args.slice(-7)).toEqual(["-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "-"]);
        expect(args).not.toContain("-re");
    });

    it("paces ffmpeg to the video's own speed when realtime is set", async () => {
        const ffmpegPath = fakeFfmpeg("");

        await collect(iterVideoFrames("interview.mp4", { realtime: true, ffmpegPath }));
        const args = ffmpegArgs();

        expect(args[args.indexOf("-i") - 1]).toBe("-re");
        expect(args[args.indexOf("-vf") + 1]).toBe("fps=3,scale='min(iw,1280)':-2");
    });

    it("yields the images written before ffmpeg fails, then throws its error output", async () => {
        const ffmpegPath = fakeFfmpeg(
            [
                "process.stdout.write(images, () => {",
                '    process.stderr.write("interview.mp4: Invalid data found when processing input\\n");',
                "    process.exit(1);",
                "});",
            ].join("\n"),
            [jpeg(1)],
        );
        const frames = iterVideoFrames("interview.mp4", { ffmpegPath });

        expect((await frames.next()).value).toEqual({ data: jpeg(1), timestampMs: 0 });
        await expect(frames.next()).rejects.toThrow(
            "ffmpeg exited with code 1: interview.mp4: Invalid data found when processing input",
        );
    });

    it("throws FfmpegNotFoundError when ffmpeg is not at the given path", async () => {
        const ffmpegPath = join(dir, "missing", "ffmpeg");

        const error = await collect(iterVideoFrames("interview.mp4", { ffmpegPath })).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(FfmpegNotFoundError);
        expect((error as Error).message).toContain(`ffmpeg was not found at ${ffmpegPath}. Install it`);
    });

    it("stops ffmpeg when iteration ends early", async () => {
        const ffmpegPath = fakeFfmpeg(
            [
                'fs.writeFileSync(require("path").join(dir, "pid"), String(process.pid));',
                "setInterval(() => process.stdout.write(images), 10);",
            ].join("\n"),
            [jpeg(1)],
        );

        for await (const _ of iterVideoFrames("interview.mp4", { ffmpegPath })) {
            break;
        }

        expect(isRunning(Number(readFileSync(join(dir, "pid"), "utf8")))).toBe(false);
    });

    it.each([0, -1, 3.5, Number.NaN])("rejects an fps of %s when called", (fps) => {
        expect(() => iterVideoFrames("interview.mp4", { fps })).toThrow(RangeError);
    });

    it("rejects an fps that is not a number when called", () => {
        expect(() => iterVideoFrames("interview.mp4", { fps: "5" as unknown as number })).toThrow(TypeError);
    });

    it("rejects a maxWidth below 16 or not an integer when called", () => {
        expect(() => iterVideoFrames("interview.mp4", { maxWidth: 15 })).toThrow(RangeError);
        expect(() => iterVideoFrames("interview.mp4", { maxWidth: 640.5 })).toThrow(TypeError);
    });
});
