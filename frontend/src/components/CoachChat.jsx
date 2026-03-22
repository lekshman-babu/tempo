import React, { useState, useEffect, useMemo } from 'react';
import { useStore } from '../lib/store';

function technicalAccuracyPercent(matcherState) {
  const total = matcherState?.sessionStats?.totalNotesConsidered || 0;
  const correct = matcherState?.sessionStats?.correctNotes || 0;
  return total > 0 ? Math.round((correct / total) * 100) : 0;
}

function buildSessionPayload(matcherState, songName, mode) {
  const pendingAttempt = (matcherState?.attemptPlayedNotes?.length || matcherState?.attemptErrors?.length)
    ? {
        exercise: {
          name: songName || 'Unknown',
          tempo_bpm: null,
          expected_notes: matcherState?.attemptExpectedNotes || [],
        },
        played_notes: matcherState?.attemptPlayedNotes || [],
        errors: matcherState?.attemptErrors || [],
        attempt_context: {
          attempt_number: (matcherState?.sessionStats?.attemptsCompleted || 0) + 1,
          attempt_played_note_count: matcherState?.attemptPlayedNotes?.length || 0,
          attempt_error_count: matcherState?.attemptErrors?.length || 0,
        },
      }
    : null;

  return {
    exercise: {
      name: songName || 'Unknown',
      tempo_bpm: null,
      expected_notes: [],
    },
    played_notes: [],
    errors: [],
    attempt_context: {
      attempt_number: matcherState?.sessionStats?.attemptsCompleted || 0,
      attempt_played_note_count: matcherState?.attemptPlayedNotes?.length || 0,
      attempt_error_count: matcherState?.attemptErrors?.length || 0,
    },
    session_context: {
      friendly_score_percent: (() => {
        const played = matcherState?.uiStats?.playedNotes || 0;
        const correct = matcherState?.uiStats?.correctPlayedNotes || 0;
        return played > 0 ? Math.round((correct / played) * 100) : 0;
      })(),
      technical_session_accuracy_percent: technicalAccuracyPercent(matcherState),
      played_notes_count: matcherState?.uiStats?.playedNotes || 0,
      correct_played_notes_count: matcherState?.uiStats?.correctPlayedNotes || 0,
      recurring_errors: Object.entries(matcherState?.recurringErrors || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([pattern, count]) => `${pattern} (${count})`),
      streak: matcherState?.sessionStats?.streak || 0,
      best_streak: matcherState?.sessionStats?.bestStreak || 0,
      attempts_completed: matcherState?.sessionStats?.attemptsCompleted || 0,
      skipped_notes_count: matcherState?.sessionStats?.skippedNotes || 0,
    },
    recent_attempts: pendingAttempt
      ? [pendingAttempt, ...(matcherState?.attemptHistory || [])]
      : (matcherState?.attemptHistory || []),
    mode: mode || 'guided',
  };
}

export function CoachChat({ wsRef, matcherState, songName, mode, lastAttemptSummary }) {
  const [userMsg, setUserMsg] = useState('');
  const messages = useStore((s) => s.coachMessages) || [];
  const addCoachMessage = useStore((s) => s.addCoachMessage);

  const debugStats = useMemo(() => {
    const played = matcherState?.uiStats?.playedNotes || 0;
    const correctPlayed = matcherState?.uiStats?.correctPlayedNotes || 0;
    const friendly = played > 0 ? Math.round((correctPlayed / played) * 100) : 0;

    return {
      friendly,
      technical: technicalAccuracyPercent(matcherState),
      skipped: matcherState?.sessionStats?.skippedNotes || 0,
      played,
      attempts: matcherState?.sessionStats?.attemptsCompleted || 0,
    };
  }, [matcherState]);

  useEffect(() => {
    if (!lastAttemptSummary) return;

    const playedCount = lastAttemptSummary?.attempt_context?.attempt_played_note_count || 0;
    if (playedCount === 0) return;

    const ws = wsRef?.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      type: 'coach_request',
      request_kind: 'attempt_feedback',
      coach_payload: lastAttemptSummary,
    }));
  }, [lastAttemptSummary, wsRef]);

  const sendToCoach = (isFullAnalysis = false) => {
    const ws = wsRef?.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const trimmed = userMsg.trim();
    if (!isFullAnalysis && !trimmed) return;

    if (!isFullAnalysis) {
      addCoachMessage({ role: 'user', content: trimmed });
    }

    const payload = {
      type: 'coach_request',
      request_kind: isFullAnalysis ? 'full_session' : 'chat',
      message: isFullAnalysis
        ? 'Give me a full coaching summary of this practice session.'
        : trimmed,
      coach_payload: isFullAnalysis
        ? buildSessionPayload(matcherState, songName, mode)
        : (lastAttemptSummary || buildSessionPayload(matcherState, songName, mode)),
    };

    ws.send(JSON.stringify(payload));
    setUserMsg('');
  };

  return (
    <div
      className="kf-coach-chat"
      style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px', border: '1px solid #ccc', borderRadius: '8px' }}
    >
      <h4 className="kf-section-title">AI Coach</h4>

      <div
        className="kf-chat-debug"
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '0.9rem' }}
      >
        <div><strong>Technical Accuracy:</strong> {debugStats.technical}%</div>
        <div><strong>Friendly Score:</strong> {debugStats.friendly}%</div>
        <div><strong>Played Notes:</strong> {debugStats.played}</div>
        <div><strong>Skipped Notes:</strong> {debugStats.skipped}</div>
        <div><strong>Attempts:</strong> {debugStats.attempts}</div>
        <div><strong>Song:</strong> {songName || '—'}</div>
      </div>

      <div
        className="kf-chat-messages"
        style={{ maxHeight: '200px', overflowY: 'auto', background: '#f9f9f9', padding: '10px', borderRadius: '4px' }}
      >
        {messages.map((msg) => (
          <div key={msg.id} style={{ marginBottom: '8px', textAlign: msg.role === 'user' ? 'right' : 'left' }}>
            <span style={{ fontWeight: 'bold', color: msg.role === 'user' ? '#007bff' : '#28a745' }}>
              {msg.role === 'user' ? 'You: ' : 'Coach: '}
            </span>
            {msg.content}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '5px' }}>
        <input
          type="text"
          value={userMsg}
          onChange={(e) => setUserMsg(e.target.value)}
          placeholder="Ask for tips..."
          style={{ flexGrow: 1, padding: '5px' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') sendToCoach(false);
          }}
        />
        <button onClick={() => sendToCoach(false)} className="kf-btn kf-btn-accent">Send</button>
      </div>

      <button
        onClick={() => sendToCoach(true)}
        className="kf-btn kf-btn-purple"
        style={{ width: '100%' }}
      >
        Get Full Analysis
      </button>
    </div>
  );
}
