import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as Tone from 'tone';
import { Midi } from '@tonejs/midi';
import { useMidi } from './hooks/useMidi';
import { startAudioContext, playNote, stopNote } from './lib/AudioEngine';
import { PianoKeyboard } from './components/PianoKeyboard';
import { MidiLoader } from './components/MidiLoader';
import { Waterfall } from './components/Waterfall';
import { Header } from './components/Header';
import { CoachChat } from './components/CoachChat';
import { ScoreDisplay } from './components/ScoreDisplay';
import { SkillGraph } from './components/SkillGraph';
import { ModeSelector } from './components/ModeSelector';
import { useStore } from './lib/store';
import { isInsForgeConfigured } from './lib/insforgeClient';
import {
  MATCHER_CONFIG,
  buildExpectedSequenceFromSong,
  createMatcherState,
  detectSkippedNotes,
  evaluatePlayedNote,
  shouldCompleteAttempt,
  finalizeAttempt,
} from './lib/patternMatcher';
import { convertWebmToWav } from './lib/wavEncoder';
import './App.css';

const KEYBOARD_MAP = {
  a: 'C3', w: 'C#3', s: 'D3', e: 'D#3', d: 'E3', f: 'F3',
  t: 'F#3', g: 'G3', y: 'G#3', h: 'A3', u: 'A#3', j: 'B3',
  k: 'C4', o: 'C#4', l: 'D4', p: 'D#4', ';': 'E4', "'": 'F4',
  ']': 'F#4', '\\': 'G4',
};

const PIANO_KEYS_SET = new Set(Object.keys(KEYBOARD_MAP));

const normalizeMidiData = (parsedMidi) => {
  const flatToSharp = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

  parsedMidi.tracks.forEach((track) => {
    track.notes.forEach((note) => {
      const match = note.name.match(/^([A-G](?:#|b)?)(-?\d+)$/);
      if (!match) return;
      const [, baseNote, octave] = match;
      if (flatToSharp[baseNote]) note.name = `${flatToSharp[baseNote]}${octave}`;
    });
  });

  return parsedMidi;
};

function App() {
  const [localNotes, setLocalNotes] = useState({});
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [songLibrary, setSongLibrary] = useState([]);
  const [externalLibrary, setExternalLibrary] = useState([]);
  const [currentSongIndex, setCurrentSongIndex] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [isWaitMode, setIsWaitMode] = useState(false);
  const [expectedNotes, setExpectedNotes] = useState([]);
  const [matcherState, setMatcherState] = useState(createMatcherState());
  const [noteFeedback, setNoteFeedback] = useState({});
  const [lastAttemptSummary, setLastAttemptSummary] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isGeneratingDrums, setIsGeneratingDrums] = useState(false);
  const [mixedTrackUrl, setMixedTrackUrl] = useState(null);
  const [isLoadingSong, setIsLoadingSong] = useState(false);

  const mode = useStore((s) => s.mode);
  const addCoachMessage = useStore((s) => s.addCoachMessage);
  const replaceLastCoachMessage = useStore((s) => s.replaceLastCoachMessage);
  const setCoachThinking = useStore((s) => s.setCoachThinking);
  const updateSkill = useStore((s) => s.updateSkill);
  const skills = useStore((s) => s.skills);

  const scrollWrapperRef = useRef(null);
  const lastAttemptActivityAtRef = useRef(0);
  const attemptTimerRef = useRef(null);
  const playbackTimeRef = useRef(0);
  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const activeKeysRef = useRef({});
  const matcherStateRef = useRef(createMatcherState());
  const coachStreamBufferRef = useRef('');
  const coachStreamActiveRef = useRef(false);

  const targetSong = currentSongIndex !== null ? songLibrary[currentSongIndex]?.midi ?? null : null;
  const currentSongName = currentSongIndex !== null ? songLibrary[currentSongIndex]?.name ?? null : null;

  useEffect(() => {
    fetch('/songs.json')
      .then((res) => res.json())
      .then((data) => setExternalLibrary(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Could not load songs.json from public folder:', err));
  }, []);

  useEffect(() => {
    return () => {
      if (mixedTrackUrl) URL.revokeObjectURL(mixedTrackUrl);
    };
  }, [mixedTrackUrl]);

  const resetMatcher = () => {
    const freshState = createMatcherState();
    matcherStateRef.current = freshState;
    setMatcherState(freshState);
    setLastAttemptSummary(null);
    setNoteFeedback({});
    lastAttemptActivityAtRef.current = 0;
    playbackTimeRef.current = 0;

    if (attemptTimerRef.current) {
      clearTimeout(attemptTimerRef.current);
      attemptTimerRef.current = null;
    }
  };

  const initAudio = async () => {
    if (!audioEnabled) {
      await startAudioContext();
      setAudioEnabled(true);
    }
  };

  const clearFeedbackAfterDelay = (note) => {
    window.setTimeout(() => {
      setNoteFeedback((prev) => {
        const next = { ...prev };
        delete next[note];
        return next;
      });
    }, 350);
  };

  const completeAttemptIfNeeded = (stateToCheck, force = false) => {
    const now = performance.now();
    if (!force && !shouldCompleteAttempt(stateToCheck, lastAttemptActivityAtRef.current, now)) {
      return stateToCheck;
    }

    const { state: nextState, attemptSummary } = finalizeAttempt(stateToCheck, {
      name: currentSongName || 'Unknown',
    });

    if (!attemptSummary) return nextState;

    setLastAttemptSummary(attemptSummary);

    if ((attemptSummary.session_context?.friendly_score_percent || 0) >= 80) {
      const quarterSkill = skills.find((item) => item.id === 'quarter');
      updateSkill('quarter', Math.min(1, (quarterSkill?.mastery || 0) + 0.05));
    }

    return nextState;
  };

  const scheduleAttemptCompletion = () => {
    if (attemptTimerRef.current) clearTimeout(attemptTimerRef.current);

    attemptTimerRef.current = window.setTimeout(() => {
      const latestState = matcherStateRef.current;
      const completedState = completeAttemptIfNeeded(latestState, false);
      matcherStateRef.current = completedState;
      setMatcherState(completedState);
    }, MATCHER_CONFIG.ATTEMPT_PAUSE_MS + 25);
  };

  const pushFeedback = (playedNote, expectedNote, feedbackType) => {
    setNoteFeedback((prev) => ({
      ...prev,
      [playedNote]: {
        type: feedbackType,
        label: expectedNote ? `${feedbackType.toUpperCase()} — expected ${expectedNote}` : `Played ${playedNote}`,
      },
    }));
    clearFeedbackAfterDelay(playedNote);
  };

  const handleMatchedNote = (note, velocity = 80, source = 'virtual') => {
    if (!expectedNotes.length) return;
    if (isWaitMode && !isPlaying) return;

    const playedTimeSeconds = playbackTimeRef.current || 0;

    const { state: afterSkips, skippedEvents } = detectSkippedNotes({
      state: matcherStateRef.current,
      expectedNotes,
      playbackTimeSeconds: playedTimeSeconds,
    });

    const expectedNote = expectedNotes[afterSkips.expectedIndex] || null;
    const { state: afterEvaluation, result } = evaluatePlayedNote({
      state: afterSkips,
      expectedNote,
      playedNote: note,
      playedTimeSeconds,
      velocity,
      source,
    });

    let nextState = afterEvaluation;

    pushFeedback(note, result.expected, result.feedbackType);

    const activityNow = performance.now();
    if (skippedEvents.length > 0) {
      lastAttemptActivityAtRef.current = activityNow;
    }
    lastAttemptActivityAtRef.current = activityNow;

    if (shouldCompleteAttempt(nextState, lastAttemptActivityAtRef.current, activityNow)) {
      nextState = completeAttemptIfNeeded(nextState, true);
      if (attemptTimerRef.current) {
        clearTimeout(attemptTimerRef.current);
        attemptTimerRef.current = null;
      }
    } else {
      scheduleAttemptCompletion();
    }

    if (nextState.expectedIndex >= expectedNotes.length) {
      nextState = completeAttemptIfNeeded(nextState, true);
    }

    matcherStateRef.current = nextState;
    setMatcherState(nextState);
  };

  const handleExternalSongSelect = async (url) => {
    if (!url) return;
    setIsLoadingSong(true);

    try {
      let midi;
      const proxyUrl = `http://localhost:8000/api/proxy-midi?url=${encodeURIComponent(url)}`;

      try {
        midi = await Midi.fromUrl(proxyUrl);
      } catch (proxyError) {
        console.warn('Proxy MIDI fetch failed, trying direct URL:', proxyError);
        midi = await Midi.fromUrl(url);
      }

      const cleanedMidi = normalizeMidiData(midi);
      const songTitle = externalLibrary.find((song) => song.url === url)?.title || 'Remote Song';
      const newSong = { name: songTitle, midi: cleanedMidi, id: url };

      setSongLibrary((prev) => [newSong, ...prev]);
      setCurrentSongIndex(0);
      setIsPlaying(false);
      resetMatcher();
    } catch (err) {
      console.error('Error loading remote MIDI:', err);
      alert('Could not retrieve the MIDI file. If the proxy route is not available, direct loading may be blocked by CORS.');
    } finally {
      setIsLoadingSong(false);
    }
  };

  const generateDrums = async (audioBlob) => {
    setIsGeneratingDrums(true);

    try {
      if (mixedTrackUrl) {
        URL.revokeObjectURL(mixedTrackUrl);
        setMixedTrackUrl(null);
      }

      const wavBlob = await convertWebmToWav(audioBlob);
      const formData = new FormData();
      formData.append('user_audio', wavBlob, 'user_performance.wav');

      const response = await fetch('http://localhost:8000/api/generate-backing-track', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`generate-backing-track failed with status ${response.status}`);
      }

      const returnedBlob = await response.blob();
      setMixedTrackUrl(URL.createObjectURL(returnedBlob));
    } catch (error) {
      console.error('Error generating AI drums:', error);
      alert('AI drums failed or the backend endpoint is unavailable.');
    } finally {
      setIsGeneratingDrums(false);
    }
  };

  const startRecording = async () => {
    await initAudio();

    try {
      const destination = Tone.getContext().rawContext.createMediaStreamDestination();
      Tone.getDestination().connect(destination);

      const mimeType = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : '';
      const options = mimeType ? { mimeType } : undefined;

      mediaRecorderRef.current = new MediaRecorder(destination.stream, options);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data?.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, {
          type: mediaRecorderRef.current?.mimeType || 'audio/webm',
        });

        if (audioBlob.size > 1000) {
          await generateDrums(audioBlob);
        }
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      if (!isPlaying) setIsPlaying(true);
    } catch (error) {
      console.error('Could not start recording:', error);
      alert('Recording could not start in this browser.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    setIsPlaying(false);
  };

  const { isReady: isMidiReady, activeNotes: midiNotes, error: midiError } = useMidi({
    onNoteEvent: (event) => {
      if (event.type === 'note_on') {
        playNote(event.note);
        handleMatchedNote(event.note, event.velocity ?? 80, event.source || 'physical');
      } else if (event.type === 'note_off') {
        stopNote(event.note);
      }
    },
  });

  useEffect(() => {
    const startAssistantStream = () => {
      coachStreamBufferRef.current = '';
      coachStreamActiveRef.current = true;
      setCoachThinking(true);
      addCoachMessage({ role: 'assistant', content: '' });
    };

    const appendAssistantStream = (chunk) => {
      if (!coachStreamActiveRef.current) startAssistantStream();
      coachStreamBufferRef.current += chunk;
      replaceLastCoachMessage(coachStreamBufferRef.current);
    };

    const finishAssistantStream = () => {
      coachStreamActiveRef.current = false;
      setCoachThinking(false);
    };

    const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws';

    if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        finishAssistantStream();
      };
      ws.onerror = () => {
        setWsConnected(false);
        finishAssistantStream();
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (error) {
          console.error('Invalid websocket payload:', error, event.data);
          return;
        }

        const messageType = msg.type || msg.action;

        if (messageType === 'coach_start') {
          startAssistantStream();
          return;
        }

        if (messageType === 'coach_chunk') {
          appendAssistantStream(msg.delta || msg.text || '');
          return;
        }

        if (messageType === 'coach_done') {
          finishAssistantStream();
          return;
        }

        if (messageType === 'coach_message' || messageType === 'coach_response') {
          const content = msg.content || msg.text || '';

          if (coachStreamActiveRef.current) {
            if (content) {
              coachStreamBufferRef.current = content;
              replaceLastCoachMessage(content);
            }
            finishAssistantStream();
            return;
          }

          if (content) {
            finishAssistantStream();
            addCoachMessage({ role: 'assistant', content });
          }
        }
      };

      wsRef.current = ws;
    }

    return () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    };
  }, [addCoachMessage, replaceLastCoachMessage, setCoachThinking]);

  useEffect(() => {
    if (!expectedNotes.length) return undefined;

    const intervalId = window.setInterval(() => {
      const latestState = matcherStateRef.current;
      const now = performance.now();
      let nextState = latestState;
      let changed = false;

      if (isPlaying) {
        const skipResult = detectSkippedNotes({
          state: latestState,
          expectedNotes,
          playbackTimeSeconds: playbackTimeRef.current || 0,
        });

        if (skipResult.skippedEvents.length > 0) {
          nextState = skipResult.state;
          lastAttemptActivityAtRef.current = now;
          changed = true;
        }
      }

      if (shouldCompleteAttempt(nextState, lastAttemptActivityAtRef.current, now)) {
        const completedState = completeAttemptIfNeeded(nextState, false);
        if (completedState !== nextState) {
          nextState = completedState;
          changed = true;
        }
      }

      if (nextState.expectedIndex >= expectedNotes.length) {
        const completedState = completeAttemptIfNeeded(nextState, true);
        if (completedState !== nextState) {
          nextState = completedState;
          changed = true;
        }
      }

      if (changed) {
        matcherStateRef.current = nextState;
        setMatcherState(nextState);
      }
    }, 60);

    return () => window.clearInterval(intervalId);
  }, [expectedNotes, isPlaying, currentSongName, skills, updateSkill]);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (!PIANO_KEYS_SET.has(key)) return;

      e.preventDefault();
      e.stopPropagation();
      const note = KEYBOARD_MAP[key];

      if (note && !activeKeysRef.current[note]) {
        activeKeysRef.current[note] = true;
        setLocalNotes((prev) => ({ ...prev, [note]: true }));
        playNote(note);
        handleMatchedNote(note, 80, 'keyboard');
      }
    }

    function onKeyUp(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const key = e.key.toLowerCase();
      if (!PIANO_KEYS_SET.has(key)) return;

      e.preventDefault();
      const note = KEYBOARD_MAP[key];
      if (!note) return;

      activeKeysRef.current[note] = false;
      setLocalNotes((prev) => {
        const next = { ...prev };
        delete next[note];
        return next;
      });
      stopNote(note);
    }

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });

    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
    };
  }, [expectedNotes, isPlaying, isWaitMode]);

  useEffect(() => {
    if (scrollWrapperRef.current) {
      scrollWrapperRef.current.scrollLeft = 720 - window.innerWidth / 2;
    }
  }, []);

  useEffect(() => () => {
    if (attemptTimerRef.current) clearTimeout(attemptTimerRef.current);
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
  }, []);

  useEffect(() => {
    if (!targetSong) {
      setExpectedNotes([]);
      resetMatcher();
      return;
    }

    setExpectedNotes(buildExpectedSequenceFromSong(targetSong));
    resetMatcher();
  }, [targetSong]);

  const handleMidiLoaded = (songs) => {
    const cleaned = songs.map((song) => ({
      ...song,
      midi: normalizeMidiData(song.midi),
      name: song.fileName.replace('.mid', ''),
    }));

    setSongLibrary((prev) => [...prev, ...cleaned]);
    if (currentSongIndex === null && cleaned.length > 0) {
      setCurrentSongIndex(songLibrary.length);
    }
  };

  const allActiveNotes = useMemo(() => {
    return Array.from(new Set([
      ...Object.keys(localNotes),
      ...Object.keys(midiNotes),
    ]));
  }, [localNotes, midiNotes]);

  const currentExpected = expectedNotes[matcherState.expectedIndex] || null;

  return (
    <div className="kf-app">
      <Header midiReady={isMidiReady} midiError={midiError} wsConnected={wsConnected} />

      <div className="kf-main">
        <div className="kf-play-area">
          <ScoreDisplay matcherState={matcherState} currentExpectedNote={currentExpected} />

          <div className="kf-waterfall-wrapper" ref={scrollWrapperRef}>
            <div className="kf-waterfall-inner">
              <Waterfall
                notes={expectedNotes}
                isPlaying={isPlaying}
                onReset={resetKey}
                audioEnabled={audioEnabled}
                activeNotes={allActiveNotes}
                isWaitMode={isWaitMode}
                playbackTimeRef={playbackTimeRef}
              />
              <PianoKeyboard
                activeNotes={allActiveNotes}
                noteFeedback={noteFeedback}
                onPlayNote={async (note) => {
                  await initAudio();
                  if (activeKeysRef.current[note]) return;
                  activeKeysRef.current[note] = true;
                  setLocalNotes((prev) => ({ ...prev, [note]: true }));
                  playNote(note);
                  handleMatchedNote(note, 80, 'virtual');
                }}
                onStopNote={(note) => {
                  if (!activeKeysRef.current[note]) return;
                  activeKeysRef.current[note] = false;
                  setLocalNotes((prev) => {
                    const next = { ...prev };
                    delete next[note];
                    return next;
                  });
                  stopNote(note);
                }}
              />
            </div>
          </div>

          <div className="kf-controls">
            <div className="kf-controls-row">
              <button
                className={`kf-btn ${isPlaying ? 'kf-btn-warn' : 'kf-btn-accent'}`}
                onClick={async () => {
                  await initAudio();
                  setIsPlaying((prev) => !prev);
                }}
              >
                {isPlaying ? '⏸ Pause' : '▶ Play'}
              </button>

              <button
                className={`kf-btn ${isWaitMode ? 'kf-btn-purple' : 'kf-btn-outline'}`}
                onClick={() => setIsWaitMode((prev) => !prev)}
              >
                Wait: {isWaitMode ? 'ON' : 'OFF'}
              </button>

              <button
                className={`kf-btn ${isRecording ? 'kf-btn-warn' : 'kf-btn-outline'}`}
                onClick={isRecording ? stopRecording : startRecording}
              >
                {isRecording ? '⏹ Stop' : '⏺ Record + AI Drums'}
              </button>

              <button
                className="kf-btn kf-btn-outline"
                onClick={() => {
                  setResetKey((prev) => prev + 1);
                  setIsPlaying(false);
                  resetMatcher();
                }}
              >
                ⏪ Rewind
              </button>
            </div>

            {isGeneratingDrums && <div className="kf-loading-status">🥁 Generating Beat...</div>}
            {mixedTrackUrl && <audio controls src={mixedTrackUrl} className="kf-audio-player" />}

            {currentSongName && (
              <div className="kf-now-playing">
                <span className="kf-np-label">Now playing:</span>
                <span className="kf-np-title">{currentSongName}</span>
              </div>
            )}
          </div>
        </div>

        <div className="kf-sidebar">
          <ModeSelector />

          <div className="kf-song-library">
            <h4 className="kf-section-title">Song Library</h4>

            {externalLibrary.length > 0 && (
              <>
                <select
                  className="kf-select"
                  onChange={(e) => handleExternalSongSelect(e.target.value)}
                  disabled={isLoadingSong}
                  value=""
                >
                  <option value="">-- Choose a Remote Song --</option>
                  {externalLibrary.map((song, idx) => (
                    <option key={song.url || idx} value={song.url}>
                      {song.title}
                    </option>
                  ))}
                </select>

                {isLoadingSong && <div className="kf-tiny-loading">Fetching MIDI...</div>}
                <div className="kf-divider">OR UPLOAD / LOCAL</div>
              </>
            )}

            {songLibrary.length === 0 ? (
              <p className="kf-empty-hint">Upload MIDI files below to get started</p>
            ) : (
              <div className="kf-song-list">
                {songLibrary.map((song, idx) => (
                  <button
                    key={song.id || idx}
                    className={`kf-song-item ${currentSongIndex === idx ? 'active' : ''}`}
                    onClick={async () => {
                      await initAudio();
                      setCurrentSongIndex(idx);
                      setIsPlaying(false);
                      resetMatcher();
                    }}
                  >
                    <span className="kf-song-name">{song.name || song.fileName}</span>
                    <span className="kf-song-meta">{buildExpectedSequenceFromSong(song.midi).length} notes</span>
                  </button>
                ))}
              </div>
            )}

            <MidiLoader onMidiLoaded={handleMidiLoaded} />
          </div>

          <CoachChat
            wsRef={wsRef}
            matcherState={matcherState}
            songName={currentSongName}
            mode={mode}
            lastAttemptSummary={lastAttemptSummary}
          />

          <SkillGraph />

          <div className="kf-integrations">
            <span className={`kf-integration-badge ${isInsForgeConfigured() ? 'active' : ''}`}>
              {isInsForgeConfigured() ? '✓ InsForge' : '○ InsForge'}
            </span>
            <span className={`kf-integration-badge ${wsConnected ? 'active' : ''}`}>
              {wsConnected ? '✓ AI Coach' : '○ AI Coach'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
