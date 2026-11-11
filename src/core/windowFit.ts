/**
 * The App's first window size, fitted to the screen it opens on (#144).
 *
 * The window opened at 1360 × 860 whatever the screen. A 14-inch Windows laptop at 1920 × 1200 runs at 150% scaling by
 * default, which leaves about 1280 × 752 of work area under the taskbar, so the window was taller than the screen and
 * whatever sat at the bottom of a picker (its "Resume selected" button) was below the edge.
 *
 * Never below the window's minimum (the OS then places it as best it can), never above the wanted size.
 */
export interface Size { width: number; height: number }

export function fitToWorkArea(want: Size, area: Size | null | undefined, min: Size): Size {
  if (!area || !(area.width > 0) || !(area.height > 0)) return { ...want };
  return {
    width: Math.max(min.width, Math.min(want.width, Math.floor(area.width))),
    height: Math.max(min.height, Math.min(want.height, Math.floor(area.height))),
  };
}
