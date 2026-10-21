import { useLayoutEffect, useState, type RefObject } from "react";
import { placeComposerPicker, type ComposerPickerPosition } from "./composerPhysicalRules.js";

/**
 * Shared @/slash popup geometry. Measure rendered content (not a guessed full
 * 256px panel), flip on insufficient headroom, and clamp against viewport
 * boundaries. The overlay remains fixed outside the clipping composer card.
 */
export function useComposerPickerPlacement(
  open: boolean,
  anchorRect: DOMRect | null,
  rootRef: RefObject<HTMLDivElement | null>,
  maxWidth: number,
): ComposerPickerPosition | null {
  const [position, setPosition] = useState<ComposerPickerPosition | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRect) {
      setPosition(null);
      return;
    }
    const calculate = () => {
      const el = rootRef.current;
      const height = Math.min(256, el ? Math.max(el.scrollHeight, el.getBoundingClientRect().height) : 256);
      const next = placeComposerPicker(
        anchorRect,
        height,
        { width: window.innerWidth, height: window.innerHeight },
        maxWidth,
      );
      setPosition((prev) =>
        prev && prev.left === next.left && prev.top === next.top &&
        prev.width === next.width && prev.maxHeight === next.maxHeight &&
        prev.side === next.side ? prev : next,
      );
    };
    calculate();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(calculate);
    if (rootRef.current) observer?.observe(rootRef.current);
    window.addEventListener("resize", calculate);
    window.addEventListener("scroll", calculate, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", calculate);
      window.removeEventListener("scroll", calculate, true);
    };
  }, [open, anchorRect, maxWidth, rootRef]);

  if (!open || !anchorRect) return null;
  return position ?? placeComposerPicker(
    anchorRect,
    256,
    { width: window.innerWidth, height: window.innerHeight },
    maxWidth,
  );
}
