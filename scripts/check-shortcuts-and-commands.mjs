import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, "package.json");
const extensionTsPath = path.join(repoRoot, "src", "extension.ts");

const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const extensionSource = fs.readFileSync(extensionTsPath, "utf8");

const commands = pkg?.contributes?.commands ?? [];
const keybindings = pkg?.contributes?.keybindings ?? [];
const editorTitleMenus = pkg?.contributes?.menus?.["editor/title"] ?? [];

const commandIds = new Set(commands.map((c) => c.command));
const registeredCommandMatches = extensionSource.matchAll(/registerCommand\("([^"]+)"/g);
const registeredCommandIds = new Set(Array.from(registeredCommandMatches, (m) => m[1]));

const failures = [];

for (const kb of keybindings) {
  if (!commandIds.has(kb.command)) {
    failures.push(`keybinding command missing from contributes.commands: ${kb.command}`);
  }
  if (!registeredCommandIds.has(kb.command)) {
    failures.push(`keybinding command missing from extension registration: ${kb.command}`);
  }
}

for (const menuItem of editorTitleMenus) {
  if (!commandIds.has(menuItem.command)) {
    failures.push(`editor/title command missing from contributes.commands: ${menuItem.command}`);
  }
  if (!registeredCommandIds.has(menuItem.command)) {
    failures.push(`editor/title command missing from extension registration: ${menuItem.command}`);
  }
}

const previewKb = keybindings.find((k) => k.command === "inkwell.preview");
const compileKb = keybindings.find((k) => k.command === "inkwell.compile");
const runKb = keybindings.find((k) => k.command === "inkwell.runCodeBlocks");

if (!previewKb || previewKb.when !== "editorLangId == markdown || editorLangId == latex") {
  failures.push("inkwell.preview keybinding when-clause must be markdown or latex");
}
if (!compileKb || compileKb.when !== "editorLangId == markdown || editorLangId == latex") {
  failures.push("inkwell.compile keybinding when-clause must be markdown or latex");
}
if (!runKb || runKb.when !== "editorLangId == markdown") {
  failures.push("inkwell.runCodeBlocks keybinding when-clause must be markdown only");
}

if (!commandIds.has("inkwell.installPackage")) {
  failures.push("inkwell.installPackage missing from contributes.commands");
}
if (!registeredCommandIds.has("inkwell.installPackage")) {
  failures.push("inkwell.installPackage missing from extension registration");
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exit(1);
}

console.log("Shortcut and command stability checks passed.");
