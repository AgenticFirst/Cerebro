import { useState, useRef, useCallback, useEffect } from 'react';

const TTS_SAMPLE_RATE = 24000; // Orpheus outputs 24kHz audio

interface AudioPlaybackResult {
  playChunk: (base64Chunk: string) => void;
  stop: () => void;
  isPlaying: boolean;
  analyserNode: AnalyserNode | null;
}

export function useAudioPlayback(): AudioPlaybackResult {
  const [isPlaying, setIsPlaying] = useState(false);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const analyserRef = useRef<AnalyserNode | null>(null);

  const ensureContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      const ctx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(ctx.destination);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      setAnalyserNode(analyser);
      nextStartTimeRef.current = 0;
    }
    // Resume if suspended (browser autoplay policy)
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  const playChunk = useCallback(
    (base64Chunk: string) => {
      const ctx = ensureContext();
      const analyser = analyserRef.current;

      // Decode base64 → PCM int16 → float32
      const raw = atob(base64Chunk);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i);
      }
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      // Create AudioBuffer
      const buffer = ctx.createBuffer(1, float32.length, TTS_SAMPLE_RATE);
      buffer.getChannelData(0).set(float32);

      // Schedule for gapless playback
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      if (analyser) {
        source.connect(analyser);
      } else {
        source.connect(ctx.destination);
      }

      const now = ctx.currentTime;
      const startTime = Math.max(now, nextStartTimeRef.current);
      source.start(startTime);
      nextStartTimeRef.current = startTime + buffer.duration;

      activeSourcesRef.current.add(source);
      setIsPlaying(true);

      source.onended = () => {
        activeSourcesRef.current.delete(source);
        if (activeSourcesRef.current.size === 0) {
          setIsPlaying(false);
        }
      };
    },
    [ensureContext],
  );

  const stop = useCallback(() => {
    // Stop all active audio sources immediately
    for (const source of activeSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped
      }
    }
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsPlaying(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, [stop]);

  return { playChunk, stop, isPlaying, analyserNode };
}
