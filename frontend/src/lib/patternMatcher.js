const NOTE_TO_SEMITONE = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
};

export const MATCHER_CONFIG = {
  PHRASE_NOTE_LIMIT: 5,
  PHRASE_PAUSE_MS: 800,
  TIMING_RUSH_MS: -150,
  TIMING_LAG_MS: 300,
  VELOCITY_HIGH: 110,
  VELOCITY_LOW: 30,
  NEAR_MISS_SEMITONES: 1,
  FAR_MISS_SEMITONES: 3,
};

export function noteNameToMidi(noteName) {
  if (!noteName || typeof noteName !== 'string') return null;

  const match = noteName.match(/^([A-G](?:#|b)?)(-?\d+)$/);
  if (!match) return null;

  const [, pitchClass, octaveStr] = match;
  const semitone = NOTE_TO_SEMITONE[pitchClass];
  if (semitone === undefined) return null;

  const octave = Number(octaveStr);
  return (octave + 1) * 12 + semitone;
}

export function semitoneDistance(noteA, noteB) {
  const midiA = noteNameToMidi(noteA);
  const midiB = noteNameToMidi(noteB);

  if (midiA == null || midiB == null) return null;
  return Math.abs(midiA - midiB);
}

export function buildExpectedSequenceFromSong(song) {
  const track = song?.tracks?.find((t) => t.notes?.length > 0);
  if (!track) return [];

  return [...track.notes]
    .sort((a, b) => a.time - b.time)
    .map((note, index) => ({
      position: index,
      note: note.name,
      midi: note.midi,
      time: note.time,
      duration: note.duration,
      velocity:
        note.velocity != null ? Math.round(note.velocity * 127) : null,
    }));
}

export function createMatcherState() {
  return {
    expectedIndex: 0,
    phraseNotes: [],
    phraseErrors: [],
    recurringErrors: {},
    sessionStats: {
      totalNotes: 0,
      correctNotes: 0,
      streak: 0,
      bestStreak: 0,
      phrasesCompleted: 0,
      totalErrorsByType: {},
    },
  };
}

function incrementCount(map, key) {
  return {
    ...map,
    [key]: (map[key] || 0) + 1,
  };
}

function recurringKeyForError(error) {
  if (
    error.type === 'wrong_note' ||
    error.type === 'near_miss' ||
    error.type === 'far_miss'
  ) {
    return `${error.expected}->${error.played}`;
  }

  return error.type;
}

function pushError(nextState, error) {
  nextState.phraseErrors.push(error);
  nextState.sessionStats.totalErrorsByType = incrementCount(
    nextState.sessionStats.totalErrorsByType,
    error.type
  );
  nextState.recurringErrors = incrementCount(
    nextState.recurringErrors,
    recurringKeyForError(error)
  );
}

export function detectSkippedNotes({
  state,
  expectedNotes,
  playbackTimeSeconds,
}) {
  if (!expectedNotes?.length) return state;

  const nextState = structuredClone(state);
  let cursor = nextState.expectedIndex;

  while (cursor < expectedNotes.length) {
    const expected = expectedNotes[cursor];
    const latenessMs = Math.round(
      (playbackTimeSeconds - expected.time) * 1000
    );

    if (latenessMs < MATCHER_CONFIG.TIMING_LAG_MS) break;

    const skippedError = {
      position: expected.position,
      expected: expected.note,
      played: null,
      expectedTime: expected.time,
      playedTime: playbackTimeSeconds,
      timingDeltaMs: latenessMs,
      velocity: null,
      type: 'note_skipped',
      severity: 'high',
      timestamp: performance.now(),
    };

    nextState.sessionStats.totalNotes += 1;
    nextState.sessionStats.streak = 0;
    pushError(nextState, skippedError);

    nextState.expectedIndex += 1;
    cursor += 1;
  }

  return nextState;
}

function classifyPitch(expectedNoteName, playedNoteName) {
  if (expectedNoteName === playedNoteName) {
    return {
      type: 'correct_note',
      semitoneDistance: 0,
      severity: 'none',
    };
  }

  const distance = semitoneDistance(expectedNoteName, playedNoteName);

  if (distance === MATCHER_CONFIG.NEAR_MISS_SEMITONES) {
    return {
      type: 'near_miss',
      semitoneDistance: distance,
      severity: 'medium',
    };
  }

  if (distance != null && distance >= MATCHER_CONFIG.FAR_MISS_SEMITONES) {
    return {
      type: 'far_miss',
      semitoneDistance: distance,
      severity: 'high',
    };
  }

  return {
    type: 'wrong_note',
    semitoneDistance: distance,
    severity: 'medium',
  };
}

export function evaluatePlayedNote({
  state,
  expectedNote,
  playedNote,
  playedTimeSeconds,
  velocity,
}) {
  const nextState = structuredClone(state);

  const result = {
    feedbackType: 'neutral',
    expected: expectedNote || null,
    played: playedNote,
    events: [],
  };

  if (!expectedNote) {
    return { state: nextState, result };
  }

  nextState.sessionStats.totalNotes += 1;

  const timingDeltaMs = Math.round(
    (playedTimeSeconds - expectedNote.time) * 1000
  );

  const baseEvent = {
    position: expectedNote.position,
    expected: expectedNote.note,
    played: playedNote,
    expectedTime: expectedNote.time,
    playedTime: playedTimeSeconds,
    timingDeltaMs,
    velocity,
    timestamp: performance.now(),
  };

  const pitch = classifyPitch(expectedNote.note, playedNote);

  if (pitch.type === 'correct_note') {
    nextState.sessionStats.correctNotes += 1;
    nextState.sessionStats.streak += 1;
    nextState.sessionStats.bestStreak = Math.max(
      nextState.sessionStats.bestStreak,
      nextState.sessionStats.streak
    );
    result.feedbackType = 'correct';
  } else {
    nextState.sessionStats.streak = 0;

    const pitchError = {
      ...baseEvent,
      type: pitch.type,
      semitoneDistance: pitch.semitoneDistance,
      severity: pitch.severity,
    };

    pushError(nextState, pitchError);
    result.events.push(pitchError);

    result.feedbackType =
      pitch.type === 'near_miss'
        ? 'near_miss'
        : pitch.type === 'far_miss'
        ? 'far_miss'
        : 'wrong';
  }

  if (timingDeltaMs < MATCHER_CONFIG.TIMING_RUSH_MS) {
    const timingError = {
      ...baseEvent,
      type: 'timing_rush',
      severity: 'medium',
    };
    pushError(nextState, timingError);
    result.events.push(timingError);
  } else if (timingDeltaMs > MATCHER_CONFIG.TIMING_LAG_MS) {
    const timingError = {
      ...baseEvent,
      type: 'timing_lag',
      severity: 'medium',
    };
    pushError(nextState, timingError);
    result.events.push(timingError);
  }

  if (velocity != null && velocity > MATCHER_CONFIG.VELOCITY_HIGH) {
    const velocityError = {
      ...baseEvent,
      type: 'velocity_high',
      severity: 'low',
    };
    pushError(nextState, velocityError);
    result.events.push(velocityError);
  } else if (velocity != null && velocity < MATCHER_CONFIG.VELOCITY_LOW) {
    const velocityError = {
      ...baseEvent,
      type: 'velocity_low',
      severity: 'low',
    };
    pushError(nextState, velocityError);
    result.events.push(velocityError);
  }

  nextState.phraseNotes.push({
    position: expectedNote.position,
    expected: expectedNote.note,
    played: playedNote,
    velocity,
    timingDeltaMs,
    time: playedTimeSeconds,
  });

  nextState.expectedIndex += 1;

  return { state: nextState, result };
}

export function shouldCompletePhrase(state, lastPlayedAtMs, nowMs) {
  if (state.phraseNotes.length >= MATCHER_CONFIG.PHRASE_NOTE_LIMIT) return true;
  if (state.phraseNotes.length === 0) return false;

  return nowMs - lastPlayedAtMs >= MATCHER_CONFIG.PHRASE_PAUSE_MS;
}

export function finalizePhrase(state) {
  const nextState = structuredClone(state);

  const phraseSummary = {
    phraseNumber: nextState.sessionStats.phrasesCompleted + 1,
    playedNotes: nextState.phraseNotes,
    errors: nextState.phraseErrors,
    recurringErrors: Object.entries(nextState.recurringErrors)
      .filter(([, count]) => count >= 2)
      .map(([pattern, count]) => `${pattern} (${count} times)`),
    sessionAccuracy:
      nextState.sessionStats.totalNotes > 0
        ? nextState.sessionStats.correctNotes /
          nextState.sessionStats.totalNotes
        : 1,
    stats: nextState.sessionStats,
  };

  nextState.sessionStats.phrasesCompleted += 1;
  nextState.phraseNotes = [];
  nextState.phraseErrors = [];

  return { state: nextState, phraseSummary };
}