import os
import re
import uuid
import shutil
import asyncio
from pathlib import Path
from typing import AsyncGenerator

import yt_dlp

DOWNLOAD_DIR = Path(__file__).parent / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)

PLATFORM_PATTERNS = {
    "youtube": [r"youtube\.com", r"youtu\.be"],
    "tiktok":  [r"tiktok\.com", r"vm\.tiktok\.com"],
    "instagram": [r"instagram\.com"],
}

def detect_platform(url: str) -> str:
    lower = url.lower()
    for platform, patterns in PLATFORM_PATTERNS.items():
        if any(re.search(p, lower) for p in patterns):
            return platform
    return "generic"

def get_youtube_id(url: str) -> str:
    patterns = [
        r'(?:v=|\/shorts\/|youtu\.be\/|\/embed\/)([0-9A-Za-z_-]{11})',
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None

def sanitize_filename(title: str, max_length: int = 100) -> str:
    clean = re.sub(r'[\\/*?:"<>|]', '', title)
    clean = re.sub(r'[\r\n\t]+', ' ', clean)
    clean = re.sub(r'\s+', ' ', clean).strip()
    if not clean:
        clean = "media"
    return clean[:max_length]

def get_uid() -> str:
    return uuid.uuid4().hex

FFMPEG_PATH = shutil.which("ffmpeg")
if not FFMPEG_PATH:
    try:
        import imageio_ffmpeg
        FFMPEG_PATH = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        FFMPEG_PATH = None

def get_cookie_file() -> str | None:
    cookie_env = os.environ.get("YOUTUBE_COOKIES")
    if cookie_env:
        env_cookie_path = Path(__file__).parent / "cookies.txt"
        try:
            if not env_cookie_path.exists() or env_cookie_path.read_text(encoding="utf-8") != cookie_env.strip():
                env_cookie_path.write_text(cookie_env.strip(), encoding="utf-8")
            return str(env_cookie_path.resolve())
        except Exception:
            pass

    candidates = [
        DOWNLOAD_DIR / "cookies.txt",
        Path(__file__).parent / "downloads" / "cookies.txt",
        Path(__file__).parent / "cookies.txt",
        Path(__file__).parent.parent / "cookies.txt",
        Path("backend/downloads/cookies.txt"),
        Path("downloads/cookies.txt"),
        Path("cookies.txt"),
    ]
    for cand in candidates:
        if cand.exists() and cand.stat().st_size > 0:
            return str(cand.resolve())
    return None

def build_ydl_opts(custom_opts: dict | None = None) -> dict:
    cookie_path = get_cookie_file()
    
    opts = {
        "quiet": True,
        "noplaylist": True,
        "nocheckcertificate": True,
        "ignoreerrors": False,
        "no_warnings": True,
        "socket_timeout": 30,
        "geo_bypass": True,
        "retries": 5,
        "fragment_retries": 5,
        "file_access_retries": 3,
        "http_headers": {
            "Accept-Language": "en-US,en;q=0.9",
        },
    }

    if cookie_path and os.path.exists(cookie_path):
        opts["cookiefile"] = cookie_path
        opts["extractor_args"] = {
            "youtube": {
                "player_client": ["web", "mweb", "android"]
            }
        }
    else:
        opts["extractor_args"] = {
            "youtube": {
                "player_client": ["android", "ios", "mweb"]
            }
        }

    if FFMPEG_PATH:
        opts["ffmpeg_location"] = FFMPEG_PATH

    if custom_opts:
        opts.update(custom_opts)

    return opts

async def fetch_info(url: str) -> dict:
    opts = build_ydl_opts({"skip_download": True})

    def _extract():
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)

    loop = asyncio.get_running_loop()
    try:
        info = await loop.run_in_executor(None, _extract)
    except yt_dlp.utils.DownloadError as e:
        raise ValueError(_friendly_ydl_error(str(e)))
    except Exception as e:
        raise ValueError(f"Xəta: {str(e)[:300]}")

    size_bytes = info.get("filesize") or info.get("filesize_approx")
    size_str = ""
    if size_bytes:
        mb = round(size_bytes / (1024 * 1024), 1)
        size_str = f"~{mb} MB" if mb >= 1.0 else f"~{round(size_bytes / 1024, 0)} KB"

    return {
        "title":          info.get("title", "Bilinməyən"),
        "thumbnail":      _best_thumbnail(info),
        "duration":       info.get("duration") or 0,
        "platform":       detect_platform(url),
        "uploader":       info.get("uploader") or info.get("channel") or "",
        "view_count":     info.get("view_count") or 0,
        "estimated_size": size_str,
    }

def _best_thumbnail(info: dict) -> str:
    thumb = info.get("thumbnail", "")
    if thumb:
        return thumb
    thumbs = info.get("thumbnails", [])
    if thumbs:
        best = max(thumbs, key=lambda t: t.get("preference", 0) or t.get("width", 0) or 0)
        return best.get("url", "")
    return ""

def _friendly_ydl_error(msg: str) -> str:
    low = msg.lower()
    if "ffmpeg" in low:
        return "Video/audio birləşdirmək üçün FFmpeg tələb olunur."
    if "format" in low and ("not available" in low or "unsupported" in low):
        return "Bu video formatı dəstəklənmir və ya mövcud deyil."
    if "video unavailable" in low or "this video is unavailable" in low or "does not exist" in low:
        return "Bu video mövcud deyil və ya silinib."
    if "bot" in low or "confirm you're not a bot" in low:
        return "YouTube server IP-sini bloklayıb (Bot yoxlaması)."
    if "members only" in low or "requires a subscription" in low:
        return "Bu video yalnız abunəçilər/üzvlər üçündür."
    if "private" in low:
        return "Bu video gizlidir (şəxsidir) və yüklənə bilmir."
    if "login" in low or "sign in" in low:
        return "YouTube giriş və ya təhlükəsizlik təsdiqi tələb edir."
    if "copyright" in low or "removed" in low:
        return "Bu video müəllif hüquqları səbəbiylə mövcud deyil."
    if "network" in low or "connection" in low or "timeout" in low or "unable to download" in low:
        return "İnternet bağlantısında problem var. Bir az sonra yenidən cəhd edin."
    if "age" in low or "18" in low:
        return "Bu video yaşa görə məhdudlaşdırılıb."
    return "Link emal edilə bilmədi və ya yükləmə xətası baş verdi. Yenidən cəhd edin."

async def download_media(
    url: str,
    format_type: str = "mp4",
    no_watermark: bool = True,
) -> AsyncGenerator[dict, None]:
    uid = get_uid()
    platform = detect_platform(url)
    
    yield {"status": "progress", "percent": 20, "speed": "", "eta": "", "phase": "Sorğu emal edilir...", "size_info": ""}
    await asyncio.sleep(0.3)

    local_filename = f"{uid}.{'mp3' if format_type == 'mp3' else 'mp4'}"
    local_path = DOWNLOAD_DIR / local_filename
    loop = asyncio.get_running_loop()

    success = False
    display_name = "media"

    if platform in ("tiktok", "instagram"):
        yield {"status": "progress", "percent": 50, "speed": "", "eta": "", "phase": "Media yüklənir...", "size_info": ""}
        
        outtmpl = str(DOWNLOAD_DIR / f"{uid}.%(ext)s")
        custom_opts = {
            "format": "b[ext=mp4]/best[ext=mp4]/best",
            "outtmpl": outtmpl,
        }
        if platform == "tiktok" and no_watermark:
            custom_opts["extractor_args"] = {
                "tiktok": {
                    "api_hostname": "api16-normal-c-useast1a.tiktokv.com"
                }
            }
        
        ydl_opts = build_ydl_opts(custom_opts)
        
        def _run_ytdlp():
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=True)
                    return info.get("title")
            except Exception:
                return None

        title = await loop.run_in_executor(None, _run_ytdlp)
        if title:
            found = _find_output_file(uid)
            if found and found.exists():
                success = True
                display_name = f"{sanitize_filename(title)}{found.suffix}"
                local_filename = found.name
                local_path = found

    if not success:
        yield {"status": "progress", "percent": 50, "speed": "", "eta": "", "phase": "Media faylı endirilir...", "size_info": ""}
        
        outtmpl = str(DOWNLOAD_DIR / f"{uid}.%(ext)s")
        if format_type == "mp3":
            fmt = "bestaudio/best"
            postprocessors = [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}]
        else:
            fmt = (
                "b[ext=mp4]/best[ext=mp4]/"
                "bestvideo[ext=mp4]+bestaudio[ext=m4a]/"
                "best"
            )
            postprocessors = []

        custom_opts = {
            "format": fmt,
            "outtmpl": outtmpl,
        }
        if postprocessors:
            custom_opts["postprocessors"] = postprocessors

        ydl_opts = build_ydl_opts(custom_opts)

        def _run_fallback():
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=True)
                    return info.get("title")
            except Exception:
                return None

        title = await loop.run_in_executor(None, _run_fallback)
        if title:
            found = _find_output_file(uid)
            if found and found.exists():
                success = True
                display_name = f"{sanitize_filename(title)}{found.suffix}"
                local_filename = found.name
                local_path = found

    if not success or not local_path.exists():
        yield {
            "status": "error", 
            "message": "YouTube server IP ünvanını bloklayıb. Zəhmət olmasa yenilənmiş cookies.txt əlavə edin."
        }
        return

    file_size_bytes = local_path.stat().st_size
    size_mb = round(file_size_bytes / (1024 * 1024), 2)
    size_formatted = f"{size_mb} MB" if size_mb >= 1.0 else f"{round(file_size_bytes / 1024, 1)} KB"

    from urllib.parse import quote
    yield {
        "status": "done",
        "filename": local_filename,
        "display_name": display_name,
        "size_formatted": size_formatted,
        "size_bytes": file_size_bytes,
        "format": format_type.upper(),
        "download_url": f"/api/file/{local_filename}?title={quote(display_name)}",
        "percent": 100,
    }

def _find_output_file(uid: str) -> Path | None:
    for f in DOWNLOAD_DIR.iterdir():
        if f.stem == uid and f.is_file():
            return f
    return None

async def cleanup_file(filename: str, delay: int = 300):
    if "cookies.txt" in filename.lower():
        return
    await asyncio.sleep(delay)
    target = DOWNLOAD_DIR / filename
    if target.exists():
        try:
            target.unlink()
        except OSError:
            pass
