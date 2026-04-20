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
import { collectNodeToolBinDirs, findBinaryViaShell } from "./shell-env";

const exec = promisify(execFile);

export interface ToolchainStatus {
  pandoc: { installed: boolean; version?: string; path?: string };
  xelatex: { installed: boolean; version?: string; path?: string };
  pdflatex: { installed: boolean; version?: string; path?: string };
  crossref: { installed: boolean; version?: string; path?: string };
  mmdc: { installed: boolean; version?: string; path?: string };
  texDistribution?: "full" | "basic" | "tinytex" | "unknown";
  missingPackages: string[];
  /** Path of the TEXMFROOT resolved via kpsewhich, when available. */
  texRoot?: string;
  /** True when the TEXMFROOT tree is writable by the current user. */
  texRootWritable?: boolean;
  /** Owner of TEXMFROOT (resolved via stat -f / stat -c). */
  texRootOwner?: string;
  /** The current process user, for comparison. */
  currentUser?: string;
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

function uniquePackages(pkgs: string[]): string[] {
  return Array.from(new Set(pkgs.map((p) => p.trim()).filter(Boolean)));
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
  "pbalance", "extsizes", "fixtounicode",
  // Required by the rho / rmxaa templates even in English documents:
  // rhobabel.sty calls \iflanguage{spanish} which hard-errors when
  // the language is not declared to babel.
  "babel-spanish", "hyphen-spanish",
  // Hit on minimal TinyTeX installs during the default pandoc
  // --template flow.
  "xstring", "fix2col",
  "amsfonts", "amscls", "tools", "preprint", "sttools",
  "graphics", "oberdiek", "psnfss",
  "mathpazo", "palatino", "bera", "soul", "stix2-type1", "tex-gyre",
  "tufte-latex",
];

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";

function searchPaths(): string[] {
  const home = os.homedir();
  const npmGlobal = path.join(home, ".npm-global", "bin");
  const nodeBins = collectNodeToolBinDirs();
  const common = ["/usr/local/bin", "/usr/bin"];
  if (isMac) {
    return [
      "/opt/homebrew/bin",
      npmGlobal,
      ...nodeBins,
      ...common,
      "/Library/TeX/texbin",
      path.join(home, "Library/TinyTeX/bin/universal-darwin"),
    ];
  }
  return [
    npmGlobal,
    ...nodeBins,
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

  if (name === "mmdc") {
    const p = findBinaryViaShell(name);
    if (p && fs.existsSync(p)) {
      try {
        const { stdout } = await exec(p, ["--version"], { timeout: 5000 });
        return { installed: true, version: stdout.split("\n")[0].trim(), path: p };
      } catch {
        return { installed: true, path: p };
      }
    }
  }

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

async function findBinary(name: string): Promise<string | undefined> {
  for (const dir of searchPaths()) {
    const candidate = `${dir}/${name}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const { stdout } = await exec("which", [name]);
    const p = stdout.trim();
    if (p) return p;
  } catch {}
  return undefined;
}

async function findTexhash(): Promise<string | undefined> {
  return (await findBinary("texhash")) || (await findBinary("mktexlsr"));
}

function buildTlmgrInstallCommand(
  packages: string[],
  opts?: { useSudo?: boolean; tlmgr?: string; texhash?: string }
): string {
  const pkgList = uniquePackages(packages).join(" ");
  const sudo = opts?.useSudo ? "sudo " : "";
  const tlmgr = opts?.tlmgr || "tlmgr";
  const texhash = opts?.texhash || "texhash";
  return `${sudo}${tlmgr} install ${pkgList} && (${sudo}${texhash} || ${sudo}mktexlsr)`;
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

  // Packages whose primary installed file does not match the default
  // "<package>.sty" heuristic. Without these mappings, kpsewhich
  // returns empty for the generated filename and the probe falsely
  // reports the package as missing, which then triggers a tlmgr
  // reinstall on every Check Toolchain run.
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
    "extsizes": "extarticle.cls",
    "babel-spanish": "spanish.ldf",
    // hyphen-spanish installs hyphenation patterns, not a .sty file.
    // kpsewhich resolves the format-file-embedded pattern through the
    // language.dat chain; the file that reliably shows up is loadhyph-es.tex.
    "hyphen-spanish": "loadhyph-es.tex",
    "fix2col": "fix2col.sty",
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

/**
 * Resolve TEXMFROOT, its owner, and whether the current user can write
 * to it. A root-owned TEXMFROOT (common after curl|sudo sh installs of
 * TinyTeX) silently breaks tlmgr: packages install into a writable
 * location but texhash / mktexlsr fail to update the root ls-R index,
 * so kpsewhich continues to report the newly-installed files as
 * absent. Detecting the ownership mismatch up front lets us surface
 * an actionable "Fix TinyTeX permissions" remediation instead of
 * looping the user through a "tlmgr install ... retry compile" cycle
 * that never resolves.
 */
async function inspectTexRoot(kpsewhich: string | undefined): Promise<{
  texRoot?: string;
  texRootWritable?: boolean;
  texRootOwner?: string;
  currentUser?: string;
}> {
  if (!kpsewhich) return {};
  let texRoot: string | undefined;
  try {
    const { stdout } = await exec(kpsewhich, ["-var-value", "TEXMFROOT"], { timeout: 5000 });
    texRoot = stdout.trim();
  } catch {
    return {};
  }
  if (!texRoot || !fs.existsSync(texRoot)) return { texRoot };

  const currentUser = process.env.USER || os.userInfo().username;
  let texRootOwner: string | undefined;
  try {
    const statArgs = isMac ? ["-f", "%Su", texRoot] : ["-c", "%U", texRoot];
    const { stdout } = await exec("stat", statArgs, { timeout: 5000 });
    texRootOwner = stdout.trim();
  } catch {}

  // fs.accessSync with W_OK on a dir is the cross-platform signal for
  // "can this user add files here"; it returns true for the root user
  // case we actually care about (user != owner).
  let texRootWritable = false;
  try {
    fs.accessSync(texRoot, fs.constants.W_OK);
    texRootWritable = true;
  } catch {}

  return { texRoot, texRootWritable, texRootOwner, currentUser };
}

export async function checkToolchain(): Promise<ToolchainStatus> {
  const [pandoc, xelatex, pdflatex, crossref, mmdc] = await Promise.all([
    probe("pandoc"),
    probe("xelatex"),
    probe("pdflatex"),
    probe("pandoc-crossref"),
    probe("mmdc"),
  ]);

  const kpsewhich = xelatex.installed ? await findKpsewhich() : undefined;
  const missingPackages = xelatex.installed
    ? await checkLatexPackages(kpsewhich)
    : [];
  const rootInfo = xelatex.installed ? await inspectTexRoot(kpsewhich) : {};

  return {
    pandoc,
    xelatex,
    pdflatex,
    crossref,
    mmdc,
    texDistribution: detectDistribution(xelatex.path),
    missingPackages,
    ...rootInfo,
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

  if (status.pdflatex.installed) {
    lines.push(`pdfLaTeX: ${status.pdflatex.version || "installed"} (${status.pdflatex.path})`);
  } else {
    lines.push("pdfLaTeX: not found (needed by tufte, tmsce, rho, kth-letter templates)");
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

  // Ownership check: if the TEXMFROOT is owned by a user other than
  // the one running Inkwell and is not writable, packages installed
  // via tlmgr cannot be registered in the ls-R index and will still
  // be "not found" at compile time. This is almost always the result
  // of a `curl ... | sudo sh` TinyTeX bootstrap and is the hardest
  // failure to diagnose from the compile log alone.
  const ownershipBroken =
    status.xelatex.installed &&
    status.texRoot &&
    status.texRootOwner &&
    status.currentUser &&
    status.texRootOwner !== status.currentUser &&
    status.texRootWritable === false;
  if (ownershipBroken) {
    lines.push(
      `TEXMFROOT permission: ${status.texRoot} is owned by "${status.texRootOwner}" but you are "${status.currentUser}". tlmgr installs will not register in the file index.`,
    );
  }

  const coreReady =
    status.pandoc.installed &&
    status.xelatex.installed &&
    status.pdflatex.installed &&
    status.crossref.installed;
  const allGood = coreReady && missingCount === 0;

  if (allGood && !ownershipBroken) {
    const mmdcNote = status.mmdc.installed
      ? ""
      : "\n(mmdc not found; mermaid diagrams will render as code in PDFs)";
    vscode.window.showInformationMessage(
      `Inkwell toolchain ready.\n${lines.join("\n")}${mmdcNote}`,
      "OK"
    );
    return;
  }

  // Surface the ownership mismatch BEFORE the "install packages"
  // prompt, because no amount of re-running tlmgr will fix the
  // underlying index problem.
  if (ownershipBroken) {
    const fixCommand = `sudo chown -R "${status.currentUser}" "${status.texRoot}" && "${path.join(status.texRoot!, isMac ? "bin/universal-darwin" : "bin")}/texhash" || sudo texhash`;
    const choice = await vscode.window.showErrorMessage(
      `TEXMFROOT ownership mismatch: ${status.texRoot} is owned by "${status.texRootOwner}" but you are running as "${status.currentUser}". tlmgr installs succeed silently but newly-installed packages never register in the file index, so compile continues to fail with "file not found" errors even after you run "Install packages".`,
      "Open terminal with fix command",
      "Show details",
      "Ignore",
    );
    if (choice === "Open terminal with fix command") {
      const terminal = vscode.window.createTerminal("Inkwell: Fix TinyTeX permissions");
      terminal.show();
      terminal.sendText(fixCommand);
      return;
    } else if (choice === "Show details") {
      showOwnershipDetails(status, fixCommand);
      return;
    }
    // "Ignore": fall through to other remediation options.
  }

  // Core tools missing
  if (!coreReady) {
    const missing: string[] = [];
    if (!status.pandoc.installed) missing.push("pandoc");
    if (!status.xelatex.installed) missing.push("xelatex (TeX distribution)");
    if (!status.pdflatex.installed) {
      missing.push("pdflatex (required by tufte, rho, tmsce, kth-letter, rmxaa)");
    }
    if (!status.crossref.installed) missing.push("pandoc-crossref");

    const buttons: string[] = [];
    if (isMac) {
      buttons.push("Install Full MacTeX (recommended)", "Install with Homebrew");
    } else if (isLinux) {
      buttons.push("Install with apt/dnf");
    }
    buttons.push("Install TinyTeX", "Show instructions");

    const choice = await vscode.window.showWarningMessage(
      `Missing: ${missing.join(", ")}`,
      ...buttons
    );

    if (choice === "Install Full MacTeX (recommended)") {
      await installFullMacTeX(status);
    } else if (choice === "Install with Homebrew") {
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
    const texAlreadyInstalled = status.xelatex.installed && status.pdflatex.installed;
    const buttons: string[] = [];
    let message = `${missingCount} LaTeX package${missingCount > 1 ? "s" : ""} missing: ${status.missingPackages.join(", ")}`;
    if (isMac && !texAlreadyInstalled) {
      message += '. Install Full MacTeX for the most reliable setup.';
      buttons.push("Install Full MacTeX (recommended)");
    }
    buttons.push("Install packages with tlmgr", "Show details");

    const choice = await vscode.window.showWarningMessage(message, ...buttons);

    if (choice === "Install Full MacTeX (recommended)") {
      await installFullMacTeX(status);
    } else if (choice === "Install packages with tlmgr") {
      await installMissingPackages(status.missingPackages);
    } else if (choice === "Show details") {
      showPackageDetails(status);
    }
  }
}

async function installMissingPackages(packages: string[]): Promise<void> {
  const terminal = vscode.window.createTerminal("Inkwell Setup");
  terminal.show();
  const tlmgr = await findBinary("tlmgr");
  const texhash = await findTexhash();

  if (!tlmgr) {
    terminal.sendText('echo "tlmgr not found on PATH. Install a TeX distribution first, then rerun Inkwell toolchain setup."');
    return;
  }

  const cmd = buildTlmgrInstallCommand(packages, {
    tlmgr,
    texhash,
  });
  terminal.sendText(cmd);
}

export async function installLatexPackage(packageName: string): Promise<void> {
  const normalized = packageName.trim();
  if (!normalized) return;
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    vscode.window.showErrorMessage(
      `Invalid package name "${normalized}". Use letters, numbers, dot, underscore, or hyphen.`,
    );
    return;
  }
  await installMissingPackages([normalized]);
}

function showOwnershipDetails(status: ToolchainStatus, fixCommand: string): void {
  const doc: string[] = ["# Inkwell: TeX tree owned by a different user\n"];
  doc.push(`**TEXMFROOT**: \`${status.texRoot}\``);
  doc.push(`**Owner**: ${status.texRootOwner}`);
  doc.push(`**Running as**: ${status.currentUser}`);
  doc.push(`**User can write to the tree**: ${status.texRootWritable ? "yes" : "no"}\n`);
  doc.push("## Why this breaks your compile\n");
  doc.push(
    "A TeX installation bootstrapped with `sudo` (most commonly `curl ... | sudo sh` for TinyTeX) ends up owned by root. `tlmgr install <pkg>` will still succeed when you run it with `sudo`, but the subsequent `texhash` / `mktexlsr` call cannot update the root ls-R index as a non-root user, so `kpsewhich` continues to report every newly-installed package as absent. Every compile then fails with `File '<pkg>.sty' not found` even though the file is sitting in the tree.",
  );
  doc.push("\n## Fix\n");
  doc.push("Change the owner of the tree to your user, then regenerate the file index:\n");
  doc.push("```bash");
  doc.push(fixCommand);
  doc.push("```\n");
  doc.push("Re-run **Inkwell: Check / Install Toolchain** after running the fix to confirm the green state.");
  vscode.workspace
    .openTextDocument({ content: doc.join("\n"), language: "markdown" })
    .then((d) => vscode.window.showTextDocument(d));
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
  const requiredPackages = uniquePackages(loadRequiredPackages());
  if (!status.pandoc.installed) {
    commands.push("brew install pandoc");
  }
  if (!status.crossref.installed) {
    commands.push("brew install pandoc-crossref");
  }
  if (!status.xelatex.installed || !status.pdflatex.installed) {
    commands.push("brew install --cask basictex");
  }
  commands.push(
    'eval "$(/usr/libexec/path_helper)" && if command -v tlmgr >/dev/null 2>&1; then sudo tlmgr update --self && ' +
      buildTlmgrInstallCommand(requiredPackages, { useSudo: true }) +
      '; else echo "tlmgr not found after install; restart terminal and run Inkwell setup again."; fi'
  );

  terminal.sendText(commands.join(" && "));
}

async function installFullMacTeX(status: ToolchainStatus): Promise<void> {
  const terminal = vscode.window.createTerminal("Inkwell Setup");
  terminal.show();

  const hasBrew = fs.existsSync("/opt/homebrew/bin/brew") ||
    fs.existsSync("/usr/local/bin/brew");
  if (!hasBrew) {
    terminal.sendText('echo "Homebrew not found. Install from https://brew.sh first."');
    return;
  }

  const commands: string[] = [];
  const requiredPackages = uniquePackages(loadRequiredPackages());
  if (!status.pandoc.installed) {
    commands.push("brew install pandoc");
  }
  if (!status.crossref.installed) {
    commands.push("brew install pandoc-crossref");
  }
  if (!status.xelatex.installed || !status.pdflatex.installed) {
    commands.push("brew install --cask mactex");
  }
  commands.push(
    'eval "$(/usr/libexec/path_helper)" && sudo tlmgr update --self && ' +
      buildTlmgrInstallCommand(requiredPackages, { useSudo: true })
  );
  terminal.sendText(commands.join(" && "));
}

async function installWithPackageManager(status: ToolchainStatus): Promise<void> {
  const terminal = vscode.window.createTerminal("Inkwell Setup");
  terminal.show();

  const hasApt = fs.existsSync("/usr/bin/apt-get");
  const hasDnf = fs.existsSync("/usr/bin/dnf");

  const commands: string[] = [];
  const requiredPackages = uniquePackages(loadRequiredPackages());

  if (hasApt) {
    if (!status.pandoc.installed) {
      commands.push("sudo apt-get update && sudo apt-get install -y pandoc");
    }
    if (!status.crossref.installed) {
      commands.push("sudo apt-get install -y pandoc-crossref || echo 'pandoc-crossref not in apt; install from https://github.com/lierdakil/pandoc-crossref/releases'");
    }
    if (!status.xelatex.installed || !status.pdflatex.installed) {
      commands.push("sudo apt-get install -y texlive-xetex texlive-latex-base texlive-fonts-recommended texlive-fonts-extra");
    }
  } else if (hasDnf) {
    if (!status.pandoc.installed) {
      commands.push("sudo dnf install -y pandoc");
    }
    if (!status.crossref.installed) {
      commands.push("sudo dnf install -y pandoc-crossref || echo 'pandoc-crossref not in dnf; install from https://github.com/lierdakil/pandoc-crossref/releases'");
    }
    if (!status.xelatex.installed || !status.pdflatex.installed) {
      commands.push("sudo dnf install -y texlive-xetex texlive texlive-collection-fontsrecommended");
    }
  } else {
    terminal.sendText('echo "Neither apt nor dnf found. See TinyTeX or manual install options."');
    return;
  }

  commands.push(
    'if command -v tlmgr >/dev/null 2>&1; then sudo tlmgr update --self && ' +
      buildTlmgrInstallCommand(requiredPackages, { useSudo: true }) +
      '; else echo "tlmgr not found; distro TeX packages may be incomplete. Consider Inkwell: Install TinyTeX or install TeX Live full."; fi'
  );

  terminal.sendText(commands.join(" && "));
}

async function installTinyTeX(status: ToolchainStatus): Promise<void> {
  const terminal = vscode.window.createTerminal("Inkwell Setup");
  terminal.show();

  const commands: string[] = [];
  const requiredPackages = uniquePackages(loadRequiredPackages());

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

  if (!status.xelatex.installed || !status.pdflatex.installed) {
    commands.push(
      'curl -sL "https://yihui.org/tinytex/install-bin-unix.sh" | sh'
    );
  }

  const home = os.homedir();
  if (isMac) {
    const tinyTlmgr = `${home}/Library/TinyTeX/bin/universal-darwin/tlmgr`;
    const tinyTexhash = `${home}/Library/TinyTeX/bin/universal-darwin/texhash`;
    commands.push(
      `if [ -x "${tinyTlmgr}" ]; then ${tinyTlmgr} update --self && ${buildTlmgrInstallCommand(requiredPackages, { tlmgr: tinyTlmgr, texhash: tinyTexhash })}; else echo "TinyTeX tlmgr not found at ${tinyTlmgr}"; fi`
    );
  } else {
    commands.push(
      `if command -v tlmgr >/dev/null 2>&1; then ${buildTlmgrInstallCommand(requiredPackages)}; else echo "tlmgr not found after TinyTeX install; restart terminal and rerun setup."; fi`
    );
  }

  terminal.sendText(commands.join(" && "));
}

function showInstructions(status: ToolchainStatus): void {
  const doc: string[] = ["# Inkwell: Toolchain Setup\n"];
  const reqFile = path.join(_extensionPath, "requirements-latex.txt");

  if (isMac) {
    doc.push("## Recommended for macOS (fewest package errors)\n");
    doc.push("If you are seeing errors like \"File `fixtounicode.sty` not found\", install full MacTeX and then apply Inkwell's requirements list.\n");
    doc.push("```bash");
    doc.push("brew install pandoc pandoc-crossref");
    doc.push("brew install --cask mactex");
    doc.push("sudo tlmgr update --self");
    doc.push(`REQ="${reqFile}"`);
    doc.push("sed 's/#.*//' \"$REQ\" | awk 'NF' | xargs sudo tlmgr install");
    doc.push("sudo texhash || sudo mktexlsr");
    doc.push("```\n");
  }

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

  if (!status.xelatex.installed || !status.pdflatex.installed) {
    doc.push("## TeX Distribution (XeLaTeX + pdfLaTeX)\n");
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
    doc.push("tlmgr update --self");
    doc.push('REQ="/path/to/requirements-latex.txt"');
    doc.push('sed \'s/#.*//\' "$REQ" | awk \'NF\' | xargs tlmgr install');
    doc.push("texhash || mktexlsr");
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

  doc.push("## Install full Inkwell LaTeX requirements\n");
  doc.push("```bash");
  doc.push(`REQ="${reqFile}"`);
  doc.push('sed \'s/#.*//\' "$REQ" | awk \'NF\' | xargs tlmgr install');
  doc.push("texhash || mktexlsr");
  doc.push("```\n");

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
