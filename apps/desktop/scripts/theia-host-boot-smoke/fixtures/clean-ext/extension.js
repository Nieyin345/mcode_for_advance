// Negative control for the permission report: this file requires ONLY `vscode`.
// If the report says `spawnsProcesses: true` for this extension, the report is
// a constant — and a constant warning is one users learn to ignore.
"use strict";
const vscode = require("vscode");

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("mcodeSmoke.clean", () => "clean-ok"),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
