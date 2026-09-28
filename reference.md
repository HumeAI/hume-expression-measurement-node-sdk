# Reference
## voice
<details><summary><code>client.voice.<a href="/src/api/resources/voice/client/Client.ts">measure</a>({ ...params }) -> ExpressionMeasurement.VoiceFileResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Send the audio as the `file` part and, to change the defaults, settings as a JSON `config` part. The response holds every utterance found in the audio and every measurement taken, the same results a realtime session would stream for the same audio.

## How measurements are produced

The server detects when speech starts and stops. Each continuous stretch of speech is an **utterance**, listed in `utterances` with its span in the audio. Every measurement in `measurements` carries the `utterance_id` it belongs to, the span of audio it covers as `audio_start_ms` and `audio_end_ms`, and a `trigger` saying why it was produced. All times count from the start of the audio.

While an utterance is in progress, the server produces a measurement every `measurement_timer_ms` milliseconds of speech, with `trigger` set to `interval`. Each measurement covers the most recent 10 seconds of the utterance, or the whole utterance if it is shorter than that. Consecutive interval measurements therefore overlap; at the maximum `measurement_timer_ms` of 10000 they meet end to end instead. An interval measurement that falls as speech stops can end shortly after the utterance does, and no final measurement follows it.

When an utterance ends, the server produces a final measurement with `trigger` set to `speech_ended`, unless less than one second of speech has passed since the previous measurement ended. Every utterance produces at least one measurement, because the final measurement is skipped only when an interval measurement ended less than one second before it. Audio that ends while speech is in progress ends the utterance.

## Limits

| Limit | Value |
|---|---|
| Request size | 25MB, the whole multipart body |
| Audio format | 16-bit PCM, 16 kHz, mono, as a WAV file or headerless samples |

A request over the size limit is rejected with `audio_too_long`. Audio in MP3, FLAC, Ogg, MP4 or a RIFF container other than WAV is rejected with `unsupported_media_type`; convert it before sending. Any other file with an even number of bytes is treated as headerless samples, so send only the formats listed here; an empty file, or one with an odd number of bytes, is rejected with `audio_decode_failed`. A WAV file that is truncated or malformed, is at another sample rate, channel count or sample format, or uses the extensible WAV header rather than plain PCM is rejected with `audio_decode_failed` rather than converted.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.voice.measure({
    file: fs.createReadStream("/path/to/your/file")
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `ExpressionMeasurement.VoiceFileUpload` 
    
</dd>
</dl>

<dl>
<dd>

**requestOptions:** `VoiceClient.RequestOptions` 
    
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## face
<details><summary><code>client.face.<a href="/src/api/resources/face/client/Client.ts">measure</a>({ ...params }) -> ExpressionMeasurement.FaceFileResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Send one or more images, each as a `file` part, and, to change the defaults, settings as a JSON `config` part. The response holds one result per image, in the order the parts were sent, with the measurements for every face found in it. An image with no faces is a normal result with an empty `faces` array.

## Detection and measurement

The server detects the faces in each image. It does not measure a face whose detection confidence is below `face.threshold`, or whose bounding box is under `face.min_size` pixels on its shorter side. Of the rest, it measures up to 64, most confident first, and lists them in `faces` in that order. Each measured face carries its bounding box, its detection confidence, a `face_id`, and two sets of scores: `expressions` for emotional expressions such as amusement or interest, and `descriptions` for visible facial actions such as a smile or a jaw drop.

`face_id` tracks a face across the images of one request. A face normally keeps the same ID while it stays in view; a face that leaves the view and returns may receive a new ID. IDs do not identify a person. To keep IDs consistent across requests, set `return_face_state` and pass the returned `face_state` as `face_state` in the next request; otherwise IDs start again from 0 in every request.

## Limits

| Limit | Value |
|---|---|
| Request size | 25MB, the whole multipart body |
| Image size | 2MB |
| Pixels per image | 8,294,400 (the area of a 3840x2160 image) |
| Faces measured per image | 64 |

Before any image is measured, every image is checked: one that is not a JPEG, or is over the image size or pixel limit, fails the request with `unsupported_media_type` or `image_too_large`. An image that cannot be decoded, or a server at capacity, can still fail the request with `image_decode_failed` or a `503` after earlier images were measured. A request that fails in any of these ways returns no result for any image and is recorded as an `errored` run.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.face.measure({
    file: [fs.createReadStream("/path/to/your/file")]
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `ExpressionMeasurement.FaceFileUpload` 
    
</dd>
</dl>

<dl>
<dd>

**requestOptions:** `FaceClient.RequestOptions` 
    
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## runs
<details><summary><code>client.runs.<a href="/src/api/resources/runs/client/Client.ts">list</a>({ ...params }) -> ExpressionMeasurement.RunsPage</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Your organization's runs, newest first, one page at a time. The filters combine.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.runs.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `ExpressionMeasurement.ListRunsRequest` 
    
</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RunsClient.RequestOptions` 
    
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.runs.<a href="/src/api/resources/runs/client/Client.ts">get</a>({ ...params }) -> ExpressionMeasurement.Run</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

The run's status, when it started and ended, what it received and stored, and the configuration it ran under.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.runs.get({
    runId: "01926f3a-5b1c-7d2e-8f40-3a9b7c1d2e5f"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `ExpressionMeasurement.GetRunsRequest` 
    
</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RunsClient.RequestOptions` 
    
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.runs.<a href="/src/api/resources/runs/client/Client.ts">listEvents</a>({ ...params }) -> ExpressionMeasurement.RunEventsPage</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

The problems the run reported, in order: frames it rejected and failures it hit. A run that went well has none. Only realtime sessions record them, except `video_recording_abandoned`, which a face file run can also record.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.runs.listEvents({
    runId: "01926f2c-6d92-7a41-9d26-5e8b0c3f71a9"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `ExpressionMeasurement.ListEventsRunsRequest` 
    
</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RunsClient.RequestOptions` 
    
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

