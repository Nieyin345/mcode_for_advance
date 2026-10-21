import { useEffect, useRef } from "react";
import { useTickerReducedMotion } from "./useTickerReducedMotion.js";

export type VoiceMode = "idle" | "connecting" | "active";

/** The armed window is real: capture/ASR can still be acquiring a microphone. */
export function voiceModeOf(armed: boolean, busy: boolean): VoiceMode {
  return busy ? "active" : armed ? "connecting" : "idle";
}

const BANDS = [
  [1, 3], [3, 6], [6, 12], [12, 22], [22, 36], [36, 56],
] as const;
const WEIGHTS = [1.1, 1.2, 1.3, 1.2, 1, 0.9] as const;

/** Six independent speech bands. Inputs are analyser byte-frequency bins. */
export function speechBarHeights(
  spectrum: Uint8Array,
  minHeight = 4,
  maxHeight = 24,
): number[] {
  return BANDS.map(([start, end], i) => {
    let sum = 0;
    for (let bin = start; bin < end; bin++) sum += spectrum[bin] ?? 0;
    const normalized = sum / (end - start) / 255;
    const gated = Math.max(0, normalized - 0.08) / 0.92;
    const amplitude = Math.min(1, Math.pow(gated, 0.7) * 1.5 * WEIGHTS[i]);
    return minHeight + (maxHeight - minHeight) * amplitude;
  });
}

/**
 * Informational decoration next to the existing mic button. No new capture
 * permission or ASR session: only observes the stream already owned by
 * useVoiceInput. AudioContext/RAF are released at idle, stream replacement and
 * unmount. Reduced-motion preference (including Mcode's explicit override)
 * disables BOTH CSS pulse and the FFT animation.
 */
export function LiveMicActivityBars({
  mode,
  audioStream,
  size = 24,
}: {
  mode: VoiceMode;
  audioStream?: MediaStream | null;
  size?: number;
}) {
  const reduced = useTickerReducedMotion();
  const bars = useRef<(SVGRectElement | null)[]>([]);

  useEffect(() => {
    if (mode !== "active" || !audioStream || reduced) return;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let raf = 0;
    try {
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      analyser.minDecibels = -70;
      analyser.maxDecibels = -10;
      source = context.createMediaStreamSource(audioStream);
      source.connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const frame = () => {
        analyser.getByteFrequencyData(bins);
        const heights = speechBarHeights(bins);
        heights.forEach((height, i) => {
          const rect = bars.current[i];
          rect?.setAttribute("height", String(height));
          rect?.setAttribute("y", String((48 - height) / 2));
        });
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    } catch (err) {
      console.warn("[voice] mic activity visualization unavailable", err);
    }
    return () => {
      cancelAnimationFrame(raf);
      source?.disconnect();
      if (context) void context.close().catch(() => {});
    };
  }, [mode, audioStream, reduced]);

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className="live-mic-bars shrink-0 text-accent"
      data-mode={mode}
      data-reduced={String(reduced)}
    >
      {[11, 16, 21, 26, 31, 36].map((x, i) => {
        const height = mode === "idle" ? 4 : 7;
        return (
          <rect
            key={x}
            ref={(el) => { bars.current[i] = el; }}
            className="live-mic-bar"
            x={x}
            y={(48 - height) / 2}
            width={3}
            height={height}
            rx={1.5}
            fill="currentColor"
            opacity={mode === "idle" ? 0.45 : 1}
            style={{ animationDelay: `${i * 150}ms` }}
          />
        );
      })}
    </svg>
  );
}
