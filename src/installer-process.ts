import { execFile, spawn } from "child_process";
import { ProcessOutcome, RunCancellation } from "./run-process";

// The installer inherits only terminal descriptors; its supervisor owns the control pipe.
// Keeping the supervisor alive pins the process group until cleanup kills it.
const SUPERVISOR = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const send = value => fs.writeSync(3, JSON.stringify(value) + "\n");
setInterval(() => {}, 1000);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
send({ type: "ready", pid: process.pid });
let reported = false;
const report = value => { if (!reported) { reported = true; send({ type: "exit", ...value }); } };
try {
  const child = spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit" });
  child.on("error", error => report({ code: null, signal: null, error: error.message }));
  child.on("exit", (code, signal) => report({ code, signal }));
} catch (error) { report({ code: null, signal: null, error: String(error) }); }
`;

interface ProcessIdentity { pid: number; parent: number; group: number; state: string; born: string }
function processes(): Promise<Map<number, ProcessIdentity>> {
  return new Promise((resolve, reject) => {
    const failure = (error: unknown, stderr = "") => new Error(`Installer process-tree inspection failed: ${stderr.trim() || String(error)}`);
    try { execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="],
    { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(failure(error, stderr)); return; }
      const result = new Map<number, ProcessIdentity>();
      for (const line of stdout.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
        if (match) result.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), state: match[4], born: match[5] });
      }
      resolve(result);
    }); } catch (error) { reject(failure(error)); }
  });
}
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/** Freeze parents first, then repeat discovery so children cannot fork out of the snapshot. */
async function freezeTree(root: number, captured: Map<number, ProcessIdentity>, privileged: Set<number>): Promise<void> {
  for (let round = 0; round < 30; round++) {
    const snapshot = await processes();
    const rootProcess = snapshot.get(root);
    if (rootProcess && !captured.has(root)) captured.set(root, rootProcess);
    let added = false;
    for (let pass = 0; pass < snapshot.size; pass++) {
      let discovered = false;
      for (const current of snapshot.values()) {
        if (captured.has(current.pid)) continue;
        const parent = captured.get(current.parent);
        if (parent && snapshot.get(parent.pid)?.born === parent.born) {
          captured.set(current.pid, current); added = true; discovered = true;
        }
      }
      if (!discovered) break;
    }
    let allStopped = true;
    for (const recorded of captured.values()) {
      const current = snapshot.get(recorded.pid);
      if (!current || current.born !== recorded.born || /[TZ]/.test(current.state) || privileged.has(recorded.pid)) continue;
      allStopped = false;
      try { process.kill(recorded.pid, "SIGSTOP"); }
      catch (error: any) { if (error.code === "EPERM") privileged.add(recorded.pid); else if (error.code !== "ESRCH") throw error; }
    }
    if (!added && allStopped) return;
  }
  throw new Error("Installer process tree did not stop creating descendants during cancellation.");
}

/** macOS script supplies a private controlling PTY, so sudo retains its own password prompt. */
export function executeInstallerProcess(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number;
  /** Headless protocols need clean captured output without terminal echo. */
  interactive?: boolean;
  forwardOutput?: boolean;
}, cancel?: RunCancellation): Promise<ProcessOutcome> {
  const failure = (error: string): ProcessOutcome => ({ stdout: "", stderr: error, error, exitCode: cancel?.cancelled ? 130 : 1,
    rawExitCode: null, signal: null, cancelled: Boolean(cancel?.cancelled), timedOut: false, maxBufferExceeded: false });
  if (cancel?.cancelled) return Promise.resolve(failure("Cancelled"));
  if (process.platform === "win32") return Promise.resolve(failure("The interactive system installer is supported on macOS and POSIX hosts."));
  return new Promise(resolve => {
    const pty = process.platform === "darwin" && options.interactive !== false;
    const supervisorArgs = ["-e", SUPERVISOR, "--", command, ...args];
    let launcher: ReturnType<typeof spawn>;
    try {
      launcher = spawn(pty ? "/usr/bin/script" : process.execPath,
        pty ? ["-q", "/dev/null", process.execPath, ...supervisorArgs] : supervisorArgs,
        { cwd: options.cwd, env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" },
          detached: true, stdio: [options.interactive !== false && process.stdin.isTTY ? "inherit" : "ignore", "pipe", "pipe", "pipe"] });
    } catch (error) { resolve(failure(String(error))); return; }

    let stdout = "", stderr = "", control = "", retainedBytes = 0;
    let error: string | undefined, group: number | undefined;
    let exit: { code: number | null; signal: string | null } | undefined;
    let timedOut = false, maxBufferExceeded = false, stopping = false, killed = false;
    let cleanup: Promise<void> | undefined;
    const limit = options.maxBuffer ?? 50 * 1024 * 1024;
    const signalGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
      if (!pid || pid === process.pid) return;
      try { process.kill(-pid, signal); }
      catch (reason: any) { if (reason.code !== "ESRCH") error ||= `Installer cleanup failed: ${reason.message || String(reason)}`; }
    };
    const kill = () => {
      if (killed) return;
      killed = true;
      signalGroup(group, "SIGKILL");
      if (!group) signalGroup(launcher.pid, "SIGKILL");
    };
    const stop = () => {
      stopping = true;
      if (cleanup || killed || !launcher.pid) return;
      cleanup = (async () => {
        const captured = new Map<number, ProcessIdentity>();
        const privileged = new Set<number>();
        const incomplete = (message: string) => {
          const detail = `Installer cancellation is incomplete: ${message}`;
          error = error ? `${error}\n${detail}` : detail;
          if (options.forwardOutput !== false) process.stderr.write(detail + "\n");
          const available = Math.max(0, limit - retainedBytes);
          const retained = Buffer.from(detail + "\n").subarray(0, available);
          stderr += retained.toString("utf8"); retainedBytes += retained.length;
        };
        try {
          // The launcher's private session also contains a supervisor that has
          // not yet sent ready; this covers cancellation during Node startup.
          await freezeTree(launcher.pid!, captured, privileged);
          let snapshot = await processes();
          for (const recorded of captured.values()) {
            if (snapshot.get(recorded.pid)?.born !== recorded.born) continue;
            // Resume the sudo monitor so it can forward termination to its
            // privileged child even when this caller cannot signal that child.
            try { process.kill(recorded.pid, "SIGTERM"); process.kill(recorded.pid, "SIGCONT"); }
            catch (reason: any) { if (reason.code === "EPERM") privileged.add(recorded.pid); else if (reason.code !== "ESRCH") throw reason; }
          }
          await delay(250);
          snapshot = await processes();
          for (const recorded of [...captured.values()].reverse()) {
            const current = snapshot.get(recorded.pid);
            if (!current || current.born !== recorded.born) continue;
            try { process.kill(recorded.pid, "SIGKILL"); }
            catch (reason: any) { if (reason.code === "EPERM") privileged.add(recorded.pid); else if (reason.code !== "ESRCH") throw reason; }
          }
        } catch (reason) {
          incomplete(String(reason));
          // A partial freeze must not strand stopped descendants if ps itself
          // subsequently fails. Captured processes were stopped before return.
          for (const recorded of [...captured.values()].reverse()) {
            try { process.kill(recorded.pid, "SIGKILL"); } catch {}
          }
        }
        finally { kill(); }
        // Wait for captured descendants to die even if they moved into another
        // process group (for example a sudo monitor with its own nested PTY).
        if (captured.size) {
          for (let attempt = 0; attempt < 100; attempt++) {
            const snapshot = await processes();
            if (![...captured.values()].some(recorded => { const current = snapshot.get(recorded.pid); return current?.born === recorded.born && !current.state.includes("Z"); })) return;
            await delay(10);
          }
          incomplete(privileged.size ? "privileged descendants are still running; use their administrator task terminal to stop them."
            : "the process tree still contains running descendants.");
        }
      })().catch(reason => { error ||= `Installer cleanup could not verify completion: ${String(reason)}`; kill(); });
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 3600000);
    const startupTimer = setTimeout(() => {
      if (!group) { error ||= "Installer supervisor did not establish its private process group."; stop(); }
    }, 10000);
    const receive = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (options.forwardOutput !== false) process[stream].write(chunk);
      const remaining = Math.max(0, limit - retainedBytes);
      const text = chunk.subarray(0, remaining).toString("utf8");
      retainedBytes += Math.min(chunk.length, remaining);
      if (stream === "stdout") stdout += text; else stderr += text;
      if (chunk.length > remaining) { maxBufferExceeded = true; error ||= `Installer output exceeded ${limit} bytes.`; stop(); }
    };
    launcher.stdout?.on("data", (chunk: Buffer) => receive(chunk, "stdout"));
    launcher.stderr?.on("data", (chunk: Buffer) => receive(chunk, "stderr"));
    launcher.stdio[3]?.on("data", (chunk: Buffer) => {
      control += chunk.toString("utf8");
      if (control.length > 65536) { error ||= "Installer control channel exceeded its size limit."; stop(); return; }
      let newline: number;
      while ((newline = control.indexOf("\n")) >= 0) {
        const line = control.slice(0, newline); control = control.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === "ready" && !group && Number.isSafeInteger(message.pid) && message.pid > 1
              && message.pid !== process.pid && (pty || message.pid === launcher.pid)) {
            group = message.pid;
            clearTimeout(startupTimer);
            if (killed) signalGroup(group, "SIGKILL");
            else if (stopping) stop();
          } else if (message.type === "exit" && group && !exit && (message.code === null || Number.isInteger(message.code))
              && (message.signal === null || typeof message.signal === "string")) {
            exit = { code: message.code, signal: message.signal };
            if (message.error) error ||= String(message.error);
            if (!stopping) kill();
          } else throw new Error("Unexpected installer control message.");
        } catch (reason) { error ||= String(reason); stop(); }
      }
    });
    launcher.on("error", reason => { error ||= reason.message; });
    cancel?.setProcess(launcher, stop);
    launcher.on("close", async () => {
      clearTimeout(timer); clearTimeout(startupTimer);
      if (cleanup) await cleanup;
      if (!killed) kill();
      cancel?.clearProcess();
      if (!exit && !cancel?.cancelled && !timedOut) error ||= "Installer supervisor closed without an observed command exit.";
      const failed = !exit || exit.code !== 0 || exit.signal || error || timedOut || cancel?.cancelled || maxBufferExceeded;
      resolve({ stdout, stderr, error, exitCode: cancel?.cancelled ? 130 : timedOut ? 124 : failed ? exit?.code || 1 : 0,
        rawExitCode: exit?.code ?? null, signal: exit?.signal ?? null, timedOut, cancelled: Boolean(cancel?.cancelled), maxBufferExceeded });
    });
  });
}
