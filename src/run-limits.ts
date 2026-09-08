export interface RunLimits {
  retentionCount: number;
  maxStdoutBytes: number; maxStderrBytes: number;
  maxArtifactBytes: number; maxArtifactTotalBytes: number;
  maxInputPaths: number; maxInputBytes: number;
}
export const DEFAULT_RUN_LIMITS: Readonly<RunLimits> = Object.freeze({
  retentionCount: 10, maxStdoutBytes: 10 * 1024 ** 2, maxStderrBytes: 10 * 1024 ** 2,
  maxArtifactBytes: 500 * 1024 ** 2, maxArtifactTotalBytes: 2 * 1024 ** 3,
  maxInputPaths: 1000, maxInputBytes: 2 * 1024 ** 3,
});
export function runLimits(values: Partial<RunLimits> = {}): RunLimits {
  const limits = { ...DEFAULT_RUN_LIMITS };
  for (const key of Object.keys(limits) as (keyof RunLimits)[]) {
    const value = values[key];
    if (value === undefined) continue;
    const maximum = key === "retentionCount" ? 1000 : key === "maxInputPaths" ? 100000 : key === "maxStdoutBytes" || key === "maxStderrBytes" ? 1024 ** 3 : 16 * 1024 ** 3;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid run limit ${key}: expected an integer from 1 to ${maximum}.`);
    limits[key] = value;
  }
  return limits;
}
