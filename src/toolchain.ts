// Compatibility facade for the shared Doctor and tracked Setup / Repair workflow.
import * as vscode from "vscode";
import * as path from "node:path";
import { DoctorReport, runDoctor } from "./doctor";
import { TEX_PACKAGE_FILES } from "./tex-requirements";
import { buildTexInvocationPath } from "./shell-env";
import { validateRequestedPackage } from "./setup-adapters";

interface ToolStatus { installed: boolean; version?: string; path?: string }
export interface ToolchainStatus {
  pandoc: ToolStatus; xelatex: ToolStatus; pdflatex: ToolStatus; crossref: ToolStatus; mmdc: ToolStatus;
  missingPackages: string[]; texDistribution?: "full" | "basic" | "tinytex" | "unknown";
  texRoot?: string; texRootWritable?: boolean; texRootOwner?: string; currentUser?: string;
  report: DoctorReport;
}
let extensionPath = path.join(__dirname, "..");
let actions: { setup(): Promise<unknown>; installPackage(name: string): Promise<unknown> } | undefined;
export function setExtensionPath(value: string): void { extensionPath = value; }
export function setToolchainActions(value: typeof actions): void { actions = value; }

export async function checkToolchain(options: { cachedOnly?: boolean; mode?: "light" | "full"; workspaceRoot?: string } = {}): Promise<ToolchainStatus> {
  const report = await runDoctor({ extensionRoot: extensionPath, mode: options.mode || "light", cachedOnly: options.cachedOnly,
    workspaceRoot: options.workspaceRoot, env: { ...process.env, PATH: buildTexInvocationPath() } });
  const tool = (name: string): ToolStatus => ({ installed: report.tools[name]?.state === "ready", path: report.tools[name]?.path, version: report.tools[name]?.version });
  return { pandoc: tool("pandoc"), xelatex: tool("xelatex"), pdflatex: tool("pdflatex"), crossref: tool("pandoc-crossref"), mmdc: tool("mmdc"),
    missingPackages: report.missingPackages, texRoot: report.tex?.root, texRootWritable: report.tex?.writable,
    texRootOwner: report.tex?.ownerUid.toString(), currentUser: report.tex?.currentUid.toString(),
    texDistribution: report.tex?.distribution === "mactex" || report.tex?.distribution === "texlive" ? "full"
      : report.tex?.distribution === "basictex" ? "basic" : report.tex?.distribution, report };
}

export async function showToolchainStatus(): Promise<void> {
  if (actions) { await actions.setup(); return; }
  await vscode.commands.executeCommand("inkwell.setupRepair");
}

export async function installLatexPackage(packageName: string): Promise<void> {
  try {
    const name = validateRequestedPackage(packageName);
    if (!actions) throw new Error("Open Inkwell Setup / Repair before installing a TeX package.");
    await actions.installPackage(name);
  } catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
}

const FILE_TO_PACKAGE: Record<string, string> = {
  ...Object.fromEntries(Object.entries(TEX_PACKAGE_FILES).flatMap(([name, files]) => files.map(file => [file, name]))),
  "mathpazo.sty": "psnfss", "times.sty": "psnfss", "helvet.sty": "psnfss",
};
export function tlmgrPackageForFile(filename: string): string {
  const base = path.basename(filename);
  return FILE_TO_PACKAGE[base] || base.replace(/\.(sty|cls|ldf|def|clo|fd|cfg|bst)$/, "");
}
