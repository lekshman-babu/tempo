import React, { useState, useEffect, useRef, useMemo } from 'react';
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
import { isInsForgeConfigured, saveSession } from './lib/insforgeClient';
import {
  buildExpectedSequenceFromSong,
  createMatcherState,
  detectSkippedNotes,
  evaluatePlayedNote,
  shouldCompletePhrase,
  finalizePhrase,
} from './lib/patternMatcher';
import './App.css';

// ── Keyboard mapping (team's original) ─────────────
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
  // ── Team's original state ────────────────────────
  const [localNotes, setLocalNotes] = useState({});
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [songLibrary, setSongLibrary] = useState([]);
  const [currentSongIndex, setCurrentSongIndex] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [isWaitMode, setIsWaitMode] = useState(false);
  const [expectedNotes, setExpectedNotes] = useState([]);
  const [matcherState, setMatcherState] = useState(createMatcherState());
  const [noteFeedback, setNoteFeedback] = useState({});
  const [lastPhraseSummary, setLastPhraseSummary] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);

  // ── New state ────────────────────────────────────
  const mode = useStore((s) => s.mode);
  const addCoachMessage = useStore((s) => s.addCoachMessage);
  const updateSkill = useStore((s) => s.updateSkill);
  const skills = useStore((s) => s.skills);

  const scrollWrapperRef = useRef(null);
  const exerciseStartRef = useRef(null);
  const lastPlayedAtRef = useRef(0);
  const phraseTimerRef = useRef(null);
  const wsRef = useRef(null);

  const targetSong = currentSongIndex !== null ? songLibrary[currentSongIndex]?.midi ?? null : null;
  const currentSongName = currentSongIndex !== null ? songLibrary[currentSongIndex]?.name ?? null : null;

  // ── WebSocket connection tracking ────────────────
  useEffect(() => {
    const checkWs = setInterval(() => {
      setWsConnected(wsRef.current?.readyState === WebSocket.OPEN);
    }, 2000);
    return () => clearInterval(checkWs);
  }, []);

  // ── Matcher helpers (team's original) ────────────
  const resetMatcher = () => {
    setMatcherState(createMatcherState());
    setLastPhraseSummary(null);
    setNoteFeedback({});
    exerciseStartRef.current = null;
    lastPlayedAtRef.current = 0;
    if (phraseTimerRef.current) {
      clearTimeout(phraseTimerRef.current);
      phraseTimerRef.current = null;
    }
  };

  const clearFeedbackAfterDelay = (note) => {
    window.setTimeout(() => {
      setNoteFeedback((prev) => { const next = { ...prev }; delete next[note]; return next; });
    }, 350);
  };

  const getPlaybackTimeSeconds = () => {
    if (!exerciseStartRef.current) return 0;
    return (performance.now() - exerciseStartRef.current) / 1000;
  };

  const completePhraseIfNeeded = (stateToCheck) => {
    const now = performance.now();
    if (!shouldCompletePhrase(stateToCheck, lastPlayedAtRef.current, now)) return stateToCheck;
    const { state: nextState, phraseSummary } = finalizePhrase(stateToCheck);
    setMatcherState(nextState);
    setLastPhraseSummary(phraseSummary);

    // Auto-coach after each phrase completion
    if (phraseSummary.errors.length > 3) {
      const errTypes = phraseSummary.errors.map((e) => e.type).join(', ');
      addCoachMessage({
        role: 'system',
        content: `Phrase #${phraseSummary.phraseNumber}: ${phraseSummary.errors.length} errors (${errTypes}). Accuracy: ${Math.round(phraseSummary.sessionAccuracy * 100)}%`,
      });
    }

    // Update skill mastery based on accuracy
    if (phraseSummary.sessionAccuracy > 0.8) {
      updateSkill('quarter', Math.min(1, (skills.find((s) => s.id === 'quarter')?.mastery || 0) + 0.05));
    }

    return nextState;
  };

  const handleMatchedNote = (note, velocity = 80, source = 'virtual') => {
    if (!expectedNotes.length) return;
    if (isWaitMode && !isPlaying) return;
    if (!exerciseStartRef.current) exerciseStartRef.current = performance.now();

    const playedTimeSeconds = getPlaybackTimeSeconds();

    setMatcherState((prevState) => {
      let workingState = detectSkippedNotes({ state: prevState, expectedNotes, playbackTimeSeconds: playedTimeSeconds });
      const expected = expectedNotes[workingState.expectedIndex];
      const { state: evaluatedState, result } = evaluatePlayedNote({
        state: workingState, expectedNote: expected, playedNote: note, playedTimeSeconds, velocity,
      });

      setNoteFeedback((prev) => ({
        ...prev,
        [note]: {
          type: result.feedbackType,
          label: expected ? `${result.feedbackType.toUpperCase()} — expected ${expected.note}` : `Played ${note}`,
        },
      }));
      clearFeedbackAfterDelay(note);
      lastPlayedAtRef.current = performance.now();

      if (phraseTimerRef.current) clearTimeout(phraseTimerRef.current);
      phraseTimerRef.current = setTimeout(() => {
        setMatcherState((latestState) => completePhraseIfNeeded(latestState));
      }, 850);

      const maybeCompleted = completePhraseIfNeeded(evaluatedState);
      if (maybeCompleted.expectedIndex >= expectedNotes.length) {
        return completePhraseIfNeeded(maybeCompleted);
      }
      return maybeCompleted;
    });
  };

  // ── MIDI hook ────────────────────────────────────
  const { isReady: isMidiReady, activeNotes: midiNotes, error: midiError } = useMidi({
    onNoteEvent: (event) => {
      if (event.type === 'note_on') {
        playNote(event.note); // Use the correct playNote
        handleMatchedNote(event.note, event.velocity ?? 80, event.source || 'physical');
      } else if (event.type === 'note_off') {
        stopNote(event.note); // Use the correct stopNote
      }
    },
  });

  // Capture wsRef from useMidi
  useEffect(() => {
    // The useMidi hook creates a WebSocket internally. We access it via the module.
    // For the coach, we reuse the same connection or create a parallel one.
    if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
      const ws = new WebSocket('ws://localhost:8000/ws');
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => setWsConnected(false);
      ws.onerror = () => setWsConnected(false);
      wsRef.current = ws;
    }
    return () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    };
  }, []);

  // ── Keyboard input ───────────────────────────────
  useEffect(() => {
    function onKeyDown(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (PIANO_KEYS_SET.has(key)) {
        e.preventDefault();
        e.stopPropagation();
        const note = KEYBOARD_MAP[key];
        if (note && !localNotes[note]) {
          playNote(note);
          setLocalNotes((prev) => ({ ...prev, [note]: true }));
          handleMatchedNote(note, 80, 'keyboard');
        }
      }
    }
    function onKeyUp(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const key = e.key.toLowerCase();
      if (PIANO_KEYS_SET.has(key)) {
        e.preventDefault();
        const note = KEYBOARD_MAP[key];
        if (note) {
          stopNote(note);
          setLocalNotes((prev) => { const n = { ...prev }; delete n[note]; return n; });
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
    };
  }, [localNotes]);

  // ── Song loading ─────────────────────────────────
  useEffect(() => {
    if (scrollWrapperRef.current) {
      scrollWrapperRef.current.scrollLeft = 720 - window.innerWidth / 2;
    }
  }, []);

  useEffect(() => { return () => { if (phraseTimerRef.current) clearTimeout(phraseTimerRef.current); }; }, []);

  useEffect(() => {
    if (!targetSong) { setExpectedNotes([]); resetMatcher(); return; }
    setExpectedNotes(buildExpectedSequenceFromSong(targetSong));
    resetMatcher();
  }, [targetSong]);

  const initAudio = async () => {
    if (!audioEnabled) { await startAudioContext(); setAudioEnabled(true); }
  };

  const handleMidiLoaded = (songs) => {
    const cleaned = songs.map((s) => ({ ...s, midi: normalizeMidiData(s.midi), name: s.fileName.replace('.mid', '') }));
    setSongLibrary((prev) => [...prev, ...cleaned]);
    if (currentSongIndex === null && cleaned.length > 0) {
      setCurrentSongIndex(songLibrary.length);
    }
  };

  const allActiveNotes = useMemo(() => {
    return [...Object.keys(localNotes), ...Object.keys(midiNotes)];
  }, [localNotes, midiNotes]);

  const accuracyPercent = matcherState.sessionStats.totalNotes > 0
    ? Math.round((matcherState.sessionStats.correctNotes / matcherState.sessionStats.totalNotes) * 100)
    : 0;

  const currentExpected = expectedNotes[matcherState.expectedIndex] || null;

  // ── Render ───────────────────────────────────────
  return (
    <div className="kf-app">
      <Header midiReady={isMidiReady} midiError={midiError} wsConnected={wsConnected} />

      <div className="kf-main">
        {/* ── Left: Play Area ──────────────────────── */}
        <div className="kf-play-area">
          <ScoreDisplay matcherState={matcherState} />

          {/* Waterfall + Piano */}
          <div className="kf-waterfall-wrapper" ref={scrollWrapperRef}>
            <div className="kf-waterfall-inner">
              <Waterfall
                song={targetSong}
                isPlaying={isPlaying}
                onReset={resetKey}
                audioEnabled={audioEnabled}
                activeNotes={allActiveNotes}
                isWaitMode={isWaitMode}
              />
              <PianoKeyboard
                activeNotes={allActiveNotes}
                noteFeedback={noteFeedback}
                onPlayNote={async (note) => {
                  await initAudio();
                  // Prevent re-triggering if already playing
                  if (!localNotes[note]) {
                    playNote(note);
                    setLocalNotes((prev) => ({ ...prev, [note]: true }));
                    handleMatchedNote(note, 80, 'virtual');
                  }
                }}
                onStopNote={(note) => {
                  // Only stop if it's currently active
                  if (localNotes[note]) {
                    stopNote(note);
                    setLocalNotes((prev) => { 
                      const n = { ...prev }; 
                      delete n[note]; 
                      return n; 
                    });
                  }
                }}
              />
            </div>
          </div>

          {/* Controls */}
          <div className="kf-controls">
            <div className="kf-controls-row">
              <button className={`kf-btn ${isPlaying ? 'kf-btn-warn' : 'kf-btn-accent'}`}
                onClick={async () => { await initAudio(); setIsPlaying((p) => !p); }}>
                {isPlaying ? '⏸ Pause' : '▶ Play'}
              </button>
              <button className={`kf-btn ${isWaitMode ? 'kf-btn-purple' : 'kf-btn-outline'}`}
                onClick={() => setIsWaitMode((p) => !p)}>
                Wait: {isWaitMode ? 'ON' : 'OFF'}
              </button>
              <button className="kf-btn kf-btn-outline"
                onClick={() => { setResetKey((p) => p + 1); setIsPlaying(false); resetMatcher(); }}>
                ⏪ Rewind
              </button>
            </div>

            {/* Song info */}
            {currentSongName && (
              <div className="kf-now-playing">
                <span className="kf-np-label">Now playing:</span>
                <span className="kf-np-title">{currentSongName}</span>
                {currentExpected && (
                  <span className="kf-np-next">Next: <strong>{currentExpected.note}</strong></span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Right: Sidebar ───────────────────────── */}
        <div className="kf-sidebar">
          <ModeSelector />

          {/* Song Library */}
          <div className="kf-song-library">
            <h4 className="kf-section-title">Song Library</h4>
            {songLibrary.length === 0 ? (
              <p className="kf-empty-hint">Upload MIDI files below to get started</p>
            ) : (
              <div className="kf-song-list">
                {songLibrary.map((song, idx) => (
                  <button
                    key={song.id || idx}
                    className={`kf-song-item ${currentSongIndex === idx ? 'active' : ''}`}
                    onClick={async () => { await initAudio(); setCurrentSongIndex(idx); setIsPlaying(false); resetMatcher(); }}
                  >
                    <span className="kf-song-name">{song.name || song.fileName}</span>
                    <span className="kf-song-meta">
                      {song.midi?.tracks?.find((t) => t.notes.length)?.notes.length || 0} notes
                    </span>
                  </button>
                ))}
              </div>
            )}

            <MidiLoader onMidiLoaded={handleMidiLoaded} />
          </div>

          {/* AI Coach */}
          <CoachChat
            wsRef={wsRef}
            matcherState={matcherState}
            songName={currentSongName}
            mode={mode}
          />

          {/* Skill Graph */}
          <SkillGraph />

          {/* InsForge status */}
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
