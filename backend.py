import os
import re
import uuid
import time
import tempfile
import asyncio
from typing import Dict, Optional
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import yt_dlp

app = FastAPI(title="Freemium Reel to MP3 API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

TEMP_DIR = tempfile.gettempdir()

# In-memory storage for user quotas and premium keys
# In production, replace with Redis or a persistent database.
VALID_LICENSE_KEYS = {"PRO2026", "AURA_VIP_99", "STUDIO_PASS"}

TIER_LIMITS = {
    "free": {
        "max_daily": 3,
        "allowed_bitrates": ["128", "192"],
    },
    "premium": {
        "max_daily": 50,
        "allowed_bitrates": ["128", "192", "256", "320"],
    }
}

# User state format: { token: { "tier": "free"|"premium", "count": int, "reset_time": timestamp } }
user_db: Dict[str, dict] = {}

class ExtractionRequest(BaseModel):
    url: str

class ConvertRequest(BaseModel):
    url: str
    bitrate: str = "192"
    token: str

class UpgradeRequest(BaseModel):
    token: str
    license_key: str

def get_or_create_user(token: str) -> dict:
    current_time = time.time()
    if token not in user_db:
        user_db[token] = {
            "tier": "free",
            "count": 0,
            "reset_time": current_time + 86400  # 24-hour cycle
        }
    else:
        user = user_db[token]
        # Reset quota if 24 hours have elapsed
        if current_time > user["reset_time"]:
            user["count"] = 0
            user["reset_time"] = current_time + 86400

    return user_db[token]

def cleanup_file(filepath: str):
    """Safely remove temporary MP3 files after download."""
    try:
        if os.path.exists(filepath):
            os.remove(filepath)
    except Exception as e:
        print(f"Error cleaning file {filepath}: {e}")

@app.get("/api/user/status")
async def get_user_status(token: str):
    """Returns user quota, tier, and remaining downloads."""
    user = get_or_create_user(token)
    tier_config = TIER_LIMITS[user["tier"]]
    remaining = max(0, tier_config["max_daily"] - user["count"])
    
    return {
        "tier": user["tier"],
        "used": user["count"],
        "max_daily": tier_config["max_daily"],
        "remaining": remaining,
        "allowed_bitrates": tier_config["allowed_bitrates"],
        "reset_in_seconds": int(max(0, user["reset_time"] - time.time()))
    }

@app.post("/api/user/upgrade")
async def upgrade_user(payload: UpgradeRequest):
    """Upgrades a user token to Premium if key matches."""
    if payload.license_key.strip().upper() not in VALID_LICENSE_KEYS:
        raise HTTPException(status_code=400, detail="Invalid license key. Try 'PRO2026'.")

    user = get_or_create_user(payload.token)
    user["tier"] = "premium"
    return {"success": True, "tier": "premium", "message": "Successfully upgraded to Pro Tier!"}

@app.post("/api/info")
async def get_video_info(payload: ExtractionRequest):
    """Fetches media metadata."""
    ydl_opts = {'quiet': True, 'no_warnings': True}
    try:
        loop = asyncio.get_event_loop()
        def fetch():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(payload.url, download=False)
        
        info = await loop.run_in_executor(None, fetch)
        return {
            "success": True,
            "title": info.get("title", "Audio Track"),
            "thumbnail": info.get("thumbnail") or (info.get("thumbnails", [{}])[-1].get("url", "") if info.get("thumbnails") else ""),
            "duration": info.get("duration", 0),
            "uploader": info.get("uploader", "Unknown Creator")
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch metadata: {str(e)}")

@app.post("/api/convert")
async def convert_to_mp3(payload: ConvertRequest, background_tasks: BackgroundTasks):
    """Validates limits, extracts audio at requested bitrate, and returns MP3."""
    user = get_or_create_user(payload.token)
    tier_config = TIER_LIMITS[user["tier"]]

    # 1. Enforce Bitrate Tier Restriction
    if payload.bitrate not in tier_config["allowed_bitrates"]:
        raise HTTPException(
            status_code=403, 
            detail=f"{payload.bitrate} kbps is reserved for Pro users. Please upgrade or choose 128k/192k."
        )

    # 2. Enforce Daily Quota Limit
    if user["count"] >= tier_config["max_daily"]:
        raise HTTPException(
            status_code=429,
            detail=f"Daily limit of {tier_config['max_daily']} downloads reached. Upgrade to Pro for 50 downloads/day."
        )

    file_id = str(uuid.uuid4())
    output_template = os.path.join(TEMP_DIR, f"{file_id}.%(ext)s")
    final_mp3_path = os.path.join(TEMP_DIR, f"{file_id}.mp3")

    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': output_template,
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': payload.bitrate,
        }],
        'quiet': True,
        'no_warnings': True,
    }

    try:
        loop = asyncio.get_event_loop()
        def extract():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(payload.url, download=True)

        info = await loop.run_in_executor(None, extract)
        raw_title = info.get("title", "reel_audio")
        safe_title = re.sub(r'[^a-zA-Z0-9_\- ]', '', raw_title)[:50].strip() or "audio"

        if not os.path.exists(final_mp3_path):
            raise HTTPException(status_code=500, detail="Conversion failed to produce MP3 file.")

        # Increment quota count
        user["count"] += 1

        background_tasks.add_task(cleanup_file, final_mp3_path)

        return FileResponse(
            path=final_mp3_path,
            filename=f"{safe_title}_{payload.bitrate}k.mp3",
            media_type="audio/mpeg",
            headers={"X-Quota-Remaining": str(tier_config["max_daily"] - user["count"])}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Conversion error: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
