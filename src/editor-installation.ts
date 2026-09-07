import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { executeRunProcess, ProcessOutcome, RunCancellation } from "./run-process";

export const EXTENSION_ID = "measure-one.inkwell";
export type EditorId = "cursor" | "code";
export type EditorSelection = "auto" | "all" | EditorId;
export type EditorProcess = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }, cancel?: RunCancellation) => Promise<ProcessOutcome>;
export interface EditorProbe {
  id: EditorId;
  label: string;
  path: string;
  version?: string;
  extensionVersion?: string;
  status: "ok" | "broken";
  message: string;
}
export interface EditorOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  applications?: string[];
  binDirectories?: string[];
  execute?: EditorProcess;
  executable?: (file: string) => boolean;
  cwd?: string;
}
const clean = (outcome: ProcessOutcome): boolean => outcome.exitCode === 0 && outcome.rawExitCode !== null &&
  !outcome.signal && !outcome.error && !outcome.timedOut && !outcome.cancelled && !outcome.maxBufferExceeded;

export function editorCandidates(id: EditorId, options: EditorOptions = {}): string[] {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const bins = options.binDirectories || ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin")];
  const apps = options.applications || ["/Applications", path.join(home, "Applications")];
  const app = id === "cursor" ? "Cursor.app" : "Visual Studio Code.app";
  return [...new Set([
    ...(env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, id)),
    ...bins.map(dir => path.join(dir, id)),
    ...apps.map(dir => path.join(dir, app, "Contents", "Resources", "app", "bin", id)),
  ])];
}

/** PATH and app-bundle discovery never sources a shell profile or changes it. */
export async function detectEditors(options: EditorOptions = {}): Promise<EditorProbe[]> {
  const execute = options.execute || executeRunProcess;
  const executable = options.executable || (file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  const processOptions = { cwd: options.cwd || options.home || os.homedir(), env: options.env || process.env, timeoutMs: 15000 };
  const editors = await Promise.all((["cursor", "code"] as const).map(async id => {
    let broken: EditorProbe | undefined;
    for (const candidate of editorCandidates(id, options)) {
      if (!executable(candidate)) continue;
      const version = await execute(candidate, ["--version"], processOptions);
      const probe: EditorProbe = { id, label: id === "cursor" ? "Cursor" : "VS Code", path: candidate,
        version: clean(version) ? version.stdout.trim().split(/\r?\n/)[0] : undefined,
        status: "broken", message: "Editor version probe failed." };
      if (!clean(version) || !probe.version) { broken ||= probe; continue; }
      const extensions = await execute(candidate, ["--list-extensions", "--show-versions"], processOptions);
      if (!clean(extensions)) { broken ||= { ...probe, message: "Editor extension list could not be read." }; continue; }
      const installed = extensions.stdout.split(/\r?\n/).map(line => line.trim()).find(line => line.toLowerCase().startsWith(EXTENSION_ID + "@"));
      return { ...probe, extensionVersion: installed?.slice(EXTENSION_ID.length + 1), status: "ok" as const, message: "Editor is executable and its installed extensions were read." };
    }
    return broken;
  }));
  return editors.filter((editor): editor is EditorProbe => Boolean(editor));
}

export function selectEditors(editors: EditorProbe[], selection: EditorSelection): EditorProbe[] {
  if (!["auto", "all", "cursor", "code"].includes(selection)) throw new Error(`Unsupported editor selection: ${selection}`);
  const selected = selection === "all" || selection === "auto" ? editors : editors.filter(editor => editor.id === selection);
  if (!selected.length) throw new Error(`No ${selection === "auto" || selection === "all" ? "supported" : selection} editor was detected. Install Cursor or VS Code, then repeat setup.`);
  const broken = selected.filter(editor => editor.status !== "ok");
  if (broken.length) throw new Error(`Editor checks failed: ${broken.map(editor => `${editor.label}: ${editor.message}`).join("; ")}`);
  return selected;
}

export async function installEditorArtifact(
  vsix: string, expectedVersion: string, editors: EditorProbe[], options: EditorOptions & { cancel?: RunCancellation } = {},
): Promise<{ success: boolean; editors: EditorProbe[]; log: string }> {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(expectedVersion)) throw new Error("Invalid expected extension version.");
  if (!path.isAbsolute(vsix) || !fs.statSync(vsix).isFile()) throw new Error("Select an existing absolute VSIX artifact path.");
  const execute = options.execute || executeRunProcess;
  const processOptions = { cwd: options.cwd || path.dirname(vsix), env: options.env || process.env, timeoutMs: 300000 };
  const results: EditorProbe[] = [], logs: string[] = [];
  for (const editor of editors) {
    const install = await execute(editor.path, ["--install-extension", vsix, "--force"], processOptions, options.cancel);
    logs.push(`${editor.label}: install ${EXTENSION_ID}@${expectedVersion}\n${install.stdout}\n${install.stderr}`);
    if (!clean(install)) { results.push({ ...editor, status: "broken", message: "Extension installation did not exit successfully." }); continue; }
    const verify = await execute(editor.path, ["--list-extensions", "--show-versions"], processOptions, options.cancel);
    logs.push(verify.stdout, verify.stderr);
    const exact = verify.stdout.split(/\r?\n/).map(line => line.trim().toLowerCase()).includes(`${EXTENSION_ID}@${expectedVersion}`.toLowerCase());
    results.push({ ...editor, extensionVersion: clean(verify) && exact ? expectedVersion : editor.extensionVersion,
      status: clean(verify) && exact ? "ok" : "broken", message: clean(verify) && exact ? `Verified ${EXTENSION_ID}@${expectedVersion}.` : `Could not verify ${EXTENSION_ID}@${expectedVersion}.` });
  }
  return { success: results.length > 0 && results.every(editor => editor.status === "ok" && editor.extensionVersion === expectedVersion), editors: results, log: logs.join("\n") };
}

/** Cask removal leaves a separately upgraded extension version in place. */
export async function uninstallEditorArtifact(expectedVersion: string, editors: EditorProbe[], options: EditorOptions = {}): Promise<{ success: boolean; log: string }> {
  const execute = options.execute || executeRunProcess;
  const logs: string[] = [];
  let success = true;
  for (const editor of editors) {
    if (editor.extensionVersion !== expectedVersion) {
      logs.push(`${editor.label}: ${editor.extensionVersion ? `preserved separately installed Inkwell ${editor.extensionVersion}` : "Inkwell is not installed"}.`); continue;
    }
    const processOptions = { cwd: options.cwd || os.homedir(), env: options.env || process.env, timeoutMs: 120000 };
    const removed = await execute(editor.path, ["--uninstall-extension", EXTENSION_ID], processOptions);
    logs.push(removed.stdout, removed.stderr);
    if (!clean(removed)) { success = false; continue; }
    const check = await execute(editor.path, ["--list-extensions", "--show-versions"], processOptions);
    if (!clean(check) || check.stdout.split(/\r?\n/).some(line => line.trim().toLowerCase() === `${EXTENSION_ID}@${expectedVersion}`.toLowerCase())) success = false;
    logs.push(check.stdout, check.stderr);
  }
  return { success, log: logs.join("\n") };
}
