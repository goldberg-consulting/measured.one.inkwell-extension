// Observed Python setup, independent of VS Code. Every subprocess receives
// executable/argv directly and readiness requires fresh interpreter + pip probes.
import * as fs from "fs";
import * as path from "path";
import { executeRunProcess, ProcessOutcome, RunCancellation } from "./run-process";

export type PythonSetupPhase = "preflight" | "create" | "install" | "verify" | "ready";

export interface PythonSetupOptions {
  projectDir: string;
  environmentDir: string;
  requirementsFile?: string;
  packages?: readonly string[];
  pythonCommand?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  cancel?: RunCancellation;
}

export interface PythonSetupStep {
  phase: PythonSetupPhase;
  command: string;
  args: string[];
  outcome: ProcessOutcome;
}

export interface PythonSetupResult {
  success: boolean;
  status: "ready" | "failed" | "cancelled";
  phase: PythonSetupPhase;
  message: string;
  environmentDir: string;
  pythonPath: string;
  pythonVersion?: string;
  exitCode: number | null;
  steps: PythonSetupStep[];
  log: string;
}

const IDENTITY_PROBE = "import json, platform, sys; print(json.dumps({'version': platform.python_version(), 'prefix': sys.prefix, 'basePrefix': sys.base_prefix}))";

function processSucceeded(result: ProcessOutcome): boolean {
  return result.exitCode === 0 && !result.signal && !result.timedOut &&
    !result.cancelled && !result.maxBufferExceeded && !result.error;
}

export async function setupPythonEnvironment(
  options: PythonSetupOptions,
  dependencies: { executeProcess?: typeof executeRunProcess } = {},
): Promise<PythonSetupResult> {
  const executeProcess = dependencies.executeProcess || executeRunProcess;
  const projectDir = path.resolve(options.projectDir);
  const environmentDir = path.resolve(projectDir, options.environmentDir);
  const pythonPath = path.join(environmentDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const steps: PythonSetupStep[] = [];
  const log: string[] = [];
  let phase: PythonSetupPhase = "preflight";
  let pythonVersion: string | undefined;
  const finish = (success: boolean, message: string): PythonSetupResult => ({
    success,
    status: success ? "ready" : steps.at(-1)?.outcome.cancelled || options.cancel?.cancelled ? "cancelled" : "failed",
    phase, message, environmentDir, pythonPath, pythonVersion,
    exitCode: steps.at(-1)?.outcome.exitCode ?? null,
    steps, log: [...log, message].join("\n"),
  });
  const run = async (command: string, args: string[]): Promise<boolean> => {
    log.push(`[inkwell] ${phase}: ${JSON.stringify({ command, args })}`);
    const outcome = await executeProcess(command, args, {
      cwd: projectDir,
      env: { ...process.env, ...options.env },
      timeoutMs: options.timeoutMs ?? 300_000,
    }, options.cancel);
    steps.push({ phase, command, args: [...args], outcome });
    log.push(outcome.stdout, outcome.stderr, `[inkwell] exit ${outcome.exitCode}${outcome.signal ? ` (${outcome.signal})` : ""}`);
    return processSucceeded(outcome);
  };
  const verifyIdentity = async (): Promise<boolean> => {
    if (!await run(pythonPath, ["-c", IDENTITY_PROBE])) return false;
    try {
      const identity = JSON.parse(steps.at(-1)!.outcome.stdout.trim());
      const expected = fs.realpathSync(environmentDir);
      const actual = fs.realpathSync(identity.prefix);
      if (actual !== expected || identity.prefix === identity.basePrefix ||
          typeof identity.version !== "string" || !/^\d+\.\d+\.\d+/.test(identity.version)) {
        log.push("The interpreter did not identify itself as the requested virtual environment.");
        return false;
      }
      pythonVersion = identity.version;
      return true;
    } catch {
      log.push("The interpreter returned an invalid virtual-environment identity.");
      return false;
    }
  };

  try {
    if (!fs.statSync(projectDir).isDirectory()) return finish(false, "The project directory does not exist.");
    const requirementsFile = options.requirementsFile ? path.resolve(projectDir, options.requirementsFile) : undefined;
    if (requirementsFile && !fs.statSync(requirementsFile).isFile()) return finish(false, "The requirements file does not exist.");
    if (options.packages?.some((value) => typeof value !== "string" || !value.trim() || value.includes("\0"))) {
      return finish(false, "Each Python package must be a nonempty package argument.");
    }
    if (fs.existsSync(environmentDir)) {
      if (!fs.existsSync(path.join(environmentDir, "pyvenv.cfg")) || !fs.existsSync(pythonPath)) {
        return finish(false, "The environment path exists but is not a Python virtual environment. Choose another path or repair this environment.");
      }
      if (!await verifyIdentity()) return finish(false, "The existing Python environment failed verification.");
    } else {
      phase = "create";
      if (!await run(options.pythonCommand || "python3", ["-m", "venv", environmentDir])) {
        return finish(false, "Python virtual-environment creation failed. See the setup log.");
      }
      if (!fs.existsSync(path.join(environmentDir, "pyvenv.cfg")) || !fs.existsSync(pythonPath)) {
        return finish(false, "Python reported success without creating a complete virtual environment.");
      }
      if (!await verifyIdentity()) return finish(false, "The newly created Python environment failed verification.");
    }

    if (requirementsFile || options.packages?.length) {
      phase = "install";
      const args = ["-m", "pip", "install"];
      if (requirementsFile) args.push("-r", requirementsFile);
      if (options.packages?.length) args.push("--", ...options.packages);
      if (!await run(pythonPath, args)) return finish(false, "Python dependency installation failed. See the setup log.");
    }

    phase = "verify";
    if (!await verifyIdentity()) return finish(false, "The final Python interpreter verification failed.");
    if (!await run(pythonPath, ["-m", "pip", "check"])) return finish(false, "The Python environment has missing or incompatible dependencies. See the setup log.");
    phase = "ready";
    return finish(true, `Python ${pythonVersion} environment is ready at ${environmentDir}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.push(message);
    return finish(false, `Python setup failed during ${phase}: ${message}`);
  }
}
