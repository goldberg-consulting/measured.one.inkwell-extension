// Project scaffold. Creates the .inkwell/ directory structure, a starter
// markdown document with sensible frontmatter defaults, an optional
// Python venv, and a .gitignore that excludes build artifacts.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { selectTemplateCommand } from "./templates";

interface ScaffoldOptions {
  name: string;
  dir: string;
  template?: string;
  pythonEnv: boolean;
}

const DEFAULT_FRONTMATTER = `---
title: "Untitled"
author: ""
date: "\\\\today"
geometry: "margin=1in"
linestretch: 1.4
inkwell:
  code-bg: "#f5f5f5"
  code-border: true
  code-rounded: true
  code-font-size: small
  tables: booktabs
  hanging-indent: true
  code-display: output
---

`;

const GITIGNORE = `.inkwell/outputs/
.inkwell/compiled.*
*.aux
*.log
*.out
*.fls
*.fdb_latexmk
*.synctex.gz
__pycache__/
*.pyc
venv/
.venv/
`;

const MANIFEST_TEMPLATE = (template?: string) =>
  JSON.stringify(
    {
      template: template || "inkwell",
      settings: {},
    },
    null,
    2
  ) + "\n";

export async function initProject(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  let baseDir: string;

  if (workspaceFolders?.length) {
    baseDir = workspaceFolders[0].uri.fsPath;
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Select project folder",
    });
    if (!picked?.[0]) return;
    baseDir = picked[0].fsPath;
  }

  const name = await vscode.window.showInputBox({
    prompt: "Project name (used for the main document filename)",
    value: path.basename(baseDir),
    validateInput: (v) => (v.trim() ? null : "Name is required"),
  });
  if (!name) return;

  const templateId = await selectTemplateCommand();

  const envChoice = await vscode.window.showQuickPick(
    [
      { label: "Yes", detail: "Create a Python venv and requirements.txt" },
      { label: "No", detail: "Skip Python setup" },
    ],
    { placeHolder: "Set up a Python virtual environment?" }
  );

  const options: ScaffoldOptions = {
    name: name.trim(),
    dir: baseDir,
    template: templateId,
    pythonEnv: envChoice?.label === "Yes",
  };

  createStructure(options);

  if (options.pythonEnv) {
    const terminal = vscode.window.createTerminal("Inkwell Setup");
    terminal.show();
    const venvPath = path.join(options.dir, "venv");
    const reqPath = path.join(options.dir, "requirements.txt");
    terminal.sendText(
      `python3 -m venv "${venvPath}" && source "${venvPath}/bin/activate" && pip install -r "${reqPath}" && python3 --version`
    );
  }

  const docPath = path.join(options.dir, `${options.name}.md`);
  const doc = await vscode.workspace.openTextDocument(docPath);
  await vscode.window.showTextDocument(doc);

  vscode.window.showInformationMessage(`Inkwell project "${options.name}" initialized.`);
}

function createStructure(opts: ScaffoldOptions): void {
  const dirs = [
    ".inkwell",
    ".inkwell/outputs",
    "scripts",
    "figures",
    "references",
  ];

  for (const d of dirs) {
    fs.mkdirSync(path.join(opts.dir, d), { recursive: true });
  }

  const manifest = path.join(opts.dir, ".inkwell", "manifest.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, MANIFEST_TEMPLATE(opts.template));
  }

  const docPath = path.join(opts.dir, `${opts.name}.md`);
  if (!fs.existsSync(docPath)) {
    let frontmatter = DEFAULT_FRONTMATTER.replace(
      '"Untitled"',
      `"${opts.name}"`
    );
    if (opts.template) {
      frontmatter = frontmatter.replace(
        "---\n\n",
        `template: ${opts.template}\n---\n\n`
      );
    }
    if (opts.pythonEnv) {
      frontmatter = frontmatter.replace(
        "  code-display: output",
        "  code-display: output\n  python-env: ./venv"
      );
    }
    const body = `# ${opts.name}\n\n`;
    fs.writeFileSync(docPath, frontmatter + body);
  }

  const gitignore = path.join(opts.dir, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, GITIGNORE);
  }

  if (opts.pythonEnv) {
    const reqPath = path.join(opts.dir, "requirements.txt");
    if (!fs.existsSync(reqPath)) {
      fs.writeFileSync(reqPath, "# Add Python dependencies here\nnumpy\nmatplotlib\npandas\n");
    }
  }

  const exampleScript = path.join(opts.dir, "scripts", ".gitkeep");
  if (!fs.existsSync(exampleScript)) {
    fs.writeFileSync(exampleScript, "");
  }

  const figuresKeep = path.join(opts.dir, "figures", ".gitkeep");
  if (!fs.existsSync(figuresKeep)) {
    fs.writeFileSync(figuresKeep, "");
  }

  const refsKeep = path.join(opts.dir, "references", ".gitkeep");
  if (!fs.existsSync(refsKeep)) {
    fs.writeFileSync(refsKeep, "");
  }
}
