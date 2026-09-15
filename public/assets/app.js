// @ts-check

/** @typedef {"convert" | "mp3"} JobOperation */
/** @typedef {"queued" | "running" | "done" | "failed" | "cancelled"} JobStatus */
/** @typedef {{codec:string,width:number,height:number}} VideoStream */
/** @typedef {{codec:string,channels:number,sampleRate:number}} AudioStream */
/** @typedef {{id:string,originalName:string,mediaType:string,size:number,duration:number,format:string,video:VideoStream|null,audio:AudioStream|null}} SourceView */
/** @typedef {{id:string,sourceId:string,operation:JobOperation,start:number,end:number|null,status:JobStatus,progress:number,outputName:string|null,error:string|null,downloadUrl:string|null}} JobView */
/** @typedef {{ffmpeg?:boolean,ffprobe?:boolean,sources?:SourceView[],jobs?:JobView[],source?:SourceView,job?:JobView,error?:string}} ApiResponse */

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required UI element is missing: ${id}`);
  return /** @type {T} */ (element);
}

const sessionKey = document.querySelector('meta[name="session-key"]')?.getAttribute("content") ?? "";
if (!sessionKey) throw new Error("Media Studio session key is missing");

const picker = /** @type {HTMLInputElement} */ (byId("file-picker"));
const dropZone = byId("drop-zone");
const sourceList = byId("source-list");
const jobsView = byId("job-list");
const videoPlayer = /** @type {HTMLVideoElement} */ (byId("video-player"));
const audioPlayer = /** @type {HTMLAudioElement} */ (byId("audio-player"));
const trimStart = /** @type {HTMLInputElement} */ (byId("trim-start"));
const trimEnd = /** @type {HTMLInputElement} */ (byId("trim-end"));
const createJobButton = /** @type {HTMLButtonElement} */ (byId("create-job"));

/** @type {SourceView[]} */
let sources = [];
/** @type {SourceView|null} */
let selected = null;
/** @type {JobOperation} */
let operation = "convert";

/** @param {string} message */
function toast(message) {
  const element = byId("toast");
  element.textContent = message;
  element.classList.remove("hidden");
  window.setTimeout(() => element.classList.add("hidden"), 4200);
}

/** @param {string} path @param {RequestInit} [options] @returns {Promise<ApiResponse>} */
async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("x-media-studio-key", sessionKey);
  const response = await fetch(path, { ...options, headers });
  const data = /** @type {ApiResponse} */ (await response.json().catch(() => ({})));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

/** @param {number} value */
function duration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** @param {number} value */
function bytes(value) {
  return value < 1_048_576
    ? `${Math.max(1, Math.round(value / 1024))} KB`
    : `${(value / 1_048_576).toFixed(1)} MB`;
}

/** @param {unknown} value */
function safe(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return String(value).replace(/[&<>"']/g, (character) => entities[/** @type {keyof typeof entities} */ (character)]);
}

function renderSources() {
  byId("source-count").textContent = String(sources.length);
  if (!sources.length) {
    sourceList.innerHTML = '<div class="empty-list">Your imported files<br><span>will appear here</span></div>';
    return;
  }
  sourceList.innerHTML = sources.map((source) => `
    <button class="source-card ${selected?.id === source.id ? "selected" : ""}" data-id="${source.id}">
      <span class="source-type">${source.video ? "▶" : "♫"}</span>
      <span class="source-info"><strong>${safe(source.originalName)}</strong><small>${duration(source.duration)} · ${bytes(source.size)}</small></span>
    </button>`).join("");
  /** @type {NodeListOf<HTMLButtonElement>} */ (sourceList.querySelectorAll(".source-card")).forEach((card) => {
    card.addEventListener("click", () => selectSource(sources.find((source) => source.id === card.dataset.id)));
  });
}

/** @param {SourceView|undefined} source */
function selectSource(source) {
  if (!source) return;
  const sourceChanged = selected?.id !== source.id;
  selected = source;
  if (sourceChanged) {
    trimStart.value = "0";
    trimEnd.value = "";
  }
  byId("preview-title").textContent = source.originalName;
  byId("preview-format").textContent = source.format.split(",")[0] ?? "unknown";
  byId("media-meta").innerHTML = `<span>${duration(source.duration)}</span><span>${source.video ? `${source.video.width} × ${source.video.height}` : "Audio only"}</span><span>${safe(source.video?.codec ?? source.audio?.codec ?? "Unknown codec")}</span>`;
  byId("stage-empty").classList.add("hidden");
  videoPlayer.pause();
  audioPlayer.pause();
  if (source.video) {
    audioPlayer.classList.add("hidden");
    videoPlayer.classList.remove("hidden");
    videoPlayer.src = `/media/${source.id}?key=${encodeURIComponent(sessionKey)}`;
    videoPlayer.load();
  } else {
    videoPlayer.classList.add("hidden");
    audioPlayer.classList.remove("hidden");
    audioPlayer.src = `/media/${source.id}?key=${encodeURIComponent(sessionKey)}`;
    audioPlayer.load();
  }
  createJobButton.disabled = false;
  const playable = source.video ? ["h264", "vp8", "vp9", "av1", "theora"].includes(source.video.codec) : true;
  byId("control-hint").textContent = operation === "mp3" && !source.audio
    ? "MP3 extraction needs an audio stream."
    : playable
      ? "Ready to add this output to the queue."
      : "This codec may not preview in your browser; conversion is still available.";
  trimEnd.placeholder = source.duration.toFixed(1);
  renderSources();
  updateTrim();
}

/** @param {File} file */
function upload(file) {
  if (file.size > 500 * 1_048_576) {
    toast("That file is larger than the 500 MB limit.");
    return;
  }
  const box = byId("upload-progress");
  const progressBar = byId("upload-bar");
  box.classList.remove("hidden");
  byId("upload-name").textContent = file.name;
  byId("upload-percent").textContent = "0%";
  progressBar.style.width = "0%";
  const request = new XMLHttpRequest();
  request.open("POST", "/api/sources");
  request.setRequestHeader("x-media-studio-key", sessionKey);
  request.setRequestHeader("x-file-name", encodeURIComponent(file.name));
  request.setRequestHeader("content-type", file.type || "application/octet-stream");
  request.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    byId("upload-percent").textContent = `${percent}%`;
    progressBar.style.width = `${percent}%`;
  };
  request.onload = () => {
    box.classList.add("hidden");
    try {
      const data = /** @type {ApiResponse} */ (JSON.parse(request.responseText));
      if (request.status < 200 || request.status >= 300 || !data.source) throw new Error(data.error ?? "Import failed.");
      sources.unshift(data.source);
      renderSources();
      selectSource(data.source);
      toast("Imported and inspected successfully.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Import failed.");
    }
  };
  request.onerror = () => {
    box.classList.add("hidden");
    toast("Could not reach the local media server.");
  };
  request.send(file);
}

picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  if (file) upload(file);
  picker.value = "";
});
dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  const file = event.dataTransfer?.files[0];
  if (file) upload(file);
});

/** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(".preset")).forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".preset").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    operation = button.dataset.operation === "mp3" ? "mp3" : "convert";
    if (selected) selectSource(selected);
  });
});

function updateTrim() {
  if (!selected) return;
  const start = Number(trimStart.value || 0);
  const end = Number(trimEnd.value || selected.duration);
  const left = Math.max(0, Math.min(100, (start / selected.duration) * 100));
  const right = Math.max(left, Math.min(100, (end / selected.duration) * 100));
  const fill = byId("trim-fill");
  fill.style.left = `${left}%`;
  fill.style.width = `${right - left}%`;
}

trimStart.addEventListener("input", updateTrim);
trimEnd.addEventListener("input", updateTrim);
byId("reset-trim").addEventListener("click", () => { trimStart.value = "0"; trimEnd.value = ""; updateTrim(); });
createJobButton.addEventListener("click", async () => {
  if (!selected) return;
  const endText = trimEnd.value;
  try {
    await api("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: selected.id, operation, start: Number(trimStart.value || 0), end: endText ? Number(endText) : null })
    });
    toast("Added to the job queue.");
    await refreshJobs();
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not create job.");
  }
});

async function refreshJobs() {
  try {
    const data = await api("/api/jobs");
    renderJobs(data.jobs ?? []);
  } catch (error) {
    console.warn(error);
  }
}

/** @param {JobView[]} items */
function renderJobs(items) {
  if (!items.length) {
    jobsView.innerHTML = '<div class="queue-empty"><span>☷</span><strong>Queue is clear</strong><small>Outputs you create will show up here.</small></div>';
    return;
  }
  jobsView.innerHTML = items.slice().reverse().map((job) => {
    const source = sources.find((item) => item.id === job.sourceId);
    const name = job.outputName ?? `${source?.originalName ?? "Media output"} · ${job.operation === "mp3" ? "MP3" : "MP4"}`;
    const action = job.status === "done" && job.downloadUrl
      ? `<a class="job-action" download href="${safe(job.downloadUrl)}">Download ↓</a>`
      : job.status === "queued" || job.status === "running"
        ? `<button class="job-action cancel" data-cancel="${job.id}">Cancel</button>`
        : "";
    return `<div class="job-card"><span class="job-icon">${job.operation === "mp3" ? "♫" : "▣"}</span><span class="job-main"><strong>${safe(name)}</strong><small>${safe(source?.originalName ?? "Media output")}${job.error ? ` · ${safe(job.error)}` : ""}</small><span class="job-progress"><i data-progress="${job.progress}"></i></span></span><span class="job-status ${job.status}">${job.status === "running" ? `${job.progress}% · processing` : job.status}</span>${action}</div>`;
  }).join("");
  /** @type {NodeListOf<HTMLElement>} */ (jobsView.querySelectorAll("[data-progress]")).forEach((bar) => {
    bar.style.width = `${bar.dataset.progress ?? 0}%`;
  });
  /** @type {NodeListOf<HTMLButtonElement>} */ (jobsView.querySelectorAll("[data-cancel]")).forEach((button) => {
    button.addEventListener("click", async () => {
      const jobId = button.dataset.cancel;
      if (!jobId) return;
      try {
        await api(`/api/jobs/${jobId}/cancel`, { method: "POST" });
        await refreshJobs();
      } catch (error) {
        toast(error instanceof Error ? error.message : "Could not cancel job.");
      }
    });
  });
}

async function refreshStatus() {
  const status = byId("engine-status");
  try {
    const data = await api("/api/status");
    const ready = data.ffmpeg === true && data.ffprobe === true;
    const dot = status.querySelector(".status-dot");
    if (dot) dot.classList.add(ready ? "ready" : "error");
    if (status.lastElementChild) status.lastElementChild.textContent = ready ? "FFmpeg ready" : "FFmpeg setup needed";
    byId("footer-engine").textContent = ready ? "FFmpeg engine · ready" : "FFmpeg / ffprobe not found — install both to process";
    if (!ready) toast("Install ffmpeg and ffprobe, then restart Media Studio.");
  } catch {
    if (status.lastElementChild) status.lastElementChild.textContent = "Server unavailable";
  }
}

videoPlayer.addEventListener("error", () => toast("This source cannot be previewed by the browser. MP4 conversion may make it playable."));
audioPlayer.addEventListener("error", () => toast("This audio codec cannot be previewed by the browser."));

async function init() {
  try {
    const data = await api("/api/sources");
    sources = data.sources ?? [];
    renderSources();
  } catch {
    toast("Start the local Media Studio server to begin.");
  }
  await refreshStatus();
  await refreshJobs();
  window.setInterval(() => { void refreshJobs(); }, 1000);
}

void init();
