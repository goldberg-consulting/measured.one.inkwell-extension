// Augmented PATH for child processes. GUI apps on macOS get a minimal PATH from
// launchd; we replicate common dev locations (TeX, Homebrew, Node version
// managers) so tools like mmdc and latexmk resolve reliably.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

/** nvm, fnm, Volta install dirs — user-specific and often missing from GUI PATH. */
export function collectNodeToolBinDirs(): string[] {
  const dirs: string[] = [];
  const home = os.homedir();

  const pushDir = (d: string) => {
    if (!d || dirs.includes(d)) return;
    try {
      if (fs.statSync(d).isDirectory()) dirs.push(d);
    } catch {
      /* skip */
    }
  };

  // nvm: active shell sets NVM_BIN
  const nvmBin = process.env.NVM_BIN;
  if (nvmBin) pushDir(nvmBin);

  const nvmDir = process.env.NVM_DIR || path.join(home, ".nvm");
  const defaultAliasFile = path.join(nvmDir, "alias", "default");
  if (fs.existsSync(defaultAliasFile)) {
    try {
      const raw = fs.readFileSync(defaultAliasFile, "utf-8").trim();
      // Skip indirection like lts/* — resolve only concrete version labels
      if (raw && !raw.includes("*") && !raw.includes("/")) {
        const withV = raw.startsWith("v") ? raw : `v${raw}`;
        let candidate = path.join(nvmDir, "versions", "node", withV, "bin");
        if (!fs.existsSync(candidate) && raw.startsWith("v")) {
          candidate = path.join(nvmDir, "versions", "node", raw, "bin");
        }
        pushDir(candidate);
      }
    } catch {
      /* unreadable alias */
    }
  }

  const versionsDir = path.join(nvmDir, "versions", "node");
  try {
    if (fs.existsSync(versionsDir)) {
      const versions = fs
        .readdirSync(versionsDir)
        .filter((n) => /^v\d/.test(n))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) {
        pushDir(path.join(versionsDir, v, "bin"));
      }
    }
  } catch {
    /* skip */
  }

  const fnmMultishell = process.env.FNM_MULTISHELL_PATH;
  if (fnmMultishell) {
    pushDir(path.join(fnmMultishell, "bin"));
  }

  const voltaHome = process.env.VOLTA_HOME || path.join(home, ".volta");
  pushDir(path.join(voltaHome, "bin"));

  return dirs;
}

function dedupePathSegments(segments: (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of segments) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.join(":");
}

/**
 * PATH for Mermaid CLI, inline eval, and other subprocesses that should see
 * the same Node/Homebrew layout as a typical developer shell.
 */
export function buildCodeBlockPath(): string {
  const base = ["/usr/local/bin", "/usr/bin"];
  const home = os.homedir();
  const npmGlobal = path.join(home, ".npm-global", "bin");
  const nodeTools = collectNodeToolBinDirs();

  if (process.platform === "darwin") {
    return dedupePathSegments([
      "/opt/homebrew/bin",
      npmGlobal,
      ...nodeTools,
      `${home}/Library/TinyTeX/bin/universal-darwin`,
      "/Library/TeX/texbin",
      ...base,
      process.env.PATH,
    ]);
  }

  return dedupePathSegments([
    npmGlobal,
    ...nodeTools,
    ...base,
    `${home}/.TinyTeX/bin/x86_64-linux`,
    `${home}/.TinyTeX/bin/aarch64-linux`,
    "/usr/local/texlive/2024/bin/x86_64-linux",
    "/usr/local/texlive/2025/bin/x86_64-linux",
    "/usr/local/texlive/2026/bin/x86_64-linux",
    process.env.PATH,
  ]);
}

/** PATH for Pandoc / XeLaTeX / pdfLaTeX runs (TeX-heavy order, plus Node shims). */
export function buildTexInvocationPath(): string {
  const base = ["/usr/local/bin", "/usr/bin"];
  const home = os.homedir();
  const npmGlobal = path.join(home, ".npm-global", "bin");
  const nodeTools = collectNodeToolBinDirs();

  if (process.platform === "darwin") {
    return dedupePathSegments([
      "/Library/TeX/texbin",
      "/opt/homebrew/bin",
      npmGlobal,
      ...nodeTools,
      `${home}/Library/TinyTeX/bin/universal-darwin`,
      ...base,
      process.env.PATH,
    ]);
  }

  return dedupePathSegments([
    ...base,
    npmGlobal,
    ...nodeTools,
    `${home}/.TinyTeX/bin/x86_64-linux`,
    `${home}/.TinyTeX/bin/aarch64-linux`,
    "/usr/local/texlive/2024/bin/x86_64-linux",
    "/usr/local/texlive/2025/bin/x86_64-linux",
    "/usr/local/texlive/2026/bin/x86_64-linux",
    process.env.PATH,
  ]);
}

/**
 * Last resort: ask the user's login shell where a binary lives (-il loads
 * ~/.zshrc / profile hooks for nvm, fnm, etc.). Used when the constructed PATH
 * still misses mmdc.
 */
export function findBinaryViaShell(binaryName: string): string | undefined {
  if (process.platform === "win32") {
    try {
      const comspec = process.env.ComSpec || "cmd.exe";
      const result = execFileSync(comspec, ["/d", "/s", "/c", `where ${binaryName}`], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
      });
      const line = result.trim().split(/\r?\n/)[0]?.trim();
      return line && fs.existsSync(line) ? line : undefined;
    } catch {
      return undefined;
    }
  }

  try {
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    const result = execFileSync(shell, ["-ilc", `command -v ${binaryName} || which ${binaryName}`], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
    });
    const resolved = result.trim().split(/\r?\n/).pop()?.trim();
    return resolved && fs.existsSync(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}
