// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { checkFps, checkMaxWidth, ffmpegArgs, readImages } from "./ffmpeg.js";
import type { VideoFrame } from "./VideoFrame.js";

export declare namespace iterVideoFrames {
    export interface Options {
        /** Frames per second to take from the video, above 0 and at most 3. 3 by default. */
        fps?: number;
        /** Frames wider than this many pixels are scaled down to it, keeping their shape. 1280 by default. */
        maxWidth?: number;
        /**
         * Produce frames no faster than the video plays, as a live source would. False by default,
         * which produces them as fast as they are consumed.
         */
        realtime?: boolean;
        /** Path to the ffmpeg executable. Found on `PATH` by default. */
        ffmpegPath?: string;
    }
}

/**
 * Reads a video file with ffmpeg and yields its frames as JPEG images ready to send with
 * `sendImageFrame`.
 *
 * Frames are taken `fps` times per second of video, and each frame's `timestampMs` is its position
 * in the video, to the nearest millisecond. Any format ffmpeg can decode works. ffmpeg must be
 * installed; it is found on `PATH` unless `ffmpegPath` is given.
 *
 * ffmpeg starts when iteration starts, so errors about the file are thrown by the first `next()`
 * rather than by this call. Ending iteration early stops ffmpeg.
 *
 * @param path Path to the video file.
 *
 * @throws {TypeError} fps is not a number, or maxWidth is not an integer.
 * @throws {RangeError} fps or maxWidth is out of range.
 * @throws {FfmpegNotFoundError} From iteration, if ffmpeg is not installed or not at `ffmpegPath`.
 * @throws {Error} From iteration, if ffmpeg fails, for example because the file does not exist or
 * is not a video. The message includes ffmpeg's error output.
 *
 * @example
 * import { iterVideoFrames } from "@humeai/expression-measurement-node/video-helpers";
 *
 * for await (const frame of iterVideoFrames("interview.mp4", { fps: 2 })) {
 *     console.log(frame.timestampMs, frame.data.length);
 * }
 */
export function iterVideoFrames(
    path: string,
    { fps = 3, maxWidth = 1280, realtime = false, ffmpegPath = "ffmpeg" }: iterVideoFrames.Options = {},
): AsyncGenerator<VideoFrame, void, undefined> {
    const args = ffmpegArgs([...(realtime ? ["-re"] : []), "-i", path], checkFps(fps), checkMaxWidth(maxWidth));
    return readFrames(ffmpegPath, args, fps);
}

async function* readFrames(
    ffmpegPath: string,
    args: string[],
    fps: number,
): AsyncGenerator<VideoFrame, void, undefined> {
    let index = 0;
    for await (const data of readImages(ffmpegPath, args)) {
        yield { data, timestampMs: Math.round((index * 1000) / fps) };
        index++;
    }
}
