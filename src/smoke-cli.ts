import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import { compile } from "./compiler";
import { validatePdf } from "./pdf-publication";
import { configureHeadlessWorkspace, Uri } from "./headless-vscode";
import { runAllBlocks } from "./runner";
import { applyRunTextEdits, planBlockIdentities } from "./run-authoring";

/** Validation facade bundled into the VSIX: release demos exercise these exact
 * compiler/runner bytes, preserving one warm process across measured iterations.
 */
export function createHeadlessCompiler(projectRoot: string): { compile: typeof compile; runAllBlocks: typeof runAllBlocks; prepareRunSource: typeof prepareRunSource } {
  configureHeadlessWorkspace(projectRoot);
  return { compile, runAllBlocks, prepareRunSource };
}

/** Callers persist this transaction to their disposable document before running,
 * just as the editor authoring adapter does. Existing authored IDs are retained.
 */
export function prepareRunSource(text: string): string {
  let nextId = 0;
  return applyRunTextEdits(text, planBlockIdentities(text, () => `run-fixture-${++nextId}`));
}

export async function compileSmokeDocument(parent: string): Promise<{ success: boolean; verified: boolean; pdfPath?: string; logs: string[] }> {
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(path.resolve(parent), "inkwell-smoke-"));
  configureHeadlessWorkspace(root);
  fs.mkdirSync(path.join(root, ".inkwell"));
  fs.writeFileSync(path.join(root, ".inkwell", "manifest.json"), JSON.stringify({ schemaVersion: 1, scaffoldVersion: 4, template: "default", defaults: {}, managedFiles: {} }));
  const text = '---\ntitle: Inkwell installation verified\ntemplate: default\n---\n\n# Ready to write\n\nInkwell smoke test: the installed compiler produced this PDF.\n\nThe equation $x^2 + y^2 = z^2$ and a Markdown table verify the document pipeline.\n\n| Item | Result |\n|:--|:--|\n| Compiler | Verified |\n';
  const file = path.join(root, "installation-check.md");
  fs.writeFileSync(file, text, { flag: "wx" });
  const document = { uri: Uri.file(file), languageId: "markdown", version: 1, isUntitled: false, getText: () => text } as unknown as vscode.TextDocument;
  const result = await compile(document);
  let valid = false;
  if (result.success && result.pdfPath) {
    try { validatePdf(result.pdfPath); valid = true; } catch { valid = false; }
  }
  return { success: result.success && valid, verified: result.success && valid, pdfPath: result.pdfPath, logs: [result.message, result.logPath || "", result.log] };
}

if (require.main === module) {
  const parent = process.argv[2];
  if (!parent || !path.isAbsolute(parent)) {
    process.stderr.write("Usage: smoke-cli.js ABSOLUTE_OUTPUT_DIRECTORY\n"); process.exitCode = 2;
  } else {
    void compileSmokeDocument(parent).then(result => { process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.success ? 0 : 1; }, error => { process.stdout.write(JSON.stringify({ success: false, verified: false, logs: [String(error)] }) + "\n"); process.exitCode = 1; });
  }
}
