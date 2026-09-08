import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getDocumentConfig, getInkwellProjectRoot, getResolvedReferences } from "./config";
import { getTemplateForDocument } from "./templates";
import { bibliographyService } from "./bibliography-service";

/** Watch all project inputs, including scripts/globs and newly created dependencies.
 * Content identities for resolved configuration, references and templates complement
 * the watcher generation. No tool process or code block runs while checking it.
 */
export class CompileInputs implements vscode.Disposable {
  private projects = new Map<string, { generation: number; watcher: vscode.FileSystemWatcher; subscriptions: vscode.Disposable[] }>();
  private outputPaths = new Set<string>();
  private epoch = 0;
  private disposed = false;
  constructor(private onChange: () => void) {}

  private observe(root: string): number {
    if (this.disposed) throw new Error("Compile input tracking has stopped.");
    let project = this.projects.get(root);
    if (!project) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), "**/*"));
      project = { generation: 0, watcher, subscriptions: [] };
      const selected = project;
      const changed = (uri: vscode.Uri) => {
        const relative = path.relative(root, uri.fsPath).split(path.sep).join("/");
        const full = path.resolve(uri.fsPath);
        const temporary = path.basename(full).match(/^\.(.+\.pdf)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/);
        const publicationTemporary = temporary && this.outputPaths.has(path.join(path.dirname(full), temporary[1]));
        if (this.outputPaths.has(full) || publicationTemporary || /(^|\/)\.git(\/|$)/.test(relative) || /^\.inkwell\/(compiled|mermaid|\.cache)(\/|$)/.test(relative)) return;
        selected.generation++; this.onChange();
      };
      project.subscriptions.push(watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
      this.projects.set(root, project);
    }
    return project.generation;
  }

  invalidate(): void { this.epoch++; this.onChange(); }

  async fingerprint(document: vscode.TextDocument): Promise<string> {
    if (this.disposed) throw new Error("Compile input tracking has stopped.");
    const sourceFile = document.uri.fsPath;
    const root = getInkwellProjectRoot(sourceFile);
    this.outputPaths.add(path.resolve(path.dirname(sourceFile), `${path.basename(sourceFile, path.extname(sourceFile))}.pdf`));
    const generation = this.observe(root), epoch = this.epoch;
    const config = getDocumentConfig(document.getText(), sourceFile);
    const references = await bibliographyService.snapshot(getResolvedReferences(config, sourceFile));
    if (this.disposed) throw new Error("Compile input tracking has stopped.");
    const template = getTemplateForDocument(document);
    const templateGeneration = this.observe(template.dir);
    const files = [template.pandocTemplate, ...template.supportingFiles].sort();
    const hashes: [string, string][] = [];
    for (const file of files) {
      const hash = crypto.createHash("sha256");
      const before = await fs.promises.stat(file);
      if (!before.isFile()) throw new Error(`Template asset is not a regular file: ${file}`);
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
      const after = await fs.promises.stat(file);
      if (this.disposed) throw new Error("Compile input tracking has stopped.");
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Template changed while checking compile inputs; retry compilation.");
      hashes.push([file, hash.digest("hex")]);
    }
    // If a watcher fired while resolving, prevent a signature for mixed inputs.
    if (generation !== this.observe(root) || templateGeneration !== this.observe(template.dir) || epoch !== this.epoch) throw new Error("Project inputs changed while preparing compilation; retry compilation.");
    return crypto.createHash("sha256").update(JSON.stringify([
      sourceFile, document.version, document.getText(), config.fingerprint,
      references.fingerprint, hashes, template.manifest, generation, templateGeneration, epoch,
    ])).digest("hex");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.projects.values()) {
      for (const subscription of item.subscriptions) subscription.dispose();
      item.watcher.dispose();
    }
    this.projects.clear(); this.outputPaths.clear(); this.invalidate();
  }
}
