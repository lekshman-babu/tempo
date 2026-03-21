import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../lib/store';

export function CoachChat({ wsRef, matcherState, songName, mode }) {
  const [input, setInput] = useState('');
  const messages = useStore((s) => s.coachMessages);
  const addMessage = useStore((s) => s.addCoachMessage);
  const replaceLastMessage = useStore((s) => s.replaceLastCoachMessage);
  const isThinking = useStore((s) => s.isCoachThinking);
  const setThinking = useStore((s) => s.setCoachThinking);
  const scrollRef = useRef(null);
  const streamBufferRef = useRef('');

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isThinking]);

  // Listen for coach responses from WebSocket
  useEffect(() => {
    function handleWsMessage(event) {
      try {
        const data = JSON.parse(event.data);

        if (data.action === 'coach_chunk') {
          streamBufferRef.current += data.text;
          replaceLastMessage(streamBufferRef.current);
        }

        if (data.action === 'coach_done') {
          setThinking(false);
          streamBufferRef.current = '';
        }

        if (data.action === 'coach_response') {
          // Non-streaming fallback
          replaceLastMessage(data.text);
          setThinking(false);
          streamBufferRef.current = '';
        }
      } catch {}
    }

    const ws = wsRef?.current;
    if (ws) {
      ws.addEventListener('message', handleWsMessage);
      return () => ws.removeEventListener('message', handleWsMessage);
    }
  }, [wsRef, replaceLastMessage, setThinking]);

  function sendToCoach(text) {
    const userMsg = text || input.trim();
    if (!userMsg && !matcherState?.sessionStats?.totalNotes) return;

    const ws = wsRef?.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addMessage({ role: 'system', content: 'Server not connected. Start the Python server with: python server.py' });
      return;
    }

    if (userMsg) {
      addMessage({ role: 'learner', content: userMsg });
      setInput('');
    }

    setThinking(true);
    streamBufferRef.current = '';
    addMessage({ role: 'coach', content: '...' });

    const stats = matcherState?.sessionStats || {};
    const accuracy = stats.totalNotes > 0
      ? Math.round((stats.correctNotes / stats.totalNotes) * 100)
      : 0;

    ws.send(JSON.stringify({
      type: 'coach_request',
      message: userMsg || null,
      performance: {
        accuracy: `${accuracy}%`,
        streak: stats.streak || 0,
        bestStreak: stats.bestStreak || 0,
        totalNotes: stats.totalNotes || 0,
        correctNotes: stats.correctNotes || 0,
        phrasesCompleted: stats.phrasesCompleted || 0,
        errorTypes: stats.totalErrorsByType || {},
      },
      song: songName || 'Unknown',
      mode: mode || 'guided',
    }));
  }

  function requestFeedback() {
    const stats = matcherState?.sessionStats || {};
    const accuracy = stats.totalNotes > 0
      ? Math.round((stats.correctNotes / stats.totalNotes) * 100)
      : 0;
    sendToCoach(
      `I just finished a practice session. ${accuracy}% accuracy, ${stats.correctNotes || 0}/${stats.totalNotes || 0} notes, best streak: ${stats.bestStreak || 0}. Give me feedback.`
    );
  }

  return (
    <div className="kf-coach">
      <div className="kf-coach-header">
        <div className="kf-coach-avatar">✦</div>
        <div>
          <strong>AI Coach</strong>
          <span className="kf-coach-status">{isThinking ? 'thinking...' : 'ready'}</span>
        </div>
        {matcherState?.sessionStats?.totalNotes > 0 && (
          <button className="kf-btn-sm kf-btn-accent" onClick={requestFeedback}>
            Get feedback
          </button>
        )}
      </div>

      <div className="kf-coach-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="kf-coach-empty">
            <p>Start playing and I'll coach you in real-time!</p>
            <p className="dim">Or ask me anything about piano, theory, or technique.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`kf-msg kf-msg-${msg.role}`}>
            <div className={`kf-msg-bubble kf-msg-bubble-${msg.role}`}>
              {msg.content}
            </div>
          </div>
        ))}
        {isThinking && messages[messages.length - 1]?.content === '...' && (
          <div className="kf-msg kf-msg-coach">
            <div className="kf-msg-bubble kf-msg-bubble-coach">
              <span className="kf-dots">
                <span /><span /><span />
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="kf-coach-input">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendToCoach()}
          placeholder="Ask your coach anything..."
        />
        <button
          onClick={() => sendToCoach()}
          disabled={!input.trim() || isThinking}
          className="kf-btn-accent"
        >
          Send
        </button>
      </div>
    </div>
  );
}
