import React from 'react';

export function ScoreDisplay({ matcherState, currentExpectedNote }) {
  const uiStats = matcherState?.uiStats || {};
  const sessionStats = matcherState?.sessionStats || {};
  const played = uiStats.playedNotes || 0;
  const correctPlayed = uiStats.correctPlayedNotes || 0;
  const friendlyScore = played > 0 ? Math.round((correctPlayed / played) * 100) : 0;

  return (
    <div className="kf-score-bar">
      <div className="kf-score-item">
        <span className="kf-score-label">Next Note</span>
        <span className="kf-score-value">{currentExpectedNote?.note || '—'}</span>
      </div>
      <div className="kf-score-item">
        <span className="kf-score-label">Score</span>
        <span className="kf-score-value neon">{played > 0 ? `${friendlyScore}%` : '—'}</span>
      </div>
      <div className="kf-score-item">
        <span className="kf-score-label">Streak</span>
        <span className="kf-score-value gold">{sessionStats.streak || 0}</span>
      </div>
      <div className="kf-score-item">
        <span className="kf-score-label">Attempts</span>
        <span className="kf-score-value">{sessionStats.attemptsCompleted || 0}</span>
      </div>
    </div>
  );
}
