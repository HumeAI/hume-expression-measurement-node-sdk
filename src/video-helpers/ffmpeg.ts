// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type { ChildProcess } from "child_process";
import { checkInteger, describe } from "../audio-helpers/pcm.js";
import { FfmpegNotFoundError } from "./FfmpegNotFoundError.js";
import { JpegSplitter } from "./JpegSplitter.js";

// The realtime video endpoint's documented send rate. Frames taken faster than this from a video
// played in real time could not all be sent, and would fall further behind the longer it plays.
const MAX_FPS = 3;

// ffmpeg's scaler fails at a width of 1, and a narrower frame is too small to hold a measurable face.
const MIN_WIDTH = 16;

// Lower is better quality. At 5, a 1280-wide frame is tens of kilobytes, far below the endpoint's
// 2 MB message limit.
const JPEG_QUALITY = 5;

// A damaged input can make ffmpeg log an error for every frame, so only the end is kept.
const MAX_STDERR_LENGTH = 16 * 1024;

const INSTALL_HINT =
    "Install it with `brew install ffmpeg` on macOS, `sudo apt install ffmpeg` on Debian or Ubuntu, or " +
    "`winget install Gyan.FFmpeg` on Windows, or pass the executable's location as ffmpegPath.";

export function checkFps(fps: number): number {
    if (typeof fps !== "number") {
        throw new TypeError(`fps must be a number, got ${describe(fps)}.`);
    }
    // Written so that NaN fails the check.
    if (!(fps > 0 && fps <= MAX_FPS)) {
        throw new RangeError(`fps must be above 0 and at most ${MAX_FPS}, got ${fps}.`);
    }
    return fps;
}

export function checkMaxWidth(maxWidth: number): number {
    checkInteger("maxWidth", maxWidth);
    if (maxWidth < MIN_WIDTH) {
        throw new RangeError(`maxWidth must be at least ${MIN_WIDTH}, got ${maxWidth}.`);
    }
    return maxWidth;
}

/** Arguments that read `input` and write JPEG images to stdout at `fps`, no wider than `maxWidth`. */
export function ffmpegArgs(input: string[], fps: number, maxWidth: number): string[] {
    return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        ...input,
        "-an",
        "-vf",
        // Quoted because the filter graph would otherwise split the expression at its comma.
        `fps=${fps},scale='min(iw,${maxWidth})':-2`,
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "-q:v",
        String(JPEG_QUALITY),
        "-",
    ];
}

/**
 * Runs ffmpeg and yields each JPEG image it writes to stdout. Ending iteration early stops the
 * process.
 */
export async function* readImages(ffmpegPath: string, args: string[]): AsyncGenerator<Uint8Array, void, undefined> {
    const { spawn } = await import("child_process");
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
        child.once("close", (code, signal) => resolve([code, signal])),
    );
    await started(child, ffmpegPath);

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
        stderr = (stderr + text).slice(-MAX_STDERR_LENGTH);
    });

    const splitter = new JpegSplitter();
    let finished = false;
    try {
        for await (const chunk of child.stdout as AsyncIterable<Uint8Array>) {
            yield* splitter.push(chunk);
        }
        const [code, signal] = await closed;
        finished = true;
        if (code !== 0) {
            const reason = code === null ? `was stopped by ${signal}` : `exited with code ${code}`;
            const output = stderr.trim();
            throw new Error(`ffmpeg ${reason}${output.length > 0 ? `: ${output}` : "."}`);
        }
    } finally {
        if (!finished) {
            child.kill();
            await closed;
        }
    }
}

function started(child: ChildProcess, ffmpegPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
                const where = ffmpegPath === "ffmpeg" ? "on PATH" : `at ${ffmpegPath}`;
                reject(new FfmpegNotFoundError(`ffmpeg was not found ${where}. ${INSTALL_HINT}`, error));
            } else {
                reject(error);
            }
        });
    });
}
