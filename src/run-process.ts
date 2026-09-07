import { ChildProcess, spawn } from "child_process";

/** Detached Unix children form one group, so cancellation also stops grandchildren. */
export function terminateProcessGroup(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform !== "win32" && proc.pid) {
    try { process.kill(-proc.pid, signal); return; } catch {}
  }
  try { proc.kill(signal); } catch {}
}

export class RunCancellation {
  private _cancelled = false;
  private active?: () => void;
  get cancelled(): boolean { return this._cancelled; }
  cancel(): void { this._cancelled = true; this.active?.(); }
  setProcess(proc: ChildProcess, terminate?: () => void): void {
    this.active = terminate ?? (() => terminateProcessGroup(proc));
    if (this._cancelled) this.active();
  }
  clearProcess(): void { this.active = undefined; }
}

export interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  rawExitCode?: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  maxBufferExceeded: boolean;
  error?: string;
}

/** spawn is required: Node's execFile does not forward detached to its child. */
export async function executeRunProcess(
  cmd: string, args: string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number;
  }, cancel?: RunCancellation,
): Promise<ProcessOutcome> {
  if (cancel?.cancelled) return {
    stdout: "", stderr: "Cancelled", exitCode: 130, rawExitCode: null, signal: null,
    timedOut: false, cancelled: true, maxBufferExceeded: false,
  };
  return new Promise((resolve) => {
    let timedOut = false; let maxBufferExceeded = false;
    let timeout: NodeJS.Timeout | undefined; let escalation: NodeJS.Timeout | undefined;
    let proc: ChildProcess;
    let error: Error | undefined;
    let outBytes = 0; let errBytes = 0;
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;
    const stop = () => {
      terminateProcessGroup(proc);
      if (!escalation) {
        escalation = setTimeout(() => terminateProcessGroup(proc, "SIGKILL"), 250);
        escalation.unref();
      }
    };
    const collect = (chunks: Buffer[], chunk: Buffer, bytes: number): number => {
      const remaining = Math.max(0, maxBuffer - bytes);
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining) {
        maxBufferExceeded = true;
        error = new Error(`Process output exceeded ${maxBuffer} bytes`);
        stop();
      }
      return bytes + chunk.length;
    };
    try {
      proc = spawn(cmd, args, { cwd: options.cwd, env: options.env,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout?.on("data", (chunk: Buffer) => { outBytes = collect(stdout, Buffer.from(chunk), outBytes); });
      proc.stderr?.on("data", (chunk: Buffer) => { errBytes = collect(stderr, Buffer.from(chunk), errBytes); });
      proc.on("error", (reason: Error & { code?: string }) => {
        error = reason;
        if (reason.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") maxBufferExceeded = true;
      });
      proc.on("close", (code, signal) => {
        if (timeout) clearTimeout(timeout);
        // A finished attempt must not leave background writers mutating its history.
        // The group leader has closed; this reaches only surviving descendants.
        terminateProcessGroup(proc, "SIGKILL");
        if (escalation) clearTimeout(escalation);
        cancel?.clearProcess();
        const failed = Boolean(error || signal || timedOut || cancel?.cancelled) || code !== 0;
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8") || (failed ? error?.message || (cancel?.cancelled ? "Cancelled" : timedOut ? "Run timed out" : "Process did not exit cleanly") : ""),
          exitCode: cancel?.cancelled ? 130 : timedOut ? 124 : failed ? (code || 1) : 0,
          rawExitCode: code, signal, timedOut, cancelled: Boolean(cancel?.cancelled), maxBufferExceeded,
          error: error?.message,
        });
      });
      cancel?.setProcess(proc, stop);
      timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 300_000);
      timeout.unref();
    } catch (reason) {
      if (timeout) clearTimeout(timeout);
      cancel?.clearProcess();
      resolve({ stdout: "", stderr: String(reason), exitCode: 1, rawExitCode: null, signal: null,
        timedOut: false, cancelled: Boolean(cancel?.cancelled), maxBufferExceeded: false, error: String(reason) });
    }
  });
}
