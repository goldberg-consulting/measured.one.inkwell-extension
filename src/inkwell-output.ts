import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

/** Single "Inkwell LaTeX" output channel for compile logs and diagnostics. */
export function getInkwellOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Inkwell LaTeX");
  }
  return channel;
}
