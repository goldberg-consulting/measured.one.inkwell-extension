import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getDocumentConfig, getInkwellProjectRoot } from "./config";
import { DocumentConfig } from "./document-config";
import { BIBLIOGRAPHY_SETTINGS, bibliographySettingValue, planBibliographyEdit, validateBibliographySetting } from "./bibliography-settings";
import { bibliographyService, resolveBibliographyConfiguration, validateReferencePath } from "./bibliography-service";
import { invalidateCitationPandoc } from "./citation-pandoc";

let generation = 0;
const seed = "% Add your BibTeX bibliography entries here.\n";
export async function configureBibliography(refresh?: () => void | Promise<void>, getConfig: (text: string, file: string) => DocumentConfig = getDocumentConfig): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown" || editor.document.isUntitled || editor.document.uri.scheme !== "file") {
    await vscode.window.showInformationMessage("Open a saved local Markdown document to configure its bibliography."); return false;
  }
  const document = editor.document, source = document.uri.fsPath, text = document.getText(), version = document.version, uri = document.uri.toString(), session = ++generation;
  const current = () => {
    if (!vscode.workspace.isTrusted) throw new Error("Trust the workspace before changing bibliography settings.");
    if (session !== generation || vscode.window.activeTextEditor !== editor || document.isClosed || document.version !== version || document.uri.toString() !== uri || document.getText() !== text) {
      throw new Error("The document changed while bibliography settings were open. Run Configure Bibliography again.");
    }
  };
  let created: { file: string; inode: number } | undefined, applied = false;
  try {
    current();
    const config = getConfig(text, source);
    const issue = config.diagnostics.find(item => item.severity === "error" && (item.code.startsWith("yaml-") || item.code.includes("manifest") || item.code === "config-section-type"));
    if (issue) throw new Error(issue.message);
    const setting = await vscode.window.showQuickPick(BIBLIOGRAPHY_SETTINGS.map(setting => {
      const capability = config.capabilities.options[setting.key], locked = capability && capability.support !== "supported";
      return { label: `${locked ? "$(lock) " : ""}${setting.label}`, description: String(bibliographySettingValue(config, setting.key) ?? ""),
        detail: locked ? capability.reason : setting.prompt, setting, locked };
    }), { title: "Configure Bibliography", placeHolder: "Choose a bibliography setting for this document", ignoreFocusOut: true });
    if (!setting) return false; current();
    if (setting.locked) { await vscode.window.showInformationMessage(setting.detail || "This setting is controlled by the template."); return false; }
    let value: unknown, createFile: string | undefined;
    const selectedFiles: string[] = [], root = getInkwellProjectRoot(source);
    const relative = (file: string) => path.relative(path.dirname(source), file).split(path.sep).join("/");
    if (setting.setting.kind === "bibliography") {
      const action = await vscode.window.showQuickPick([
        { label: "Choose existing bibliography files", action: "choose" }, { label: "Create a bibliography file", action: "create" },
      ], { title: "Bibliography files", ignoreFocusOut: true });
      if (!action) return false; current();
      if (action.action === "create") {
        const target = await vscode.window.showSaveDialog({ title: "Create bibliography", defaultUri: vscode.Uri.file(path.join(path.dirname(source), "refs.bib")), filters: { BibTeX: ["bib"] } });
        if (!target) return false; current();
        if (target.scheme !== "file" || path.extname(target.fsPath).toLowerCase() !== ".bib") throw new Error("Choose a local .bib file.");
        createFile = target.fsPath;
        validateReferencePath(root, createFile, true);
        // Promoting project defaults/discovery into document YAML must retain
        // their actual paths, even when this document is in a subdirectory.
        const existing = resolveBibliographyConfiguration(config, source, root).bibliography;
        selectedFiles.push(...existing);
        value = [...new Set([...existing.map(relative), relative(createFile)])];
      } else {
        const selected = await vscode.window.showOpenDialog({ title: "Choose this document's bibliography files", canSelectMany: true, canSelectFiles: true, canSelectFolders: false, filters: { BibTeX: ["bib"] } });
        if (!selected?.length) return false; current();
        if (selected.some(file => file.scheme !== "file" || path.extname(file.fsPath).toLowerCase() !== ".bib")) throw new Error("Choose local .bib files.");
        value = selected.map(file => relative(file.fsPath));
        selectedFiles.push(...selected.map(file => file.fsPath));
      }
    } else if (setting.setting.kind === "csl") {
      const selected = await vscode.window.showOpenDialog({ title: "Choose a CSL citation style", canSelectMany: false, canSelectFiles: true, canSelectFolders: false, filters: { CSL: ["csl"] } });
      if (!selected?.length) return false; current();
      if (selected[0].scheme !== "file" || path.extname(selected[0].fsPath).toLowerCase() !== ".csl") throw new Error("Choose a local .csl file.");
      value = relative(selected[0].fsPath);
      selectedFiles.push(selected[0].fsPath);
    } else if (setting.setting.choices) {
      const selected = await vscode.window.showQuickPick(setting.setting.choices.map(value => ({ label: typeof value === "boolean" ? value ? "Enabled" : "Disabled" : value, value })), { title: setting.setting.label, ignoreFocusOut: true });
      if (!selected) return false; current(); value = selected.value;
    } else {
      const initial = bibliographySettingValue(config, setting.setting.key);
      value = await vscode.window.showInputBox({ title: setting.setting.label, prompt: setting.setting.prompt,
        value: initial === undefined || initial === "Template-defined" ? "" : String(initial), ignoreFocusOut: true,
        validateInput: value => { try { validateBibliographySetting(config, setting.setting.key, value); return undefined; } catch (error) { return String((error as Error).message); } } });
      if (value === undefined) return false; current();
    }
    if (getConfig(text, source).fingerprint !== config.fingerprint) throw new Error("The document's configuration changed. Run Configure Bibliography again.");
    const plan = planBibliographyEdit(text, setting.setting.key, value, config);
    for (const file of selectedFiles) validateReferencePath(root, file);
    if (createFile) {
      validateReferencePath(root, createFile, true); current();
      const handle = await fs.promises.open(createFile, "wx", 0o600);
      try { created = { file: createFile, inode: (await handle.stat()).ino }; await handle.writeFile(seed, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      current();
    }
    applied = await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(plan.start), document.positionAt(plan.end)), plan.replacement), { undoStopBefore: true, undoStopAfter: true });
    if (!applied) throw new Error("The editor could not apply the bibliography setting. The document was preserved.");
    bibliographyService.invalidate(); invalidateCitationPandoc();
    await refresh?.();
    if (created) await vscode.window.showTextDocument(vscode.Uri.file(created.file), { preview: false });
    return true;
  } catch (error) {
    await vscode.window.showErrorMessage(`Bibliography settings: ${(error as Error).message}`); return applied;
  } finally {
    if (created && !applied) {
      try {
        const dirty = vscode.workspace.textDocuments.some(doc => doc.uri.fsPath === created!.file && doc.isDirty);
        if (!dirty && (await fs.promises.stat(created.file)).ino === created.inode && (await fs.promises.readFile(created.file, "utf8")) === seed) await fs.promises.unlink(created.file);
      } catch { /* Preserve anything no longer owned by this attempted edit. */ }
    }
  }
}
