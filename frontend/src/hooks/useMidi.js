import { useState, useEffect, useRef } from 'react';

export const useMidi = ({ onNoteEvent } = {}) => {
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState(null);
  const [activeNotes, setActiveNotes] = useState({});
  const midiAccessRef = useRef(null);
  const onNoteEventRef = useRef(onNoteEvent);

  useEffect(() => {
    onNoteEventRef.current = onNoteEvent;
  }, [onNoteEvent]);

  useEffect(() => {
    const onMidiMessage = (event) => {
      const [command, note, velocity] = event.data;
      const noteName = midiNumberToNoteName(note);

      if (command === 144 && velocity > 0) {
        setActiveNotes((prev) => ({ ...prev, [noteName]: velocity }));
        onNoteEventRef.current?.({ type: 'note_on', note: noteName, velocity, source: 'physical' });
      } else if (command === 128 || (command === 144 && velocity === 0)) {
        setActiveNotes((prev) => {
          const next = { ...prev };
          delete next[noteName];
          return next;
        });
        onNoteEventRef.current?.({ type: 'note_off', note: noteName, velocity: 0, source: 'physical' });
      }
    };

    const setupMidi = async () => {
      if (!navigator.requestMIDIAccess) {
        setError('Web MIDI API is not supported in this browser.');
        setIsReady(false);
        return;
      }

      try {
        const midiAccess = await navigator.requestMIDIAccess();
        midiAccessRef.current = midiAccess;

        if (midiAccess.inputs.size > 0) {
          midiAccess.inputs.forEach((input) => {
            input.onmidimessage = onMidiMessage;
          });
          setIsReady(true);
          setError(null);
        } else {
          setError('No MIDI input devices found.');
        }

        midiAccess.onstatechange = (event) => {
          if (event.port.type === 'input' && event.port.state === 'connected') {
            event.port.onmidimessage = onMidiMessage;
            setIsReady(true);
            setError(null);
          } else if (event.port.type === 'input' && event.port.state === 'disconnected') {
            if (midiAccess.inputs.size === 0) {
              setError('MIDI device disconnected. No inputs remaining.');
              setIsReady(false);
            }
          }
        };
      } catch (err) {
        setError(`MIDI Access Error: ${err.message}`);
        setIsReady(false);
      }
    };

    setupMidi();

    return () => {
      if (midiAccessRef.current) {
        midiAccessRef.current.inputs.forEach((input) => {
          input.onmidimessage = null;
        });
      }
    };
  }, []);

  return { isReady, error, activeNotes };
};

function midiNumberToNoteName(midiNumber) {
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midiNumber / 12) - 1;
  const noteIndex = midiNumber % 12;
  return `${notes[noteIndex]}${octave}`;
}
