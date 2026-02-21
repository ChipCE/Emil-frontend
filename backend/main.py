from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from collections import deque
from typing import Optional, List, Dict, Any
import httpx
import json
import os
import shutil
from fastapi.responses import StreamingResponse
from fastapi import File, UploadFile, Query
import uuid
import time

app = FastAPI()

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory stores
# In-memory stores
class ClientSession:
    def __init__(self):
        self.queue = deque()
        self.state = {
            "current_profile": None,
            "current_scene": None,
            "queue_size": 0,
            "is_looping": False,
            "last_report_ts": 0,
            "is_muted": False,
            "is_sync_enabled": True
        }
        self.last_seen = time.time()

sessions: Dict[str, ClientSession] = {}

def get_or_create_session(client_id: str) -> ClientSession:
    if client_id not in sessions:
        sessions[client_id] = ClientSession()
    sessions[client_id].last_seen = time.time()
    return sessions[client_id]

# Cleanup stale sessions (optional, can be called periodically)
def cleanup_sessions(timeout_seconds=300):
    now = time.time()
    to_remove = [cid for cid, sess in sessions.items() if now - sess.last_seen > timeout_seconds]
    for cid in to_remove:
        del sessions[cid]

# Ensure uploads directory exists
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Models
class Command(BaseModel):
    payload: Dict[str, Any] # Flexible payload
    interrupt: bool = False # If true, clear queue and stop current action

class StatusReport(BaseModel):
    client_id: str
    current_profile: Optional[str] = None
    current_scene: Optional[str] = None
    queue_size: int = 0
    is_looping: bool = False


# Endpoints

@app.get("/api/proxy")
async def proxy_audio(url: str):
    """Proxy remote audio files to bypass CORS."""
    async def stream_audio():
        async with httpx.AsyncClient() as client:
            try:
                async with client.stream("GET", url) as response:
                    if response.status_code != 200:
                        raise HTTPException(status_code=response.status_code, detail="Remote audio fetch failed")
                    async for chunk in response.aiter_bytes():
                        yield chunk
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

    media_type = "audio/mpeg"
    if url.lower().endswith(".wav"):
        media_type = "audio/wav"
    elif url.lower().endswith(".ogg"):
        media_type = "audio/ogg"

    return StreamingResponse(stream_audio(), media_type=media_type)

@app.get("/api/extrasProxy")
async def proxy_extras(url: str):
    """Proxy general GET requests to bypass CORS for extras."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(url)
            # Try to return JSON if it's JSON, otherwise return text
            try:
                return response.json()
            except ValueError:
                return {"_text": response.text, "_status": response.status_code}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/status")
async def get_status():
    # Return status of all active clients
    clients_data = {}
    for cid, sess in sessions.items():
        clients_data[cid] = {
            "queue_length": len(sess.queue),
            "model_state": sess.state,
            "last_seen_seconds_ago": int(time.time() - sess.last_seen)
        }
    return {
        "clients": clients_data,
        "active_session_count": len(sessions)
    }

class StatusUpdate(BaseModel):
    client_id: Optional[str] = None
    is_muted: Optional[bool] = None
    is_sync_enabled: Optional[bool] = None

@app.post("/api/status")
async def update_status(update: StatusUpdate):
    target_sessions = []
    if update.client_id:
        if update.client_id in sessions:
            target_sessions.append(sessions[update.client_id])
    else:
        target_sessions = list(sessions.values())
    
    for sess in target_sessions:
        if update.is_muted is not None:
            sess.state["is_muted"] = update.is_muted
        if update.is_sync_enabled is not None:
            sess.state["is_sync_enabled"] = update.is_sync_enabled
        
    return {
        "status": "updated",
        "targets": len(target_sessions)
    }

class CommandInput(BaseModel):
    profile: Optional[str] = None
    client_id: Optional[str] = None # Optional: if None, broadcast to all

@app.post("/api/applyProfile")
async def apply_profile(command_input: CommandInput):
    """Add a command to the queue."""
    
    # Construct internal command
    internal_command = Command(
        payload={
            "profile": command_input.profile
        },
        interrupt=False
    )
    
    target_sessions = []
    if command_input.client_id:
        # Target specific client
        if command_input.client_id in sessions:
            target_sessions.append(sessions[command_input.client_id])
    else:
        # Broadcast to all
        target_sessions = list(sessions.values())
    
    for sess in target_sessions:
        sess.queue.append(internal_command)
        
    return {"status": "queued", "targets": len(target_sessions)}

@app.get("/api/queue")
async def get_next_command(client_id: str = Query(..., description="Unique Client ID")):
    session = get_or_create_session(client_id)
    if session.queue:
        return session.queue.popleft()
    return None

@app.post("/api/upload")
async def upload_audio(file: UploadFile = File(...)):
    """Upload an audio file and return its URL."""
    file_path = os.path.join(UPLOAD_DIR, file.filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    
    return {
        "status": "uploaded",
        "filename": file.filename,
        "url": f"/api/uploads/{file.filename}"
    }

@app.post("/api/report")
async def report_status(report: StatusReport):
    session = get_or_create_session(report.client_id)
    session.state["current_profile"] = report.current_profile
    session.state["current_scene"] = report.current_scene
    session.state["queue_size"] = report.queue_size
    session.state["is_looping"] = report.is_looping
    return {"status": "ok"}

# --- Play API ---
# --- Play API ---
class PlayRequest(BaseModel):
    scene: str
    loop: Optional[bool] = False
    audio_url: Optional[str] = None
    msg: Optional[str] = None
    interrupt: Optional[bool] = True
    client_id: Optional[str] = None # Optional: if None, broadcast

@app.post("/api/playScene")
async def play_scene(request: PlayRequest):
    """Play a pre-defined scene."""
    
    # Determine targets
    target_sessions = []
    if request.client_id:
        if request.client_id in sessions:
            target_sessions.append(sessions[request.client_id])
    else:
        target_sessions = list(sessions.values())

    # Handle interrupt
    if request.interrupt:
        for sess in target_sessions:
            sess.queue.clear()

    # Validate scene exists
    settings_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "settings.json")
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read settings.json: {e}")

    scenes_rel = settings.get("scenes_path", "scenes.json")
    scenes_path = os.path.join(os.path.dirname(__file__), "..", "frontend", scenes_rel)

    try:
        with open(scenes_path, "r", encoding="utf-8") as f:
            scenes = json.load(f)
    except FileNotFoundError:
        scenes = {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read scenes.json: {e}")
        
    if request.scene not in scenes:
         raise HTTPException(status_code=404, detail=f"Scene '{request.scene}' not found")

    # Construct the command
    command = Command(
        payload={
            "scene": request.scene,
            "loop": request.loop,
            "audio_url": request.audio_url,
            "msg": request.msg
        },
        interrupt=request.interrupt # Pass the interrupt flag to the frontend
    )
    
    for sess in target_sessions:
        sess.queue.append(command)
        
    return {"status": "queued", "targets": len(target_sessions)}

class PlayScenesRequest(BaseModel):
    scenes: List[str]
    interrupt: Optional[bool] = False
    client_id: Optional[str] = None

@app.post("/api/playScenes")
async def play_scenes(request: PlayScenesRequest):
    """Queue multiple scenes."""

    # Determine targets
    target_sessions = []
    if request.client_id:
        if request.client_id in sessions:
            target_sessions.append(sessions[request.client_id])
    else:
        target_sessions = list(sessions.values())

    # Handle interrupt
    if request.interrupt:
        for sess in target_sessions:
            sess.queue.clear()
    
    # Load scenes (reusing logic from play_scene)
    settings_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "settings.json")
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read settings.json: {e}")

    scenes_rel = settings.get("scenes_path", "scenes.json")
    scenes_path = os.path.join(os.path.dirname(__file__), "..", "frontend", scenes_rel)

    try:
        with open(scenes_path, "r", encoding="utf-8") as f:
            available_scenes = json.load(f)
    except FileNotFoundError:
        available_scenes = {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read scenes.json: {e}")
        
    queued_scenes = []
    first_command = True
    
    for scene_name in request.scenes:
        if scene_name in available_scenes:
            # Check if this command should trigger an interrupt
            should_interrupt = False
            if first_command and request.interrupt:
                should_interrupt = True

            # Construct the command
            command = Command(
                payload={
                    "scene": scene_name,
                    "loop": False, # Explicitly false as per requirement
                    "audio_url": None,
                    "msg": None
                },
                interrupt=should_interrupt
            )
            
            for sess in target_sessions:
                sess.queue.append(command)
            
            queued_scenes.append(scene_name)
            first_command = False
            
    return {
        "status": "ok", 
        "queued": queued_scenes,
        "targets": len(target_sessions)
    }

# --- Save Profile ---
class ProfileSave(BaseModel):
    name: str
    scopes: List[str] = []
    parameters: Dict[str, Any] = {}

@app.get("/api/profiles")
async def list_profiles():
    """Return all profiles from profiles.json."""
    settings_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "settings.json")
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read settings.json: {e}")

    profiles_rel = settings.get("profiles_path", "profiles.json")
    profiles_path = os.path.join(os.path.dirname(__file__), "..", "frontend", profiles_rel)

    try:
        with open(profiles_path, "r", encoding="utf-8") as f:
            profiles = json.load(f)
    except FileNotFoundError:
        profiles = {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read profiles.json: {e}")

    return profiles

@app.post("/api/profiles")
async def save_profile(profile: ProfileSave):
    """Save or update a profile in profiles.json."""
    import re
    if re.search(r'[\s\u3000"\'`/\\<>|:*?]', profile.name):
        raise HTTPException(status_code=400, detail="Profile name contains invalid characters")
    # Read profiles_path from settings.json
    settings_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "settings.json")
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read settings.json: {e}")

    profiles_rel = settings.get("profiles_path", "profiles.json")
    profiles_path = os.path.join(os.path.dirname(__file__), "..", "frontend", profiles_rel)

    # Load existing profiles
    try:
        with open(profiles_path, "r", encoding="utf-8") as f:
            profiles = json.load(f)
    except FileNotFoundError:
        profiles = {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read profiles.json: {e}")

    # Upsert the profile
    profiles[profile.name] = {
        "scopes": profile.scopes,
        "parameters": profile.parameters
    }

    # Write back
    try:
        with open(profiles_path, "w", encoding="utf-8") as f:
            json.dump(profiles, f, indent=4, ensure_ascii=False)
            f.write("\n")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write profiles.json: {e}")

    return {"status": "ok", "name": profile.name}

@app.delete("/api/profiles")
async def delete_profile(name: str):
    """Delete a profile from profiles.json."""
    settings_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "settings.json")
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read settings.json: {e}")

    profiles_rel = settings.get("profiles_path", "profiles.json")
    profiles_path = os.path.join(os.path.dirname(__file__), "..", "frontend", profiles_rel)

    try:
        with open(profiles_path, "r", encoding="utf-8") as f:
            profiles = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read profiles.json: {e}")

    if name not in profiles:
        raise HTTPException(status_code=404, detail=f"Profile '{name}' not found")

    del profiles[name]

    try:
        with open(profiles_path, "w", encoding="utf-8") as f:
            json.dump(profiles, f, indent=4, ensure_ascii=False)
            f.write("\n")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write profiles.json: {e}")

    return {"status": "ok", "name": name}

# --- Save Scene ---
class SceneStep(BaseModel):
    profile: str
    duration: int

class SceneSave(BaseModel):
    name: str
    steps: List[SceneStep]

@app.post("/api/scenes")
async def save_scene(scene: SceneSave):
    """Save or update a scene in scenes.json."""
    import re
    if re.search(r'[\s\u3000"\'`/\\<>|:*?]', scene.name):
        raise HTTPException(status_code=400, detail="Scene name contains invalid characters")

    settings_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "settings.json")
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read settings.json: {e}")

    scenes_rel = settings.get("scenes_path", "scenes.json")
    scenes_path = os.path.join(os.path.dirname(__file__), "..", "frontend", scenes_rel)

    try:
        with open(scenes_path, "r", encoding="utf-8") as f:
            scenes_data = json.load(f)
    except FileNotFoundError:
        scenes_data = {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read scenes.json: {e}")

    scenes_data[scene.name] = [{"profile": s.profile, "duration": s.duration} for s in scene.steps]

    try:
        with open(scenes_path, "w", encoding="utf-8") as f:
            json.dump(scenes_data, f, indent=4, ensure_ascii=False)
            f.write("\n")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write scenes.json: {e}")

    return {"status": "ok", "name": scene.name}

# --- Delete Scene ---
@app.delete("/api/scenes")
async def delete_scene(name: str):
    """Delete a scene from scenes.json."""
    settings_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "settings.json")
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read settings.json: {e}")

    scenes_rel = settings.get("scenes_path", "scenes.json")
    scenes_path = os.path.join(os.path.dirname(__file__), "..", "frontend", scenes_rel)

    try:
        with open(scenes_path, "r", encoding="utf-8") as f:
            scenes = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read scenes.json: {e}")

    if name not in scenes:
        raise HTTPException(status_code=404, detail=f"Scene '{name}' not found")

    del scenes[name]

    try:
        with open(scenes_path, "w", encoding="utf-8") as f:
            json.dump(scenes, f, indent=4, ensure_ascii=False)
            f.write("\n")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write scenes.json: {e}")

    return {"status": "ok", "name": name}

@app.get("/api/scenes")
async def list_scenes():
    """Return all scenes from scenes.json."""
    settings_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "settings.json")
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read settings.json: {e}")

    scenes_rel = settings.get("scenes_path", "scenes.json")
    scenes_path = os.path.join(os.path.dirname(__file__), "..", "frontend", scenes_rel)

    try:
        with open(scenes_path, "r", encoding="utf-8") as f:
            scenes = json.load(f)
    except FileNotFoundError:
        scenes = {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read scenes.json: {e}")

    return scenes

# Serve Static Files
app.mount("/api/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
