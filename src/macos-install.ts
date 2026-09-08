import * as crypto from "crypto";
import * as path from "path";
import { executeRunProcess, ProcessOutcome, RunCancellation } from "./run-process";

export interface InstallationStep {
  id: string; label: string; command: string; args: string[]; cwd?: string;
  env?: NodeJS.ProcessEnv; verificationIds: string[];
}
export interface InstallationPlan {
  id: string; title: string; steps: InstallationStep[];
  diagnostics: string[]; requirementsHash: string;
}
export interface MacInstallationFacts {
  platform: string;
  brew?: string;
  tools: Record<string, { installed?: boolean; path?: string; status?: string }>;
  tex?: { root?: string; distribution?: "full" | "basic" | "tinytex" | "unknown"; writable?: boolean; ownedByCurrentUser?: boolean; tlmgr?: string };
  missingPackages: string[];
  requirementsHash: string;
  profile?: "full" | "lean";
  cwd: string;
}

/** Plan only the missing work. An existing TeX tree is never replaced or chowned. */
export function planMacInstallation(facts: MacInstallationFacts): InstallationPlan {
  const steps: InstallationStep[] = [], diagnostics: string[] = [];
  const add = (step: Omit<InstallationStep, "cwd">) => steps.push({ ...step, cwd: facts.cwd });
  const working = (name: string) => facts.tools[name]?.installed === true || facts.tools[name]?.status === "ok";
  if (facts.platform !== "darwin") diagnostics.push("Automatic system installation is available on macOS. The doctor report identifies the missing tools for this platform.");
  if (facts.platform === "darwin") {
    const formulas = [["pandoc", "pandoc"], ["crossref", "pandoc-crossref"], ["mmdc", "mermaid-cli"]].filter(([name]) => !working(name));
    if (formulas.length && !facts.brew) diagnostics.push("Homebrew was not found in PATH or its standard locations. Install Homebrew, then repeat Setup / Repair.");
    if (formulas.length && facts.brew) add({ id: "homebrew-tools", label: `Install ${formulas.map(([, formula]) => formula).join(", ")}`,
      command: facts.brew, args: ["install", ...formulas.map(([, formula]) => formula)], verificationIds: formulas.map(([name]) => `tool:${name === "crossref" ? "pandoc-crossref" : name}`) });
    const hasTexTree = Boolean(facts.tex?.root || facts.tools.xelatex?.path || facts.tools.pdflatex?.path);
    if (!working("xelatex") || !working("pdflatex")) {
      if (hasTexTree) {
        if (!facts.tex?.tlmgr) diagnostics.push("The existing TeX installation is incomplete. Its package manager was not found; repair this distribution before continuing.");
      } else if (!facts.brew) diagnostics.push("Homebrew is required to install the default MacTeX distribution.");
      else add({ id: "tex-distribution", label: facts.profile === "lean" ? "Install BasicTeX (must pass the full doctor)" : "Install full MacTeX",
        command: facts.brew, args: ["install", "--cask", facts.profile === "lean" ? "basictex" : "mactex"], verificationIds: ["tool:xelatex", "tool:pdflatex"] });
    }
    if (facts.tex?.root) {
      const packages = [...new Set([...facts.missingPackages, ...(!working("xelatex") ? ["xetex"] : []), ...(!working("pdflatex") ? ["pdftex"] : [])])].sort();
      if (packages.some(name => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) throw new Error("The installed requirements manifest contains an invalid TeX package name.");
      if (packages.length) {
        if (!facts.tex.tlmgr) diagnostics.push("The existing TeX distribution has no usable tlmgr package manager.");
        else if (facts.tex.distribution === "tinytex" && (!facts.tex.ownedByCurrentUser || !facts.tex.writable)) {
          diagnostics.push("This TinyTeX installation is not writable by its owner. Choose a working user-owned installation or repair its permissions before continuing. Inkwell will not change tree ownership.");
        } else {
          const userOwned = facts.tex.ownedByCurrentUser === true && facts.tex.writable === true;
          add({ id: "tex-packages", label: `Install ${packages.length} missing TeX packages${userOwned ? "" : " (administrator permission)"}`,
            command: userOwned ? facts.tex.tlmgr : "/usr/bin/sudo", args: [...(userOwned ? [] : [facts.tex.tlmgr]), "install", ...packages],
            verificationIds: packages.map(name => name === "xetex" ? "tool:xelatex" : name === "pdftex" ? "tool:pdflatex" : `tex-package:${name}`) });
        }
      }
    }
    // BasicTeX/TinyTeX need a Ghostscript executable for the shipped EPS assets.
    if ((facts.profile === "lean" || facts.tex?.distribution === "tinytex" || facts.tex?.distribution === "basic") && !working("ghostscript")) {
      if (facts.brew) add({ id: "ghostscript", label: "Install Ghostscript for template EPS assets", command: facts.brew, args: ["install", "ghostscript"], verificationIds: ["tool:ghostscript"] });
      else diagnostics.push("Ghostscript is required by the lean TeX profile and was not found.");
    }
  }
  const id = crypto.createHash("sha256").update(JSON.stringify({ steps, diagnostics, requirementsHash: facts.requirementsHash })).digest("hex");
  return { id, title: steps.length ? "Install missing Inkwell dependencies" : "Inkwell dependencies need no installation", steps, diagnostics, requirementsHash: facts.requirementsHash };
}

export type InstallProcess = typeof executeRunProcess;
export async function executeInstallationPlan(
  plan: InstallationPlan,
  options: { execute?: InstallProcess; cancel?: RunCancellation; onLog?: (text: string) => void; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessOutcome> {
  const log: string[] = [];
  const failed = (message: string): ProcessOutcome => ({ stdout: log.join("\n"), stderr: message, exitCode: 1, rawExitCode: null, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false });
  if (plan.diagnostics.length) return failed(plan.diagnostics.join("\n"));
  const execute = options.execute || executeRunProcess;
  for (const step of plan.steps) {
    const name = path.basename(step.command);
    const allowed = name === "brew" && step.args[0] === "install" || name === "tlmgr" && step.args[0] === "install" ||
      step.command === "/usr/bin/sudo" && path.basename(step.args[0] || "") === "tlmgr" && step.args[1] === "install";
    if (!allowed || !path.isAbsolute(step.command)) return failed(`Unsupported installer command: ${step.command}`);
    const message = `${step.label}\n${JSON.stringify([step.command, ...step.args])}`;
    log.push(message); options.onLog?.(message);
    const result = await execute(step.command, step.args, { cwd: step.cwd || process.cwd(), env: { ...(options.env || process.env), ...step.env }, timeoutMs: 60 * 60 * 1000 }, options.cancel);
    const output = `${result.stdout}\n${result.stderr}`;
    log.push(output); options.onLog?.(output);
    if (result.exitCode !== 0 || result.rawExitCode === null || result.signal || result.error || result.timedOut || result.cancelled || result.maxBufferExceeded) return { ...result, stdout: log.join("\n"), exitCode: result.exitCode || 1 };
  }
  return { stdout: log.join("\n"), stderr: "", exitCode: 0, rawExitCode: 0, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false };
}
