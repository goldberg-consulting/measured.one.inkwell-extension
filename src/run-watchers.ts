import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { getInkwellProjectRoot } from "./config";
import { containedRunPath } from "./run-paths";
import { parseCodeBlocks } from "./runner";

export interface RunWatchRefresh {
  projectRoot: string;
  sourceVersion: number;
  revision: number;
  changedPaths: readonly string[];
  /** Async consumers must check this before publishing their refreshed view. */
  isCurrent(): boolean;
}
export interface RunWatcherOptions {
  debounceMs?: number;
  onError?(error: unknown, document: vscode.TextDocument): void;
}
export interface RunWatcherRegistration extends vscode.Disposable {
  /** Invoke after preview/readiness opens a document to cover projects outside workspace folders. */
  observe(document: vscode.TextDocument): void;
}
type Refresh = (document: vscode.TextDocument, request: RunWatchRefresh) => void | Promise<void>;
interface PendingRefresh {
  document: vscode.TextDocument;
  projectRoot: string;
  realProjectRoot: string;
  revision: number;
  changedPaths: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}
interface ProjectWatch {
  documents: Set<vscode.TextDocument>;
  watcher: vscode.FileSystemWatcher;
  subscriptions: vscode.Disposable[];
}

function generatedPath(file: string): boolean {
  const segments = file.split(/[\\/]/);
  if (segments.includes(".git")) return true;
  return segments.some((segment, index) => segment === ".inkwell"
    && ["runs", "outputs", ".cache", "compiled", "mermaid"].includes((segments[index + 1] || "").toLowerCase()));
}
function runnable(document: vscode.TextDocument): boolean {
  return !document.isClosed && !document.isUntitled && document.uri.scheme === "file" && document.languageId === "markdown"
    && parseCodeBlocks(document.getText()).some(block => /^(python3?|r|node|javascript|shell|bash|sh)$/i.test(block.lang));
}

/** Passive notifications only: fingerprints remain owned by RunStore and no code runs here. */
export function registerRunWatchers(context: vscode.ExtensionContext, refresh: Refresh, options: RunWatcherOptions = {}): RunWatcherRegistration {
  const debounceMs = Math.min(2000, Math.max(1, options.debounceMs ?? 120));
  const pending = new Map<string, PendingRefresh>();
  const projects = new Map<string, ProjectWatch>();
  const observed = new Map<vscode.TextDocument, string>();
  let disposed = false;
  let revision = 0;
  // No document scans, filesystem reads, or interpreter/environment probes at registration.
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");

  const cancel = (key: string): void => {
    const item = pending.get(key);
    if (item?.timer) clearTimeout(item.timer);
    pending.delete(key);
  };
  const stillOpen = (document: vscode.TextDocument): boolean => vscode.workspace.textDocuments.includes(document) && runnable(document);
  const validProject = (item: PendingRefresh): boolean => {
    if (disposed || !vscode.workspace.isTrusted || !stillOpen(item.document)) return false;
    try {
      if (path.resolve(getInkwellProjectRoot(item.document.uri.fsPath)) !== item.projectRoot) return false;
      if (fs.realpathSync(item.projectRoot) !== item.realProjectRoot) return false;
      containedRunPath(item.projectRoot, item.document.uri.fsPath, true);
      return true;
    } catch { return false; }
  };
  const reportError = (error: unknown, document: vscode.TextDocument): void => {
    if (disposed || document.isClosed || !vscode.workspace.textDocuments.includes(document)) return;
    try { options.onError?.(error, document); } catch { /* Error reporting must not escape an async file listener. */ }
  };
  const dispatch = (key: string, item: PendingRefresh): void => {
    item.timer = undefined;
    if (pending.get(key) !== item || !validProject(item)) { if (pending.get(key) === item) pending.delete(key); return; }
    const sourceVersion = item.document.version;
    const thisRevision = item.revision;
    const changedPaths = Object.freeze([...item.changedPaths].filter(file => {
      try { containedRunPath(item.projectRoot, file, true); return true; } catch { return false; }
    }).sort());
    item.changedPaths.clear();
    if (!changedPaths.length) { pending.delete(key); return; }
    const request: RunWatchRefresh = {
      projectRoot: item.projectRoot, sourceVersion, revision: thisRevision, changedPaths,
      isCurrent: () => pending.get(key) === item && item.revision === thisRevision && item.document.version === sourceVersion && validProject(item),
    };
    try {
      void Promise.resolve(refresh(item.document, request)).catch(error => reportError(error, item.document));
    } catch (error) { reportError(error, item.document); }
  };
  const changed = (uri: vscode.Uri): void => {
    if (disposed || !vscode.workspace.isTrusted || uri.scheme !== "file" || generatedPath(uri.fsPath)) return;
    for (const document of vscode.workspace.textDocuments) {
      if (!runnable(document)) continue;
      let projectRoot: string; let realProjectRoot: string;
      try {
        projectRoot = path.resolve(getInkwellProjectRoot(document.uri.fsPath));
        containedRunPath(projectRoot, document.uri.fsPath, true);
        // allowMissing validates remaining real parents on delete events.
        containedRunPath(projectRoot, uri.fsPath, true);
        realProjectRoot = fs.realpathSync(projectRoot);
      } catch { continue; }
      const key = document.uri.toString();
      let item = pending.get(key);
      if (!item || item.document !== document || item.projectRoot !== projectRoot || item.realProjectRoot !== realProjectRoot) {
        cancel(key);
        item = { document, projectRoot, realProjectRoot, revision: ++revision, changedPaths: new Set() };
        pending.set(key, item);
      } else item.revision = ++revision;
      if (item.timer) clearTimeout(item.timer);
      // A burst can refresh a project once without retaining an unbounded path list.
      if (item.changedPaths.size < 1000) item.changedPaths.add(path.resolve(uri.fsPath));
      const selected = item;
      item.timer = setTimeout(() => dispatch(key, selected), debounceMs);
    }
  };
  const removeObservation = (document: vscode.TextDocument): void => {
    const root = observed.get(document);
    if (!root) return;
    observed.delete(document);
    const project = projects.get(root);
    project?.documents.delete(document);
    if (project && !project.documents.size) {
      for (const subscription of project.subscriptions) subscription.dispose();
      project.watcher.dispose(); projects.delete(root);
    }
  };
  const observe = (document: vscode.TextDocument): void => {
    if (disposed || !vscode.workspace.isTrusted || !stillOpen(document)) { removeObservation(document); return; }
    try {
      const root = path.resolve(getInkwellProjectRoot(document.uri.fsPath));
      containedRunPath(root, document.uri.fsPath, true);
      // Test coverage at the project root: an opened nested folder may omit its parent's inputs.
      if (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))) { removeObservation(document); return; }
      if (observed.get(document) === root) return;
      removeObservation(document);
      let project = projects.get(root);
      if (!project) {
        const projectWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), "**/*"));
        project = { documents: new Set(), watcher: projectWatcher,
          subscriptions: [projectWatcher.onDidChange(changed), projectWatcher.onDidCreate(changed), projectWatcher.onDidDelete(changed)] };
        projects.set(root, project);
      }
      project.documents.add(document); observed.set(document, root);
      // Observation is user/event initiated. Retain a shared watcher for already-open sibling documents too.
      for (const sibling of vscode.workspace.textDocuments) {
        if (sibling === document || !runnable(sibling)) continue;
        try {
          if (path.resolve(getInkwellProjectRoot(sibling.uri.fsPath)) !== root) continue;
          containedRunPath(root, sibling.uri.fsPath, true);
          if (observed.get(sibling) !== root) removeObservation(sibling);
          project.documents.add(sibling); observed.set(sibling, root);
        } catch { /* An unrelated or unsafe open document does not acquire this project watcher. */ }
      }
    } catch { removeObservation(document); }
  };
  const subscriptions = [
    watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
    vscode.workspace.onDidOpenTextDocument(observe),
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString();
      if (pending.get(key)?.document === document) cancel(key);
      removeObservation(document);
    }),
  ];
  const registration = new vscode.Disposable(() => {
    disposed = true;
    for (const key of pending.keys()) cancel(key);
    for (const subscription of subscriptions) subscription.dispose();
    for (const document of observed.keys()) removeObservation(document);
    watcher.dispose();
  });
  context.subscriptions.push(registration);
  return Object.assign(registration, { observe });
}
