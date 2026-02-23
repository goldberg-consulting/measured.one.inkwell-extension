import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import { getBlockHash, loadCache, saveCache, BlockCache } from "./cache";

const exec = promisify(execFile);

export class RunCancellation {
  private _cancelled = false;
  private _activeProcess: ChildProcess | undefined;

  get cancelled(): boolean {
    return this._cancelled;
  }

  cancel(): void {
    this._cancelled = true;
    if (this._activeProcess && !this._activeProcess.killed) {
      this._activeProcess.kill("SIGTERM");
    }
  }

  setProcess(proc: ChildProcess): void {
    this._activeProcess = proc;
  }

  clearProcess(): void {
    this._activeProcess = undefined;
  }
}

export type BlockStatus = "pending" | "running" | "cached" | "done" | "failed" | "cancelled";

export interface BlockProgress {
  index: number;
  total: number;
  lang: string;
  label: string;
  status: BlockStatus;
  elapsed?: number;
  error?: string;
  interpreter?: string;
  warning?: string;
}

export type DisplayMode = "output" | "both" | "code" | "none";

export interface CodeBlock {
  index: number;
  lang: string;
  source: string;
  file?: string;
  output?: string;
  env?: string;
  display?: DisplayMode;
  caption?: string;
  label?: string;
  startLine: number;
  endLine: number;
  raw: string;
}

export interface RunConfig {
  pythonEnv?: string;
  rEnv?: string;
  nodeEnv?: string;
  defaultDisplay?: DisplayMode;
}

export interface BlockResult {
  block: CodeBlock;
  stdout: string;
  stderr: string;
  exitCode: number;
  artifacts: Map<string, string>;
  cached: boolean;
  interpreter?: string;
  warning?: string;
}

const LANG_COMMANDS: Record<string, string[]> = {
  python: ["python3", "-u"],
  python3: ["python3", "-u"],
  r: ["Rscript"],
  shell: ["bash", "-e"],
  bash: ["bash", "-e"],
  sh: ["sh", "-e"],
  node: ["node"],
  javascript: ["node"],
};

const BLOCK_PATTERN = /^```\{(\w+)([^}]*)\}\s*\n([\s\S]*?)^```/gm;

export function parseRunConfig(markdown: string): RunConfig {
  const config: RunConfig = {};
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return config;

  const fm = fmMatch[1];
  const inkwellBlock = fm.match(/^inkwell:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!inkwellBlock) return config;

  const block = inkwellBlock[1] || "";
  const pyMatch = block.match(/^\s+python-env:\s*["']?(.+?)["']?\s*$/m);
  if (pyMatch) config.pythonEnv = pyMatch[1].trim();

  const rMatch = block.match(/^\s+r-env:\s*["']?(.+?)["']?\s*$/m);
  if (rMatch) config.rEnv = rMatch[1].trim();

  const nodeMatch = block.match(/^\s+node-env:\s*["']?(.+?)["']?\s*$/m);
  if (nodeMatch) config.nodeEnv = nodeMatch[1].trim();

  const displayMatch = block.match(/^\s+code-display:\s*["']?(\w+)["']?\s*$/m);
  if (displayMatch) {
    const val = displayMatch[1].trim() as DisplayMode;
    if (["output", "both", "code", "none"].includes(val)) {
      config.defaultDisplay = val;
    }
  }

  return config;
}

export function parseCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let match: RegExpExecArray | null;
  let index = 0;

  BLOCK_PATTERN.lastIndex = 0;
  while ((match = BLOCK_PATTERN.exec(markdown)) !== null) {
    const lang = match[1];
    const attrsStr = match[2].trim();
    const source = match[3];
    const raw = match[0];

    const charOffset = match.index;
    const startLine = markdown.substring(0, charOffset).split("\n").length;
    const endLine = startLine + raw.split("\n").length - 1;

    const attrs = parseAttrs(attrsStr);

    const display = (attrs.display as DisplayMode) || undefined;

    blocks.push({
      index: index++,
      lang,
      source: source.trimEnd(),
      file: attrs.file,
      output: attrs.output,
      env: attrs.env,
      display,
      caption: attrs.caption,
      label: attrs.label,
      startLine,
      endLine,
      raw,
    });
  }

  return blocks;
}

function parseAttrs(str: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /(\w+)="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(str)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

export interface ResolvedInterpreter {
  cmd: string;
  args: string[];
  envVars: Record<string, string>;
  label: string;
  warning?: string;
}

function resolveInterpreter(
  langKey: string,
  envPath: string | undefined,
  runConfig: RunConfig,
  workDir: string,
): ResolvedInterpreter {
  const defaults = LANG_COMMANDS[langKey];
  if (!defaults) return { cmd: langKey, args: [], envVars: {}, label: langKey };

  const [defaultCmd, ...defaultArgs] = defaults;

  const envSpec = envPath
    || (langKey.startsWith("python") ? runConfig.pythonEnv : undefined)
    || (langKey === "r" ? runConfig.rEnv : undefined)
    || (langKey === "node" || langKey === "javascript" ? runConfig.nodeEnv : undefined);

  if (!envSpec) {
    return { cmd: defaultCmd, args: defaultArgs, envVars: {}, label: defaultCmd };
  }

  const resolved = path.resolve(workDir, envSpec.replace(/^~/, process.env.HOME || "~"));

  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const isPython = langKey.startsWith("python") || langKey === "python3";
    const isNode = langKey === "node" || langKey === "javascript";

    if (isPython) {
      const bin = path.join(resolved, "bin", "python3");
      const binAlt = path.join(resolved, "bin", "python");
      const interpreter = fs.existsSync(bin) ? bin : fs.existsSync(binAlt) ? binAlt : undefined;
      if (!interpreter) {
        return {
          cmd: defaultCmd, args: defaultArgs, envVars: {},
          label: defaultCmd,
          warning: `Venv "${envSpec}" exists but has no python3 binary. Using system Python.`,
        };
      }
      return {
        cmd: interpreter,
        args: defaultArgs,
        envVars: {
          VIRTUAL_ENV: resolved,
          PATH: path.join(resolved, "bin") + ":" + (process.env.PATH || ""),
        },
        label: `${envSpec} (${interpreter})`,
      };
    }

    if (isNode) {
      const bin = path.join(resolved, "node_modules", ".bin", "node");
      const interpreter = fs.existsSync(bin) ? bin : defaultCmd;
      return {
        cmd: interpreter, args: defaultArgs,
        envVars: { PATH: path.join(resolved, "node_modules", ".bin") + ":" + (process.env.PATH || "") },
        label: `${envSpec} (node)`,
      };
    }

    return { cmd: defaultCmd, args: defaultArgs, envVars: {}, label: defaultCmd };
  }

  if (fs.existsSync(resolved)) {
    return { cmd: resolved, args: defaultArgs, envVars: {}, label: resolved };
  }

  return {
    cmd: defaultCmd, args: defaultArgs, envVars: {},
    label: defaultCmd,
    warning: `Environment "${envSpec}" not found at ${resolved}. Using system ${defaultCmd}. Run "Inkwell: Setup Python Env" to create it.`,
  };
}

export async function runBlock(
  block: CodeBlock,
  workDir: string,
  outputDir: string,
  cancel?: RunCancellation,
  runConfig?: RunConfig,
): Promise<BlockResult> {
  fs.mkdirSync(outputDir, { recursive: true });

  if (cancel?.cancelled) {
    return {
      block, stdout: "", stderr: "Cancelled", exitCode: 130,
      artifacts: new Map(), cached: false,
    };
  }

  const langKey = block.lang.toLowerCase();
  const commandParts = LANG_COMMANDS[langKey];
  if (!commandParts) {
    return {
      block, stdout: "", stderr: `Unsupported language: ${block.lang}`,
      exitCode: 1, artifacts: new Map(), cached: false,
    };
  }

  let scriptPath: string;

  if (block.file) {
    scriptPath = path.resolve(workDir, block.file);
    if (!fs.existsSync(scriptPath)) {
      return {
        block, stdout: "", stderr: `File not found: ${block.file}`,
        exitCode: 1, artifacts: new Map(), cached: false,
      };
    }
  } else {
    const ext = langKey === "python" || langKey === "python3" ? ".py"
      : langKey === "r" ? ".R"
      : langKey === "node" || langKey === "javascript" ? ".js"
      : ".sh";
    scriptPath = path.join(outputDir, `block_${block.index}${ext}`);
    fs.writeFileSync(scriptPath, block.source, "utf-8");
  }

  const interp = resolveInterpreter(langKey, block.env, runConfig || {}, workDir);

  const env = {
    ...process.env,
    ...interp.envVars,
    INKWELL_OUTPUT_DIR: outputDir,
    INKWELL_BLOCK_INDEX: String(block.index),
  };

  const cmd = interp.cmd;
  const args = [...interp.args, scriptPath];

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const proc = execFile(cmd, args, {
      cwd: workDir,
      timeout: 300_000,
      env,
      maxBuffer: 10 * 1024 * 1024,
    }, () => {});

    if (cancel) cancel.setProcess(proc);

    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let out = "";
      let err = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0 || code === null) {
          resolve({ stdout: out, stderr: err });
        } else {
          const e: any = new Error(`Process exited with code ${code}`);
          e.stdout = out;
          e.stderr = err;
          e.code = code;
          reject(e);
        }
      });
      proc.on("error", (e: any) => {
        e.stdout = out;
        e.stderr = err;
        reject(e);
      });
    });

    if (cancel) cancel.clearProcess();
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    if (cancel) cancel.clearProcess();
    stdout = err.stdout || "";
    stderr = err.stderr || "";
    exitCode = err.code ?? 1;
    if (cancel?.cancelled) exitCode = 130;
  }

  fs.writeFileSync(path.join(outputDir, "stdout.txt"), stdout, "utf-8");
  if (stderr) {
    fs.writeFileSync(path.join(outputDir, "stderr.txt"), stderr, "utf-8");
  }

  const artifacts = discoverArtifacts(outputDir);

  return {
    block, stdout, stderr, exitCode, artifacts, cached: false,
    interpreter: interp.label,
    warning: interp.warning,
  };
}

function discoverArtifacts(outputDir: string): Map<string, string> {
  const artifacts = new Map<string, string>();
  const skip = new Set(["stdout.txt", "stderr.txt"]);

  try {
    for (const entry of fs.readdirSync(outputDir)) {
      if (skip.has(entry) || entry.startsWith("block_")) continue;
      const full = path.join(outputDir, entry);
      if (fs.statSync(full).isFile()) {
        const name = path.basename(entry, path.extname(entry));
        artifacts.set(name, full);
      }
    }
  } catch {}

  return artifacts;
}

export function blockLabel(block: CodeBlock): string {
  if (block.file) return block.file;
  const preview = block.source.split("\n")[0].substring(0, 40);
  return preview || `${block.lang} block`;
}

export async function runAllBlocks(
  markdown: string,
  sourceFile: string,
  cancel?: RunCancellation,
  onProgress?: (p: BlockProgress) => void,
): Promise<BlockResult[]> {
  const blocks = parseCodeBlocks(markdown);
  if (!blocks.length) return [];

  const workDir = path.dirname(sourceFile);
  const cacheDir = path.join(workDir, ".inkwell", "outputs");
  fs.mkdirSync(cacheDir, { recursive: true });

  const runConfig = parseRunConfig(markdown);
  const cache = loadCache(cacheDir);
  const results: BlockResult[] = [];
  const total = blocks.length;

  for (const block of blocks) {
    if (cancel?.cancelled) {
      onProgress?.({
        index: block.index, total, lang: block.lang,
        label: blockLabel(block), status: "cancelled",
      });
      results.push({
        block, stdout: "", stderr: "Cancelled", exitCode: 130,
        artifacts: new Map(), cached: false,
      });
      continue;
    }

    const hash = getBlockHash(block, workDir);
    const blockDir = path.join(cacheDir, `block_${block.index}`);
    const cached = cache.blocks[block.index];

    if (cached && cached.hash === hash && cached.exitCode === 0) {
      const artifacts = discoverArtifacts(blockDir);
      let stdout = "";
      try {
        stdout = fs.readFileSync(path.join(blockDir, "stdout.txt"), "utf-8");
      } catch {}

      onProgress?.({
        index: block.index, total, lang: block.lang,
        label: blockLabel(block), status: "cached",
      });

      results.push({
        block, stdout, stderr: "", exitCode: 0,
        artifacts, cached: true,
      });
      continue;
    }

    onProgress?.({
      index: block.index, total, lang: block.lang,
      label: blockLabel(block), status: "running",
    });

    const t0 = Date.now();
    fs.mkdirSync(blockDir, { recursive: true });
    const result = await runBlock(block, workDir, blockDir, cancel, runConfig);
    const elapsed = Date.now() - t0;

    const status: BlockStatus = cancel?.cancelled ? "cancelled"
      : result.exitCode === 0 ? "done" : "failed";

    onProgress?.({
      index: block.index, total, lang: block.lang,
      label: blockLabel(block), status, elapsed,
      error: result.exitCode !== 0 ? result.stderr.split("\n")[0] : undefined,
      interpreter: result.interpreter,
      warning: result.warning,
    });

    results.push(result);

    cache.blocks[block.index] = {
      hash,
      exitCode: result.exitCode,
      timestamp: Date.now(),
    };
    saveCache(cacheDir, cache);
  }

  return results;
}
