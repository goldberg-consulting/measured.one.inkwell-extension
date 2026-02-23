import * as vscode from "vscode";

export interface CompileError {
  line: number | undefined;
  message: string;
  severity: "error" | "warning";
  missingPackage?: string;
}

export class InkwellDiagnostics implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection;
  private codeActions: Map<string, vscode.CodeAction[]> = new Map();
  private codeActionProvider: vscode.Disposable;

  constructor() {
    this.collection =
      vscode.languages.createDiagnosticCollection("inkwell");

    this.codeActionProvider = vscode.languages.registerCodeActionsProvider(
      "markdown",
      {
        provideCodeActions: (document, range) => {
          const key = document.uri.toString();
          const actions = this.codeActions.get(key);
          if (!actions) return [];
          return actions.filter((a) => {
            const diag = a.diagnostics?.[0];
            return diag && range.intersection(diag.range);
          });
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    );
  }

  report(uri: vscode.Uri, errors: CompileError[]): void {
    const diagnostics: vscode.Diagnostic[] = [];
    const actions: vscode.CodeAction[] = [];

    for (const err of errors) {
      const line = err.line ? err.line - 1 : 0;
      const range = new vscode.Range(line, 0, line, 1000);
      const severity =
        err.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning;

      const diag = new vscode.Diagnostic(range, err.message, severity);
      diag.source = "inkwell";
      diagnostics.push(diag);

      if (err.missingPackage) {
        const action = new vscode.CodeAction(
          `Install ${err.missingPackage} via tlmgr`,
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.command = {
          title: `Install ${err.missingPackage}`,
          command: "inkwell.installPackage",
          arguments: [err.missingPackage],
        };
        actions.push(action);
      }
    }

    this.collection.set(uri, diagnostics);
    this.codeActions.set(uri.toString(), actions);
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
    this.codeActions.delete(uri.toString());
  }

  dispose(): void {
    this.collection.dispose();
    this.codeActionProvider.dispose();
  }
}
