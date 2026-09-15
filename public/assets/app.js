// @ts-check

/** @typedef {"convert" | "mp3"} JobOperation */
/** @typedef {"queued" | "running" | "done" | "failed" | "cancelled"} JobStatus */
/** @typedef {{codec:string,width:number,height:number,fps:number|null}} VideoStream */
/** @typedef {{codec:string,channels:number,sampleRate:number}} AudioStream */
/** @typedef {"playable" | "uncertain" | "convert-recommended"} Compatibility */
/** @typedef {{id:string,originalName:string,mediaType:string,size:number,duration:number,format:string,video:VideoStream|null,audio:AudioStream|null,compatibility:Compatibility}} SourceView */
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
const previewError = byId("preview-error");
const convertPreview = /** @type {HTMLButtonElement} */ (byId("convert-preview"));
const trimStartError = byId("trim-start-error");
const trimEndError = byId("trim-end-error");
const trimSummary = byId("trim-summary");
const presetButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(".preset"));

const compatibilityText = {
  playable: "Tarayıcıda oynatılabilir",
  uncertain: "Önizleme desteği belirsiz",
  "convert-recommended": "Uyumlu MP4 önerilir"
};
const statusText = {
  queued: "Sırada",
  running: "İşleniyor",
  done: "İndirmeye hazır",
  failed: "İşlem başarısız",
  cancelled: "İptal edildi"
};

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
    sourceList.innerHTML = '<div class="empty-list">Eklediğiniz dosyalar<br><span>burada görünecek</span></div>';
    return;
  }
  sourceList.innerHTML = sources.map((source) => `
    <button type="button" class="source-card ${selected?.id === source.id ? "selected" : ""}" data-id="${source.id}">
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
  byId("meta-duration").textContent = duration(source.duration);
  byId("meta-format").textContent = source.format.split(",")[0] ?? "Bilinmiyor";
  byId("meta-resolution").textContent = source.video ? `${source.video.width} × ${source.video.height}` : "Yalnızca ses";
  byId("meta-fps").textContent = source.video?.fps ? String(Number(source.video.fps.toFixed(2))) : "—";
  byId("meta-video-codec").textContent = source.video?.codec ?? "—";
  byId("meta-audio-codec").textContent = source.audio?.codec ?? "—";
  byId("stage-empty").classList.add("hidden");
  previewError.classList.add("hidden");
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
  trimEnd.placeholder = source.duration.toFixed(1);
  renderSources();
  updateTrim();
}

/** @param {File} file */
function upload(file) {
  if (file.size > 500 * 1_048_576) {
    toast("Bu dosya 500 MB sınırını aşıyor.");
    return;
  }
  const box = byId("upload-progress");
  const progressBar = byId("upload-bar");
  box.classList.remove("hidden");
  byId("upload-name").textContent = `${file.name} yükleniyor`;
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
      if (request.status < 200 || request.status >= 300 || !data.source) throw new Error(data.error ?? "Dosya eklenemedi.");
      sources.unshift(data.source);
      renderSources();
      selectSource(data.source);
      toast("Dosya eklendi ve incelendi.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Dosya eklenemedi.");
    }
  };
  request.onerror = () => {
    box.classList.add("hidden");
    toast("Yerel medya sunucusuna ulaşılamadı.");
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

presetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    operation = button.dataset.operation === "mp3" ? "mp3" : "convert";
    updateTrim();
  });
});

function readTrim() {
  if (!selected) return { start: 0, end: null, effectiveEnd: 0, valid: false };
  const start = Number(trimStart.value || 0);
  const end = trimEnd.value === "" ? null : Number(trimEnd.value);
  const effectiveEnd = end ?? selected.duration;
  const startFinite = Number.isFinite(start);
  const endFinite = Number.isFinite(effectiveEnd);
  const startError = !startFinite || start < 0
    ? "Başlangıç 0 veya daha büyük olmalı."
    : start >= effectiveEnd
      ? "Başlangıç bitişten küçük olmalı."
      : start >= selected.duration
        ? "Başlangıç dosya süresini aşamaz."
        : "";
  const endError = !endFinite || effectiveEnd <= start
    ? "Bitiş başlangıçtan büyük olmalı."
    : effectiveEnd > selected.duration
      ? "Bitiş dosya süresini aşamaz."
      : "";
  trimStartError.textContent = startError;
  trimEndError.textContent = endError;
  trimStart.setAttribute("aria-invalid", String(Boolean(startError)));
  trimEnd.setAttribute("aria-invalid", String(Boolean(endError)));
  return { start, end, effectiveEnd, valid: !startError && !endError };
}

function updateControls(trim = readTrim()) {
  const hasVideo = Boolean(selected?.video);
  const hasAudio = Boolean(selected?.audio);
  if (operation === "convert" && !hasVideo && hasAudio) operation = "mp3";
  if (operation === "mp3" && !hasAudio && hasVideo) operation = "convert";
  presetButtons.forEach((button) => {
    const buttonOperation = button.dataset.operation === "mp3" ? "mp3" : "convert";
    button.disabled = buttonOperation === "convert" ? !hasVideo : !hasAudio;
    const active = buttonOperation === operation;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const operationAllowed = operation === "convert" ? hasVideo : hasAudio;
  createJobButton.disabled = !selected || !trim.valid || !operationAllowed;
  byId("control-hint").textContent = selected
    ? `${compatibilityText[selected.compatibility]}. ${operationAllowed ? "İşlem kuyruğa eklenebilir." : "Bu işlem dosyanın akışlarıyla uyumlu değil."}`
    : "Çıktı seçenekleri için bir dosya ekleyin.";
}

function updateTrim() {
  const trim = readTrim();
  const fill = byId("trim-fill");
  if (!selected) {
    fill.style.left = "0%";
    fill.style.width = "100%";
    trimSummary.textContent = "";
  } else {
    const left = Math.max(0, Math.min(100, (trim.start / selected.duration) * 100));
    const right = Math.max(left, Math.min(100, (trim.effectiveEnd / selected.duration) * 100));
    fill.style.left = `${left}%`;
    fill.style.width = `${right - left}%`;
    trimSummary.textContent = trim.valid ? `Seçilen bölüm: ${duration(trim.effectiveEnd - trim.start)}` : "Kırpma aralığını düzeltin.";
  }
  updateControls(trim);
}

trimStart.addEventListener("input", updateTrim);
trimEnd.addEventListener("input", updateTrim);
byId("reset-trim").addEventListener("click", () => { trimStart.value = "0"; trimEnd.value = ""; updateTrim(); });
createJobButton.addEventListener("click", async () => {
  if (!selected) return;
  const trim = readTrim();
  if (!trim.valid) return updateTrim();
  try {
    await api("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: selected.id, operation, start: trim.start, end: trim.end })
    });
    toast("İşlem kuyruğa eklendi.");
    await refreshJobs();
  } catch (error) {
    toast(error instanceof Error ? error.message : "İşlem başlatılamadı.");
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
    jobsView.innerHTML = '<div class="queue-empty"><span>☷</span><strong>Kuyruk boş</strong><small>Oluşturduğunuz çıktılar burada görünecek.</small></div>';
    return;
  }
  jobsView.innerHTML = items.slice().reverse().map((job) => {
    const source = sources.find((item) => item.id === job.sourceId);
    const name = job.outputName ?? `${source?.originalName ?? "Medya çıktısı"} · ${job.operation === "mp3" ? "MP3" : "MP4"}`;
    const action = job.status === "done" && job.downloadUrl
      ? `<a class="job-action" download href="${safe(job.downloadUrl)}">İndir ↓</a>`
      : job.status === "queued" || job.status === "running"
        ? `<button type="button" class="job-action cancel" data-cancel="${job.id}">İptal et</button>`
        : "";
    return `<div class="job-card"><span class="job-icon">${job.operation === "mp3" ? "♫" : "▣"}</span><span class="job-main"><strong>${safe(name)}</strong><small>${safe(source?.originalName ?? "Medya çıktısı")}${job.error ? ` · ${safe(job.error)}` : ""}</small><span class="job-progress"><i data-progress="${job.progress}"></i></span></span><span class="job-status ${job.status}">${job.status === "running" ? `${job.progress}% · işleniyor` : statusText[job.status]}</span>${action}</div>`;
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
        toast(error instanceof Error ? error.message : "İşlem iptal edilemedi.");
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
    if (status.lastElementChild) status.lastElementChild.textContent = ready ? "FFmpeg hazır" : "FFmpeg kurulumu gerekli";
    byId("footer-engine").textContent = ready ? "FFmpeg motoru · hazır" : "FFmpeg ve ffprobe bulunamadı · işlem için ikisini de kurun";
    if (!ready) toast("FFmpeg ve ffprobe kurulduktan sonra Media Studio'yu yeniden başlatın.");
  } catch {
    if (status.lastElementChild) status.lastElementChild.textContent = "Yerel sunucuya ulaşılamıyor";
  }
}

videoPlayer.addEventListener("error", () => {
  byId("preview-error-text").textContent = "Tarayıcınız bu dosyayı oynatamıyor. Uyumlu MP4 oluşturabilirsiniz.";
  convertPreview.classList.remove("hidden");
  previewError.classList.remove("hidden");
});
audioPlayer.addEventListener("error", () => {
  byId("preview-error-text").textContent = "Tarayıcınız bu ses codec'ini oynatamıyor.";
  convertPreview.classList.add("hidden");
  previewError.classList.remove("hidden");
});
convertPreview.addEventListener("click", () => {
  if (!selected?.video) return;
  operation = "convert";
  updateTrim();
  createJobButton.focus();
});

async function init() {
  try {
    const data = await api("/api/sources");
    sources = data.sources ?? [];
    renderSources();
    updateTrim();
  } catch {
    toast("Başlamak için yerel Media Studio sunucusunu çalıştırın.");
  }
  await refreshStatus();
  await refreshJobs();
  window.setInterval(() => { void refreshJobs(); }, 1000);
}

void init();
