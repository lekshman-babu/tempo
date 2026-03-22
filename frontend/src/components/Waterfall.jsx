import React, { useEffect, useRef } from 'react';
import { playNote, stopNote } from '../lib/AudioEngine';

const generateNotePositions = (startOctave, endOctave) => {
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const positions = {};
  let currentLeft = 0;

  for (let oct = startOctave; oct <= endOctave; oct += 1) {
    notes.forEach((note) => {
      const isBlack = note.includes('#');
      if (isBlack) {
        positions[`${note}${oct}`] = { left: currentLeft - 12, width: 24, color: '#00f2fe' };
      } else {
        positions[`${note}${oct}`] = { left: currentLeft, width: 40, color: '#4facfe' };
        currentLeft += 40;
      }
    });
  }

  positions[`C${endOctave + 1}`] = { left: currentLeft, width: 40, color: '#4facfe' };
  currentLeft += 40;

  return { positions, totalWidth: currentLeft };
};

const { positions: NOTE_POSITIONS, totalWidth: WATERFALL_WIDTH } = generateNotePositions(2, 6);
const PIXELS_PER_SECOND = 150;
const WATERFALL_HEIGHT = 400;

export function Waterfall({
  notes = [],
  isPlaying,
  onReset,
  audioEnabled,
  activeNotes,
  isWaitMode,
  playbackTimeRef,
}) {
  const canvasRef = useRef(null);
  const timeRef = useRef(0);
  const lastFrameTimeRef = useRef(performance.now());
  const requestRef = useRef();
  const playingNotesRef = useRef(new Set());
  const activeNotesRef = useRef(activeNotes);

  useEffect(() => {
    activeNotesRef.current = activeNotes;
  }, [activeNotes]);

  const stopAllActiveNotes = () => {
    playingNotesRef.current.forEach((index) => {
      const note = notes[index];
      if (note) stopNote(note.note || note.name);
    });
    playingNotesRef.current.clear();
  };

  useEffect(() => {
    timeRef.current = 0;
    if (playbackTimeRef) playbackTimeRef.current = 0;
    lastFrameTimeRef.current = performance.now();
    stopAllActiveNotes();
  }, [notes, onReset, playbackTimeRef]);

  useEffect(() => {
    if (!isPlaying) stopAllActiveNotes();
  }, [isPlaying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');

    const draw = (now) => {
      const deltaSeconds = (now - lastFrameTimeRef.current) / 1000;
      lastFrameTimeRef.current = now;

      let shouldPause = false;
      const currentlyExpected = [];

      notes.forEach((note) => {
        const name = note.note || note.name;
        if (timeRef.current >= note.time && timeRef.current <= (note.time + note.duration - 0.05)) {
          currentlyExpected.push(name);
        }
      });

      if (isWaitMode && currentlyExpected.length > 0) {
        const missingNotes = currentlyExpected.filter((name) => !activeNotesRef.current.includes(name));
        if (missingNotes.length > 0) shouldPause = true;
      }

      if (isPlaying && !shouldPause) {
        timeRef.current += deltaSeconds;
      }

      if (playbackTimeRef) playbackTimeRef.current = timeRef.current;

      ctx.clearRect(0, 0, WATERFALL_WIDTH, WATERFALL_HEIGHT);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, WATERFALL_WIDTH, WATERFALL_HEIGHT);

      notes.forEach((note, index) => {
        const name = note.note || note.name;
        const pos = NOTE_POSITIONS[name];
        if (!pos) return;

        const bottomY = (note.time - timeRef.current) * PIXELS_PER_SECOND;
        const noteHeight = note.duration * PIXELS_PER_SECOND;
        const isNoteActive = timeRef.current >= note.time && timeRef.current <= (note.time + note.duration);

        if (audioEnabled && isPlaying && !isWaitMode) {
          if (isNoteActive && !playingNotesRef.current.has(index)) {
            playingNotesRef.current.add(index);
            playNote(name);
          } else if (!isNoteActive && playingNotesRef.current.has(index)) {
            playingNotesRef.current.delete(index);
            stopNote(name);
          }
        }

        if (bottomY <= WATERFALL_HEIGHT && bottomY + noteHeight >= 0) {
          let drawColor = pos.color;
          if (isNoteActive) {
            if (activeNotesRef.current.includes(name)) {
              drawColor = '#28a745';
            } else {
              drawColor = isWaitMode ? '#ffc107' : '#dc3545';
            }
          }

          ctx.fillStyle = drawColor;
          const drawY = WATERFALL_HEIGHT - bottomY - noteHeight;
          ctx.fillRect(pos.left, drawY, pos.width, noteHeight);
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.lineWidth = 2;
          ctx.strokeRect(pos.left, drawY, pos.width, noteHeight);
        }
      });

      requestRef.current = requestAnimationFrame(draw);
    };

    requestRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(requestRef.current);
  }, [notes, isPlaying, audioEnabled, isWaitMode, playbackTimeRef]);

  return (
    <canvas
      ref={canvasRef}
      width={WATERFALL_WIDTH}
      height={WATERFALL_HEIGHT}
      style={{
        display: 'block',
        border: '2px solid #333',
        borderBottom: '4px solid #ff4757',
        borderRadius: '8px 8px 0 0',
        backgroundColor: '#1a1a1a',
      }}
    />
  );
}
