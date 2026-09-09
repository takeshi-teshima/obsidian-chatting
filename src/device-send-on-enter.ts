import { Platform } from "obsidian";
import type { ChatSettings } from "./types";

export type DeviceCategory = "desktop" | "phone" | "tablet";

/**
 * Obsidian's own device classification (`Platform.isTablet`/`isPhone`/
 * `isMobile`), not window width or a media query — this is genuinely about
 * which device/keyboard modality the user is on right now, which is exactly
 * what `Platform` is for (unlike layout, which must react to actual pane
 * width; see src/ui/responsive/pane-layout.ts's doc comments for why that
 * one deliberately avoids `Platform`). An iPad running the Obsidian mobile
 * app reports `isTablet` (and `isMobile`); a phone reports `isMobile` but
 * not `isTablet`; anything else (desktop app, or a browser/other context
 * lacking these flags) falls back to "desktop".
 */
export function currentDeviceCategory(): DeviceCategory {
  if (Platform.isTablet) return "tablet";
  if (Platform.isMobile) return "phone";
  return "desktop";
}

/** Resolves `ChatSettings.sendOnEnterByDevice` for the device this code is currently running on. */
export function resolveSendOnEnter(settings: Pick<ChatSettings, "sendOnEnterByDevice">): boolean {
  return settings.sendOnEnterByDevice[currentDeviceCategory()];
}
