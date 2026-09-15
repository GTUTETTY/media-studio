# Media Studio

Media Studio is a small, local-only browser UI for importing media, inspecting it with `ffprobe`, trimming it, converting video to browser-friendly H.264/AAC MP4, and extracting MP3 audio with FFmpeg.

The compatibility conversion re-encodes media and can be lossy. The current encoder uses CPU-based `libx264`; hardware acceleration is not enabled.

## Launch

Requirements: Node.js 24 or newer, plus `ffmpeg` and `ffprobe` available on `PATH`.

```text
npm install
npm start
```

Open [http://127.0.0.1:8837](http://127.0.0.1:8837). Set `MEDIA_STUDIO_PORT` to another unprivileged port when needed (the UI and Host/origin checks use that port). `npm run typecheck` and `npm test` run the checks, including a locally generated FFmpeg fixture, probe, conversion, and download.

## Privacy and storage

The server binds only to `127.0.0.1`. It has no cloud upload, telemetry, external fonts, cookies, deployment configuration, or yt-dlp integration. The browser sends selected files directly to this local process. Source copies and completed outputs are stored under the app's ignored `.cache/sources` and `.cache/outputs` directories; state is held in memory and is not resumed after restart. Remove those app-local files manually when you no longer need them.

Each run generates a random session key, requires it on APIs and media/download URLs, validates the Host and write Origin, uses opaque IDs, and never accepts a server path or shell command from the browser. Uploads are streamed and capped at 500 MB. Outputs use unique names and FFmpeg's no-overwrite mode.

## Known limitations

This is a focused local browser UI MVP, not an Electron/Tauri package. It supports one FFmpeg job at a time and keeps the queue in memory. Preview support depends on the browser's native codecs; files whose codecs cannot play in the browser can still be converted. The output choices are H.264/AAC MP4 and libmp3lame MP3. There is no source deletion UI, persistent history, subtitle editing, batch folder import, remote media, cookies, or yt-dlp feature.

## License

The original Media Studio application code and design are MIT licensed. FFmpeg is not bundled; install and license it separately according to the FFmpeg project terms.
