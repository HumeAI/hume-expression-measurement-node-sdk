# Hume Expression Measurement Node SDK

The official Node.js client for the [Hume Expression Measurement API](https://dev.hume.ai/docs/expression-measurement/overview). The API measures emotional expression in audio and images. Upload a file to receive every measurement in one response, or stream audio or JPEG images over a WebSocket to receive measurements while the media is still arriving.

The SDK provides clients for the upload, realtime, and run endpoints, TypeScript types for every request, response, and message, and API key authentication. It ships CommonJS and ES module builds.

1. [Documentation](https://dev.hume.ai/docs/expression-measurement/overview)
2. [Node.js quickstart](https://dev.hume.ai/docs/expression-measurement/quickstart/nodejs)
3. [Voice upload guide](https://dev.hume.ai/docs/expression-measurement/voice/upload)
4. [Face upload guide](https://dev.hume.ai/docs/expression-measurement/face/upload)
5. [Voice realtime guide](https://dev.hume.ai/docs/expression-measurement/voice/realtime)
6. [Face realtime guide](https://dev.hume.ai/docs/expression-measurement/face/realtime)
7. [Runs guide](https://dev.hume.ai/docs/expression-measurement/runs)
8. [API reference](https://dev.hume.ai/reference/expression-measurement)

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

This package is for server-side use. Keep API keys on a server, and to use the API from a web page, relay through your server. See [Authentication](https://dev.hume.ai/docs/expression-measurement/authentication).

## Preparing audio

The voice endpoints accept 16-bit PCM at 16 kHz, mono. The upload endpoint takes it as a WAV file or as headerless little-endian samples, and the realtime endpoint takes headerless samples only. Convert a recording with ffmpeg:

```bash
ffmpeg -i recording.wav -f s16le -acodec pcm_s16le -ac 1 -ar 16000 speech.pcm
```

## Quickstart: upload

The upload endpoints take media you already have and return every measurement in one response.

### Voice

```typescript
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";

const client = new ExpressionMeasurementClient();

const response = await client.voice.measure({
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

`contentType` labels the part. `application/octet-stream` marks the file as headerless samples; to upload a WAV file, pass `audio/wav`. The response lists every utterance in `utterances` and every measurement in `measurements`, each with the `utteranceId` it belongs to. A request holds up to 25,000,000 bytes, a little over 13 minutes of audio. The [voice upload guide](https://dev.hume.ai/docs/expression-measurement/voice/upload) covers the request, the response, and every error.

### Face

```typescript
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";

const client = new ExpressionMeasurementClient();

const response = await client.face.measure({
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

`file` is a list, so one request can carry several JPEG images. `measurements` holds one result per image, in the order sent, and `frameId` is the image's position in the list. The [face upload guide](https://dev.hume.ai/docs/expression-measurement/face/upload) covers image limits, detection settings, and tracking faces across requests.

## Quickstart: realtime

The realtime endpoints take media that is still arriving, such as audio from a live microphone or images from a camera, and send measurements as they are produced.

### Voice

Open a session, register a message handler, stream the file in frames, and close.

```typescript
import { readFile } from "node:fs/promises";
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";

const client = new ExpressionMeasurementClient();

// A session cannot be resumed, so a reconnect would start a new one with the default configuration.
const socket = await client.voice.connect({ reconnectAttempts: 0 });

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
socket.sendVoiceSessionClose({ type: "session.close" });
```

The server detects speech, groups it into utterances, and sends a `measurement.result` every 3 seconds of speech while an utterance continues. It accepts the first 30 seconds of audio immediately and then twice real time, so a long recording must be paced. The [voice realtime guide](https://dev.hume.ai/docs/expression-measurement/voice/realtime) covers the send rate, utterances, and the message flow.

### Face

The face endpoint accepts one complete JPEG image per frame and answers each accepted frame with one `measurement.result` listing every face it detected.

```typescript
import { readFile } from "node:fs/promises";
import { ExpressionMeasurementClient } from "@humeai/expression-measurement-node";

const client = new ExpressionMeasurementClient();

const socket = await client.face.connect({ reconnectAttempts: 0 });

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
socket.sendFaceSessionClose({ type: "session.close" });
```

`bbox` is `[x0, y0, x1, y1]` in pixels of the submitted image. `faceId` links the same face across frames within a session. The [face realtime guide](https://dev.hume.ai/docs/expression-measurement/face/realtime) covers frame limits, the send rate, and face tracking.

### Handling messages

The `message` handler receives one typed object per message, and each has a `type` field that narrows the union in a `switch`. The `open`, `close`, and `error` events report the state of the connection itself, and `error` also fires when a message arrives that the SDK cannot parse. Message types are exported under the `ExpressionMeasurement` namespace.

```typescript
import type { ExpressionMeasurement } from "@humeai/expression-measurement-node";

function topExpression(result: ExpressionMeasurement.VoiceMeasurementResult): string | undefined {
    return result.expressions[0]?.name;
}
```

| Message | Voice | Face | Meaning |
|---|---|---|---|
| `session.created` | yes | yes | Sent on connect with the session ID and the default configuration. |
| `session.updated` | yes | yes | Confirms a `session.update` and states the configuration in force. |
| `utterance.start`, `utterance.end` | yes | no | Bracket one continuous stretch of speech. |
| `measurement.result` | yes | yes | Scores for one window of an utterance, or for the faces in one image. |
| `error` | yes | yes | A rejected frame or a failed session, with a `code` and whether it is `retryable`. |
| `session.closed` | yes | yes | The last message. States why the session ended and totals what was received and produced. |

## Scores

Every measurement is a list of scores, each pairing a `name` with a `probability` from 0 to 1 that the expression or quality is present. Scores are sorted by descending probability, and only those judged present are returned, so arrays vary in length and may be empty. Voice results carry `expressions`, each filtered against a threshold set for that expression, and `voiceAttributes`, which include only scores of 0.85 or above. Face results carry `expressions` and `descriptions` for each face, which include only scores above 0.1. [Scores](https://dev.hume.ai/docs/expression-measurement/scores) explains how to read them.

## Configuration

These settings apply to both upload and realtime requests.

| Setting | Endpoint | Default | Range |
|---|---|---|---|
| `measurementTimerMs` | Voice | 3000 | 3000 to 10000 ms of speech between measurements |
| `face.threshold` | Face | 0.9 | 0 to 1, the minimum detection confidence for a face to be measured |
| `face.minSize` | Face | 60 | 1 or more, the shortest side of a face's bounding box in pixels |

On an upload, pass the settings as `config`:

```typescript
await client.voice.measure({ file: audioFile, config: { measurementTimerMs: 5000 } });
await client.face.measure({ file: images, config: { face: { threshold: 0.8, minSize: 40 } } });
```

In a session, send `session.update` before the first frame. The server replies with `session.updated`. The configuration locks once the first frame is accepted, and a field omitted from `session.update` returns to its default.

```typescript
socket.sendVoiceSessionUpdate({ type: "session.update", measurementTimerMs: 5000 });
```

```typescript
socket.sendFaceSessionUpdate({ type: "session.update", face: { threshold: 0.8, minSize: 40 } });
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

const page = await client.runs.list({ endpoint: "voice", mode: "realtime" });
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

`runs.list` and `runs.listEvents` return one page at a time. Pass a page's `nextCursor` back as `cursor` to fetch the next one; the last page has none. The [runs guide](https://dev.hume.ai/docs/expression-measurement/runs) covers filters, run status, and every event kind.

## Errors

The upload and run methods reject with an `ExpressionMeasurementError` when a request fails. `statusCode` holds the HTTP status, and `body` holds the error body, whose `code` says what went wrong. A `401` body has no `code`; it carries a `message` and, when an API key was rejected, a `requestId`.

```typescript
import { ExpressionMeasurementError } from "@humeai/expression-measurement-node";

try {
    await client.face.measure({ file: [{ path: "photo.jpg", contentType: "image/jpeg" }] });
} catch (error) {
    if (!(error instanceof ExpressionMeasurementError)) throw error;
    console.error(`${error.statusCode}: ${JSON.stringify(error.body)}`);
}
```

Problems during a session arrive as `error` messages rather than exceptions. A rejected frame, such as `invalid_audio_frame`, `invalid_image_frame`, or `rate_limited`, is discarded and the session continues. `config_invalid`, `message_too_large`, and a voice `internal_error` end the session, and `session.closed` follows with `reason` set to `error`. A rejected API key fails the handshake, which surfaces through the socket's `error` and `close` events rather than as a message.

[Errors](https://dev.hume.ai/docs/expression-measurement/errors) lists every code and whether to retry.

## Contributing

Most of this SDK is generated by [Fern](https://buildwithfern.com) from the API definition, and edits to generated files are overwritten on the next generation. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to build and test the project and how to add code that persists across regenerations. To report a problem, open an issue in this repository.

## License

[MIT](LICENSE)
