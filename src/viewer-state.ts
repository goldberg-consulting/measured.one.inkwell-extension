/** Viewer preferences never enter document configuration or compile input. */
export interface ViewerState {
  schemaVersion: 1;
  fontScale: number;
  selectedTab: "preview" | "print" | "pdf" | "log";
  pdfFitMode: "width" | "page" | "custom";
  pdfZoom: number;
}

export type FontScaleAction = "decrease" | "increase" | "reset";

/** Self-contained so the webview and host execute exactly the same validation.
 * No external bindings: bundling/minification cannot break its serialized form.
 */
export function viewerStateRuntime() {
  function normalizeFontScale(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(200, Math.max(50, Math.round(value))) : 100;
  }

  function changeFontScale(current: unknown, action: FontScaleAction): number {
    return action === "reset" ? 100 : normalizeFontScale(normalizeFontScale(current) + (action === "increase" ? 10 : -10));
  }

  function readViewerState(value: unknown, initialFontScale = 100, defaultTab: ViewerState["selectedTab"] = "preview"): ViewerState {
    const saved = value && typeof value === "object" ? value as Partial<ViewerState> : {};
    return {
      schemaVersion: 1,
      fontScale: normalizeFontScale(saved.fontScale ?? initialFontScale),
      selectedTab: ["preview", "print", "pdf", "log"].includes(saved.selectedTab as string) ? saved.selectedTab! : defaultTab,
      pdfFitMode: ["width", "page", "custom"].includes(saved.pdfFitMode as string) ? saved.pdfFitMode! : "width",
      pdfZoom: typeof saved.pdfZoom === "number" && Number.isFinite(saved.pdfZoom) ? Math.min(400, Math.max(25, saved.pdfZoom)) : 100,
    };
  }

  return { normalizeFontScale, changeFontScale, readViewerState };
}

export const { normalizeFontScale, changeFontScale, readViewerState } = viewerStateRuntime();
