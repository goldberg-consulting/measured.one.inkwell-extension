// Build-time adapter for the headless compiler bundle. The extension bundle
// continues to import the real VS Code API; compiler code is shared unchanged.
import * as path from "path";
let root: string | undefined;
export function configureHeadlessWorkspace(directory: string): void { root = directory; }
export const Uri = { file: (file: string) => ({ fsPath: path.resolve(file), scheme: "file", toString: () => `file://${path.resolve(file)}` }) };
export const workspace = {
  isTrusted: true,
  getWorkspaceFolder: () => root ? { uri: Uri.file(root) } : undefined,
  getConfiguration: () => ({ get: (_name: string, fallback?: unknown) => fallback, inspect: () => ({}) }),
};
const unavailable = () => { throw new Error("This action needs an interactive editor. The headless compiler only builds documents."); };
export const window = { createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
  showErrorMessage: unavailable, showInformationMessage: unavailable, showSaveDialog: unavailable, showWarningMessage: unavailable,
  showQuickPick: unavailable, showTextDocument: unavailable, withProgress: unavailable, createTerminal: unavailable };
export const commands = { executeCommand: unavailable };
export const ProgressLocation = { Notification: 15 };
