"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH and others.
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
exports.ShellIntegrationInjector = void 0;
const tslib_1 = require("tslib");
const path = require("path");
const fs = require("fs");
const shell_type_1 = require("../common/shell-type");
const shell_process_1 = require("./shell-process");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
let ShellIntegrationInjector = class ShellIntegrationInjector {
    constructor() {
        this.INTEGRATION_ROOT_DIR = 'shell-integrations';
        this.BASH_RCFILE_FLAG = '--rcfile';
        this.BASH_INTEGRATION_SCRIPT_PATH = 'bash/bash-integration.bash';
        this.ZSH_INTEGRATION_ENV_VAR = 'THEIA_ZSH_DIR';
        this.ZSH_INTEGRATION_DIR = 'zsh';
        this.ZDOTDIR_ENV_VAR = 'ZDOTDIR';
        this.ZDOTDIR_RELATIVE_DIR = '/zsh/zdotdir/';
        this.ZDOTDIR_ORIGINAL_ENV_VAR = 'THEIA_ORIGINAL_ZDOTDIR';
    }
    injectShellIntegration(options) {
        const shellExecutable = options.shell ?? shell_process_1.ShellProcess.getShellExecutablePath();
        const shellType = (0, shell_type_1.guessShellTypeFromExecutable)(shellExecutable);
        if (shellType === "bash" /* GeneralShellType.Bash */) {
            const scriptPath = this.getShellIntegrationPath(this.BASH_INTEGRATION_SCRIPT_PATH);
            if (!scriptPath) {
                return options;
            }
            // strips the login flag if present to avoid conflicts with --rcfile
            const filteredArgs = this.stripLoginFlag(options.args);
            return {
                ...options,
                args: [
                    this.BASH_RCFILE_FLAG, scriptPath,
                    ...(filteredArgs ?? []),
                ],
            };
        }
        else if (shellType === "zsh" /* GeneralShellType.Zsh */) {
            const zdotdirPath = this.getShellIntegrationPath(this.ZDOTDIR_RELATIVE_DIR);
            const zshDirPath = this.getShellIntegrationPath(this.ZSH_INTEGRATION_DIR);
            if (!zdotdirPath || !zshDirPath) {
                return options;
            }
            return {
                ...options,
                env: {
                    ...options.env,
                    [this.ZDOTDIR_ENV_VAR]: zdotdirPath,
                    [this.ZSH_INTEGRATION_ENV_VAR]: zshDirPath,
                    [this.ZDOTDIR_ORIGINAL_ENV_VAR]: options.env?.ZDOTDIR ?? process.env.ZDOTDIR ?? ''
                },
            };
        }
        else {
            return options;
        }
    }
    getShellIntegrationPath(relativePath) {
        const fullPath = path.join(__dirname, this.INTEGRATION_ROOT_DIR, relativePath);
        if (!fs.existsSync(fullPath)) {
            this.logger.warn(`Shell integration file not found (application may not be bundled correctly): ${fullPath}`);
            return undefined;
        }
        return fullPath;
    }
    stripLoginFlag(args) {
        if (args === undefined) {
            return args;
        }
        if (typeof args === 'string') {
            // split string on any amount of whitespace into an array
            return args.trim().split(/\s+/).filter(arg => arg !== '-l' && arg !== '--login');
        }
        return args.filter(arg => arg !== '-l' && arg !== '--login');
    }
};
exports.ShellIntegrationInjector = ShellIntegrationInjector;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('terminal:ShellIntegrationInjector'),
    tslib_1.__metadata("design:type", Object)
], ShellIntegrationInjector.prototype, "logger", void 0);
exports.ShellIntegrationInjector = ShellIntegrationInjector = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ShellIntegrationInjector);
//# sourceMappingURL=shell-integration-injector.js.map