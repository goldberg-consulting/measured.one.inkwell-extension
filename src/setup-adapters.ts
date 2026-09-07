import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DoctorReport } from "./doctor";
import { InstallationPlan, planMacInstallation } from "./macos-install";
import { InstallPlan } from "./setup-orchestrator";
import { loadTexRequirements, TEX_PACKAGE_FILES, texFileProbeArguments } from "./tex-requirements";
import { executeRunProcess, RunCancellation } from "./run-process";

/** Filesystem-only executable discovery shared by editor and headless setup. */
export function findSetupExecutable(name: string, report?: DoctorReport, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const known = report?.tools[name]?.path;
  const dirs = [...new Set([...(report?.tools.kpsewhich?.path ? [path.dirname(report.tools.kpsewhich.path)] : []),
    ...(env.PATH || "").split(path.delimiter), "/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
    path.join(os.homedir(), "Library/TinyTeX/bin/universal-darwin"), path.join(os.homedir(), ".TinyTeX/bin/x86_64-linux")].filter(Boolean))];
  for (const candidate of [...(known ? [known] : []), ...dirs.map(dir => path.join(dir, name))]) {
    try { if (path.isAbsolute(candidate) && fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } } catch {}
  }
  return undefined;
}

export function doctorToInstallationPlan(report: DoctorReport, options: {
  extensionRoot: string; cwd: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
  brew?: string; profile?: "full" | "lean"; requirementsHash?: string;
}): InstallationPlan {
  const names: Record<string, string> = { crossref: "pandoc-crossref" };
  const tools = Object.fromEntries(["pandoc", "xelatex", "pdflatex", "crossref", "mmdc", "ghostscript"].map(name => {
    const tool = report.tools[names[name] || name];
    return [name, { installed: tool?.state === "ready", path: tool?.path }];
  }));
  return planMacInstallation({ platform: options.platform || process.platform, cwd: options.cwd,
    brew: options.brew || findSetupExecutable("brew", report, options.env), tools,
    requirementsHash: options.requirementsHash || loadTexRequirements(options.extensionRoot).hash,
    missingPackages: report.missingPackages, profile: options.profile,
    tex: report.tex ? { root: report.tex.root, writable: report.tex.writable,
      ownedByCurrentUser: report.tex.ownerUid === report.tex.currentUid,
      distribution: report.tex.distribution === "mactex" || report.tex.distribution === "texlive" ? "full"
        : report.tex.distribution === "basictex" ? "basic" : report.tex.distribution,
      tlmgr: findSetupExecutable("tlmgr", report, options.env) } : undefined,
  });
}

export function asSetupPlan(plan: InstallationPlan): InstallPlan {
  if (plan.diagnostics.length) throw new Error(plan.diagnostics.join("\n"));
  return { ...plan, steps: plan.steps.map(step => ({ ...step,
    env: step.env ? Object.fromEntries(Object.entries(step.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) : undefined,
  })) };
}

export function validateRequestedPackage(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(normalized)) throw new Error("Use one TeX package name containing letters, numbers, dot, plus, underscore or hyphen.");
  return normalized;
}

export function requestedPackagePlan(report: DoctorReport, name: string, cwd: string, env?: NodeJS.ProcessEnv): InstallPlan {
  name = validateRequestedPackage(name);
  if (report.checks.some(check => check.id === `tex-package:${name}` && check.status === "ok")) return { id: `package:${name}:ready`, title: `${name} is already installed`, steps: [] };
  const tlmgr = findSetupExecutable("tlmgr", report, env);
  if (!tlmgr || !report.tex) throw new Error("A working TeX installation is required. Run Setup / Repair first.");
  if (report.tex.privilege === "repair-required") throw new Error(report.tex.message);
  const userOwned = report.tex.privilege === "user";
  return { id: `package:${name}`, title: `Install TeX package ${name}`, steps: [{ id: `package:${name}`, label: `Install ${name}${userOwned ? "" : " (administrator permission)"}`,
    command: userOwned ? tlmgr : "/usr/bin/sudo", args: [...(userOwned ? [] : [tlmgr]), "install", name], cwd,
    verificationIds: [`tex-package:${name}`] }] };
}

/** Exact known files, or tlmgr's local-only package inventory, verify an explicitly requested package. */
export async function probeRequestedPackage(report: DoctorReport, name: string, options: {
  cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; execute?: typeof executeRunProcess;
}): Promise<DoctorReport> {
  name = validateRequestedPackage(name);
  const result = structuredClone(report);
  const env = options.env || process.env, execute = options.execute || executeRunProcess;
  const cancellation = new RunCancellation(), abort = () => cancellation.cancel();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  let verified = false;
  try {
    const files = TEX_PACKAGE_FILES[name];
    const binary = findSetupExecutable(files ? "kpsewhich" : "tlmgr", report, env);
    if (binary) {
      const success = (outcome: Awaited<ReturnType<typeof execute>>) => outcome.exitCode === 0 && outcome.rawExitCode !== null && !outcome.signal && !outcome.cancelled && !outcome.timedOut && !outcome.maxBufferExceeded && !outcome.error;
      if (files) {
        verified = true;
        for (const file of files) {
          const outcome = await execute(binary, texFileProbeArguments(file), { cwd: options.cwd, env, timeoutMs: 10000 }, cancellation);
          const found = outcome.stdout.trim();
          if (!success(outcome) || !path.isAbsolute(found) || !fs.existsSync(found) || !fs.statSync(found).isFile()) { verified = false; break; }
        }
      } else {
        const outcome = await execute(binary, ["info", "--only-installed", "--data", "name", name], { cwd: options.cwd, env, timeoutMs: 10000 }, cancellation);
        verified = success(outcome) && outcome.stdout.trim().split(/\r?\n/).some(line => line === name || line === `"${name}"`);
      }
    }
  } finally { options.signal?.removeEventListener("abort", abort); }
  const check = { id: `tex-package:${name}`, required: true, status: verified ? "ok" as const : "error" as const,
    message: verified ? `Freshly verified TeX package ${name}.` : `TeX package ${name} did not pass its fresh installation probe.` };
  result.checks = [...result.checks.filter(candidate => candidate.id !== check.id), check];
  result.ready = result.checks.every(candidate => !candidate.required || candidate.status === "ok");
  result.status = result.checks.some(candidate => candidate.required && candidate.status === "error") ? "error" : result.ready ? "ok" : "warning";
  return result;
}
