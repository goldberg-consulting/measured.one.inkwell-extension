// Toolchain detection and guided installation. Probes for pandoc and
// xelatex across platform-specific search paths, classifies the TeX
// distribution (Full/Basic/TinyTeX), and offers one-click install via
// Homebrew, apt/dnf, or TinyTeX when dependencies are absent.

import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";

const exec = promisify(execFile);

export interface ToolchainStatus {
  pandoc: { installed: boolean; version?: string; path?: string };
  xelatex: { installed: boolean; version?: string; path?: string };
  texDistribution?: "full" | "basic" | "tinytex" | "unknown";
}

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";

function searchPaths(): string[] {
  const common = ["/usr/local/bin", "/usr/bin"];
  if (isMac) {
    return ["/opt/homebrew/bin", ...common, "/Library/TeX/texbin"];
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

export async function checkToolchain(): Promise<ToolchainStatus> {
  const [pandoc, xelatex] = await Promise.all([
    probe("pandoc"),
    probe("xelatex"),
  ]);
  return {
    pandoc,
    xelatex,
    texDistribution: detectDistribution(xelatex.path),
  };
}

export async function showToolchainStatus(): Promise<void> {
  const status = await checkToolchain();
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

  const allGood = status.pandoc.installed && status.xelatex.installed;

  if (allGood) {
    vscode.window.showInformationMessage(
      `Inkwell toolchain ready.\n${lines.join("\n")}`,
      "OK"
    );
    return;
  }

  const missing: string[] = [];
  if (!status.pandoc.installed) missing.push("pandoc");
  if (!status.xelatex.installed) missing.push("xelatex (TeX distribution)");

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
    if (!status.xelatex.installed) {
      commands.push("sudo apt-get install -y texlive-xetex texlive-fonts-recommended texlive-fonts-extra");
    }
  } else if (hasDnf) {
    if (!status.pandoc.installed) {
      commands.push("sudo dnf install -y pandoc");
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

  vscode.workspace
    .openTextDocument({ content: doc.join("\n"), language: "markdown" })
    .then((d) => vscode.window.showTextDocument(d));
}
