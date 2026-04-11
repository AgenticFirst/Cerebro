import { useState, useRef, useCallback, useEffect } from 'react';

const SAMPLE_RATE = 16000;
// ScriptProcessorNode requires a power-of-2 buffer size (256–16384).
// 2048 at 16 kHz ≈ 128 ms per chunk — close to our 100 ms target.
const BUFFER_SIZE = 2048;

interface AudioCaptureResult {
  start: () => Promise<void>;
  stop: () => void;
  isMuted: boolean;
  setMuted: (muted: boolean) => void;
  isCapturing: boolean;
  analyserNode: AnalyserNode | null;
  error: string | null;
}

export function useAudioCapture(
  onChunk: (chunk: ArrayBuffer) => void,
): AudioCaptureResult {
  const [isCapturing, setIsCapturing] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const mutedRef = useRef(isMuted);

  // Keep muted ref in sync + update gain node for visual feedback
  useEffect(() => {
    mutedRef.current = isMuted;
    if (gainRef.current) {
      gainRef.current.gain.value = isMuted ? 0 : 1;
    }
  }, [isMuted]);

  const start = useCallback(async () => {
    // Don't start twice
    if (audioContextRef.current) return;

    try {
      setError(null);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      const source = ctx.createMediaStreamSource(stream);

      // GainNode controls mute — affects both analyser (visualization)
      // and processor (chunk extraction), so waveform goes flat when muted
      const gain = ctx.createGain();
      gain.gain.value = mutedRef.current ? 0 : 1;
      source.connect(gain);

      // Analyser for visualization (connected after gain, so mute = flat)
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      gain.connect(analyser);

      // ScriptProcessor for extracting PCM samples
      const processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);

      processor.onaudioprocess = (event) => {
        if (mutedRef.current) return;

        const inputData = event.inputBuffer.getChannelData(0);
        // Convert float32 [-1, 1] to int16 [-32768, 32767]
        const int16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        onChunk(int16.buffer);
      };

      gain.connect(processor);
      processor.connect(ctx.destination);

      audioContextRef.current = ctx;
      streamRef.current = stream;
      processorRef.current = processor;
      sourceRef.current = source;
      gainRef.current = gain;
      setAnalyserNode(analyser);
      setIsCapturing(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone access denied';
      setError(message);
      console.error('[AudioCapture] Failed to start:', err);
    }
  }, [onChunk]);

  const stop = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (gainRef.current) {
      gainRef.current.disconnect();
      gainRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setAnalyserNode(null);
    setIsCapturing(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    start,
    stop,
    isMuted,
    setMuted: setIsMuted,
    isCapturing,
    analyserNode,
    error,
  };
}
