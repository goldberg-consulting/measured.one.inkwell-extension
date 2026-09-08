// Compatibility entry point for the existing Clear Code Block Cache command.
// Current outputs are owned and validated by RunStore, never cache.json.
import { clearGeneratedRuns } from "./run-store";

export function clearCache(cacheDir: string, sourceFile?: string): void {
  clearGeneratedRuns(cacheDir, sourceFile);
}
