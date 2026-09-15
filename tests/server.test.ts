import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { buildFfmpegArgs, classifyCompatibility, isConfinedPath, isOpaqueId, parseFrameRate, startServer, validateOperation, validateTrimRange } from "../src/server.ts";

const TEST_PORT = Number(process.env.MEDIA_STUDIO_PORT ?? 8837);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

test("operation validation accepts safe trim ranges and rejects unsafe input", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(isOpaqueId(id), true);
  assert.equal(isOpaqueId("../../etc/passwd"), false);
  assert.deepEqual(validateOperation({ sourceId: id, operation: "convert", start: 0, end: 2 }), { sourceId: id, operation: "convert", start: 0, end: 2 });
  assert.equal(validateOperation({ sourceId: id, operation: "convert", start: -1, end: 2 }), null);
  assert.equal(validateOperation({ sourceId: id, operation: "convert", start: 3, end: 2 }), null);
  assert.equal(validateOperation({ sourceId: id, operation: "rm -rf", start: 0, end: null }), null);
});

test("frame rates and trim ranges are parsed safely", () => {
  assert.ok(Math.abs((parseFrameRate("30000/1001") ?? 0) - 29.97002997) < 0.000001);
  assert.equal(parseFrameRate("0/0"), null);
  assert.equal(parseFrameRate("broken"), null);
  assert.equal(parseFrameRate("0/25"), null);
  assert.equal(validateTrimRange(0, null, 4), true);
  assert.equal(validateTrimRange(-1, 2, 4), false);
  assert.equal(validateTrimRange(4, null, 4), false);
  assert.equal(validateTrimRange(3, 2, 4), false);
  assert.equal(validateTrimRange(0, 5, 4), false);
});

test("compatibility uses the container, video codec, and audio codec", () => {
  assert.equal(classifyCompatibility({ format: "mp4", video: { codec: "h264", width: 1, height: 1, fps: 30 }, audio: { codec: "aac", channels: 2, sampleRate: 48000 } }), "playable");
  assert.equal(classifyCompatibility({ format: "mp4", video: { codec: "hevc", width: 1, height: 1, fps: 30 }, audio: { codec: "aac", channels: 2, sampleRate: 48000 } }), "convert-recommended");
  assert.equal(classifyCompatibility({ format: "unknown", video: { codec: "h264", width: 1, height: 1, fps: 30 }, audio: { codec: "unknown", channels: 2, sampleRate: 48000 } }), "uncertain");
});

test("ffmpeg arguments are fixed, local-protocol-only, and do not overwrite", () => {
  const source = { id: "123e4567-e89b-12d3-a456-426614174000", originalName: "clip.mkv", mediaType: "video/x-matroska", size: 1, filePath: "C:\\cache\\clip.mkv", duration: 4, format: "matroska", video: { codec: "h264", width: 321, height: 241, fps: 30 }, audio: { codec: "aac", channels: 2, sampleRate: 48000 } };
  const args = buildFfmpegArgs(source, { sourceId: source.id, operation: "convert", start: 0.5, end: 2.5 }, "C:\\cache\\out.mp4");
  assert.ok(args.includes("-protocol_whitelist") && args.includes("file,pipe"));
  assert.ok(args.includes("-n"));
  assert.ok(args.includes("-pix_fmt") && args.includes("yuv420p"));
  assert.ok(args.includes("-vf") && args.some((arg) => arg.includes("trunc(iw/2)")));
  assert.equal(args.includes("-y"), false);
});

test("cache confinement permits nested cache files and rejects traversal", () => {
  const root = "C:\\studio\\.cache";
  assert.equal(isConfinedPath("C:\\studio\\.cache\\sources\\one.source", root), true);
  assert.equal(isConfinedPath("C:\\studio\\.cache\\..\\secret", root), false);
  assert.equal(isConfinedPath(root, root), false);
});

test("real local fixture is probed, converted, and downloadable", { timeout: 45_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "media-studio-"));
  const fixture = join(temp, "fixture.mp4");
  const audioFixture = join(temp, "audio.wav");
  const silentFixture = join(temp, "silent.mp4");
  const generated = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", fixture], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const generatedAudio = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1", audioFixture], { encoding: "utf8" });
  assert.equal(generatedAudio.status, 0, generatedAudio.stderr);
  const generatedSilent = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", silentFixture], { encoding: "utf8" });
  assert.equal(generatedSilent.status, 0, generatedSilent.stderr);
  const server = await startServer();
  try {
    const page = await fetch(`${BASE_URL}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const key = /name="session-key" content="([^"]+)"/.exec(html)?.[1];
    assert.ok(key);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal((await fetch(`${BASE_URL}/assets/styles.css`)).status, 200);
    assert.equal((await fetch(`${BASE_URL}/assets/enhancements.css`)).status, 200);
    assert.equal((await fetch(`${BASE_URL}/assets/app.js`)).status, 200);
    assert.equal((await fetch(`${BASE_URL}/api/status`)).status, 403);
    assert.equal((await fetch(`${BASE_URL}/api/sources`, { method: "POST", headers: { "x-media-studio-key": key, "origin": "http://attacker.invalid", "content-type": "video/mp4" }, body: "x" })).status, 403);
    assert.equal((await fetch(`${BASE_URL}/api/sources`, { method: "POST", headers: { "x-media-studio-key": key, "origin": BASE_URL, "content-type": "text/plain" }, body: "x" })).status, 415);
    const upload = await fetch(`${BASE_URL}/api/sources`, { method: "POST", headers: { "x-media-studio-key": key, "origin": BASE_URL, "content-type": "video/mp4", "x-file-name": encodeURIComponent("Türkçe clip.mp4") }, body: await readFile(fixture) });
    const uploadBody = await upload.json();
    assert.equal(upload.status, 201, JSON.stringify(uploadBody));
    const source = uploadBody.source;
    assert.equal(source.originalName, "Türkçe clip.mp4");
    assert.equal(source.video.fps, 15);
    assert.equal(source.compatibility, "playable");
    const suffixRange = await fetch(`${BASE_URL}/media/${source.id}?key=${key}`, { headers: { range: "bytes=-10" } });
    assert.equal(suffixRange.status, 206);
    assert.equal((await suffixRange.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(`${BASE_URL}/media/${source.id}?key=${key}`, { headers: { range: "bytes=999999999-" } })).status, 416);
    const created = await fetch(`${BASE_URL}/api/jobs`, { method: "POST", headers: { "x-media-studio-key": key, "origin": BASE_URL, "content-type": "application/json" }, body: JSON.stringify({ sourceId: source.id, operation: "convert", start: 0, end: 0.8 }) });
    const createdBody = await created.json() as { job: { id: string } };
    assert.equal(created.status, 202, JSON.stringify(createdBody));
    const jobId = createdBody.job.id;
    let job;
    for (let attempt = 0; attempt < 100; attempt++) { await new Promise((resolve) => setTimeout(resolve, 100)); const data = await (await fetch(`${BASE_URL}/api/jobs`, { headers: { "x-media-studio-key": key } })).json() as { jobs: Array<{ id: string; status: string; error: string | null; downloadUrl: string | null }> }; job = data.jobs.find((item) => item.id === jobId); if (job?.status === "done" || job?.status === "failed") break; }
    assert.equal(job?.status, "done", job?.error || "conversion did not finish");
    const downloadUrl = job?.downloadUrl;
    assert.equal(typeof downloadUrl, "string");
    const output = await fetch(`${BASE_URL}${downloadUrl as string}`);
    assert.equal(output.status, 200);
    assert.ok(Number(output.headers.get("content-length")) > 0);
    assert.match(output.headers.get("content-disposition") ?? "", /filename\*=UTF-8''/);
    assert.equal((await fetch(`${BASE_URL}/media/${source.id}?key=${key}`)).status, 200, "source must remain available after conversion");

    const audioUpload = await fetch(`${BASE_URL}/api/sources`, { method: "POST", headers: { "x-media-studio-key": key, "origin": BASE_URL, "content-type": "audio/wav", "x-file-name": "audio.wav" }, body: await readFile(audioFixture) });
    const audioBody = await audioUpload.json();
    assert.equal(audioUpload.status, 201, JSON.stringify(audioBody));
    const audioConvert = await fetch(`${BASE_URL}/api/jobs`, { method: "POST", headers: { "x-media-studio-key": key, "origin": BASE_URL, "content-type": "application/json" }, body: JSON.stringify({ sourceId: audioBody.source.id, operation: "convert", start: 0, end: null }) });
    assert.equal(audioConvert.status, 422);

    const silentUpload = await fetch(`${BASE_URL}/api/sources`, { method: "POST", headers: { "x-media-studio-key": key, "origin": BASE_URL, "content-type": "video/mp4", "x-file-name": "silent.mp4" }, body: await readFile(silentFixture) });
    const silentBody = await silentUpload.json();
    assert.equal(silentUpload.status, 201, JSON.stringify(silentBody));
    const silentMp3 = await fetch(`${BASE_URL}/api/jobs`, { method: "POST", headers: { "x-media-studio-key": key, "origin": BASE_URL, "content-type": "application/json" }, body: JSON.stringify({ sourceId: silentBody.source.id, operation: "mp3", start: 0, end: null }) });
    assert.equal(silentMp3.status, 422);
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(temp, { recursive: true, force: true }); }
});
