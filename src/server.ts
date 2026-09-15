import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rm, stat, readFile, rename } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_ROOT = join(APP_ROOT, "public");
const ASSET_ROOT = join(PUBLIC_ROOT, "assets");
const CACHE_ROOT = join(APP_ROOT, ".cache");
const SOURCE_ROOT = join(CACHE_ROOT, "sources");
const OUTPUT_ROOT = join(CACHE_ROOT, "outputs");
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const PORT = parsePort(process.env.MEDIA_STUDIO_PORT);
const HOST = "127.0.0.1";
const SESSION_KEY = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const allowedContentTypes = new Set([
  "application/octet-stream", "video/mp4", "video/webm", "video/quicktime", "video/x-matroska",
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/ogg", "audio/webm"
]);

export interface SourceRecord {
  id: string;
  originalName: string;
  mediaType: string;
  size: number;
  filePath: string;
  duration: number;
  format: string;
  video: { codec: string; width: number; height: number } | null;
  audio: { codec: string; channels: number; sampleRate: number } | null;
}

export type MediaOperation = "convert" | "mp3";

export interface MediaOperationRequest {
  sourceId: string;
  operation: MediaOperation;
  start: number;
  end: number | null;
}

export interface JobRecord {
  id: string;
  sourceId: string;
  operation: MediaOperation;
  start: number;
  end: number | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  outputPath: string | null;
  outputName: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  process?: ChildProcess;
  cancelRequested?: boolean;
}

const sources = new Map<string, SourceRecord>();
const jobs = new Map<string, JobRecord>();
const pendingJobs: Array<{ job: JobRecord; source: SourceRecord }> = [];
let activeJobs = 0;
let shuttingDown = false;

function parsePort(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) return 8837;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 8837;
}

export function isOpaqueId(value: string): boolean {
  return OPAQUE_ID.test(value);
}

export function isConfinedPath(candidate: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function validateOperation(value: unknown): MediaOperationRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.sourceId !== "string" || !isOpaqueId(input.sourceId)) return null;
  if (input.operation !== "convert" && input.operation !== "mp3") return null;
  const start = input.start === undefined ? 0 : input.start;
  const end = input.end === undefined || input.end === null || input.end === "" ? null : input.end;
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0) return null;
  if (end !== null && (typeof end !== "number" || !Number.isFinite(end) || end <= start)) return null;
  return { sourceId: input.sourceId, operation: input.operation, start, end };
}

export function buildFfmpegArgs(source: SourceRecord, operation: MediaOperationRequest, outputPath: string): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-protocol_whitelist", "file,pipe"];
  if (operation.start > 0) args.push("-ss", String(operation.start));
  args.push("-i", source.filePath);
  if (operation.end !== null) args.push("-t", String(operation.end - operation.start));
  if (operation.operation === "mp3") {
    args.push("-vn", "-map", "0:a:0", "-codec:a", "libmp3lame", "-q:a", "2");
  } else if (source.video) {
    args.push("-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2");
    if (source.audio) args.push("-c:a", "aac"); else args.push("-an");
    args.push("-movflags", "+faststart");
  } else {
    args.push("-vn", "-map", "0:a:0", "-c:a", "aac", "-movflags", "+faststart");
  }
  args.push(outputPath);
  return args;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function error(response: ServerResponse, status: number, message: string): void {
  json(response, status, { error: message });
}

function publicSource(source: SourceRecord): Omit<SourceRecord, "filePath"> {
  const { filePath: _, ...safe } = source;
  return safe;
}

function publicJob(job: JobRecord): Omit<JobRecord, "process" | "cancelRequested" | "outputPath"> & { downloadUrl: string | null } {
  const { process: _, cancelRequested: __, outputPath: ___, ...safe } = job;
  return { ...safe, downloadUrl: job.status === "done" ? `/download/${job.id}?key=${encodeURIComponent(SESSION_KEY)}` : null };
}

function requestHostIsValid(request: IncomingMessage): boolean {
  const value = header(request, "host");
  return value === `${HOST}:${PORT}` || value === `localhost:${PORT}`;
}

function writeOriginIsValid(request: IncomingMessage): boolean {
  const origin = header(request, "origin");
  return origin === undefined || origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
}

function apiKeyIsValid(request: IncomingMessage, queryKey?: string): boolean {
  return header(request, "x-media-studio-key") === SESSION_KEY || queryKey === SESSION_KEY;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 64 * 1024) throw new Error("Request JSON is too large");
  }
  return JSON.parse(text);
}

function safeOriginalName(value: string | undefined): string {
  let decoded = value ?? "media";
  try { decoded = decodeURIComponent(decoded); } catch { /* keep the safe raw header */ }
  const cleaned = decoded.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const name = basename(cleaned || "media");
  return name.length > 160 ? name.slice(-160) : name;
}

class LimitTransform extends Transform {
  private total = 0;
  private readonly limit: number;
  constructor(limit: number) { super(); this.limit = limit; }
  _transform(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.total += chunk.length;
    if (this.total > this.limit) callback(new Error("Upload exceeds the 500 MB limit"));
    else callback(null, chunk);
  }
  get bytes(): number { return this.total; }
}

function spawnVersion(binary: string): Promise<boolean> {
  return new Promise((resolveResult) => {
    const child = spawn(binary, ["-version"], { shell: false, stdio: "ignore" });
    child.once("error", () => resolveResult(false));
    child.once("close", (code) => resolveResult(code === 0));
  });
}

async function probeFile(filePath: string): Promise<{ duration: number; format: string; video: SourceRecord["video"]; audio: SourceRecord["audio"] }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_format", "-show_streams", filePath], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let diagnostics = "";
    let settled = false;
    let finishReject: (cause: Error) => void = () => undefined;
    const timer = setTimeout(() => { child.kill("SIGKILL"); finishReject(new Error("ffprobe timed out while inspecting the media file")); }, 20_000);
    finishReject = (cause: Error): void => { if (!settled) { settled = true; clearTimeout(timer); child.kill("SIGKILL"); reject(cause); } };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (settled) return; output += chunk; if (output.length > 1_048_576) finishReject(new Error("ffprobe returned too much metadata")); });
    child.stderr.on("data", (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-32_000); });
    child.once("error", (cause) => finishReject(new Error(`ffprobe unavailable: ${cause.message}`)));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) return finishReject(new Error(diagnostics.trim() || "ffprobe could not read this media file"));
      try {
        const parsed = JSON.parse(output) as { format?: { format_name?: string; duration?: string }; streams?: Array<Record<string, unknown>> };
        const streams = parsed.streams ?? [];
        const videoStream = streams.find((stream) => stream.codec_type === "video");
        const audioStream = streams.find((stream) => stream.codec_type === "audio");
        const duration = Number(parsed.format?.duration ?? videoStream?.duration ?? audioStream?.duration ?? 0);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("Media has no readable duration");
        settled = true;
        clearTimeout(timer);
        resolveResult({
          duration,
          format: parsed.format?.format_name ?? "unknown",
          video: videoStream ? { codec: String(videoStream.codec_name ?? "unknown"), width: Number(videoStream.width ?? 0), height: Number(videoStream.height ?? 0) } : null,
          audio: audioStream ? { codec: String(audioStream.codec_name ?? "unknown"), channels: Number(audioStream.channels ?? 0), sampleRate: Number(audioStream.sample_rate ?? 0) } : null
        });
      } catch (cause) { finishReject(new Error(cause instanceof Error ? cause.message : "Invalid ffprobe output")); }
    });
  });
}

function uniqueOutputPath(extension: string): string {
  return join(OUTPUT_ROOT, `${randomUUID()}${extension}`);
}

async function removeExact(filePath: string): Promise<void> {
  if (isConfinedPath(filePath, CACHE_ROOT)) await rm(filePath, { force: true });
}

async function runJob(job: JobRecord, source: SourceRecord): Promise<void> {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  const outputPath = uniqueOutputPath(job.operation === "mp3" ? ".mp3" : ".mp4");
  job.outputPath = outputPath;
  job.outputName = `${source.originalName.replace(/\.[^.]*$/, "") || "media"}${job.operation === "mp3" ? ".mp3" : ".mp4"}`;
  const args = buildFfmpegArgs(source, job, outputPath);
  await new Promise<void>((resolveJob) => {
    const child = spawn("ffmpeg", ["-progress", "pipe:1", ...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    job.process = child;
    let diagnostics = "";
    let progressBuffer = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      progressBuffer += chunk;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const [key, value] = line.split("=", 2);
        if (key === "out_time_ms") {
          const seconds = Number(value) / 1_000_000;
          const total = job.end === null ? source.duration - job.start : job.end - job.start;
          job.progress = Math.min(99, Math.max(0, Math.round((seconds / Math.max(0.1, total)) * 100)));
        } else if (key === "progress" && value === "end") job.progress = 100;
      }
    });
    child.stderr?.on("data", (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-64_000); });
    child.once("error", (cause) => {
      job.error = `ffmpeg unavailable: ${cause.message}`;
    });
    child.once("close", (code) => {
      delete job.process;
      if (job.cancelRequested) {
        job.status = "cancelled";
        job.error = null;
        void removeExact(outputPath);
      } else if (code === 0) {
        job.status = "done";
        job.progress = 100;
      } else {
        job.status = "failed";
        job.error = diagnostics.trim().split("\n").slice(-1)[0] || job.error || "ffmpeg failed to create the output";
        void removeExact(outputPath);
      }
      job.finishedAt = new Date().toISOString();
      resolveJob();
    });
  });
}

function drainJobs(): void {
  if (shuttingDown || activeJobs > 0) return;
  const next = pendingJobs.shift();
  if (!next) return;
  if (next.job.status === "cancelled") return drainJobs();
  activeJobs = 1;
  void runJob(next.job, next.source).catch((cause: unknown) => {
    next.job.status = "failed";
    next.job.error = cause instanceof Error ? cause.message : "Job failed";
    next.job.finishedAt = new Date().toISOString();
  }).finally(() => { activeJobs = 0; drainJobs(); });
}

function enqueueJob(job: JobRecord, source: SourceRecord): void {
  pendingJobs.push({ job, source });
  drainJobs();
}

function contentType(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  return extension === ".mp4" || extension === ".m4v" ? "video/mp4" : extension === ".webm" ? "video/webm" : extension === ".mp3" ? "audio/mpeg" : extension === ".wav" ? "audio/wav" : "application/octet-stream";
}

function rangeFor(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const suffix = !match[1] ? Number(match[2]) : 0;
  if (!match[1] && (!Number.isInteger(suffix) || suffix <= 0)) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - suffix);
  const end = match[2] && match[1] ? Number(match[2]) : size - 1;
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && start < size ? { start, end: Math.min(end, size - 1) } : null;
}

async function streamFile(request: IncomingMessage, response: ServerResponse, filePath: string, name: string, download = false): Promise<void> {
  const info = await stat(filePath);
  const requestedRange = header(request, "range");
  const range = rangeFor(requestedRange, info.size);
  if (requestedRange && !range) {
    response.writeHead(416, { "content-range": `bytes */${info.size}`, "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Requested byte range is not satisfiable" }));
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  response.writeHead(range ? 206 : 200, {
    "content-type": contentType(name),
    "content-length": end - start + 1,
    ...(range ? { "content-range": `bytes ${start}-${end}/${info.size}`, "accept-ranges": "bytes" } : { "accept-ranges": "bytes" }),
    "cache-control": "no-store",
    ...(download ? { "content-disposition": `attachment; filename="output${extname(name)}"; filename*=UTF-8''${encodeURIComponent(name)}` } : {}),
    "x-content-type-options": "nosniff"
  });
  await pipeline(createReadStream(filePath, { start, end }), response);
}

async function servePage(response: ServerResponse): Promise<void> {
  const template = await readFile(join(PUBLIC_ROOT, "index.html"), "utf8");
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'"
  });
  response.end(template.replace("__MEDIA_STUDIO_KEY__", SESSION_KEY));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!requestHostIsValid(request)) return error(response, 421, "Unrecognized Host header");
  const parsed = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (parsed.pathname === "/" && request.method === "GET") return servePage(response);
  if (parsed.pathname.startsWith("/assets/") && request.method === "GET") {
    const requested = resolve(ASSET_ROOT, `.${parsed.pathname.slice("/assets".length)}`);
    if (!isConfinedPath(requested, ASSET_ROOT)) return error(response, 404, "Not found");
    try {
      const file = await stat(requested);
      if (!file.isFile()) return error(response, 404, "Not found");
      response.writeHead(200, { "content-type": parsed.pathname.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'" });
      return void pipeline(createReadStream(requested), response);
    } catch { return error(response, 404, "Not found"); }
  }
  const key = parsed.searchParams.get("key") ?? undefined;
  if (parsed.pathname.startsWith("/api/") && !apiKeyIsValid(request)) return error(response, 403, "Missing or invalid session key");
  if (WRITE_METHODS.has(request.method ?? "") && !writeOriginIsValid(request)) return error(response, 403, "Origin is not allowed");
  if (parsed.pathname === "/api/status" && request.method === "GET") {
    const [ffmpeg, ffprobe] = await Promise.all([spawnVersion("ffmpeg"), spawnVersion("ffprobe")]);
    return json(response, 200, { ffmpeg, ffprobe, port: PORT, cacheNotice: "Sources and outputs remain in this app's local .cache directory until removed." });
  }
  if (parsed.pathname === "/api/sources" && request.method === "GET") return json(response, 200, { sources: [...sources.values()].map(publicSource) });
  if (parsed.pathname === "/api/sources" && request.method === "POST") {
    const type = ((header(request, "content-type") ?? "").split(";", 1)[0] ?? "").toLowerCase();
    const declaredLength = Number(header(request, "content-length") ?? 0);
    if (!allowedContentTypes.has(type)) return error(response, 415, "Choose a supported audio or video file");
    if (declaredLength > MAX_UPLOAD_BYTES) return error(response, 413, "Upload exceeds the 500 MB limit");
    const id = randomUUID();
    const tempPath = join(SOURCE_ROOT, `${id}.upload`);
    const outputPath = join(SOURCE_ROOT, `${id}.source`);
    const limiter = new LimitTransform(MAX_UPLOAD_BYTES);
    try {
      await pipeline(request, limiter, createWriteStream(tempPath, { flags: "wx" }));
      if (limiter.bytes === 0) throw new Error("The selected file is empty");
      const probed = await probeFile(tempPath);
      try { await access(outputPath); throw new Error("Source ID collision"); } catch (cause) { if (cause instanceof Error && cause.message === "Source ID collision") throw cause; }
      await rename(tempPath, outputPath);
      const source: SourceRecord = { id, originalName: safeOriginalName(header(request, "x-file-name")), mediaType: type, size: limiter.bytes, filePath: outputPath, ...probed };
      sources.set(id, source);
      return json(response, 201, { source: publicSource(source) });
    } catch (cause) {
      await removeExact(tempPath);
      await removeExact(outputPath);
      const message = cause instanceof Error ? cause.message : "Upload failed";
      return error(response, message.includes("ffprobe") ? 422 : message.includes("500 MB") ? 413 : 400, message);
    }
  }
  const sourceMatch = /^\/api\/sources\/([^/]+)$/.exec(parsed.pathname);
  const sourceId = sourceMatch?.[1];
  if (sourceMatch && sourceId && request.method === "GET" && isOpaqueId(sourceId)) {
    const source = sources.get(sourceId);
    return source ? json(response, 200, { source: publicSource(source) }) : error(response, 404, "Source not found");
  }
  if (parsed.pathname === "/api/jobs" && request.method === "GET") return json(response, 200, { jobs: [...jobs.values()].map(publicJob) });
  if (parsed.pathname === "/api/jobs" && request.method === "POST") {
    try {
      const type = ((header(request, "content-type") ?? "").split(";", 1)[0] ?? "").toLowerCase();
      if (type !== "application/json") return error(response, 415, "Jobs require application/json");
      const operation = validateOperation(await readJson(request));
      if (!operation) return error(response, 400, "Invalid operation or trim range");
      const source = sources.get(operation.sourceId);
      if (!source) return error(response, 404, "Source not found");
      if (operation.operation === "mp3" && !source.audio) return error(response, 422, "MP3 extraction needs an audio stream");
      if (operation.start >= source.duration) return error(response, 400, "Trim start is longer than the source");
      if (operation.end !== null && operation.end > source.duration) return error(response, 400, "Trim end is longer than the source");
      const unfinishedJobs = [...jobs.values()].filter((job) => job.status === "queued" || job.status === "running").length;
      if (unfinishedJobs >= 100) return error(response, 429, "Queue limit reached; cancel or finish existing jobs first");
      const job: JobRecord = { id: randomUUID(), sourceId: source.id, operation: operation.operation, start: operation.start, end: operation.end, status: "queued", progress: 0, outputPath: null, outputName: null, error: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null };
      jobs.set(job.id, job);
      enqueueJob(job, source);
      return json(response, 202, { job: publicJob(job) });
    } catch (cause) { return error(response, 400, cause instanceof Error ? cause.message : "Invalid JSON"); }
  }
  const cancelMatch = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(parsed.pathname);
  const cancelId = cancelMatch?.[1];
  if (cancelMatch && cancelId && request.method === "POST" && isOpaqueId(cancelId)) {
    const job = jobs.get(cancelId);
    if (!job) return error(response, 404, "Job not found");
    if (job.status === "queued") { job.status = "cancelled"; job.finishedAt = new Date().toISOString(); }
    else if (job.status === "running" && job.process) { job.cancelRequested = true; job.process.kill("SIGTERM"); }
    return json(response, 200, { job: publicJob(job) });
  }
  const mediaMatch = /^\/media\/([^/]+)$/.exec(parsed.pathname);
  const mediaId = mediaMatch?.[1];
  if (mediaMatch && mediaId && request.method === "GET" && isOpaqueId(mediaId) && apiKeyIsValid(request, key)) {
    const source = sources.get(mediaId);
    return source ? streamFile(request, response, source.filePath, source.originalName) : error(response, 404, "Source not found");
  }
  const downloadMatch = /^\/download\/([^/]+)$/.exec(parsed.pathname);
  const downloadId = downloadMatch?.[1];
  if (downloadMatch && downloadId && request.method === "GET" && isOpaqueId(downloadId) && apiKeyIsValid(request, key)) {
    const job = jobs.get(downloadId);
    if (!job || job.status !== "done" || !job.outputPath || !job.outputName) return error(response, 404, "Completed output not found");
    return streamFile(request, response, job.outputPath, job.outputName, true);
  }
  return error(response, 404, "Not found");
}

export async function startServer(): Promise<ReturnType<typeof createServer>> {
  await mkdir(SOURCE_ROOT, { recursive: true });
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const server = createServer((request, response) => {
    void handle(request, response).catch((cause: unknown) => {
      if (!response.headersSent) error(response, 500, "Unexpected server error");
      console.error("media-studio request error", cause instanceof Error ? cause.message : cause);
    });
  });
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(PORT, HOST, () => { server.removeListener("error", rejectListening); resolveListening(); });
  });
  console.log(`Media Studio listening at http://${HOST}:${PORT}`);
  const shutdown = (): void => {
    shuttingDown = true;
    for (const pending of pendingJobs) { pending.job.status = "cancelled"; pending.job.finishedAt = new Date().toISOString(); }
    pendingJobs.length = 0;
    for (const job of jobs.values()) if (job.process) { job.cancelRequested = true; job.process.kill("SIGTERM"); }
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.once("close", () => { process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void startServer();
