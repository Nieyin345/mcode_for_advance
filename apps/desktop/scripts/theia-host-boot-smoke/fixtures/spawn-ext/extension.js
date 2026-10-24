// Positive control for the permission report: this file really does require
// `child_process`. It also gives the boot suite a command with a real return
// value, so the end-to-end assertion can check a value crossing the pipe
// (not just "no throw").
"use strict";
const vscode = require("vscode");
const cp = require("child_process");

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("mcodeSmoke.spawnEcho", async () => {
      return {
        // proving the host gives extensions a real Node runtime: `execSync` runs
        // and its stdout comes back
        echo: cp.execSync("node -e \"process.stdout.write('pong')\"", { encoding: "utf8" }),
        greeting: vscode.workspace.getConfiguration("mcodeSmoke").get("greeting"),
        appName: vscode.env.appName,
        // the command id the extension was asked to run
        active: vscode.window.activeTextEditor
          ? vscode.window.activeTextEditor.document.getText()
          : null,
      };
    }),
    // declared in package.json but NOT registered here on purpose:
    // the boot suite uses it to prove "declared" != "registered".
    vscode.commands.registerCommand("mcodeSmoke.undeclared", () => "undeclared-fn"),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
