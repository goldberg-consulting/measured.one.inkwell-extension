import * as path from "path";
import * as fs from "fs";
import { executeRunProcess, RunCancellation } from "./run-process";
import { executeInstallerProcess } from "./installer-process";
import { buildTexInvocationPath } from "./shell-env";

export async function runSmokeBuild(extensionRoot: string, outputRoot: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<{ success: boolean; verified: boolean; pdfPath?: string; logs: string[] }> {
  const cli = path.join(extensionRoot, "out", "smoke-cli.js");
  if (!fs.existsSync(cli)) return { success: false, verified: false, logs: ["The packaged headless compiler is missing. Reinstall Inkwell."] };
  fs.mkdirSync(outputRoot, { recursive: true });
  const cancellation = new RunCancellation();
  const cancel = () => cancellation.cancel();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const execute = process.platform === "win32" ? executeRunProcess : executeInstallerProcess;
    const result = await execute(process.execPath, [cli, path.resolve(outputRoot)], {
      cwd: outputRoot, env: { ...env, PATH: `${env.PATH || ""}${path.delimiter}${buildTexInvocationPath()}`, ELECTRON_RUN_AS_NODE: "1", INKWELL_HEADLESS: "1" }, timeoutMs: 120000,
      interactive: false, forwardOutput: false,
    }, cancellation);
    if (result.exitCode !== 0 || result.rawExitCode !== 0 || result.signal || result.timedOut || result.cancelled || result.maxBufferExceeded || result.error) {
      return { success: false, verified: false, logs: [result.stdout, result.stderr] };
    }
    const value = JSON.parse(result.stdout);
    return { success: value.success === true && value.verified === true, verified: value.verified === true, pdfPath: value.pdfPath, logs: Array.isArray(value.logs) ? value.logs : [] };
  } catch (error) { return { success: false, verified: false, logs: [String(error)] }; }
  finally { signal?.removeEventListener("abort", cancel); }
}
