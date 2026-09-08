// Code block runner. Executes dependency-ordered blocks in fresh attempts,
// then publishes successful, fingerprint-validated products through RunStore.
// Python, R, Node and shell are supported with system or project interpreters.

import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { getDocumentConfig, getInkwellProjectRoot } from "./config";
import { applyBlockOverrides, ConfigDiagnostic, DocumentConfig, resolveDocumentConfig } from "./document-config";
import { executeRunProcess, RunCancellation, ProcessOutcome } from "./run-process";
import { fingerprintBlock, resolveRunSource, RunStore, RunFingerprint } from "./run-store";
import { parseQuotedAttrs, parseRunList } from "./run-attributes";
import { containedRunPath, relativeRunPath } from "./run-paths";
import { RunLimits, runLimits } from "./run-limits";
export { parseQuotedAttrs } from "./run-attributes";
export { RunCancellation } from "./run-process";

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
  noCache?: boolean;
}

export type DisplayMode = "output" | "both" | "code" | "none";

export interface CodeBlock {
  index: number;
  id?: string;
  inputs?: string[];
  dependsOn?: string[];
  attributes?: Record<string, string>;
  configDiagnostics?: ConfigDiagnostic[];
  parsingError?: string;
  timeoutMs?: number;
  lang: string;
  source: string;
  file?: string;
  output?: string;
  env?: string;
  display?: DisplayMode;
  caption?: string;
  label?: string;
  noCache?: boolean;
  startLine: number;
  endLine: number;
  raw: string;
}

export interface RunConfig extends Partial<RunLimits> {
  pythonEnv?: string;
  rEnv?: string;
  nodeEnv?: string;
  defaultDisplay?: DisplayMode;
  timeoutMs?: number;
  maxBuffer?: number;
  cache?: boolean;
  inputs?: string[];
  dependsOn?: string[];
  diagnostics?: ConfigDiagnostic[];
  documentConfig?: DocumentConfig;
}

export interface BlockResult {
  block: CodeBlock;
  runId?: string;
  blockId?: string;
  fingerprint?: string;
  resultHash?: string;
  process?: ProcessOutcome;
  stdout: string;
  stderr: string;
  exitCode: number;
  artifacts: Map<string, string>;
  cached: boolean;
  cacheStatus?: "hit" | "miss";
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

// Quarto/Pandoc-style fenced code blocks: ```{python file="..." output="plot"}
const BLOCK_PATTERN = /^```\{(\w+)([^\r\n]*)\}\s*\r?\n([\s\S]*?)^```[ \t]*(?=\r?$)/gm;

export function parseRunConfig(markdown: string, sourceFile?: string): RunConfig {
  const config = sourceFile ? getDocumentConfig(markdown, sourceFile) : resolveDocumentConfig({ text: markdown });
  return {
    ...runLimits(config.runs as Partial<RunLimits>),
    pythonEnv: config.runs.pythonEnv, rEnv: config.runs.rEnv, nodeEnv: config.runs.nodeEnv,
    defaultDisplay: config.runs.display, cache: config.runs.cache,
    timeoutMs: config.runs.timeoutSeconds === undefined ? undefined : config.runs.timeoutSeconds * 1000,
    inputs: [...config.runs.inputs], dependsOn: [...config.runs.dependsOn], diagnostics: [...config.diagnostics], documentConfig: config,
  };
}

function applyRunDefaults(blocks: CodeBlock[], config: RunConfig): CodeBlock[] {
  return blocks.map(block => {
    const attributes: Record<string, unknown> = { ...block.attributes };
    if (block.inputs !== undefined) attributes.inputs = block.inputs;
    if (block.dependsOn !== undefined) attributes["depends-on"] = block.dependsOn;
    if (attributes.cache === "no") attributes.cache = false;
    if (attributes.cache === "yes") attributes.cache = true;
    const effective = applyBlockOverrides(config.documentConfig!, attributes);
    return { ...block,
      display: effective.runs.display,
      file: effective.runs.file, id: effective.runs.id, output: effective.runs.output,
      caption: effective.runs.caption, label: effective.runs.label,
      noCache: !effective.runs.cache,
      inputs: effective.runs.inputs.length ? [...effective.runs.inputs] : undefined,
      dependsOn: effective.runs.dependsOn.length ? [...effective.runs.dependsOn] : undefined,
      timeoutMs: effective.runs.timeoutSeconds === undefined ? undefined : effective.runs.timeoutSeconds * 1000,
      configDiagnostics: effective.diagnostics.map(diagnostic => config.diagnostics?.includes(diagnostic) ? diagnostic : { ...diagnostic, line: block.startLine }),
    };
  });
}

export function parseCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let match: RegExpExecArray | null;
  let index = 0;

  BLOCK_PATTERN.lastIndex = 0;
  while ((match = BLOCK_PATTERN.exec(markdown)) !== null) {
    const lang = match[1];
    if (lang === "mermaid") continue;
    const attrsStr = match[2].trim();
    const source = match[3];
    const raw = match[0];

    const charOffset = match.index;
    const startLine = markdown.substring(0, charOffset).split("\n").length;
    const endLine = startLine + raw.split("\n").length - 1;

    let attrs: Record<string, string> = {};
    let parsingError: string | undefined;
    try { attrs = parseQuotedAttrs(attrsStr); } catch (error) { parsingError = String(error); }

    const display = (attrs.display as DisplayMode) || undefined;
    const noCache = attrs.cache === undefined ? undefined : attrs.cache === "false" || attrs.cache === "no";

    blocks.push({
      index: index++,
      id: attrs.id,
      attributes: attrs,
      parsingError,
      inputs: attrs.inputs === undefined ? undefined : parseRunList(attrs.inputs),
      dependsOn: attrs["depends-on"] === undefined ? undefined : parseRunList(attrs["depends-on"]),
      lang,
      source: source.trimEnd(),
      file: attrs.file,
      output: attrs.output,
      env: attrs.env,
      display,
      caption: attrs.caption,
      label: attrs.label,
      noCache,
      startLine,
      endLine,
      raw,
    });
  }

  return blocks;
}

/** The python binary inside a venv directory, preferring python3. */
export function venvPythonBin(venvDir: string): string | undefined {
  const p3 = path.join(venvDir, "bin", "python3");
  const p = path.join(venvDir, "bin", "python");
  return fs.existsSync(p3) ? p3 : fs.existsSync(p) ? p : undefined;
}

/** Resolve a `python-env` spec (relative to project root or document dir) to its python binary. */
export function resolveVenvPython(
  envSpec: string,
  projectRoot: string,
  docDir: string,
): string | undefined {
  relativeRunPath(envSpec);
  const spec = envSpec;
  for (const base of [projectRoot, docDir]) {
    const directory = containedRunPath(projectRoot, path.resolve(base, spec), true);
    const bin = venvPythonBin(directory);
    if (bin) return bin;
  }
  return undefined;
}

export interface ResolvedInterpreter {
  cmd: string;
  args: string[];
  envVars: Record<string, string>;
  label: string;
  warning?: string;
}

// Resolves the interpreter binary for a given language and optional
// virtualenv. Falls back to the system interpreter if the env is missing
// and reports a warning so the user knows what happened.
export function resolveInterpreter(
  langKey: string,
  envPath: string | undefined,
  runConfig: RunConfig,
  projectRoot: string,
  docDir: string,
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

  // Project-selected environments are project paths. Installed system tools
  // remain available through the language's default executable on PATH.
  relativeRunPath(envSpec);
  const spec = envSpec;
  let resolved: string | undefined;
  for (const base of [projectRoot, docDir]) {
    const r = containedRunPath(projectRoot, path.resolve(base, spec), true);
    if (fs.existsSync(r)) {
      resolved = r;
      break;
    }
  }
  if (!resolved) resolved = path.resolve(projectRoot, spec);

  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const isPython = langKey.startsWith("python") || langKey === "python3";
    const isNode = langKey === "node" || langKey === "javascript";

    if (isPython) {
      const interpreter = venvPythonBin(resolved);
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

  let warning = `Environment "${envSpec}" not found at ${resolved}. Using system ${defaultCmd}. Run "Inkwell: Setup Python Env" to create it.`;
  if (langKey.startsWith("python")) {
    const reqFile = [path.join(docDir, "requirements.txt"), path.join(projectRoot, "requirements.txt")].find((p) =>
      fs.existsSync(p)
    );
    if (reqFile) {
      warning += ` Found requirements.txt at ${reqFile}; run setup from this document folder and choose "${envSpec}" to auto-install dependencies.`;
    }
  }

  return {
    cmd: defaultCmd, args: defaultArgs, envVars: {},
    label: defaultCmd,
    warning,
  };
}

function failedResult(block: CodeBlock, message: string, exitCode = 1): BlockResult {
  return { block, stdout: "", stderr: message, exitCode, artifacts: new Map(), cached: false, cacheStatus: "miss" };
}

export async function runBlock(
  block: CodeBlock, projectRoot: string, docDir: string, outputDir: string,
  cancel?: RunCancellation, runConfig: RunConfig = {},
  plan?: { interpreter: ResolvedInterpreter; fingerprint: RunFingerprint },
): Promise<BlockResult> {
  if (vscode.workspace.isTrusted === false) return failedResult(block, "Trust this workspace before running document code.");
  containedRunPath(projectRoot, outputDir, true, true);
  fs.mkdirSync(outputDir, { recursive: true });
  if (cancel?.cancelled) return failedResult(block, "Cancelled", 130);
  const langKey = block.lang.toLowerCase();
  if (!LANG_COMMANDS[langKey]) return failedResult(block, `Unsupported language: ${block.lang}`);
  const selected = resolveInterpreter(langKey, block.env, runConfig, projectRoot, docDir);
  const current = fingerprintBlock(block, docDir, projectRoot, selected, plan?.fingerprint.upstream, runLimits(runConfig));
  if (plan && current.hash !== plan.fingerprint.hash) return failedResult(block, "Source, inputs, or interpreter selection changed before execution; run again.");
  const interpreter = plan?.interpreter || selected;
  const fingerprint = plan?.fingerprint || current;
  let scriptPath: string;
  if (block.file) {
    scriptPath = resolveRunSource(block.file, docDir, projectRoot);
    if (!fs.existsSync(scriptPath)) return failedResult(block, `File not found: ${block.file}`);
  } else {
    const ext = langKey.startsWith("python") ? ".py" : langKey === "r" ? ".R"
      : ["node", "javascript"].includes(langKey) ? ".js" : ".sh";
    // Source stays outside the published artifacts directory.
    scriptPath = path.join(path.dirname(outputDir), `source${plan ? "" : `-${randomUUID()}`}${ext}`);
    containedRunPath(projectRoot, scriptPath, true, true);
    fs.writeFileSync(scriptPath, block.source, { encoding: "utf8", flag: "wx" });
  }
  const executable = fingerprint.interpreter.path;
  const outcome = await executeRunProcess(executable, [...interpreter.args, scriptPath], {
    cwd: projectRoot, timeoutMs: block.timeoutMs ?? runConfig.timeoutMs, maxBuffer: runConfig.maxBuffer,
    maxStdoutBytes: runConfig.maxStdoutBytes, maxStderrBytes: runConfig.maxStderrBytes,
    env: { ...process.env, ...interpreter.envVars, INKWELL_OUTPUT_DIR: outputDir, INKWELL_BLOCK_INDEX: String(block.index) },
  }, cancel);
  return { block, ...outcome, process: outcome,
    artifacts: outcome.exitCode === 0 ? discoverArtifacts(outputDir) : new Map(),
    cached: false, interpreter: interpreter.label, warning: interpreter.warning };
}

/** Used only to discover a fresh attempt; readers must go through RunStore.current. */
export function discoverArtifacts(outputDir: string): Map<string, string> {
  const artifacts = new Map<string, string>();
  if (!fs.existsSync(outputDir)) return artifacts;
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (entry.isFile()) artifacts.set(path.basename(entry.name, path.extname(entry.name)), path.join(outputDir, entry.name));
  }
  return artifacts;
}

export function blockLabel(block: CodeBlock): string {
  return block.file || block.source.split("\n")[0].substring(0, 40) || `${block.lang} block`;
}

/** Read-only validation used by both compilation and preview. */
export function readCurrentRunResults(markdown: string, sourceFile: string): BlockResult[] {
  if (vscode.workspace.isTrusted === false) return parseCodeBlocks(markdown).map(block => failedResult(block, "Trust this workspace before verifying document code results."));
  const runConfig = parseRunConfig(markdown, sourceFile);
  const blocks = applyRunDefaults(parseCodeBlocks(markdown), runConfig);
  const projectRoot = getInkwellProjectRoot(sourceFile);
  const docDir = path.dirname(sourceFile);
  const store = new RunStore(projectRoot, sourceFile, runLimits(runConfig));
  const invalid = runConfig.diagnostics?.filter(diagnostic => diagnostic.severity === "error");
  if (invalid?.length) return blocks.map(block => failedResult(block, invalid.map(diagnostic => diagnostic.message).join("\n")));
  let ids: string[];
  try { ids = store.assignBlockIds(blocks); } catch (error) { return blocks.map(block => failedResult(block, String(error))); }
  const byName = new Map(blocks.filter(block => block.id || block.label).map(block => [block.id || block.label!, block]));
  const results = new Map<number, BlockResult>(); const visiting = new Set<number>();
  const read = (block: CodeBlock): BlockResult => {
    const existing = results.get(block.index); if (existing) return existing;
    if (visiting.has(block.index)) return failedResult(block, "Cyclic run dependency");
    visiting.add(block.index);
    const invalid = block.configDiagnostics?.filter(diagnostic => diagnostic.severity === "error");
    if (invalid?.length || block.parsingError) {
      const result = failedResult(block, block.parsingError || invalid!.map(diagnostic => `Line ${diagnostic.line}: ${diagnostic.message}`).join("\n"));
      visiting.delete(block.index); results.set(block.index, result); return result;
    }
    if (!LANG_COMMANDS[block.lang.toLowerCase()]) {
      const result = failedResult(block, `Unsupported language: ${block.lang}`);
      visiting.delete(block.index); results.set(block.index, result); return result;
    }
    const upstream: Record<string, string> = {};
    let error: string | undefined;
    for (const dependency of block.dependsOn || []) {
      const upstreamBlock = byName.get(dependency);
      const result = upstreamBlock ? read(upstreamBlock) : undefined;
      if (!result?.resultHash || result.exitCode !== 0) error = `Run dependency is missing or stale: ${dependency}`;
      else upstream[dependency] = result.resultHash;
    }
    let result: BlockResult;
    try {
      const interpreter = resolveInterpreter(block.lang.toLowerCase(), block.env, runConfig, projectRoot, docDir);
      const fingerprint = fingerprintBlock(block, docDir, projectRoot, interpreter, upstream, runLimits(runConfig));
      if (Object.values(fingerprint.inputs).some(hash => hash === "missing")) error = "A declared input is missing.";
      result = error ? failedResult(block, error) : store.current(block, ids[block.index], fingerprint) || failedResult(block, "Run output is missing or stale. Run this block again.");
    } catch (reason) { result = failedResult(block, String(reason)); }
    visiting.delete(block.index); results.set(block.index, result); return result;
  };
  return blocks.map(read);
}

export async function runAllBlocks(
  markdown: string, sourceFile: string, cancel?: RunCancellation,
  onProgress?: (progress: BlockProgress) => void,
  selectedIndices?: number[],
): Promise<BlockResult[]> {
  const runConfig = parseRunConfig(markdown, sourceFile);
  const blocks = applyRunDefaults(parseCodeBlocks(markdown), runConfig); if (!blocks.length) return [];
  const projectRoot = getInkwellProjectRoot(sourceFile); const docDir = path.dirname(sourceFile);
  if (vscode.workspace.isTrusted === false) return blocks.map(block => failedResult(block, "Trust this workspace before running document code."));
  const store = new RunStore(projectRoot, sourceFile, runLimits(runConfig));
  const invalid = runConfig.diagnostics?.filter(diagnostic => diagnostic.severity === "error");
  if (invalid?.length) return blocks.map(block => {
    const result = failedResult(block, invalid.map(diagnostic => diagnostic.message).join("\n"));
    onProgress?.({ index: block.index, total: blocks.length, lang: block.lang, label: blockLabel(block), status: "failed", error: result.stderr });
    return result;
  });
  const ids = store.assignBlockIds(blocks, true);
  const byName = new Map(blocks.filter(block => block.id || block.label).map(block => [block.id || block.label!, block]));
  const results = new Map<number, BlockResult>(); const visiting = new Set<number>();
  const execute = async (block: CodeBlock): Promise<BlockResult> => {
    const existing = results.get(block.index); if (existing) return existing;
    if (visiting.has(block.index)) return failedResult(block, "Cyclic run dependency");
    visiting.add(block.index);
    const report = (status: BlockStatus, result?: BlockResult, elapsed?: number) => onProgress?.({
      index: block.index, total: blocks.length, lang: block.lang, label: blockLabel(block), status, elapsed,
      interpreter: result?.interpreter, warning: result?.warning, noCache: block.noCache,
      error: result?.exitCode ? result.stderr.split("\n")[0] : undefined,
    });
    const invalid = block.configDiagnostics?.filter(diagnostic => diagnostic.severity === "error");
    if (invalid?.length || block.parsingError) {
      const result = failedResult(block, block.parsingError || invalid!.map(diagnostic => `Line ${diagnostic.line}: ${diagnostic.message}`).join("\n"));
      report("failed", result); visiting.delete(block.index); results.set(block.index, result); return result;
    }
    if (!LANG_COMMANDS[block.lang.toLowerCase()]) {
      const result = failedResult(block, `Unsupported language: ${block.lang}`);
      report("failed", result); visiting.delete(block.index); results.set(block.index, result); return result;
    }
    const upstream: Record<string, string> = {}; let dependencyError: string | undefined;
    for (const dependency of block.dependsOn || []) {
      const upstreamBlock = byName.get(dependency); const result = upstreamBlock ? await execute(upstreamBlock) : undefined;
      if (!result?.resultHash || result.exitCode !== 0) dependencyError = `Run dependency failed or is missing: ${dependency}`;
      else upstream[dependency] = result.resultHash;
    }
    if (!store.isCurrentGeneration()) {
      const result = failedResult(block, "Run cache was cleared; remaining blocks were discarded.");
      report("cancelled", result); visiting.delete(block.index); results.set(block.index, result); return result;
    }
    let interpreter: ResolvedInterpreter;
    let fingerprint;
    try {
      interpreter = resolveInterpreter(block.lang.toLowerCase(), block.env, runConfig, projectRoot, docDir);
      fingerprint = fingerprintBlock(block, docDir, projectRoot, interpreter, upstream, runLimits(runConfig));
    }
    catch (error) {
      const result = failedResult(block, String(error));
      report("failed", result); visiting.delete(block.index); results.set(block.index, result); return result;
    }
    if (Object.values(fingerprint.inputs).some(hash => hash === "missing")) dependencyError = "A declared input is missing. Check the block inputs attribute.";
    let result = !block.noCache && !cancel?.cancelled && !dependencyError ? store.current(block, ids[block.index], fingerprint) : undefined;
    if (result) report("cached", result);
    else {
      const attempt = store.begin(ids[block.index], Boolean(block.id || block.label)); report("running");
      try {
        result = dependencyError ? failedResult(block, dependencyError)
          : await runBlock(block, projectRoot, docDir, attempt.artifactsDir, cancel, runConfig, { interpreter, fingerprint });
      } catch (error) { result = failedResult(block, String(error)); }
      const outcome: ProcessOutcome = result.process || { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
        rawExitCode: null, signal: null, timedOut: false, cancelled: Boolean(cancel?.cancelled), maxBufferExceeded: false };
      try {
        const currentUpstream: Record<string, string> = {};
        if (outcome.exitCode === 0 && block.dependsOn?.length) {
          const verified = new Map(readCurrentRunResults(markdown, sourceFile).map(item => [item.block.id || item.block.label, item]));
          for (const dependency of block.dependsOn) {
            const current = verified.get(dependency);
            if (!current?.resultHash || current.exitCode !== 0 || current.cacheStatus === "miss") throw new Error(`Upstream dependency changed during execution: ${dependency}. Run again.`);
            currentUpstream[dependency] = current.resultHash;
          }
        }
        const currentInterpreter = resolveInterpreter(block.lang.toLowerCase(), block.env, runConfig, projectRoot, docDir);
        if (outcome.exitCode === 0 && fingerprintBlock(block, docDir, projectRoot, currentInterpreter, currentUpstream, runLimits(runConfig)).hash !== fingerprint.hash) {
          outcome.exitCode = 1; outcome.stderr = "Source, inputs, or environment changed during execution; run again.";
        }
      } catch (error) { outcome.exitCode = 1; outcome.stderr = String(error); }
      const argv = [...interpreter.args, block.file ? fingerprint.sourcePath : path.join(attempt.directory, `source${block.lang.toLowerCase().startsWith("python") ? ".py" : block.lang.toLowerCase() === "r" ? ".R" : ["node", "javascript"].includes(block.lang.toLowerCase()) ? ".js" : ".sh"}`)];
      let manifest;
      try { manifest = store.finish(attempt, fingerprint, argv, outcome); }
      catch (error) { outcome.exitCode = 1; outcome.error = String(error); outcome.stderr = String(error); }
      const published = outcome.exitCode === 0 && manifest ? store.resultForManifest(block, manifest, fingerprint) : undefined;
      if (outcome.exitCode === 0 && !published) {
        outcome.exitCode = 1;
        outcome.error = "The generated result could not be verified after execution.";
        outcome.stderr = outcome.error;
        if (manifest) store.discardPublished(manifest);
      }
      if (published && manifest) store.confirmPublished(manifest);
      result = published ? { ...published, cached: false, interpreter: interpreter.label, warning: interpreter.warning }
        : { ...result, ...outcome, artifacts: new Map(), cached: false, cacheStatus: "miss" };
      report(outcome.cancelled ? "cancelled" : result.exitCode === 0 ? "done" : "failed", result, Date.now() - Date.parse(attempt.startedAt));
    }
    visiting.delete(block.index); results.set(block.index, result); return result;
  };
  for (const block of blocks) if (!selectedIndices || selectedIndices.includes(block.index)) await execute(block);
  return blocks.filter(block => results.has(block.index)).map(block => results.get(block.index)!);
}
