import json
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from dotenv import load_dotenv

    env_path = Path(__file__).resolve().parent.parent / '.env'
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass

app = FastAPI(title='Tempo Server')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

SYSTEM_PROMPT = """You are Tempo Coach — an expert piano teacher and AI music tutor.
You are warm, encouraging, technically precise, and conversational.

Important scoring rules:
- friendly_score_percent is the player-facing score based only on played notes.
- technical_session_accuracy_percent is the harsher coaching score and may include skipped notes.
- Do not confuse or collapse these two scores.
- Base your coaching primarily on expected_notes, played_notes, errors, recurring_errors, and session context.
- Treat contradictions between friendly and technical scores as meaningful: note-to-note progress can be good while continuity or timing still needs work.

When you respond:
1. Mention one concrete thing that went well.
2. Mention one concrete issue to improve.
3. Suggest one next action.
Keep responses under 3 sentences unless asked for detail.
"""


class CrawlRequest(BaseModel):
    url: str
    goal: Optional[str] = None


def normalize_legacy_event(event: dict) -> dict:
    event_type = event.get('type')

    if event_type == 'realtime_chunk':
        recent_notes = event.get('recent_notes', [])
        context = event.get('context', {})
        return {
            'type': 'coach_request',
            'request_kind': 'attempt_feedback',
            'message': '',
            'coach_payload': {
                'exercise': {
                    'name': context.get('song', 'Unknown'),
                    'tempo_bpm': None,
                    'expected_notes': [
                        {
                            'position': index,
                            'note': note.get('expected'),
                            'time': None,
                            'duration': None,
                        }
                        for index, note in enumerate(recent_notes)
                    ],
                },
                'played_notes': [
                    {
                        'position': index,
                        'note': note.get('played'),
                        'time': None,
                        'velocity': note.get('velocity'),
                        'timing_delta_ms': note.get('timingDeltaMs'),
                    }
                    for index, note in enumerate(recent_notes)
                ],
                'errors': [],
                'attempt_context': {
                    'attempt_number': 0,
                    'attempt_played_note_count': len(recent_notes),
                    'attempt_error_count': event.get('error_count', 0),
                },
                'session_context': {},
            },
        }

    if event_type == 'session_complete':
        context = event.get('context', {})
        return {
            'type': 'coach_request',
            'request_kind': 'full_session',
            'message': event.get('message', ''),
            'coach_payload': {
                'exercise': {
                    'name': context.get('song', 'Unknown'),
                    'tempo_bpm': None,
                    'expected_notes': [],
                },
                'played_notes': [],
                'errors': [],
                'attempt_context': {
                    'attempt_number': 0,
                    'attempt_played_note_count': 0,
                    'attempt_error_count': 0,
                },
                'session_context': event.get('performance_summary', {}),
                'timeline': event.get('full_timeline', []),
            },
        }

    return event


def build_coach_request(event: dict) -> dict:
    normalized = normalize_legacy_event(event)
    payload = normalized.get('coach_payload') or {}
    context = normalized.get('context') or {}

    if isinstance(payload, dict):
        exercise = payload.setdefault('exercise', {})
        exercise.setdefault('name', context.get('song', 'Unknown'))
        payload.setdefault('mode', context.get('mode', 'guided'))

    return {
        'request_kind': normalized.get('request_kind', 'chat'),
        'user_message': normalized.get('message', ''),
        'coach_payload': payload,
    }


def build_llm_input(event: dict) -> str:
    request = build_coach_request(event)
    return json.dumps(request, ensure_ascii=False, indent=2)


async def stream_coach_response(websocket: WebSocket, llm_input: str):
    api_key = os.getenv('OPENAI_API_KEY', '')
    if not api_key:
        await websocket.send_text(json.dumps({
            'type': 'coach_message',
            'role': 'assistant',
            'content': 'Coach is offline. Add OPENAI_API_KEY to your environment to enable AI coaching.',
        }))
        return

    try:
        import httpx

        await websocket.send_text(json.dumps({
            'type': 'coach_start',
            'role': 'assistant',
        }))

        async with httpx.AsyncClient() as client:
            async with client.stream(
                'POST',
                'https://api.openai.com/v1/chat/completions',
                headers={
                    'Authorization': f'Bearer {api_key}',
                    'Content-Type': 'application/json',
                },
                json={
                    'model': 'gpt-4o-mini',
                    'max_tokens': 300,
                    'stream': True,
                    'messages': [
                        {'role': 'system', 'content': SYSTEM_PROMPT},
                        {'role': 'user', 'content': llm_input},
                    ],
                },
                timeout=30.0,
            ) as response:
                async for line in response.aiter_lines():
                    if not line.startswith('data: '):
                        continue

                    data = line[6:]
                    if data == '[DONE]':
                        break

                    try:
                        chunk = json.loads(data)
                        text = chunk['choices'][0]['delta'].get('content', '')
                    except (json.JSONDecodeError, KeyError, IndexError):
                        text = ''

                    if text:
                        await websocket.send_text(json.dumps({
                            'type': 'coach_chunk',
                            'role': 'assistant',
                            'delta': text,
                        }))

        await websocket.send_text(json.dumps({
            'type': 'coach_done',
            'role': 'assistant',
        }))
    except Exception as exc:
        await websocket.send_text(json.dumps({
            'type': 'coach_message',
            'role': 'assistant',
            'content': f'Coach error: {exc}',
        }))


@app.websocket('/ws')
async def midi_stream_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_notes = {}

    try:
        while True:
            data = await websocket.receive_text()
            event = json.loads(data)
            event_type = event.get('type')

            if event_type == 'note_on':
                note = event.get('note')
                timestamp = event.get('time')
                active_notes[note] = timestamp
                continue

            if event_type == 'note_off':
                note = event.get('note')
                timestamp = event.get('time')
                if note in active_notes and timestamp is not None:
                    start_time = active_notes.pop(note)
                    duration_ms = timestamp - start_time
                    await websocket.send_text(json.dumps({
                        'type': 'processed_note',
                        'note': note,
                        'duration_seconds': round(duration_ms / 1000, 3),
                    }))
                continue

            if event_type in {'coach_request', 'realtime_chunk', 'session_complete'}:
                await stream_coach_response(websocket, build_llm_input(event))
                continue

            if event_type == 'save_session':
                await websocket.send_text(json.dumps({
                    'type': 'session_saved',
                    'success': True,
                    'data': event.get('data', {}),
                }))
    except WebSocketDisconnect:
        return


@app.post('/api/crawl')
async def crawl_songs(req: CrawlRequest):
    api_key = os.getenv('TINYFISH_API_KEY', '')
    if not api_key:
        raise HTTPException(400, 'TINYFISH_API_KEY not set. Get one free at tinyfish.ai')

    goal = req.goal or (
        'Find all available MIDI files. For each, return JSON array: '
        '[{"title":"...","artist":"...","midi_url":"..."}]'
    )

    try:
        import httpx

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                'https://agent.tinyfish.ai/v1/automation/run-sse',
                headers={
                    'X-API-Key': api_key,
                    'Content-Type': 'application/json',
                },
                json={'url': req.url, 'goal': goal},
            )

            result = ''
            for line in response.text.split('\n'):
                if not line.startswith('data: '):
                    continue
                try:
                    parsed = json.loads(line[6:])
                except json.JSONDecodeError:
                    continue
                if parsed.get('type') == 'COMPLETE':
                    result = parsed.get('resultJson', parsed.get('result', ''))

            if result:
                return {'songs': json.loads(result), 'source': req.url}
            return {'songs': [], 'source': req.url, 'note': 'No results found'}
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc


@app.get('/api/health')
async def health():
    return {
        'status': 'ok',
        'openai': bool(os.getenv('OPENAI_API_KEY')),
        'tinyfish': bool(os.getenv('TINYFISH_API_KEY')),
    }


if __name__ == '__main__':
    import uvicorn

    uvicorn.run(app, host='0.0.0.0', port=8000)
