// Project scaffold. Creates the .inkwell/ directory structure, a starter
// markdown document with sensible frontmatter defaults, an optional
// Python venv, and a .gitignore that excludes build artifacts.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { selectTemplateCommand } from "./templates";

const SCAFFOLD_VERSION = 2;

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
bibliography: references/refs.bib
link-citations: true
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

const STARTER_BIB = `@article{knuth1984,
  author  = {Knuth, Donald E.},
  title   = {Literate Programming},
  journal = {The Computer Journal},
  volume  = {27},
  number  = {2},
  pages   = {97--111},
  year    = {1984},
  doi     = {10.1093/comjnl/27.2.97}
}

@software{macfarlane2023,
  author  = {MacFarlane, John},
  title   = {Pandoc: A Universal Document Converter},
  year    = {2023},
  url     = {https://pandoc.org}
}

@article{harris2020,
  author  = {Harris, Charles R. and others},
  title   = {Array programming with {NumPy}},
  journal = {Nature},
  volume  = {585},
  pages   = {357--362},
  year    = {2020},
  doi     = {10.1038/s41586-020-2649-2}
}

@article{hunter2007,
  author  = {Hunter, John D.},
  title   = {Matplotlib: A {2D} graphics environment},
  journal = {Computing in Science \\& Engineering},
  volume  = {9},
  number  = {3},
  pages   = {90--95},
  year    = {2007},
  doi     = {10.1109/MCSE.2007.55}
}
`;

const SINE_PLOT_PY = `import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

x = np.linspace(0, 4 * np.pi, 500)
fig, ax = plt.subplots(figsize=(6, 3))
for n in [1, 3, 5, 9]:
    y = sum(np.sin((2*k-1)*x) / (2*k-1) for k in range(1, n+1)) * 4 / np.pi
    ax.plot(x, y, label=f"$n={n}$", linewidth=1.2)
ax.axhline(1, color="black", linestyle="--", linewidth=0.5, alpha=0.4)
ax.axhline(-1, color="black", linestyle="--", linewidth=0.5, alpha=0.4)
ax.set_xlabel("$x$")
ax.set_ylabel("$f_n(x)$")
ax.set_title("Fourier Partial Sums of a Square Wave")
ax.legend(fontsize=8)
ax.grid(alpha=0.2)
fig.tight_layout()

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
fig.savefig(os.path.join(out, "sine_plot.png"), dpi=200, bbox_inches="tight")
plt.close(fig)
print("Fourier partial sums generated.")
`;

const SCATTER_PY = `import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

rng = np.random.default_rng(42)
x = rng.normal(0, 1, 150)
y = 0.7 * x + rng.normal(0, 0.35, 150)

fig, ax = plt.subplots(figsize=(5, 3.5))
ax.scatter(x, y, s=14, alpha=0.6, color="#4A90D9")
m, b = np.polyfit(x, y, 1)
xs = np.sort(x)
ax.plot(xs, m * xs + b, color="#E74C3C", linewidth=1.5,
        label=f"$y = {m:.2f}x {'+' if b >= 0 else ''}{b:.2f}$")
ax.set_xlabel("$x$")
ax.set_ylabel("$y$")
ax.legend()
ax.grid(alpha=0.2)
fig.tight_layout()

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
fig.savefig(os.path.join(out, "scatter.png"), dpi=200, bbox_inches="tight")
plt.close(fig)

r = np.corrcoef(x, y)[0, 1]
print(f"n = {len(x)}, r = {r:.3f}, slope = {m:.3f}")
`;

const MANIFEST_TEMPLATE = (template?: string) =>
  JSON.stringify(
    {
      scaffoldVersion: SCAFFOLD_VERSION,
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
    const body = `# Introduction

Write your content here. Cite sources with [@knuth1984] and use inline math like $x^2$.

## Example Figures

\`\`\`{python file="scripts/sine_plot.py" output="sine_plot" caption="Fourier partial sums of a square wave." label="fourier"}
\`\`\`

\`\`\`{python file="scripts/scatter.py" output="scatter" caption="Scatter plot with linear regression." label="scatter"}
\`\`\`

## References
`;
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

  const sinePlot = path.join(opts.dir, "scripts", "sine_plot.py");
  if (!fs.existsSync(sinePlot)) {
    fs.writeFileSync(sinePlot, SINE_PLOT_PY);
  }

  const scatterPlot = path.join(opts.dir, "scripts", "scatter.py");
  if (!fs.existsSync(scatterPlot)) {
    fs.writeFileSync(scatterPlot, SCATTER_PY);
  }

  const figuresKeep = path.join(opts.dir, "figures", ".gitkeep");
  if (!fs.existsSync(figuresKeep)) {
    fs.writeFileSync(figuresKeep, "");
  }

  const refsBib = path.join(opts.dir, "references", "refs.bib");
  if (!fs.existsSync(refsBib)) {
    fs.writeFileSync(refsBib, STARTER_BIB);
  }

  copyDemoFiles(opts.dir);
}

// ── Update Project ─────────────────────────────────────────────────

const GITIGNORE_LINES = GITIGNORE.split("\n").map((l) => l.trim()).filter(Boolean);

const REQUIRED_DIRS = [".inkwell", ".inkwell/outputs", "scripts", "figures", "references", "examples"];

const STARTER_FILES: Array<{ rel: string; content: string }> = [
  { rel: "scripts/sine_plot.py", content: SINE_PLOT_PY },
  { rel: "scripts/scatter.py", content: SCATTER_PY },
  { rel: "references/refs.bib", content: STARTER_BIB },
  { rel: "figures/.gitkeep", content: "" },
];

function copyDemoFiles(projectRoot: string): string[] {
  const extensionExamples = path.join(__dirname, "..", "examples");
  const destDir = path.join(projectRoot, "examples");
  const copied: string[] = [];

  if (!fs.existsSync(extensionExamples)) return copied;

  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(extensionExamples)) {
    if (!entry.endsWith(".md")) continue;
    const src = path.join(extensionExamples, entry);
    const dest = path.join(destDir, entry);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      copied.push(`examples/${entry}`);
    }
  }
  return copied;
}

function updateGitignore(projectRoot: string): string[] {
  const gi = path.join(projectRoot, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(gi, "utf-8");
  } catch {}

  const existingSet = new Set(
    existing.split("\n").map((l) => l.trim()).filter(Boolean)
  );
  const added: string[] = [];
  for (const line of GITIGNORE_LINES) {
    if (!existingSet.has(line)) {
      added.push(line);
    }
  }

  if (added.length) {
    const suffix = (existing.endsWith("\n") ? "" : "\n") + added.join("\n") + "\n";
    fs.writeFileSync(gi, existing + suffix, "utf-8");
  }
  return added;
}

function updateManifest(projectRoot: string): string[] {
  const mp = path.join(projectRoot, ".inkwell", "manifest.json");
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(mp, "utf-8"));
  } catch {}

  const changes: string[] = [];

  if (!manifest.template) {
    manifest.template = "inkwell";
    changes.push("added default template");
  }
  if (!manifest.settings) {
    manifest.settings = {};
    changes.push("added settings block");
  }

  const prev = (manifest.scaffoldVersion as number) || 0;
  if (prev < SCAFFOLD_VERSION) {
    manifest.scaffoldVersion = SCAFFOLD_VERSION;
    changes.push(`scaffoldVersion ${prev} -> ${SCAFFOLD_VERSION}`);
  }

  fs.mkdirSync(path.dirname(mp), { recursive: true });
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return changes;
}

function ensureDirs(projectRoot: string): string[] {
  const created: string[] = [];
  for (const d of REQUIRED_DIRS) {
    const full = path.join(projectRoot, d);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
      created.push(d);
    }
  }
  return created;
}

function ensureStarterFiles(projectRoot: string): string[] {
  const created: string[] = [];
  for (const { rel, content } of STARTER_FILES) {
    const full = path.join(projectRoot, rel);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf-8");
      created.push(rel);
    }
  }
  return created;
}

export async function updateProject(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open a file inside an Inkwell project first.");
    return;
  }

  const { findInkwellRoot } = await import("./config");
  const projectRoot = findInkwellRoot(editor.document.uri);
  if (!projectRoot) {
    vscode.window.showWarningMessage(
      "No Inkwell project found. Run \"Inkwell: New Project\" first."
    );
    return;
  }

  const report: string[] = [];

  const dirs = ensureDirs(projectRoot);
  if (dirs.length) report.push(`Created directories: ${dirs.join(", ")}`);

  const gi = updateGitignore(projectRoot);
  if (gi.length) report.push(`Added .gitignore entries: ${gi.join(", ")}`);

  const mf = updateManifest(projectRoot);
  if (mf.length) report.push(`Manifest: ${mf.join("; ")}`);

  const files = ensureStarterFiles(projectRoot);
  if (files.length) report.push(`Created starter files: ${files.join(", ")}`);

  const demos = copyDemoFiles(projectRoot);
  if (demos.length) report.push(`Copied demo files: ${demos.join(", ")}`);

  if (report.length) {
    vscode.window.showInformationMessage(
      `Project updated (${report.length} change${report.length > 1 ? "s" : ""}). ${report.join(". ")}.`
    );
  } else {
    vscode.window.showInformationMessage("Project is already up to date.");
  }
}
