// ============================================================
// app.js — Media Downloader Frontend Məntiqi
// ============================================================
// Arxitektura:
//  - State maşını (state machine) ilə UI vəziyyətləri
//  - SSE (Server-Sent Events) ilə real-time progress
//  - Platform avtomatik tanıma
//  - Dark/Light mode (localStorage)
//  - Dostyana Azərbaycan dilində mesajlar
// ============================================================

// ── Konfiqurasiya ────────────────────────────────────────────
const CONFIG = {
  API_BASE: (window.location.origin && window.location.origin.startsWith("http")) ? window.location.origin : "http://localhost:8000",   // Backend URL
  INFO_DEBOUNCE_MS: 600,               // URL yazılandan sonra gözlə
  TOAST_DURATION_MS: 4000,
};

// ── UI Vəziyyətləri (State Machine) ─────────────────────────
const State = {
  IDLE:        "idle",          // Başlanğıc
  DETECTING:   "detecting",    // Platform tanınır
  READY:       "ready",        // Yükləməyə hazır
  DOWNLOADING: "downloading",  // Yüklənir
  DONE:        "done",         // Tamamlandı
  ERROR:       "error",        // Xəta
};

let currentState = State.IDLE;
let currentPlatform = null;
let infoDebounceTimer = null;
let downloadEventSource = null; // SSE bağlantısı

// ── DOM Elementləri ──────────────────────────────────────────
const DOM = {
  // Giriş
  urlInput:          document.getElementById("url-input"),
  clearBtn:          document.getElementById("clear-btn"),

  // Platform
  platformBadge:     document.getElementById("platform-badge"),
  platformIcon:      document.getElementById("platform-icon"),
  platformName:      document.getElementById("platform-name"),

  // Media məlumatı
  mediaInfo:         document.getElementById("media-info"),
  thumbnailImg:      document.getElementById("thumbnail-img"),
  mediaTitle:        document.getElementById("media-title"),
  mediaUploader:     document.getElementById("media-uploader"),
  mediaDuration:     document.getElementById("media-duration"),
  mediaSize:         document.getElementById("media-size"),

  // Format seçimi
  formatSection:     document.getElementById("format-section"),
  formatMp4:         document.getElementById("format-mp4"),
  formatMp3:         document.getElementById("format-mp3"),
  watermarkSection:  document.getElementById("watermark-section"),
  watermarkToggle:   document.getElementById("watermark-toggle"),

  // Düymə
  downloadBtn:       document.getElementById("download-btn"),
  downloadBtnText:   document.getElementById("download-btn-text"),
  downloadBtnIcon:   document.getElementById("download-btn-icon"),

  // Progress
  progressSection:   document.getElementById("progress-section"),
  progressBar:       document.getElementById("progress-bar"),
  progressPercent:   document.getElementById("progress-percent"),
  progressSpeed:     document.getElementById("progress-speed"),
  progressEta:       document.getElementById("progress-eta"),
  progressSize:      document.getElementById("progress-size"),

  // Nəticə
  resultSection:     document.getElementById("result-section"),
  downloadLink:      document.getElementById("download-link"),
  resultFilename:    document.getElementById("result-filename"),
  resultFilesize:    document.getElementById("result-filesize"),
  resultFormat:      document.getElementById("result-format"),

  // Xəta
  errorSection:      document.getElementById("error-section"),
  errorMessage:      document.getElementById("error-message"),

  // Theme
  themeToggle:       document.getElementById("theme-toggle"),
  themeIcon:         document.getElementById("theme-icon"),

  // Toast
  toast:             document.getElementById("toast"),
  toastMessage:      document.getElementById("toast-message"),
};

// ── Platform Konfiqurasiyası ─────────────────────────────────
const PLATFORMS = {
  youtube: {
    name: "YouTube",
    color: "bg-red-500",
    textColor: "text-red-600 dark:text-red-400",
    emoji: "▶️",
    patterns: [/youtube\.com/, /youtu\.be/],
    supportsAudio: true,
    supportsWatermark: false,
  },
  tiktok: {
    name: "TikTok",
    color: "bg-black dark:bg-gray-800",
    textColor: "text-gray-800 dark:text-gray-200",
    emoji: "🎵",
    patterns: [/tiktok\.com/, /vm\.tiktok\.com/],
    supportsAudio: true,
    supportsWatermark: true,
  },
  instagram: {
    name: "Instagram",
    color: "bg-gradient-to-r from-purple-500 via-pink-500 to-orange-400",
    textColor: "text-pink-600 dark:text-pink-400",
    emoji: "📸",
    patterns: [/instagram\.com/],
    supportsAudio: true,
    supportsWatermark: true,
  },
  generic: {
    name: "Digər",
    color: "bg-indigo-500",
    textColor: "text-indigo-600 dark:text-indigo-400",
    emoji: "🌐",
    patterns: [],
    supportsAudio: false,
    supportsWatermark: false,
  },
};

// ── Yardımçı Funksiyalar ─────────────────────────────────────

/**
 * URL-dən platformu müəyyən edir.
 * @param {string} url
 * @returns {string} Platform açarı
 */
function detectPlatform(url) {
  const lower = url.toLowerCase();
  for (const [key, config] of Object.entries(PLATFORMS)) {
    if (key === "generic") continue;
    if (config.patterns.some(p => p.test(lower))) return key;
  }
  return "generic";
}

/**
 * URL-in əvvəlinə http/https yoxdursa avtomatik https:// əlavə edir.
 * @param {string} rawUrl
 * @returns {string}
 */
function normalizeUrl(rawUrl) {
  let url = (rawUrl || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  return url;
}

/**
 * Saniyəni "m:ss" formatına çevirir.
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Vəziyyəti dəyişdirir və UI-ı yeniləyir.
 * @param {string} newState
 */
function setState(newState) {
  currentState = newState;
  updateUI();
}

// ── UI Yeniləmə Funksiyası ───────────────────────────────────

function updateUI() {
  const isIdle        = currentState === State.IDLE;
  const isDetecting   = currentState === State.DETECTING;
  const isReady       = currentState === State.READY;
  const isDownloading = currentState === State.DOWNLOADING;
  const isDone        = currentState === State.DONE;
  const isError       = currentState === State.ERROR;

  // Format bölməsi
  setVisible(DOM.formatSection,    isReady || isDownloading);
  setVisible(DOM.mediaInfo,        isReady || isDownloading);
  setVisible(DOM.progressSection,  isDownloading);
  setVisible(DOM.resultSection,    isDone);
  setVisible(DOM.errorSection,     isError);

  // Düymə vəziyyəti
  DOM.downloadBtn.disabled = !isReady;

  if (isDetecting) {
    DOM.downloadBtnText.textContent = "Məlumat oxunur...";
    DOM.downloadBtnIcon.innerHTML = `<div class="spinner"></div>`;
    DOM.downloadBtn.disabled = true;
  } else if (isDownloading) {
    DOM.downloadBtnText.textContent = "Yüklənir...";
    DOM.downloadBtnIcon.innerHTML = `<div class="spinner"></div>`;
    DOM.downloadBtn.disabled = true;
  } else if (isDone) {
    DOM.downloadBtnText.textContent = "Yenidən yüklə";
    DOM.downloadBtnIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>`;
    DOM.downloadBtn.disabled = false;
  } else {
    DOM.downloadBtnText.textContent = "Yüklə";
    DOM.downloadBtnIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  }
}

/** Elementi göstər/gizlət */
function setVisible(el, visible) {
  if (!el) return;
  if (visible) {
    el.classList.remove("hidden");
    el.classList.add("flex");
  } else {
    el.classList.add("hidden");
    el.classList.remove("flex");
  }
}

// ── Platform Badge ───────────────────────────────────────────

function showPlatformBadge(platformKey) {
  const p = PLATFORMS[platformKey] || PLATFORMS.generic;
  DOM.platformBadge.classList.remove("hidden");
  DOM.platformBadge.classList.add("platform-badge");
  DOM.platformIcon.textContent = p.emoji;
  DOM.platformName.textContent = p.name;

  // Watermark seçimini göstər/gizlət
  if (p.supportsWatermark) {
    DOM.watermarkSection.classList.remove("hidden");
  } else {
    DOM.watermarkSection.classList.add("hidden");
  }

  // Sadəcə audio üçün MP3 seçimini göstər/gizlət
  if (!p.supportsAudio) {
    DOM.formatMp3.closest(".format-card").classList.add("opacity-50", "pointer-events-none");
    selectFormat("mp4");
  } else {
    DOM.formatMp3.closest(".format-card").classList.remove("opacity-50", "pointer-events-none");
  }
}

function hidePlatformBadge() {
  DOM.platformBadge.classList.add("hidden");
}

// ── Format Seçimi ────────────────────────────────────────────

let selectedFormat = "mp4";

function selectFormat(format) {
  selectedFormat = format;
  DOM.formatMp4.closest(".format-card").classList.toggle("selected", format === "mp4");
  DOM.formatMp3.closest(".format-card").classList.toggle("selected", format === "mp3");
}

// Klik event-ləri format kartlarına
document.querySelectorAll(".format-card").forEach(card => {
  card.addEventListener("click", () => {
    selectFormat(card.dataset.format);
  });
});

// ── URL Input Handler ────────────────────────────────────────

DOM.urlInput.addEventListener("input", () => {
  const raw = DOM.urlInput.value.trim();

  // Silmə düyməsini göstər
  DOM.clearBtn.classList.toggle("hidden", !raw);

  // Əvvəlki debounce-u ləğv et
  clearTimeout(infoDebounceTimer);

  if (!raw) {
    setState(State.IDLE);
    hidePlatformBadge();
    return;
  }

  const url = normalizeUrl(raw);

  // Platformu dərhal tanı (local)
  const platform = detectPlatform(url);
  currentPlatform = platform;
  showPlatformBadge(platform);

  // Debounce ilə server-dən info al
  setState(State.DETECTING);
  infoDebounceTimer = setTimeout(() => fetchMediaInfo(url), CONFIG.INFO_DEBOUNCE_MS);
});

DOM.urlInput.addEventListener("paste", () => {
  // Yapışdırmada dərhal cavab ver
  clearTimeout(infoDebounceTimer);
  setTimeout(() => {
    const raw = DOM.urlInput.value.trim();
    if (!raw) return;
    const url = normalizeUrl(raw);
    DOM.urlInput.value = url;
    const platform = detectPlatform(url);
    currentPlatform = platform;
    showPlatformBadge(platform);
    setState(State.DETECTING);
    fetchMediaInfo(url);
  }, 40);
});

// Enter düyməsi ilə dərhal axtar və ya yüklə
DOM.urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(infoDebounceTimer);
    const raw = DOM.urlInput.value.trim();
    if (!raw) return;
    const url = normalizeUrl(raw);
    DOM.urlInput.value = url;
    if (currentState === State.READY) {
      DOM.downloadBtn.click();
    } else {
      const platform = detectPlatform(url);
      currentPlatform = platform;
      showPlatformBadge(platform);
      setState(State.DETECTING);
      fetchMediaInfo(url);
    }
  }
});

// Silmə düyməsi
DOM.clearBtn.addEventListener("click", () => {
  DOM.urlInput.value = "";
  DOM.clearBtn.classList.add("hidden");
  setState(State.IDLE);
  hidePlatformBadge();
  currentPlatform = null;
  DOM.urlInput.focus();
});

// ── Server-dən Media Info Al ─────────────────────────────────

async function fetchMediaInfo(url) {
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json();
      showError(err.detail || "Link emal edilə bilmədi.");
      return;
    }

    const info = await res.json();

    // Thumbnail
    if (info.thumbnail) {
      DOM.thumbnailImg.src = info.thumbnail;
      DOM.thumbnailImg.classList.remove("hidden");
    } else {
      DOM.thumbnailImg.classList.add("hidden");
    }

    // Mətn məlumatı
    DOM.mediaTitle.textContent = info.title || "Başlıq bilinmir";
    DOM.mediaUploader.textContent = info.uploader || "";
    DOM.mediaDuration.textContent = formatDuration(info.duration);

    if (info.estimated_size && DOM.mediaSize) {
      DOM.mediaSize.textContent = `💾 ${info.estimated_size}`;
      DOM.mediaSize.classList.remove("hidden");
    } else if (DOM.mediaSize) {
      DOM.mediaSize.classList.add("hidden");
    }

    setState(State.READY);
  } catch (err) {
    // Şəbəkə xətası
    showError("Server ilə əlaqə qurmaq mümkün olmadı. Zəhmət olmasa bir az sonra yenidən cəhd edin.");
  }
}

// ── Yükləmə (SSE ilə) ────────────────────────────────────────

DOM.downloadBtn.addEventListener("click", async () => {
  if (currentState === State.DONE) {
    // "Yenidən yüklə" rejimi
    resetToReady();
    return;
  }

  const url = normalizeUrl(DOM.urlInput.value);
  if (!url) return;

  setState(State.DOWNLOADING);
  resetProgress();

  // SSE vasitəsilə yükləməni başlat
  try {
    const response = await fetch(`${CONFIG.API_BASE}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        format: selectedFormat,
        no_watermark: DOM.watermarkToggle.checked,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      showError(err.detail || "Yükləmə başlamadı.");
      return;
    }

    // ReadableStream ilə SSE oxu
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE mesajlarını parse et
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Natamam sətri gözlət

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));
            handleDownloadEvent(event);
          } catch {
            // Parse xətası — davam et
          }
        }
      }
    }
  } catch (err) {
    showError("Yükləmə zamanı xəta baş verdi. Zəhmət olmasa internet bağlantınızı yoxlayın.");
  }
});

function handleDownloadEvent(event) {
  if (event.status === "progress") {
    updateProgress(event.percent, event.speed, event.eta, event.phase, event.size_info);
  } else if (event.status === "done") {
    onDownloadDone(event);
  } else if (event.status === "error") {
    showError(event.message || "Gözlənilməz xəta baş verdi.");
  }
}

// ── Progress Bar ─────────────────────────────────────────────

function resetProgress() {
  DOM.progressBar.style.width = "0%";
  DOM.progressPercent.textContent = "0%";
  DOM.progressSpeed.textContent = "";
  DOM.progressEta.textContent = "";
  if (DOM.progressSize) DOM.progressSize.textContent = "";
}

function updateProgress(percent, speed, eta, phase, sizeInfo) {
  const p = Math.min(Math.max(percent || 0, 0), 100);
  DOM.progressBar.style.width = `${p}%`;
  DOM.progressBar.setAttribute("aria-valuenow", Math.round(p));
  DOM.progressPercent.textContent = `${p.toFixed(1)}%`;
  if (speed) DOM.progressSpeed.textContent = speed;
  if (eta)   DOM.progressEta.textContent = `Qalıb: ${eta}`;
  if (DOM.progressSize) {
    DOM.progressSize.textContent = sizeInfo ? `💾 ${sizeInfo}` : "";
  }
  const statusEl = document.getElementById("progress-status-text");
  if (statusEl && phase) {
    statusEl.textContent = phase === "Çevrilir"
      ? "🔄 Çevrilir, zəhmət olmasa gözləyin..."
      : "⏳ Yüklənir, zəhmət olmasa gözləyin...";
  }
}

// ── Yükləmə Tamamlandı ───────────────────────────────────────

function onDownloadDone(event) {
  updateProgress(100, "", "");
  const downloadUrl = event.download_url || "";
  const displayName = event.display_name || "media";
  const sizeFormatted = event.size_formatted || "";
  const formatName = event.format || (selectedFormat ? selectedFormat.toUpperCase() : "MP4");

  DOM.downloadLink.href = `${CONFIG.API_BASE}${downloadUrl}`;
  DOM.downloadLink.setAttribute("download", displayName);

  if (DOM.resultFilename) {
    DOM.resultFilename.textContent = displayName;
  }
  if (DOM.resultFilesize) {
    DOM.resultFilesize.textContent = sizeFormatted ? `💾 ${sizeFormatted}` : "";
    DOM.resultFilesize.style.display = sizeFormatted ? "inline-block" : "none";
  }
  if (DOM.resultFormat) {
    DOM.resultFormat.textContent = formatName;
  }

  setState(State.DONE);
  showToast(`✅ Yükləmə tamamlandı! (${sizeFormatted})`);

  // Avtomatik yükləməni başlat
  setTimeout(() => {
    DOM.downloadLink.click();
  }, 350);
}

// ── Xəta Göstərmə ────────────────────────────────────────────

function showError(message) {
  DOM.errorMessage.textContent = message;
  setState(State.ERROR);
}

function resetToReady() {
  setState(State.READY);
  setVisible(DOM.resultSection,   false);
  setVisible(DOM.errorSection,    false);
  setVisible(DOM.progressSection, false);
}

// ── Toast Bildirişi ──────────────────────────────────────────

let toastTimer = null;

function showToast(message, type = "success") {
  clearTimeout(toastTimer);
  DOM.toastMessage.textContent = message;
  DOM.toast.classList.remove("hidden", "hide");

  const colors = {
    success: "bg-green-600",
    error:   "bg-red-600",
    info:    "bg-indigo-600",
  };
  DOM.toast.className = DOM.toast.className
    .replace(/bg-\w+-\d+/g, "")
    .trim();
  DOM.toast.classList.add(colors[type] || colors.success);

  toastTimer = setTimeout(() => {
    DOM.toast.classList.add("hide");
    setTimeout(() => DOM.toast.classList.add("hidden"), 300);
  }, CONFIG.TOAST_DURATION_MS);
}

// ── Dark / Light Mode ────────────────────────────────────────

const SUN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const MOON_ICON = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>`;

function applyTheme(isDark) {
  document.documentElement.classList.toggle("dark", isDark);
  DOM.themeIcon.innerHTML = isDark ? SUN_ICON : MOON_ICON;
  localStorage.setItem("theme", isDark ? "dark" : "light");
}

DOM.themeToggle.addEventListener("click", () => {
  const isDark = !document.documentElement.classList.contains("dark");
  applyTheme(isDark);
});

// Başlangıcda mövzunu tətbiq et
(function initTheme() {
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved === "dark" || (!saved && prefersDark));
})();

// ── Klaviatura Qısayolları ───────────────────────────────────

document.addEventListener("keydown", (e) => {
  // Ctrl+V → inputa fokusla
  if ((e.ctrlKey || e.metaKey) && e.key === "v" && document.activeElement !== DOM.urlInput) {
    DOM.urlInput.focus();
  }
  // Enter → yüklə
  if (e.key === "Enter" && currentState === State.READY) {
    DOM.downloadBtn.click();
  }
  // Escape → sil
  if (e.key === "Escape" && DOM.urlInput.value) {
    DOM.clearBtn.click();
  }
});

// ── Başlanğıc seçimi: MP4 ────────────────────────────────────
selectFormat("mp4");

// ── Global-a export (HTML inline onclick üçün) ──────────────
window.setState = setState;
window.State    = State;
window.resetToReady = resetToReady;
