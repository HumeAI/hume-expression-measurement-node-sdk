// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

// Helpers that turn video into frames for the realtime video endpoint, which accepts one complete
// JPEG image per message.

export { connectVideo, ReconnectingVideoSession } from "./connectVideo.js";
export { FfmpegNotFoundError } from "./FfmpegNotFoundError.js";
export { iterVideoFrames } from "./file.js";
export { JpegSplitter } from "./JpegSplitter.js";
export { SessionEndedError } from "./SessionEndedError.js";
export { streamVideo, type VideoStream } from "./sender.js";
export type { VideoFrame } from "./VideoFrame.js";
