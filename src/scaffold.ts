// Workspace commands delegate all scaffold writes to the shared migration service.
import * as vscode from "vscode";
import * as path from "path";
import { selectTemplateCommand } from "./templates";
import { setupPythonEnvironment } from "./python-setup";
import { getInkwellOutputChannel } from "./inkwell-output";
import { ProjectReadiness } from "./project-readiness";
import { ensureProjectReadyWithUI } from "./project-readiness-ui";
import { createScaffoldDocument, validateProjectName } from "./scaffold-migrations";
import { DEFAULT_FRONTMATTER, TEMPLATE_FRONTMATTER } from "./scaffold-assets";
export { validateProjectName } from "./scaffold-migrations";

async function pickWorkspaceRoot(
  openLabel: string
): Promise<string | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders?.length === 1) {
    return workspaceFolders[0].uri.fsPath;
  }
  if (workspaceFolders && workspaceFolders.length > 1) {
    const items = workspaceFolders.map((wf) => ({
      label: wf.name,
      detail: wf.uri.fsPath,
      path: wf.uri.fsPath,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Choose a workspace folder for Inkwell setup",
    });
    return picked?.path;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel,
  });
  return picked?.[0]?.fsPath;
}

async function prepareScaffold(root: string, template?: string): Promise<ProjectReadiness> {
  const result = await ensureProjectReadyWithUI({
    root, template, trusted: vscode.workspace.isTrusted !== false,
    explicitSetup: true, assetRoot: path.join(__dirname, ".."),
  });
  return result;
}

export type ScaffoldPreparation = (root: string, template?: string) => Promise<Pick<ProjectReadiness, "ready"> & Partial<ProjectReadiness>>;

export async function initProject(prepare: ScaffoldPreparation = prepareScaffold): Promise<void> {
  const root = await pickWorkspaceRoot("Select project folder");
  if (!root) return;
  const name = await vscode.window.showInputBox({
    prompt: "Project name (used for the main document filename)",
    value: path.basename(root), validateInput: validateProjectName,
  });
  if (!name) return;
  const invalid = validateProjectName(name);
  if (invalid) { await vscode.window.showErrorMessage(invalid); return; }
  const template = await selectTemplateCommand();
  if (!(await prepare(root, template)).ready) return;
  const python = await vscode.window.showQuickPick([
    { label: "Yes", detail: "Create a Python venv and install requirements.txt" },
    { label: "No", detail: "Skip Python setup" },
  ], { placeHolder: "Set up a Python virtual environment?" });
  let frontmatter = DEFAULT_FRONTMATTER.replace('"Untitled"', JSON.stringify(name.trim()));
  const templateStub = template && TEMPLATE_FRONTMATTER[template];
  if (templateStub) frontmatter = frontmatter.replace("---\n\n", `${templateStub}---\n\n`);
  else if (template) frontmatter = frontmatter.replace("---\n\n", `template: ${JSON.stringify(template)}\n---\n\n`);
  if (python?.label === "Yes") frontmatter = frontmatter.replace("  code-display: output", "  code-display: output\n  python-env: ./venv");
  const body = `# Introduction

Write your content here. Cite sources with [@knuth1984] and use inline math like $x^2$.

## Example Figures

\`\`\`{python file=".inkwell/scripts/sine_plot.py" output="sine_plot" caption="Fourier partial sums of a square wave." label="fourier"}
\`\`\`

\`\`\`{python file=".inkwell/scripts/scatter.py" output="scatter" caption="Scatter plot with linear regression." label="scatter"}
\`\`\`

## References
`;
  const documentPath = createScaffoldDocument(root, name.trim(), frontmatter + body);
  if (python?.label === "Yes" && !await setupScaffoldPython(root)) return;
  const document = await vscode.workspace.openTextDocument(documentPath);
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("setContext", "inkwell.projectCreated", true);
  await vscode.window.showInformationMessage(`Inkwell project "${name.trim()}" initialized.`);
}

export async function setupWorkspace(prepare: ScaffoldPreparation = prepareScaffold): Promise<void> {
  const root = await pickWorkspaceRoot("Select workspace root");
  if (!root) return;
  const readiness = await prepare(root);
  if (!readiness.ready) return;
  const python = await vscode.window.showQuickPick([
    { label: "Yes", detail: "Create a Python venv and install requirements.txt" },
    { label: "No", detail: "Skip Python setup" },
  ], { placeHolder: "Set up a Python virtual environment?" });
  if (python?.label === "Yes" && !await setupScaffoldPython(root)) return;
  await vscode.window.showInformationMessage(readiness.migration?.status === "up-to-date" || readiness.cached
    ? "Workspace is already up to date."
    : "Workspace setup complete.");
}

async function setupScaffoldPython(projectDir: string): Promise<boolean> {
  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Setting up the Python environment",
  }, () => setupPythonEnvironment({
    projectDir,
    environmentDir: path.join(projectDir, "venv"),
    requirementsFile: path.join(projectDir, "requirements.txt"),
  }));
  const output = getInkwellOutputChannel();
  output.appendLine(result.log);
  if (!result.success) {
    output.show(true);
    await vscode.window.showErrorMessage(`Project files are available, but Python setup did not complete: ${result.message}`);
  }
  return result.success;
}
