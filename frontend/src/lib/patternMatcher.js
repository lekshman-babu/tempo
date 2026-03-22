export const MATCHER_CONFIG = {
  TIMING_RUSH_MS: -150,
  TIMING_LAG_MS: 150,
  EXTRA_EARLY_IGNORE_MS: -400,
  VELOCITY_HIGH: 100,
  VELOCITY_LOW: 40,
  FAR_MISS_SEMITONES: 3,
  SKIP_DETECTION_BUFFER_MS: 200,
  ATTEMPT_NOTE_COUNT: 5,
  ATTEMPT_PAUSE_MS: 800,
  MAX_SKIPS_PER_PASS: 8,
  MAX_EVENT_LOG_ENTRIES: 400,
};

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function nowMs() {
  return Date.now();
}

export function noteToMidi(noteName) {
  if (!noteName) return 0;
  const match = noteName.match(/^([A-G]#?)(-?\d+)$/);
  if (!match) return 0;
  const pitchClass = NOTES.indexOf(match[1]);
  const octave = Number.parseInt(match[2], 10);
  return (octave + 1) * 12 + pitchClass;
}

function roundSeconds(value) {
  return Number(value.toFixed(3));
}

function classifyPitch(expectedNoteName, playedNoteName) {
  if (expectedNoteName === playedNoteName) {
    return { type: 'correct_note', semitoneDistance: 0, severity: 'none' };
  }

  const diff = Math.abs(noteToMidi(expectedNoteName) - noteToMidi(playedNoteName));

  if (diff === 1) {
    return { type: 'near_miss', semitoneDistance: diff, severity: 'medium' };
  }

  if (diff >= MATCHER_CONFIG.FAR_MISS_SEMITONES) {
    return { type: 'far_miss', semitoneDistance: diff, severity: 'high' };
  }

  return { type: 'wrong_note', semitoneDistance: diff, severity: 'medium' };
}

function buildRecurringKey(error) {
  if (['near_miss', 'wrong_note', 'far_miss'].includes(error.type) && error.expected && error.played) {
    return `${error.expected}->${error.played}`;
  }
  return error.type;
}

function bumpRecurringPattern(state, error) {
  const key = buildRecurringKey(error);
  state.recurringErrors[key] = (state.recurringErrors[key] || 0) + 1;
}

function registerExpectedForAttempt(state, expectedNote) {
  if (!expectedNote) return;
  if (state.attemptExpectedNotes.some((item) => item.position === expectedNote.position)) return;

  state.attemptExpectedNotes.push({
    position: expectedNote.position,
    note: expectedNote.note,
    midi: expectedNote.midi,
    time: expectedNote.time,
    duration: expectedNote.duration,
    velocity: expectedNote.velocity ?? null,
  });
}

function pushEventLog(state, event) {
  state.eventLog.push(event);
  if (state.eventLog.length > MATCHER_CONFIG.MAX_EVENT_LOG_ENTRIES) {
    state.eventLog = state.eventLog.slice(-MATCHER_CONFIG.MAX_EVENT_LOG_ENTRIES);
  }
}

function pushError(state, error) {
  state.attemptErrors.push(error);
  pushEventLog(state, error);
  state.sessionStats.totalErrorsByType[error.type] =
    (state.sessionStats.totalErrorsByType[error.type] || 0) + 1;
  bumpRecurringPattern(state, error);
}

function recurringErrorsSummary(recurringErrors) {
  return Object.entries(recurringErrors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern, count]) => `${pattern} (${count} ${count === 1 ? 'time' : 'times'})`);
}

export function getFriendlyScorePercent(state) {
  const played = state?.uiStats?.playedNotes || 0;
  const correct = state?.uiStats?.correctPlayedNotes || 0;
  return played > 0 ? Math.round((correct / played) * 100) : 0;
}

export function getTechnicalAccuracyPercent(state) {
  const total = state?.sessionStats?.totalNotesConsidered || 0;
  const correct = state?.sessionStats?.correctNotes || 0;
  return total > 0 ? Math.round((correct / total) * 100) : 0;
}

export function buildSessionContext(state) {
  return {
    friendly_score_percent: getFriendlyScorePercent(state),
    technical_session_accuracy_percent: getTechnicalAccuracyPercent(state),
    played_notes_count: state?.uiStats?.playedNotes || 0,
    correct_played_notes_count: state?.uiStats?.correctPlayedNotes || 0,
    total_notes_considered: state?.sessionStats?.totalNotesConsidered || 0,
    skipped_notes_count: state?.sessionStats?.skippedNotes || 0,
    recurring_errors: recurringErrorsSummary(state?.recurringErrors || {}),
    streak: state?.sessionStats?.streak || 0,
    best_streak: state?.sessionStats?.bestStreak || 0,
    attempts_completed: state?.sessionStats?.attemptsCompleted || 0,
  };
}

export function buildExpectedSequenceFromSong(song) {
  if (!song?.tracks) return [];

  const allNotes = [];

  song.tracks.forEach((track, trackIndex) => {
    track.notes.forEach((note, noteIndex) => {
      allNotes.push({
        note: note.name,
        midi: typeof note.midi === 'number' ? note.midi : noteToMidi(note.name),
        time: note.time,
        duration: note.duration,
        velocity: note.velocity ?? null,
        trackIndex,
        trackNoteIndex: noteIndex,
      });
    });
  });

  allNotes.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex;
    if (a.midi !== b.midi) return a.midi - b.midi;
    return a.trackNoteIndex - b.trackNoteIndex;
  });

  return allNotes.map((note, position) => ({
    position,
    note: note.note,
    midi: note.midi,
    time: note.time,
    duration: note.duration,
    velocity: note.velocity,
    trackIndex: note.trackIndex,
  }));
}

export function createMatcherState() {
  return {
    expectedIndex: 0,
    attemptExpectedNotes: [],
    attemptPlayedNotes: [],
    attemptErrors: [],
    attemptAddressedNotesCount: 0,
    attemptHistory: [],
    eventLog: [],
    recurringErrors: {},
    uiStats: {
      playedNotes: 0,
      correctPlayedNotes: 0,
    },
    sessionStats: {
      totalNotesConsidered: 0,
      correctNotes: 0,
      skippedNotes: 0,
      attemptsCompleted: 0,
      streak: 0,
      bestStreak: 0,
      totalErrorsByType: {},
    },
  };
}

export function detectSkippedNotes({
  state,
  expectedNotes,
  playbackTimeSeconds,
  maxSkipsPerPass = MATCHER_CONFIG.MAX_SKIPS_PER_PASS,
}) {
  const nextExpected = expectedNotes?.[state.expectedIndex];
  const skipThresholdMs = MATCHER_CONFIG.TIMING_LAG_MS + MATCHER_CONFIG.SKIP_DETECTION_BUFFER_MS;

  if (!nextExpected) {
    return { state, skippedEvents: [] };
  }

  const initialDeltaMs = Math.round((playbackTimeSeconds - nextExpected.time) * 1000);
  if (initialDeltaMs <= skipThresholdMs) {
    return { state, skippedEvents: [] };
  }

  const nextState = structuredClone(state);
  const skippedEvents = [];
  let processed = 0;

  while (nextState.expectedIndex < expectedNotes.length && processed < maxSkipsPerPass) {
    const expected = expectedNotes[nextState.expectedIndex];
    const deltaMs = Math.round((playbackTimeSeconds - expected.time) * 1000);

    if (deltaMs > skipThresholdMs) {
      registerExpectedForAttempt(nextState, expected);
      nextState.sessionStats.totalNotesConsidered += 1;
      nextState.sessionStats.skippedNotes += 1;
      nextState.sessionStats.streak = 0;
      nextState.attemptAddressedNotesCount += 1;

      const skipError = {
        position: expected.position,
        type: 'note_skipped',
        expected: expected.note,
        expected_midi: expected.midi,
        played: null,
        played_midi: null,
        expected_time: expected.time,
        played_time: roundSeconds(playbackTimeSeconds),
        timing_delta_ms: deltaMs,
        velocity: null,
        severity: 'high',
        timestamp_ms: nowMs(),
      };

      pushError(nextState, skipError);
      skippedEvents.push(skipError);
      nextState.expectedIndex += 1;
      processed += 1;
      continue;
    }

    break;
  }

  return { state: nextState, skippedEvents };
}

export function evaluatePlayedNote({
  state,
  expectedNote,
  playedNote,
  playedTimeSeconds,
  velocity,
  source = 'virtual',
}) {
  const nextState = structuredClone(state);
  const playedMidi = noteToMidi(playedNote);

  const result = {
    feedbackType: 'neutral',
    expected: expectedNote?.note ?? null,
    played: playedNote,
    events: [],
    noteRecord: null,
  };

  if (!expectedNote) {
    const extraRecord = {
      type: 'extra_note',
      position: null,
      note: playedNote,
      midi: playedMidi,
      time: roundSeconds(playedTimeSeconds),
      velocity: velocity ?? null,
      source,
    };
    pushEventLog(nextState, extraRecord);
    result.feedbackType = 'extra_note';
    result.noteRecord = extraRecord;
    return { state: nextState, result };
  }

  const timingDeltaMs = Math.round((playedTimeSeconds - expectedNote.time) * 1000);

  if (timingDeltaMs < MATCHER_CONFIG.EXTRA_EARLY_IGNORE_MS) {
    const extraEarlyRecord = {
      type: 'extra_note',
      position: null,
      note: playedNote,
      midi: playedMidi,
      time: roundSeconds(playedTimeSeconds),
      velocity: velocity ?? null,
      source,
      timing_delta_ms: timingDeltaMs,
    };
    pushEventLog(nextState, extraEarlyRecord);
    result.feedbackType = 'extra_note';
    result.noteRecord = extraEarlyRecord;
    return { state: nextState, result };
  }

  registerExpectedForAttempt(nextState, expectedNote);
  nextState.uiStats.playedNotes += 1;
  nextState.sessionStats.totalNotesConsidered += 1;
  nextState.attemptAddressedNotesCount += 1;

  const baseEvent = {
    position: expectedNote.position,
    expected: expectedNote.note,
    expected_midi: expectedNote.midi,
    played: playedNote,
    played_midi: playedMidi,
    expected_time: expectedNote.time,
    played_time: roundSeconds(playedTimeSeconds),
    timing_delta_ms: timingDeltaMs,
    velocity: velocity ?? null,
    source,
    timestamp_ms: nowMs(),
  };

  const pitch = classifyPitch(expectedNote.note, playedNote);

  if (pitch.type === 'correct_note') {
    nextState.uiStats.correctPlayedNotes += 1;
    nextState.sessionStats.correctNotes += 1;
    nextState.sessionStats.streak += 1;
    nextState.sessionStats.bestStreak = Math.max(
      nextState.sessionStats.bestStreak,
      nextState.sessionStats.streak,
    );
    result.feedbackType = 'correct';
  } else {
    nextState.sessionStats.streak = 0;
    const pitchError = {
      ...baseEvent,
      type: pitch.type,
      semitone_distance: pitch.semitoneDistance,
      severity: pitch.severity,
    };
    pushError(nextState, pitchError);
    result.events.push(pitchError);
    result.feedbackType = pitch.type;
  }

  if (timingDeltaMs < MATCHER_CONFIG.TIMING_RUSH_MS) {
    const timingError = { ...baseEvent, type: 'timing_rush', severity: 'medium' };
    pushError(nextState, timingError);
    result.events.push(timingError);
  } else if (timingDeltaMs > MATCHER_CONFIG.TIMING_LAG_MS) {
    const timingError = { ...baseEvent, type: 'timing_lag', severity: 'medium' };
    pushError(nextState, timingError);
    result.events.push(timingError);
  }

  if (velocity != null && velocity > MATCHER_CONFIG.VELOCITY_HIGH) {
    const velocityError = { ...baseEvent, type: 'velocity_high', severity: 'low' };
    pushError(nextState, velocityError);
    result.events.push(velocityError);
  } else if (velocity != null && velocity < MATCHER_CONFIG.VELOCITY_LOW) {
    const velocityError = { ...baseEvent, type: 'velocity_low', severity: 'low' };
    pushError(nextState, velocityError);
    result.events.push(velocityError);
  }

  const noteRecord = {
    position: expectedNote.position,
    note: playedNote,
    midi: playedMidi,
    expected: expectedNote.note,
    expected_midi: expectedNote.midi,
    time: roundSeconds(playedTimeSeconds),
    velocity: velocity ?? null,
    source,
    timing_delta_ms: timingDeltaMs,
    pitch_classification: pitch.type,
  };

  nextState.attemptPlayedNotes.push(noteRecord);
  pushEventLog(nextState, { type: 'played_note', ...noteRecord });
  nextState.expectedIndex += 1;

  result.noteRecord = noteRecord;
  return { state: nextState, result };
}

export function shouldCompleteAttempt(state, lastActivityAt, now) {
  const addressedCount = state?.attemptAddressedNotesCount || 0;
  const playedCount = state?.attemptPlayedNotes?.length || 0;
  const errorCount = state?.attemptErrors?.length || 0;

  if (addressedCount === 0 && playedCount === 0 && errorCount === 0) return false;
  if (addressedCount >= MATCHER_CONFIG.ATTEMPT_NOTE_COUNT) return true;
  if (!lastActivityAt) return false;

  return now - lastActivityAt >= MATCHER_CONFIG.ATTEMPT_PAUSE_MS;
}

export function finalizeAttempt(state, exercise = {}) {
  const nextState = structuredClone(state);
  const playedCount = nextState.attemptPlayedNotes.length;
  const errorCount = nextState.attemptErrors.length;

  if (playedCount === 0 && errorCount === 0) {
    return { state: nextState, attemptSummary: null };
  }

  nextState.sessionStats.attemptsCompleted += 1;
  const attemptNumber = nextState.sessionStats.attemptsCompleted;

  const attemptSummary = {
    exercise: {
      name: exercise.name || 'Unknown',
      tempo_bpm: exercise.tempo_bpm ?? null,
      expected_notes: nextState.attemptExpectedNotes,
    },
    played_notes: nextState.attemptPlayedNotes,
    errors: nextState.attemptErrors,
    attempt_context: {
      attempt_number: attemptNumber,
      attempt_played_note_count: playedCount,
      attempt_addressed_note_count: nextState.attemptAddressedNotesCount,
      attempt_error_count: errorCount,
    },
    session_context: buildSessionContext(nextState),
  };

  nextState.attemptHistory = [attemptSummary, ...nextState.attemptHistory].slice(0, 10);
  nextState.attemptExpectedNotes = [];
  nextState.attemptPlayedNotes = [];
  nextState.attemptErrors = [];
  nextState.attemptAddressedNotesCount = 0;

  return { state: nextState, attemptSummary };
}
