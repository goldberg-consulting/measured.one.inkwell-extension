// Toolchain detection and guided installation. Probes for pandoc and
// xelatex across platform-specific search paths, classifies the TeX
// distribution (Full/Basic/TinyTeX), and offers one-click install via
// Homebrew, apt/dnf, or TinyTeX when dependencies are absent.

import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const exec = promisify(execFile);

export interface ToolchainStatus {
  pandoc: { installed: boolean; version?: string; path?: string };
  xelatex: { installed: boolean; version?: string; path?: string };
  crossref: { installed: boolean; version?: string; path?: string };
  mmdc: { installed: boolean; version?: string; path?: string };
  texDistribution?: "full" | "basic" | "tinytex" | "unknown";
  missingPackages: string[];
}

let _extensionPath = "";

export function setExtensionPath(p: string): void {
  _extensionPath = p;
}

function loadRequiredPackages(): string[] {
  const reqFile = path.join(_extensionPath, "requirements-latex.txt");
  if (fs.existsSync(reqFile)) {
    return fs
      .readFileSync(reqFile, "utf-8")
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean);
  }
  return FALLBACK_PACKAGES;
}

const FALLBACK_PACKAGES = [
  "fancyhdr", "titlesec", "setspace", "etoolbox", "enumitem", "float",
  "xcolor", "xurl", "parskip", "framed", "fancyvrb", "fvextra",
  "booktabs", "caption", "microtype", "mdframed",
  "zref", "needspace", "titling", "lettrine", "lineno", "footmisc",
  "adjustbox", "lastpage", "listings", "csquotes", "ragged2e",
  "tcolorbox", "colortbl",
  "mathtools", "thmtools", "here",
  "multirow", "environ", "abstract", "bookmark", "cleveref",
  "natbib", "adforn", "xifthen",
  "ccicons", "imakeidx", "fontawesome5", "orcidlink", "pdflscape",
  "chemfig", "circuitikz",
  "supertabular", "matlab-prettifier", "lipsum", "hardwrap",
  "units", "silence",
  "amsfonts", "amscls", "tools", "preprint", "sttools",
  "graphics", "oberdiek", "psnfss",
  "mathpazo", "palatino", "bera", "soul", "stix2-type1", "tex-gyre",
  "tufte-latex",
];

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";

function searchPaths(): string[] {
  const common = ["/usr/local/bin", "/usr/bin"];
  if (isMac) {
    const home = os.homedir();
    return [
      "/opt/homebrew/bin",
      ...common,
      "/Library/TeX/texbin",
      path.join(home, "Library/TinyTeX/bin/universal-darwin"),
    ];
  }
  const home = os.homedir();
  return [
    ...common,
    `${home}/bin`,
    `${home}/.TinyTeX/bin/x86_64-linux`,
    `${home}/.TinyTeX/bin/aarch64-linux`,
    "/usr/local/texlive/2024/bin/x86_64-linux",
    "/usr/local/texlive/2025/bin/x86_64-linux",
    "/usr/local/texlive/2026/bin/x86_64-linux",
  ];
}

async function probe(
  name: string
): Promise<{ installed: boolean; version?: string; path?: string }> {
  for (const dir of searchPaths()) {
    const candidate = `${dir}/${name}`;
    if (fs.existsSync(candidate)) {
      try {
        const { stdout } = await exec(candidate, ["--version"], {
          timeout: 5000,
        });
        const version = stdout.split("\n")[0].trim();
        return { installed: true, version, path: candidate };
      } catch {
        return { installed: true, path: candidate };
      }
    }
  }
  try {
    const { stdout: whichOut } = await exec("which", [name]);
    const p = whichOut.trim();
    if (p) {
      try {
        const { stdout } = await exec(p, ["--version"], { timeout: 5000 });
        return { installed: true, version: stdout.split("\n")[0].trim(), path: p };
      } catch {
        return { installed: true, path: p };
      }
    }
  } catch {}
  return { installed: false };
}

function detectDistribution(xelatexPath: string | undefined): ToolchainStatus["texDistribution"] {
  if (!xelatexPath) return undefined;
  if (/[Tt]iny[Tt]e[Xx]/.test(xelatexPath)) return "tinytex";
  if (xelatexPath.includes("texlive")) {
    if (isMac) {
      if (fs.existsSync("/usr/local/texlive") || fs.existsSync("/opt/homebrew/Caskroom/mactex")) {
        return "full";
      }
      return "basic";
    }
    const texliveBase = xelatexPath.match(/\/texlive\/\d+\//);
    if (texliveBase) {
      return "full";
    }
    return "basic";
  }
  if (isMac && xelatexPath.includes("/Library/TeX/texbin")) {
    return fs.existsSync("/usr/local/texlive") ? "full" : "basic";
  }
  return "unknown";
}

async function findKpsewhich(): Promise<string | undefined> {
  for (const dir of searchPaths()) {
    const candidate = `${dir}/kpsewhich`;
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const { stdout } = await exec("which", ["kpsewhich"]);
    const p = stdout.trim();
    if (p) return p;
  } catch {}
  return undefined;
}

async function checkLatexPackages(kpsewhich: string | undefined): Promise<string[]> {
  const requiredPackages = loadRequiredPackages();
  if (!kpsewhich) return requiredPackages;

  // Run texhash first to ensure the file database is current
  const texhashDir = kpsewhich.replace(/\/kpsewhich$/, "/texhash");
  if (fs.existsSync(texhashDir)) {
    try {
      await exec(texhashDir, [], { timeout: 30000 });
    } catch {}
  }

  const packageFiles: Record<string, string> = {
    "tufte-latex": "tufte-handout.cls",
    "bera": "beramono.sty",
    "palatino": "pplr8r.tfm",
    "tex-gyre": "qplr.tfm",
    "stix2-type1": "stix2.sty",
    "amsfonts": "amssymb.sty",
    "amscls": "amsthm.sty",
    "tools": "array.sty",
    "preprint": "authblk.sty",
    "sttools": "flushend.sty",
    "graphics": "rotating.sty",
    "oberdiek": "iflang.sty",
    "psnfss": "helvet.sty",
  };

  const missing: string[] = [];
  const batchSize = 20;
  for (let i = 0; i < requiredPackages.length; i += batchSize) {
    const batch = requiredPackages.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (pkg) => {
        const file = packageFiles[pkg] || `${pkg}.sty`;
        try {
          const { stdout } = await exec(kpsewhich, [file], { timeout: 5000 });
          return stdout.trim() ? null : pkg;
        } catch {
          return pkg;
        }
      })
    );
    for (const r of results) {
      if (r) missing.push(r);
    }
  }
  return missing;
}

export async function checkToolchain(): Promise<ToolchainStatus> {
  const [pandoc, xelatex, crossref, mmdc] = await Promise.all([
    probe("pandoc"),
    probe("xelatex"),
    probe("pandoc-crossref"),
    probe("mmdc"),
  ]);

  const kpsewhich = xelatex.installed ? await findKpsewhich() : undefined;
  const missingPackages = xelatex.installed
    ? await checkLatexPackages(kpsewhich)
    : [];

  return {
    pandoc,
    xelatex,
    crossref,
    mmdc,
    texDistribution: detectDistribution(xelatex.path),
    missingPackages,
  };
}

export async function showToolchainStatus(): Promise<void> {
  const status = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Inkwell: checking toolchain...",
      cancellable: false,
    },
    () => checkToolchain()
  );

  const lines: string[] = [];

  if (status.pandoc.installed) {
    lines.push(`Pandoc: ${status.pandoc.version || "installed"} (${status.pandoc.path})`);
  } else {
    lines.push("Pandoc: not found");
  }

  if (status.xelatex.installed) {
    const distLabel = status.texDistribution
      ? ` [${status.texDistribution}]`
      : "";
    lines.push(`XeLaTeX: ${status.xelatex.version || "installed"}${distLabel} (${status.xelatex.path})`);
  } else {
    lines.push("XeLaTeX: not found");
  }

  if (status.crossref.installed) {
    lines.push(`pandoc-crossref: ${status.crossref.version || "installed"} (${status.crossref.path})`);
  } else {
    lines.push("pandoc-crossref: not found (required for @fig:, @eq:, @tbl: cross-references)");
  }

  if (status.mmdc.installed) {
    lines.push(`mmdc (Mermaid): ${status.mmdc.version || "installed"} (${status.mmdc.path})`);
  } else {
    lines.push("mmdc (Mermaid): not found (optional, for mermaid diagrams in PDF)");
  }

  const pkgCount = loadRequiredPackages().length;
  const missingCount = status.missingPackages.length;
  if (missingCount === 0 && status.xelatex.installed) {
    lines.push(`LaTeX packages: all ${pkgCount} required packages found`);
  } else if (missingCount > 0) {
    lines.push(`LaTeX packages: ${missingCount} missing (${status.missingPackages.slice(0, 5).join(", ")}${missingCount > 5 ? ", ..." : ""})`);
  }

  const coreReady = status.pandoc.installed && status.xelatex.installed && status.crossref.installed;
  const allGood = coreReady && missingCount === 0;

  if (allGood) {
    const mmdcNote = status.mmdc.installed
      ? ""
      : "\n(mmdc not found; mermaid diagrams will render as code in PDFs)";
    vscode.window.showInformationMessage(
      `Inkwell toolchain ready.\n${lines.join("\n")}${mmdcNote}`,
      "OK"
    );
    return;
  }

  // Core tools missing
  if (!coreReady) {
    const missing: string[] = [];
    if (!status.pandoc.installed) missing.push("pandoc");
    if (!status.xelatex.installed) missing.push("xelatex (TeX distribution)");
    if (!status.crossref.installed) missing.push("pandoc-crossref");

    const buttons: string[] = [];
    if (isMac) {
      buttons.push("Install with Homebrew");
    } else if (isLinux) {
      buttons.push("Install with apt/dnf");
    }
    buttons.push("Install TinyTeX", "Show instructions");

    const choice = await vscode.window.showWarningMessage(
      `Missing: ${missing.join(", ")}`,
      ...buttons
    );

    if (choice === "Install with Homebrew") {
      await installWithHomebrew(status);
    } else if (choice === "Install with apt/dnf") {
      await installWithPackageManager(status);
    } else if (choice === "Install TinyTeX") {
      await installTinyTeX(status);
    } else if (choice === "Show instructions") {
      showInstructions(status);
    }
    return;
  }

  // Core tools present but packages missing
  if (missingCount > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${missingCount} LaTeX package${missingCount > 1 ? "s" : ""} missing: ${status.missingPackages.join(", ")}`,
      "Install now",
      "Show details"
    );

    if (choice === "Install now") {
      await installMissingPackages(status.missingPackages);
    } else if (choice === "Show details") {
      showPackageDetails(status);
    }
  }
}

async function installMissingPackages(packages: string[]): Promise<void> {
  const terminal = vscode.window.createTerminal("Inkwell Setup");
  terminal.show();
  const cmd = `tlmgr install ${packages.join(" ")} && texhash`;
  terminal.sendText(cmd);
}

function showPackageDetails(status: ToolchainStatus): void {
  const doc: string[] = ["# Inkwell: LaTeX Package Status\n"];

  const installed = loadRequiredPackages().filter(
    (p) => !status.missingPackages.includes(p)
  );

  if (status.missingPackages.length > 0) {
    doc.push(`## Missing (${status.missingPackages.length})\n`);
    doc.push("Install all at once:\n");
    doc.push("```bash");
    doc.push(`tlmgr install ${status.missingPackages.join(" ")} && texhash`);
    doc.push("```\n");
    doc.push("Packages:\n");
    for (const pkg of status.missingPackages) {
      doc.push(`- [ ] ${pkg}`);
    }
    doc.push("");
  }

  doc.push(`## Installed (${installed.length})\n`);
  for (const pkg of installed) {
    doc.push(`- [x] ${pkg}`);
  }
  doc.push("");

  if (!status.crossref.installed) {
    doc.push("## pandoc-crossref (cross-references)\n");
    doc.push("```bash");
    doc.push(isMac ? "brew install pandoc-crossref" : "# https://github.com/lierdakil/pandoc-crossref/releases");
    doc.push("```\n");
  }

  if (!status.mmdc.installed) {
    doc.push("## Mermaid CLI (optional)\n");
    doc.push("```bash");
    doc.push("npm install -g @mermaid-js/mermaid-cli");
    doc.push("```\n");
  }

  vscode.workspace
    .openTextDocument({ content: doc.join("\n"), language: "markdown" })
    .then((d) => vscode.window.showTextDocument(d));
}

async function installWithHomebrew(status: ToolchainStatus): Promise<void> {
  const terminal = vscode.window.createTerminal("Inkwell Setup");
  terminal.show();

  const hasBrew = fs.existsSync("/opt/homebrew/bin/brew") ||
    fs.existsSync("/usr/local/bin/brew");

  if (!hasBrew) {
    terminal.sendText('echo "Homebrew not found. Install from https://brew.sh first."');
    return;
  }

  const commands: string[] = [];
  if (!status.pandoc.installed) {
    commands.push("brew install pandoc");
  }
  if (!status.crossref.installed) {
    commands.push("brew install pandoc-crossref");
  }
  if (!status.xelatex.installed) {
    commands.push("brew install --cask basictex");
    commands.push(
      'eval "$(/usr/libexec/path_helper)" && sudo tlmgr update --self && sudo tlmgr install collection-fontsrecommended xetex'
    );
  }

  terminal.sendText(commands.join(" && "));
}

async function installWithPackageManager(status: ToolchainStatus): Promise<void> {
  const terminal = vscode.window.createTerminal("Inkwell Setup");
  terminal.show();

  const hasApt = fs.existsSync("/usr/bin/apt-get");
  const hasDnf = fs.existsSync("/usr/bin/dnf");

  const commands: string[] = [];

  if (hasApt) {
    if (!status.pandoc.installed) {
      commands.push("sudo apt-get update && sudo apt-get install -y pandoc");
    }
    if (!status.crossref.installed) {
      commands.push("sudo apt-get install -y pandoc-crossref || echo 'pandoc-crossref not in apt; install from https://github.com/lierdakil/pandoc-crossref/releases'");
    }
    if (!status.xelatex.installed) {
      commands.push("sudo apt-get install -y texlive-xetex texlive-fonts-recommended texlive-fonts-extra");
    }
  } else if (hasDnf) {
    if (!status.pandoc.installed) {
      commands.push("sudo dnf install -y pandoc");
    }
    if (!status.crossref.installed) {
      commands.push("sudo dnf install -y pandoc-crossref || echo 'pandoc-crossref not in dnf; install from https://github.com/lierdakil/pandoc-crossref/releases'");
    }
    if (!status.xelatex.installed) {
      commands.push("sudo dnf install -y texlive-xetex texlive-collection-fontsrecommended");
    }
  } else {
    terminal.sendText('echo "Neither apt nor dnf found. See TinyTeX or manual install options."');
    return;
  }

  terminal.sendText(commands.join(" && "));
}

async function installTinyTeX(status: ToolchainStatus): Promise<void> {
  const terminal = vscode.window.createTerminal("Inkwell Setup");
  terminal.show();

  const commands: string[] = [];

  if (!status.pandoc.installed) {
    if (isMac) {
      const hasBrew = fs.existsSync("/opt/homebrew/bin/brew") || fs.existsSync("/usr/local/bin/brew");
      if (hasBrew) {
        commands.push("brew install pandoc");
      } else {
        commands.push('echo "Install pandoc from https://pandoc.org/installing.html"');
      }
    } else {
      const hasApt = fs.existsSync("/usr/bin/apt-get");
      if (hasApt) {
        commands.push("sudo apt-get update && sudo apt-get install -y pandoc");
      } else {
        commands.push('echo "Install pandoc from https://pandoc.org/installing.html"');
      }
    }
  }

  if (!status.crossref.installed) {
    if (isMac) {
      const hasBrew = fs.existsSync("/opt/homebrew/bin/brew") || fs.existsSync("/usr/local/bin/brew");
      if (hasBrew) {
        commands.push("brew install pandoc-crossref");
      } else {
        commands.push('echo "Install pandoc-crossref from https://github.com/lierdakil/pandoc-crossref/releases"');
      }
    } else {
      commands.push('echo "Install pandoc-crossref from https://github.com/lierdakil/pandoc-crossref/releases"');
    }
  }

  if (!status.xelatex.installed) {
    commands.push(
      'curl -sL "https://yihui.org/tinytex/install-bin-unix.sh" | sh'
    );
    const home = os.homedir();
    if (isMac) {
      commands.push(
        `${home}/Library/TinyTeX/bin/universal-darwin/tlmgr install collection-fontsrecommended xetex fontspec`
      );
    } else {
      commands.push(
        "tlmgr install collection-fontsrecommended xetex fontspec"
      );
    }
  }

  terminal.sendText(commands.join(" && "));
}

function showInstructions(status: ToolchainStatus): void {
  const doc: string[] = ["# Inkwell: Toolchain Setup\n"];

  if (!status.pandoc.installed) {
    doc.push("## Pandoc\n");
    if (isMac) {
      doc.push("```bash");
      doc.push("brew install pandoc");
      doc.push("```\n");
    } else {
      doc.push("**Debian/Ubuntu:**\n");
      doc.push("```bash");
      doc.push("sudo apt-get install pandoc");
      doc.push("```\n");
      doc.push("**Fedora/RHEL:**\n");
      doc.push("```bash");
      doc.push("sudo dnf install pandoc");
      doc.push("```\n");
    }
    doc.push("Or download from https://pandoc.org/installing.html\n");
  }

  if (!status.crossref.installed) {
    doc.push("## pandoc-crossref (for @fig:, @eq:, @tbl: references)\n");
    if (isMac) {
      doc.push("```bash");
      doc.push("brew install pandoc-crossref");
      doc.push("```\n");
    } else {
      doc.push("Download from https://github.com/lierdakil/pandoc-crossref/releases\n");
      doc.push("Or if available in your package manager:\n");
      doc.push("```bash");
      doc.push("sudo apt-get install pandoc-crossref  # Debian/Ubuntu");
      doc.push("sudo dnf install pandoc-crossref      # Fedora/RHEL");
      doc.push("```\n");
    }
  }

  if (!status.xelatex.installed) {
    doc.push("## TeX Distribution (XeLaTeX)\n");
    if (isMac) {
      doc.push("**Option A: BasicTeX (recommended, ~300MB)**\n");
      doc.push("```bash");
      doc.push("brew install --cask basictex");
      doc.push("sudo tlmgr update --self");
      doc.push("sudo tlmgr install collection-fontsrecommended");
      doc.push("```\n");
    } else {
      doc.push("**Option A: TeX Live (via package manager)**\n");
      doc.push("```bash");
      doc.push("# Debian/Ubuntu");
      doc.push("sudo apt-get install texlive-xetex texlive-fonts-recommended");
      doc.push("");
      doc.push("# Fedora/RHEL");
      doc.push("sudo dnf install texlive-xetex texlive-collection-fontsrecommended");
      doc.push("```\n");
    }
    doc.push("**Option B: TinyTeX (~100MB)**\n");
    doc.push("```bash");
    doc.push('curl -sL "https://yihui.org/tinytex/install-bin-unix.sh" | sh');
    doc.push("tlmgr install collection-fontsrecommended xetex fontspec");
    doc.push("```\n");
    if (isMac) {
      doc.push("**Option C: Full MacTeX (~5GB)**\n");
      doc.push("```bash");
      doc.push("brew install --cask mactex");
      doc.push("```\n");
    } else {
      doc.push("**Option C: Full TeX Live (~5GB)**\n");
      doc.push("```bash");
      doc.push("sudo apt-get install texlive-full  # Debian/Ubuntu");
      doc.push("```\n");
    }
  }

  if (status.missingPackages.length > 0) {
    doc.push("## Missing LaTeX Packages\n");
    doc.push("```bash");
    doc.push(`tlmgr install ${status.missingPackages.join(" ")} && texhash`);
    doc.push("```\n");
  }

  if (!status.mmdc.installed) {
    doc.push("## Mermaid CLI (optional, for diagrams in PDF)\n");
    doc.push("```bash");
    doc.push("npm install -g @mermaid-js/mermaid-cli");
    doc.push("```\n");
  }

  vscode.workspace
    .openTextDocument({ content: doc.join("\n"), language: "markdown" })
    .then((d) => vscode.window.showTextDocument(d));
}
