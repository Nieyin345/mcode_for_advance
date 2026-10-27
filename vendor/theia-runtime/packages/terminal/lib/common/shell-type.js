"use strict";
// *****************************************************************************
// Copyright (C) 2025 STMicroelectronics and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************
Object.defineProperty(exports, "__esModule", { value: true });
exports.shellTypesToRegex = exports.windowShellTypesToRegex = void 0;
exports.looksLikeHostPrompt = looksLikeHostPrompt;
exports.looksLikePath = looksLikePath;
exports.cleanTerminalTitle = cleanTerminalTitle;
exports.guessShellTypeFromExecutable = guessShellTypeFromExecutable;
const core_1 = require("@theia/core");
const path = require("path");
exports.windowShellTypesToRegex = new Map([
    ["cmd" /* WindowsShellType.CommandPrompt */, /^cmd$/],
    ["gitbash" /* WindowsShellType.GitBash */, /^bash$/],
    ["wsl" /* WindowsShellType.Wsl */, /^wsl$/]
]);
exports.shellTypesToRegex = new Map([
    ["bash" /* GeneralShellType.Bash */, /^bash$/],
    ["csh" /* GeneralShellType.Csh */, /^csh$/],
    ["fish" /* GeneralShellType.Fish */, /^fish$/],
    ["julia" /* GeneralShellType.Julia */, /^julia$/],
    ["ksh" /* GeneralShellType.Ksh */, /^ksh$/],
    ["node" /* GeneralShellType.Node */, /^node$/],
    ["nu" /* GeneralShellType.NuShell */, /^nu$/],
    ["pwsh" /* GeneralShellType.PowerShell */, /^pwsh(-preview)?|powershell$/],
    ["python" /* GeneralShellType.Python */, /^py(?:thon)?(?:\d+)?$/],
    ["sh" /* GeneralShellType.Sh */, /^sh$/],
    ["zsh" /* GeneralShellType.Zsh */, /^zsh$/]
]);
const shellPrefixPatterns = [
    /^noglob\s+/,
    /^nocorrect\s+/,
    /^command\s+/,
    /^builtin\s+/,
    /^exec\s+/,
];
/** Matches `user@host:` style prompts (e.g. `user@host:~/path`). */
function looksLikeHostPrompt(value) {
    return /^[^@\s]+@[^:\s]+:/.test(value);
}
/** Checks whether a single token looks like a file-system path (starts with `/`, `~`, or `./`). */
function looksLikePath(value) {
    return /^[/~]|^\.\//.test(value);
}
/**
 * Cleans a shell-reported terminal title by stripping shell prefixes and
 * extracting the base command name. Returns an empty string for CWD/prompt-style
 * titles (e.g. `/home/user/project`, `user@host:~/path`) to signal that the
 * title should not be updated.
 */
function cleanTerminalTitle(title) {
    let cleaned = title.trim();
    let changed = true;
    while (changed) {
        changed = false;
        for (const pattern of shellPrefixPatterns) {
            const result = cleaned.replace(pattern, '');
            if (result !== cleaned) {
                cleaned = result;
                changed = true;
            }
        }
    }
    // user@host:path is always a CWD/prompt, skip the update
    if (looksLikeHostPrompt(cleaned)) {
        return '';
    }
    const parts = cleaned.split(/\s+/);
    // A single path-like token (no arguments) is likely a CWD, skip the update
    if (parts.length <= 1 && looksLikePath(cleaned)) {
        return '';
    }
    const command = parts[0];
    const baseName = command.includes('/') ? command.substring(command.lastIndexOf('/') + 1) : command;
    return baseName || title;
}
function guessShellTypeFromExecutable(executable) {
    if (!executable) {
        return undefined;
    }
    if (core_1.OS.backend.isWindows) {
        const windowsExecutableName = path.basename(executable, '.exe');
        for (const [shellType, pattern] of exports.windowShellTypesToRegex) {
            if (windowsExecutableName.match(pattern)) {
                return shellType;
            }
        }
        // check also for generic ones as python
        for (const [shellType, pattern] of exports.shellTypesToRegex) {
            if (windowsExecutableName.match(pattern)) {
                return shellType;
            }
        }
    }
    const executableName = path.basename(executable);
    for (const [shellType, pattern] of exports.shellTypesToRegex) {
        if (executableName.match(pattern)) {
            return shellType;
        }
    }
    return undefined;
}
//# sourceMappingURL=shell-type.js.map