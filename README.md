# Hume Expression Measurement Node SDK

The official Node.js client for the [Hume Expression Measurement API](https://dev.hume.ai/expression-measurement/docs/overview). The API measures emotional expression in audio and images. Upload a file to receive every measurement in one response, or stream audio or JPEG images over a WebSocket to receive measurements while the media is still arriving.

The SDK provides clients for the upload, realtime, and run endpoints, TypeScript types for every request, response, and message, and API key authentication. It ships CommonJS and ES module builds.

1. [Documentation](https://dev.hume.ai/expression-measurement/docs/overview)
2. [Node.js quickstart](https://dev.hume.ai/expression-measurement/docs/quickstart/nodejs)
3. [Audio upload guide](https://dev.hume.ai/expression-measurement/docs/audio/upload)
4. [Video upload guide](https://dev.hume.ai/expression-measurement/docs/video/upload)
5. [Audio realtime guide](https://dev.hume.ai/expression-measurement/docs/audio/realtime)
6. [Video realtime guide](https://dev.hume.ai/expression-measurement/docs/video/realtime)
7. [Runs guide](https://dev.hume.ai/expression-measurement/docs/runs)
8. [API reference](https://dev.hume.ai/expression-measurement/reference)

## Requirements

Node.js 18 or later.

## Installation

```bash
npm install @humeai/expression-measurement-node
```

## Authentication

Every request and every WebSocket connection carries your API key in the `X-Hume-Api-Key` header. Pass the key to the client, or set the `HUME_API_KEY` environment variable and construct the client without arguments.

```typescript
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";

const client = new ExpressionMeasurementClient({ apiKey: "YOUR_API_KEY" });
```

This package is for server-side use. Keep API keys on a server, and to use the API from a web page, relay through your server. See [Authentication](https://dev.hume.ai/expression-measurement/docs/authentication).

## Preparing audio

The audio endpoints accept 16-bit PCM at 16 kHz, mono. The upload endpoint takes it as a WAV file or as headerless little-endian samples, and the realtime endpoint takes headerless samples only. Convert a recording with ffmpeg:

```bash
ffmpeg -i recording.wav -f s16le -acodec pcm_s16le -ac 1 -ar 16000 speech.pcm
```

## Quickstart: upload

The upload endpoints take media you already have and return every measurement in one response.

### Audio

```typescript
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";

const client = new ExpressionMeasurementClient();

const response = await client.audio.measure({
    file: { path: "speech.pcm", contentType: "application/octet-stream" },
});

for (const measurement of response.measurements) {
    const top = measurement.expressions
        .slice(0, 3)
        .map((score) => `${score.name} ${score.probability.toFixed(2)}`)
        .join(", ");
    console.log(`utterance ${measurement.utteranceId}, ${measurement.audioStartMs} to ${measurement.audioEndMs} ms: ${top}`);
}
```

`contentType` labels the part. `application/octet-stream` marks the file as headerless samples; to upload a WAV file, pass `audio/wav`. The response lists every utterance in `utterances` and every measurement in `measurements`, each with the `utteranceId` it belongs to. The 25MB request limit applies to the whole multipart body, config included, which leaves room for a little over 13 minutes of audio. The [audio upload guide](https://dev.hume.ai/expression-measurement/docs/audio/upload) covers the request, the response, and every error.

### Video

```typescript
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";

const client = new ExpressionMeasurementClient();

const response = await client.video.measure({
    file: [{ path: "photo.jpg", contentType: "image/jpeg" }],
});

for (const result of response.measurements) {
    for (const face of result.faces) {
        const top = face.expressions
            .slice(0, 3)
            .map((score) => `${score.name} ${score.probability.toFixed(2)}`)
            .join(", ");
        console.log(`image ${result.frameId}, face ${face.faceId} at [${face.bbox.join(", ")}]: ${top}`);
    }
}
```

`file` is a list, so one request can carry several JPEG images. `measurements` holds one result per image, in the order sent, and `frameId` is the image's position in the list. The [video upload guide](https://dev.hume.ai/expression-measurement/docs/video/upload) covers image limits, detection settings, and tracking faces across requests.

## Quickstart: realtime

The realtime endpoints take media that is still arriving, such as audio from a live microphone or images from a camera, and send measurements as they are produced.

### Audio

Open a session, register a message handler, stream the file in frames, and close.

```typescript
import { readFile } from "node:fs/promises";
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";

const client = new ExpressionMeasurementClient();

// A session cannot be resumed, so a reconnect would start a new one with the default configuration.
const socket = await client.audio.connect({ reconnectAttempts: 0 });

socket.on("message", (message) => {
    switch (message.type) {
        case "measurement.result": {
            const top = message.expressions
                .slice(0, 3)
                .map((score) => `${score.name} ${score.probability.toFixed(2)}`)
                .join(", ");
            console.log(`utterance ${message.utteranceId}, ${message.audioStartMs} to ${message.audioEndMs} ms: ${top}`);
            break;
        }
        case "error":
            console.error(`${message.code}: ${message.message}`);
            break;
        case "session.closed":
            console.log(`closed after ${message.produced.measurements} measurements`);
            socket.close();
            break;
    }
});

await socket.waitForOpen();

// 3200 bytes is 100 ms of audio at 16 kHz, 16-bit, mono.
const FRAME_SIZE = 3200;
const audio = await readFile("speech.pcm");
for (let offset = 0; offset < audio.length; offset += FRAME_SIZE) {
    socket.sendAudioFrame(audio.subarray(offset, offset + FRAME_SIZE));
}
socket.sendAudioSessionClose({ type: "session.close" });
```

The server detects speech, groups it into utterances, and sends a `measurement.result` every 3 seconds of speech while an utterance continues. It accepts the first 30 seconds of audio immediately and then twice real time, so a long recording must be paced. The [audio realtime guide](https://dev.hume.ai/expression-measurement/docs/audio/realtime) covers the send rate, utterances, and the message flow.

### Video

The video endpoint accepts one complete JPEG image per frame and answers each accepted frame with one `measurement.result` listing every face it detected.

```typescript
import { readFile } from "node:fs/promises";
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";

const client = new ExpressionMeasurementClient();

const socket = await client.video.connect({ reconnectAttempts: 0 });

socket.on("message", (message) => {
    switch (message.type) {
        case "measurement.result":
            for (const face of message.faces) {
                const top = face.expressions
                    .slice(0, 3)
                    .map((score) => `${score.name} ${score.probability.toFixed(2)}`)
                    .join(", ");
                console.log(`face ${face.faceId} at [${face.bbox.join(", ")}]: ${top}`);
            }
            break;
        case "error":
            console.error(`${message.code}: ${message.message}`);
            break;
        case "session.closed":
            socket.close();
            break;
    }
});

await socket.waitForOpen();
socket.sendImageFrame(await readFile("photo.jpg"));
socket.sendVideoSessionClose({ type: "session.close" });
```

`bbox` is `[x0, y0, x1, y1]` in pixels of the submitted image. `faceId` links the same face across frames within a session. The [video realtime guide](https://dev.hume.ai/expression-measurement/docs/video/realtime) covers frame limits, the send rate, and face tracking.

### Handling messages

The `message` handler receives one typed object per message, and each has a `type` field that narrows the union in a `switch`. The `open`, `close`, and `error` events report the state of the connection itself, and `error` also fires when a message arrives that the SDK cannot parse. Message types are exported under the `ExpressionMeasurement` namespace.

```typescript
import type { ExpressionMeasurement } from "@humeai/expression-measurement-node";

function topExpression(result: ExpressionMeasurement.AudioMeasurementResult): string | undefined {
    return result.expressions[0]?.name;
}
```

| Message | Audio | Video | Meaning |
|---|---|---|---|
| `session.created` | yes | yes | Sent on connect with the session ID and the default configuration. |
| `session.updated` | yes | yes | Confirms a `session.update` and states the configuration in force. |
| `utterance.start`, `utterance.end` | yes | no | Bracket one continuous stretch of speech. |
| `measurement.result` | yes | yes | Scores for one window of an utterance, or for the faces in one image. |
| `error` | yes | yes | A rejected frame or a failed session, with a `code` and whether it is `retryable`. |
| `session.closed` | yes | yes | The last message. States why the session ended and totals what was received and produced. |

## Audio helpers

`@humeai/expression-measurement-node/audio-helpers` records from a microphone, reads WAV files, and converts audio at any sample rate from 1 kHz and any channel count into frames for the realtime audio endpoint. The WAV reader and the resampler are written in TypeScript and need nothing beyond this package.

### Microphone

`Microphone` records through [decibri](https://www.npmjs.com/package/decibri), an optional peer dependency. Install it alongside the SDK:

```bash
npm install decibri
```

decibri is licensed under the Apache License 2.0. Its platform packages include ONNX Runtime, licensed under MIT, which accounts for most of their size, about 40 MB on macOS. decibri provides native addons for Windows and Linux (glibc) on x64 and arm64 and for macOS on arm64. On Linux it also needs the ALSA library: `sudo apt-get install libasound2t64` on Ubuntu 24.04, Debian 13 and later, or `sudo apt-get install libasound2` on earlier releases of Debian and Ubuntu. If decibri is missing or cannot load, `Microphone.open()` throws a `MissingDependencyError` whose message says what to install.

`Microphone.open()` records from the default input device, or the one you pass as `device`, and yields 100 ms frames ready to send. This example records for 10 seconds while printing measurements as they arrive, then closes the session.

```typescript
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";
import { Microphone } from "@humeai/expression-measurement-node/audio-helpers";

const client = new ExpressionMeasurementClient();

// Opening the microphone first means a missing or busy device fails before a session starts.
const microphone = await Microphone.open();
try {
    const socket = await client.audio.connect({ reconnectAttempts: 0 });
    socket.on("message", (message) => {
        switch (message.type) {
            case "measurement.result": {
                const top = message.expressions
                    .slice(0, 3)
                    .map((score) => `${score.name} ${score.probability.toFixed(2)}`)
                    .join(", ");
                console.log(`utterance ${message.utteranceId}, ${message.audioStartMs} to ${message.audioEndMs} ms: ${top}`);
                break;
            }
            case "error":
                console.error(`${message.code}: ${message.message}`);
                break;
            case "session.closed":
                socket.close();
                break;
        }
    });
    await socket.waitForOpen();

    console.log(`Recording from ${microphone.deviceName} for 10 seconds`);
    let framesSent = 0;
    for await (const frame of microphone) {
        socket.sendAudioFrame(frame);
        framesSent++;
        // 100 frames of 100 ms is 10 seconds.
        if (framesSent === 100) {
            break;
        }
    }
    socket.sendAudioSessionClose({ type: "session.close" });
} finally {
    await microphone.close();
}
```

The device records at its own sample rate, and the SDK converts its audio to 16 kHz mono. Each `for await` yields only audio recorded after it starts, so a push-to-talk loop that starts a new `for await` for each press never sends audio recorded between presses. If the loop body is too slow and more than 10 seconds of audio builds up, the loop throws. An unknown device, or a name that matches several devices, throws an error that lists the available input devices. On macOS, the first recording asks permission for the terminal or app running Node; if access is denied, recording fails or records silence.

### WAV files

`iterWavFrames` reads 8, 16, 24, or 32-bit integer and 32 or 64-bit floating-point WAV at any sample rate from 1 kHz and any channel count and yields 100 ms frames. It replaces the file loop in the [realtime quickstart](#quickstart-realtime):

```typescript
import { iterWavFrames } from "@humeai/expression-measurement-node/audio-helpers";

await socket.waitForOpen();
for await (const frame of iterWavFrames("recording.wav")) {
    socket.sendAudioFrame(frame);
}
socket.sendAudioSessionClose({ type: "session.close" });
```

Frames are produced as fast as the file is read, so pace the sends for a file longer than 30 seconds. Compressed WAV files make iteration throw an error with an ffmpeg command that converts them.

### Other sources

`Resampler` converts a stream you already have, block by block. Pass each block to `process`, then call `flush` after the last one. Blocks can be bytes, as an `ArrayBuffer`, `Uint8Array`, or `Buffer`, which are read as little-endian and may end partway through a sample frame, or an `Int16Array`, `Float32Array`, or `Float64Array` that matches `sampleFormat`. Channels are averaged to mono.

At input rates other than 16 kHz, the resampler holds back a little audio as filter history, 4 ms at input rates above 16 kHz and up to 64 ms at 1 kHz, so `process` can return an empty result for a short block. The endpoint rejects empty frames, so check before sending. It also rejects frames longer than 10 seconds, so pass a long recording in blocks of about 100 ms rather than in one call, and pace the sends for a recording longer than 30 seconds.

```typescript
import { Resampler } from "@humeai/expression-measurement-node/audio-helpers";

const resampler = new Resampler({ sampleRate: 48000, channels: 2, sampleFormat: "int16" });
for await (const block of blocks) {
    const pcm = resampler.process(block);
    if (pcm.length > 0) {
        socket.sendAudioFrame(pcm);
    }
}
const rest = resampler.flush();
if (rest.length > 0) {
    socket.sendAudioFrame(rest);
}
```

## Video helpers

`@humeai/expression-measurement-node/video-helpers` streams JPEG frames to the realtime video endpoint. `streamVideo` sends frames within the send rate, handles rejected frames, and pairs every reply with the frame it answers. `iterVideoFrames` reads frames from a video file through ffmpeg, and `JpegSplitter` splits a stream of concatenated JPEG images, such as MJPEG, into single frames.

### Streaming frames

`streamVideo` takes a socket and any async iterable of frames, each a JPEG image as `data` with its time in milliseconds as `timestampMs`, and yields one reply per frame, in the order of the frames. A reply holds the frame's `timestampMs` and either the `result` that measured it or the `error` that rejected it. This example measures a video file:

```typescript
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";
import { iterVideoFrames, streamVideo } from "@humeai/expression-measurement-node/video-helpers";

const client = new ExpressionMeasurementClient();
const socket = await client.video.connect({ reconnectAttempts: 0 });

const stream = streamVideo(socket, iterVideoFrames("interview.mp4", { fps: 2 }));
for await (const reply of stream) {
    if (reply.result) {
        for (const face of reply.result.faces) {
            const top = face.expressions
                .slice(0, 3)
                .map((score) => `${score.name} ${score.probability.toFixed(2)}`)
                .join(", ");
            console.log(`${reply.timestampMs} ms, face ${face.faceId}: ${top}`);
        }
    } else {
        console.error(`${reply.timestampMs} ms: ${reply.error.code}`);
    }
}
console.log(`${stream.closed?.produced.measurements} faces measured`);
```

The server accepts the first 8 frames immediately and then 4 per second. `streamVideo` sends the first 7 at once, keeping one in reserve for uneven network timing, and paces the rest. When the server rejects a frame with `rate_limited`, `streamVideo` halves its send rate, down to one frame every 2 seconds, and raises it again gradually while frames are accepted, so a tighter limit than expected costs only a few rejected frames. What happens to the rejected frame depends on the source:

1. From a recording, the default, it sends the frame again once the lower rate allows, so every frame is measured. It also sends a frame once more after a retryable `internal_error`.
2. From a live source, with `{ live: true }`, it yields the rejection and moves on, so results keep up with the source. A live frame that arrives when the send rate has no room is not sent at all, and `stream.droppedFrames` counts it.

A frame over the 2 MB message limit would end the session, so it is never sent and is yielded as a `message_too_large` error. Frames that are not valid JPEGs or that exceed 8,294,400 pixels are rejected by the server with `invalid_image_frame`, and the session continues.

When the frames run out, `streamVideo` closes the session, yields the remaining replies, and closes the socket. `stream.closed` then holds the `session.closed` message with the session's totals. If the session ends before the frames do, because of a session-ending error, an idle timeout, or a dropped connection, the loop throws a `SessionEndedError`. Its `closed` holds the `session.closed` message when one arrived, and its `code` names the error that ended the session, if there was one. Leaving the loop early also closes the socket.

`streamVideo` takes over the socket's `message` handler, so read messages from the replies instead. The configuration locks at the first frame, so send any `session.update` before streaming. Frames are sent only while the loop asks for the next reply, so keep the loop body short.

### Video files

`iterVideoFrames` runs [ffmpeg](https://ffmpeg.org), which must be installed: `brew install ffmpeg` on macOS, `sudo apt install ffmpeg` on Debian or Ubuntu, or `winget install Gyan.FFmpeg` on Windows. It reads any format ffmpeg can decode and yields frames whose `timestampMs` is their position in the video. If ffmpeg is not on `PATH` or at `ffmpegPath`, iteration throws an `FfmpegNotFoundError` whose message says how to install it, and if ffmpeg fails, the error includes its output. ffmpeg starts when the first frame is requested, which `streamVideo` does once the connection is open, so these errors are thrown from the loop after a session has started. `streamVideo` closes the socket before throwing them.

| Option | Default | Purpose |
|---|---|---|
| `fps` | 3 | Frames taken per second of video, above 0 and at most 4. |
| `maxWidth` | 1280 | Wider frames are scaled down to this width, keeping their shape. Narrower frames are left as they are. |
| `realtime` | false | Produce frames no faster than the video plays, as a live source would. By default they are produced as fast as they are sent. |
| `ffmpegPath` | `ffmpeg` on `PATH` | The ffmpeg executable to run. |

Ending the loop early stops ffmpeg.

### Live sources

`streamVideo` measures frames from any source you can turn into an async iterable, such as a camera your application already captures. Encode each frame as a JPEG, give it a `timestampMs`, and pass `{ live: true }`. A camera usually produces more frames than the 4 per second the endpoint accepts; `streamVideo` sends what the send rate allows and counts the rest in `stream.droppedFrames`, so capturing fewer frames saves encoding work. Keep frames around 1280 pixels wide.

`JpegSplitter` turns a byte stream of concatenated JPEG images, such as ffmpeg's `image2pipe` output or the body of an MJPEG stream, into single images. Pass each chunk to `push`, which returns the images completed so far and holds back a partial one. This generator yields frames from such a stream, timed from when it starts:

```typescript
import { JpegSplitter, streamVideo, type VideoFrame } from "@humeai/expression-measurement-node/video-helpers";

async function* framesFrom(mjpeg: AsyncIterable<Uint8Array>): AsyncGenerator<VideoFrame> {
    const splitter = new JpegSplitter();
    const start = Date.now();
    for await (const chunk of mjpeg) {
        for (const data of splitter.push(chunk)) {
            yield { data, timestampMs: Date.now() - start };
        }
    }
}

for await (const reply of streamVideo(socket, framesFrom(mjpeg), { live: true })) {
    console.log(reply.timestampMs, reply.result?.faces.length ?? reply.error?.code);
}
```

## Scores

Every measurement contains lists of scores, each pairing a `name` with a `probability` from 0 to 1. Scores are sorted by descending probability, and each list includes only the scores that pass its cutoff, so lists vary in length and may be empty. Audio results carry `expressions`, each included when judged present against a threshold set for that expression, and `voiceAttributes`, included at 0.725 or above. Video results carry `expressions` and `descriptions` for each face, both included above 0.1. What `probability` denotes differs from list to list. [Scores](https://dev.hume.ai/expression-measurement/docs/scores) explains how to read them.

## Configuration

These settings apply to both upload and realtime requests.

| Setting | Endpoint | Default | Range |
|---|---|---|---|
| `measurementTimerMs` | Audio | 3000 | 3000 to 10000 ms of speech between measurements |
| `face.threshold` | Video | 0.9 | 0 to 1, the minimum detection confidence for a face to be measured |
| `face.minSize` | Video | 60 | 1 or more, the shortest side of a face's bounding box in pixels |

On an upload, pass the settings as `config`:

```typescript
await client.audio.measure({ file: audioFile, config: { measurementTimerMs: 5000 } });
await client.video.measure({ file: images, config: { face: { threshold: 0.8, minSize: 40 } } });
```

In a session, send `session.update` before the first frame. The server replies with `session.updated`. The configuration locks once the first frame is accepted, and a field omitted from `session.update` returns to its default.

```typescript
socket.sendAudioSessionUpdate({ type: "session.update", measurementTimerMs: 5000 });
```

```typescript
socket.sendVideoSessionUpdate({ type: "session.update", face: { threshold: 0.8, minSize: 40 } });
```

## Connection options

`connect()` accepts options for the WebSocket itself.

| Option | Default | Purpose |
|---|---|---|
| `reconnectAttempts` | 30 | Automatic reconnects after an unexpected close. Set to 0 for session-based streaming, since a new connection is a new session. |
| `shouldReconnect` | reconnect on any close code other than 1000 | Decides whether a close triggers a reconnect. Return false to treat the close as final. |
| `connectionTimeoutInSeconds` | none | Fails the handshake after this long. |
| `headers`, `queryParams` | none | Extra values sent with the handshake. |
| `abortSignal` | none | Aborts the connection from outside. |

`connect()` resolves before the handshake completes. Call `waitForOpen()` before sending, or send from the `open` handler. Sending on a socket that is not open throws.

## Runs

Every upload request that is measured and every realtime session is recorded as a run. A run's ID is the `runId` of an upload response or the `sessionId` of a session. The run endpoints return a run's status, configuration, and event log. They do not return measurements, so keep the results you need from the upload response or the session.

```typescript
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";

const client = new ExpressionMeasurementClient();

const page = await client.runs.list({ endpoint: "audio", mode: "realtime" });
for (const summary of page.runs) {
    console.log(summary.runId, summary.status, summary.meteredSeconds);
}

const run = await client.runs.get({ runId: "01926f3a-5b1c-7d2e-8f40-3a9b7c1d2e5f" });
console.log(run.status, run.closeReason);

const events = await client.runs.listEvents({ runId: "01926f3a-5b1c-7d2e-8f40-3a9b7c1d2e5f" });
for (const event of events.events) {
    console.log(event.seq, event.kind);
}
```

`runs.list` and `runs.listEvents` return one page at a time. Pass a page's `nextCursor` back as `cursor` to fetch the next one; the last page has none. The [runs guide](https://dev.hume.ai/expression-measurement/docs/runs) covers filters, run status, and every event kind.

## Errors

The upload and run methods reject with an `ExpressionMeasurementError` when a request fails. `statusCode` holds the HTTP status, and `body` holds the error body, whose `code` says what went wrong. A `401` body has no `code`; it carries a `message` and, when an API key was rejected, a `requestId`.

```typescript
import { ExpressionMeasurementError } from "@humeai/expression-measurement-node";

try {
    await client.video.measure({ file: [{ path: "photo.jpg", contentType: "image/jpeg" }] });
} catch (error) {
    if (!(error instanceof ExpressionMeasurementError)) throw error;
    console.error(`${error.statusCode}: ${JSON.stringify(error.body)}`);
}
```

Problems during a session arrive as `error` messages rather than exceptions. A rejected frame, such as `invalid_audio_frame`, `invalid_image_frame`, or `rate_limited`, is discarded and the session continues. `config_invalid`, `message_too_large`, an audio `internal_error`, and five consecutive video `internal_error` messages end the session, and `session.closed` follows with `reason` set to `error`. A rejected API key fails the handshake, which surfaces through the socket's `error` and `close` events rather than as a message.

[Errors](https://dev.hume.ai/expression-measurement/docs/errors) lists every code and whether to retry.

## Contributing

Most of this SDK is generated by [Fern](https://buildwithfern.com) from the API definition, and edits to generated files are overwritten on the next generation. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to build and test the project and how to add code that persists across regenerations. To report a problem, open an issue in this repository.

## License

[MIT](LICENSE)
