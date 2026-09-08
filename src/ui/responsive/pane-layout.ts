export type PaneLayoutMode = "compact" | "regular" | "wide";

export interface PaneLayoutSnapshot {
  width: number;
  mode: PaneLayoutMode;
}

export const PANE_COMPACT_MAX = 439;
export const PANE_WIDE_MIN = 840;

export function resolvePaneLayout(width: number): PaneLayoutMode {
  if (width <= PANE_COMPACT_MAX) return "compact";
  if (width >= PANE_WIDE_MIN) return "wide";
  return "regular";
}

/**
 * Observe the actual ChatView content width. Never infer mobile/desktop from
 * window.innerWidth: a narrow desktop sidebar is functionally mobile-sized.
 */
export function observePaneLayout(
  node: HTMLElement,
  onChange: (snapshot: PaneLayoutSnapshot) => void,
): () => void {
  let lastWidth = -1;
  let lastMode: PaneLayoutMode | null = null;
  const publish = (width: number): void => {
    const rounded = Math.max(0, Math.round(width));
    const mode = resolvePaneLayout(rounded);
    node.dataset.ochattingPaneLayout = mode;
    node.style.setProperty("--ochatting-pane-width", `${rounded}px`);
    if (rounded === lastWidth && mode === lastMode) return;
    lastWidth = rounded;
    lastMode = mode;
    onChange({ width: rounded, mode });
  };

  publish(node.getBoundingClientRect().width);
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const width = entry?.contentRect.width ?? node.getBoundingClientRect().width;
      publish(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }

  const handler = () => publish(node.getBoundingClientRect().width);
  globalThis.addEventListener?.("resize", handler);
  return () => globalThis.removeEventListener?.("resize", handler);
}
