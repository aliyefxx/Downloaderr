import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from downloader import (
    DOWNLOAD_DIR,
    cleanup_file,
    download_media,
    fetch_info,
    sanitize_filename,
)

app = FastAPI(
    title="Media Downloader API",
    description="YouTube, TikTok, Instagram və digər platformalardan media yükləmə API-si",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/app", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

class InfoRequest(BaseModel):
    url: str

class DownloadRequest(BaseModel):
    url: str
    format: str = "mp4"
    no_watermark: bool = True

def friendly_error(e) -> str:
    msg = str(e).lower()
    if "format" in msg and ("not available" in msg or "unsupported" in msg):
        return "Bu video formatı dəstəklənmir və ya mövcud deyil."
    if "video unavailable" in msg or "this video is unavailable" in msg or "does not exist" in msg:
        return "Bu video mövcud deyil və ya silinib."
    if "bot" in msg or "confirm you're not a bot" in msg:
        return "YouTube serveri bot kimi qəbul etdi (IP bloku)."
    if "members only" in msg or "requires a subscription" in msg:
        return "Bu video yalnız abunəçilər/üzvlər üçündür."
    if "private" in msg:
        return "Bu video gizlidir (şəxsidir) və yüklənə bilmir."
    if "login" in msg or "sign in" in msg:
        return "YouTube giriş və ya təhlükəsizlik təsdiqi tələb edir."
    if "copyright" in msg or "removed" in msg:
        return "Bu video müəllif hüquqları ilə qorunub və yüklənə bilmir."
    if "age" in msg:
        return "Bu video yaşa görə məhdudlaşdırılıb."
    if "429" in msg or "too many" in msg:
        return "Çox sorğu göndərildi. Bir neçə saniyə gözləyib yenidən cəhd edin."
    if "network" in msg or "connection" in msg or "timeout" in msg:
        return "İnternet bağlantısında problem var. Bir az sonra yenidən cəhd edin."
    return "Xəta baş verdi. Linki yoxlayıb yenidən cəhd edin."

def normalize_url(url: str) -> str:
    u = url.strip()
    if not u:
        return ""
    if not u.startswith("http://") and not u.startswith("https://"):
        return f"https://{u}"
    return u

@app.get("/api/health")
async def health_check():
    return {"status": "ok", "message": "Server işləyir ✓"}

@app.post("/api/info")
async def get_info(body: InfoRequest):
    url = normalize_url(body.url)
    if not url:
        raise HTTPException(status_code=400, detail="URL boş ola bilməz.")
    try:
        info = await fetch_info(url)
        return info
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=friendly_error(e))

@app.post("/api/download")
async def start_download(body: DownloadRequest):
    url = normalize_url(body.url)
    if not url:
        raise HTTPException(status_code=400, detail="URL boş ola bilməz.")

    if body.format not in ("mp4", "mp3"):
        raise HTTPException(status_code=400, detail="Format yalnız 'mp4' və ya 'mp3' ola bilər.")

    async def event_generator():
        try:
            async for event in download_media(
                url=url,
                format_type=body.format,
                no_watermark=body.no_watermark,
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event["status"] == "done":
                    asyncio.create_task(cleanup_file(event["filename"]))
                    break
                elif event["status"] == "error":
                    break
        except Exception as e:
            error_msg = friendly_error(e)
            yield f"data: {json.dumps({'status': 'error', 'message': error_msg}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

@app.get("/api/file/{filename}")
async def serve_file(filename: str, title: str | None = None):
    import re
    if not re.match(r"^[a-f0-9]+\.(mp4|mp3|webm|m4a)$", filename):
        raise HTTPException(status_code=400, detail="Yanlış fayl adı.")

    file_path = DOWNLOAD_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Fayl tapılmadı və ya artıq silinib.")

    ext = file_path.suffix.lower()
    if title:
        clean_name = sanitize_filename(title)
        if not clean_name.lower().endswith(ext):
            display_name = f"{clean_name}{ext}"
        else:
            display_name = clean_name
    else:
        display_name = filename

    media_type = "audio/mpeg" if ext == ".mp3" else "video/mp4"
    return FileResponse(
        path=file_path,
        media_type=media_type,
        filename=display_name,
    )

@app.get("/")
async def root():
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/app/index.html")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    host = os.environ.get("HOST", "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        reload=False if os.environ.get("PORT") else True,
        log_level="info",
    )
