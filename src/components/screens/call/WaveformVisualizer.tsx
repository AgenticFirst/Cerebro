import { useRef, useEffect } from 'react';

interface WaveformVisualizerProps {
  analyserNode: AnalyserNode | null;
  color?: string;
  barCount?: number;
}

export default function WaveformVisualizer({
  analyserNode,
  color = '#06b6d4',
  barCount = 32,
}: WaveformVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dataArray = analyserNode
      ? new Uint8Array(analyserNode.frequencyBinCount)
      : null;

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      if (analyserNode && dataArray) {
        analyserNode.getByteFrequencyData(dataArray);
      }

      const barWidth = width / barCount;
      const gap = 2;

      for (let i = 0; i < barCount; i++) {
        let value: number;
        if (dataArray && analyserNode) {
          // Map bar index to frequency bin
          const binIndex = Math.floor((i / barCount) * (dataArray.length * 0.6));
          value = dataArray[binIndex] / 255;
        } else {
          // Idle animation: gentle sine wave
          value = 0.05 + Math.sin(Date.now() / 800 + i * 0.3) * 0.03;
        }

        const barHeight = Math.max(2, value * height * 0.8);
        const x = i * barWidth + gap / 2;
        const y = (height - barHeight) / 2;

        ctx.fillStyle = color;
        ctx.globalAlpha = 0.3 + value * 0.7;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth - gap, barHeight, 1);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
    };

    draw();

    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [analyserNode, color, barCount]);

  return (
    <canvas
      ref={canvasRef}
      width={320}
      height={40}
      className="w-80 h-10 opacity-70"
    />
  );
}
