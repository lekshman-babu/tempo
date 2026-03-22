import claudeCoach
import os
import json
import tempfile
import librosa
import numpy as np
import soundfile as sf
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse


app = FastAPI(title="Tempo Backend Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.websocket("/ws")
async def get_full_feedback(websocket: WebSocket):
    await websocket.accept()
    print("🟢 Client connected")
    try:
        while True:
            data = await websocket.receive_json()
            event_type = data.get('type')

            if event_type == 'coach_request':
                await websocket.send_text(json.dumps({
                    'type': 'coach_start',
                    'role': 'assistant',
                }))

                feedback = await claudeCoach.get_coach_response(json.dumps(data))

                await websocket.send_text(json.dumps({
                    'type': 'coach_chunk',
                    'role': 'assistant',
                    'delta': feedback,
                }))

                await websocket.send_text(json.dumps({
                    'type': 'coach_done',
                    'role': 'assistant',
                }))

    except WebSocketDisconnect:
        print("🔴 Client disconnected")

@app.get("/api/proxy-midi")
async def proxy_midi(url: str):
    """
    Acts as a middle-man. Fetches MIDI from a remote site 
    and sends it to the frontend from 'localhost' to bypass CORS.
    """
    try:
        print(f"🌐 Proxy Request: {url}")
        async with httpx.AsyncClient() as client:
            # We follow redirects (some sites use http -> https redirects)
            response = await client.get(url, follow_redirects=True, timeout=15.0)
            
            if response.status_code != 200:
                print(f"❌ Remote site error: {response.status_code}")
                raise HTTPException(status_code=response.status_code, detail="Remote MIDI not found")
            
            # Return raw binary data
            return Response(
                content=response.content,
                media_type="audio/midi",
                headers={
                    "Content-Disposition": "attachment; filename=track.mid",
                    "Access-Control-Allow-Origin": "*"
                }
            )
    except Exception as e:
        print(f"❌ Proxy Error: {str(e)}")
        raise HTTPException(500, f"Proxy failed: {str(e)}")

# ══════════════════════════════════════════════════════
# LOCAL RHYTHM GENERATION & MIXING
# ══════════════════════════════════════════════════════

@app.post("/api/generate-backing-track")
async def generate_backing_track(user_audio: UploadFile = File(...)):
    """
    Analyzes piano recording for BPM and adds a sharp click track.
    """
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_in:
        tmp_in.write(await user_audio.read())
        input_path = tmp_in.name

    try:
        print("🎵 Processing audio for rhythm analysis...")
        y, sr = librosa.load(input_path, sr=None)
        
        # Analyze BPM
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        detected_bpm = round(float(tempo[0]) if isinstance(tempo, (np.ndarray, list)) else float(tempo))
        print(f"⏱️ BPM: {detected_bpm}")

        # Fallback if no rhythmic pulses detected
        if len(beat_frames) == 0:
            print("⚠️ Forcing metronome fallback...")
            safe_bpm = detected_bpm if detected_bpm > 0 else 120
            beat_samples = np.arange(0, len(y), int(sr * 60 / safe_bpm))
            beat_frames = librosa.samples_to_frames(beat_samples)

        # Generate Click track (1000Hz = sharp beep)
        clicks = librosa.clicks(frames=beat_frames, sr=sr, length=len(y), click_freq=1000.0, click_duration=0.1)
        
        # Mix: Piano 50% / Click 100%
        mixed = (y * 0.5) + (clicks * 1.0)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_out:
            output_path = tmp_out.name
        
        sf.write(output_path, mixed, sr)
        print("✅ Mix complete.")
        return FileResponse(output_path, media_type="audio/wav")
        
    except Exception as e:
        print(f"❌ Mix Error: {e}")
        raise HTTPException(500, str(e))
    finally:
        if os.path.exists(input_path): os.remove(input_path)


if __name__ == '__main__':
    import uvicorn

    uvicorn.run(app, host='0.0.0.0', port=8000)
