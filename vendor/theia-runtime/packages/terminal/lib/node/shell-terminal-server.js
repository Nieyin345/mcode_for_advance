"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShellTerminalServer = void 0;
const tslib_1 = require("tslib");
// *****************************************************************************
// Copyright (C) 2017 Ericsson and others.
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
const child_process_1 = require("child_process");
const fs = require("fs");
const inversify_1 = require("@theia/core/shared/inversify");
const logger_1 = require("@theia/core/lib/common/logger");
const environment_utils_1 = require("@theia/core/lib/node/environment-utils");
const base_terminal_server_1 = require("./base-terminal-server");
const shell_process_1 = require("./shell-process");
const node_1 = require("@theia/process/lib/node");
const os_1 = require("@theia/core/lib/common/os");
const cp = require("child_process");
const shell_terminal_protocol_1 = require("../common/shell-terminal-protocol");
const core_1 = require("@theia/core");
const collections_1 = require("@theia/core/lib/common/collections");
let ShellTerminalServer = class ShellTerminalServer extends base_terminal_server_1.BaseTerminalServer {
    constructor(shellFactory, processManager, logger) {
        super(processManager, logger);
        this.shellFactory = shellFactory;
        this.logger = logger;
        this.collections = new collections_1.MultiKeyMap(2);
    }
    async create(options) {
        try {
            this.validateTerminalOptions(options);
            if (options.strictEnv !== true) {
                options.env = this.environmentUtils.mergeProcessEnv(options.env);
                this.applyToProcessEnvironment(core_1.URI.fromFilePath((0, shell_process_1.getRootPath)(options.rootURI)), options.env);
            }
            const term = this.shellFactory(options);
            this.postCreate(term);
            return term.id;
        }
        catch (error) {
            this.logger.error('Error while creating terminal', error);
            return -1;
        }
    }
    /**
     * Validates and sanitizes terminal options received from the client.
     * Invalid values are replaced with safe defaults rather than rejecting the request,
     * so legitimate users with misconfigured preferences still get a working terminal.
     */
    validateTerminalOptions(options) {
        // Validate shell: must be an existing, executable file. Fall back to default otherwise.
        if (options.shell !== undefined) {
            if (typeof options.shell !== 'string' || !this.isValidShell(options.shell)) {
                this.logger.warn(`Invalid shell "${options.shell}": falling back to default shell.`);
                options.shell = undefined;
            }
        }
        // Validate rootURI: must resolve to an existing directory.
        if (options.rootURI !== undefined) {
            try {
                const rootPath = (0, shell_process_1.getRootPath)(options.rootURI);
                if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
                    this.logger.warn(`Invalid rootURI "${options.rootURI}": falling back to home directory.`);
                    options.rootURI = undefined;
                }
            }
            catch {
                this.logger.warn(`Invalid rootURI "${options.rootURI}": falling back to home directory.`);
                options.rootURI = undefined;
            }
        }
        // Validate cols/rows: must be positive integers within reasonable bounds.
        if (options.cols !== undefined) {
            if (typeof options.cols !== 'number' || !Number.isInteger(options.cols) || options.cols < 1 || options.cols > 500) {
                options.cols = undefined;
            }
        }
        if (options.rows !== undefined) {
            if (typeof options.rows !== 'number' || !Number.isInteger(options.rows) || options.rows < 1 || options.rows > 500) {
                options.rows = undefined;
            }
        }
        // Validate args: must be a string array or a single string.
        if (options.args !== undefined) {
            if (typeof options.args === 'string') {
                // single string is fine
            }
            else if (Array.isArray(options.args)) {
                if (!options.args.every(arg => typeof arg === 'string')) {
                    options.args = undefined;
                }
            }
            else {
                options.args = undefined;
            }
        }
    }
    isValidShell(shell) {
        try {
            // On Windows, cmd.exe and powershell.exe are resolved from PATH,
            // so we only check accessibility for absolute paths.
            if (os_1.isWindows && !/[/\\]/.test(shell)) {
                return true;
            }
            fs.accessSync(shell, fs.constants.X_OK);
            return true;
        }
        catch {
            return false;
        }
    }
    // copied and modified from https://github.com/microsoft/vscode/blob/4636be2b71c87bfb0bfe3c94278b447a5efcc1f1/src/vs/workbench/contrib/debug/node/terminals.ts#L32-L75
    spawnAsPromised(command, args) {
        return new Promise((resolve, reject) => {
            let stdout = '';
            const child = cp.spawn(command, args, {
                shell: true
            });
            if (child.pid) {
                child.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
            }
            child.on('error', err => {
                reject(err);
            });
            child.on('close', code => {
                resolve(stdout);
            });
        });
    }
    hasChildProcesses(processId) {
        if (processId) {
            // if shell has at least one child process, assume that shell is busy
            if (os_1.isWindows) {
                return new Promise(resolve => {
                    (0, child_process_1.exec)('powershell -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId | ConvertTo-Json"', (error, stdout) => {
                        if (error) {
                            this.logger.error(`Failed to get Windows process list: ${error}`);
                            return resolve(true); // assume busy on error
                        }
                        try {
                            const processes = JSON.parse(stdout);
                            const hasChild = processes.some(proc => proc.ParentProcessId === processId);
                            return resolve(hasChild);
                        }
                        catch (parseError) {
                            this.logger.error(`Failed to parse process list JSON: ${parseError}`);
                            return resolve(true); // assume busy on parse error
                        }
                    });
                });
            }
            else {
                return this.spawnAsPromised('/usr/bin/pgrep', ['-lP', String(processId)]).then(stdout => {
                    const r = stdout.trim();
                    if (r.length === 0 || r.indexOf(' tmux') >= 0) { // ignore 'tmux';
                        return false;
                    }
                    else {
                        return true;
                    }
                }, error => true);
            }
        }
        // fall back to safe side
        return Promise.resolve(true);
    }
    applyToProcessEnvironment(cwdUri, env) {
        let lowerToActualVariableNames;
        if (os_1.isWindows) {
            lowerToActualVariableNames = {};
            Object.keys(env).forEach(e => lowerToActualVariableNames[e.toLowerCase()] = e);
        }
        this.collections.forEach((mutators, [extensionIdentifier, rootUri]) => {
            if (rootUri === shell_terminal_protocol_1.NO_ROOT_URI || this.matchesRootUri(cwdUri, rootUri)) {
                mutators.variableMutators.forEach((mutator, variable) => {
                    const actualVariable = os_1.isWindows ? lowerToActualVariableNames[variable.toLowerCase()] || variable : variable;
                    switch (mutator.type) {
                        case shell_terminal_protocol_1.EnvironmentVariableMutatorType.Append:
                            env[actualVariable] = (env[actualVariable] || '') + mutator.value;
                            break;
                        case shell_terminal_protocol_1.EnvironmentVariableMutatorType.Prepend:
                            env[actualVariable] = mutator.value + (env[actualVariable] || '');
                            break;
                        case shell_terminal_protocol_1.EnvironmentVariableMutatorType.Replace:
                            env[actualVariable] = mutator.value;
                            break;
                    }
                });
            }
        });
    }
    matchesRootUri(cwdUri, rootUri) {
        return new core_1.URI(rootUri).isEqualOrParent(cwdUri);
    }
    /*---------------------------------------------------------------------------------------------
  *  Copyright (c) Microsoft Corporation. All rights reserved.
  *  Licensed under the MIT License. See License.txt in the project root for license information.
  *--------------------------------------------------------------------------------------------*/
    // some code copied and modified from https://github.com/microsoft/vscode/blob/1.49.0/src/vs/workbench/contrib/terminal/common/environmentVariableService.ts
    setCollection(extensionIdentifier, baseUri, persistent, collection) {
        this.doSetCollection(extensionIdentifier, baseUri, persistent, collection);
        this.updateCollections();
    }
    doSetCollection(extensionIdentifier, baseUri, persistent, collection) {
        this.collections.set([extensionIdentifier, baseUri], {
            persistent: persistent,
            description: collection.description,
            variableMutators: new Map(collection.mutators)
        });
    }
    restorePersisted(jsonValue) {
        const collectionsJson = JSON.parse(jsonValue);
        collectionsJson.forEach(c => this.doSetCollection(c.extensionIdentifier, c.rootUri ?? shell_terminal_protocol_1.NO_ROOT_URI, true, c.collection));
    }
    deleteCollection(extensionIdentifier) {
        this.collections.delete([extensionIdentifier]);
        this.updateCollections();
    }
    updateCollections() {
        this.persistCollections();
    }
    persistCollections() {
        const collectionsJson = [];
        this.collections.forEach((collection, [extensionIdentifier, rootUri]) => {
            if (collection.persistent) {
                collectionsJson.push({
                    extensionIdentifier,
                    rootUri,
                    collection: {
                        description: collection.description,
                        mutators: [...this.collections.get([extensionIdentifier, rootUri]).variableMutators.entries()]
                    },
                });
            }
        });
        if (this.client) {
            const stringifiedJson = JSON.stringify(collectionsJson);
            this.client.storeTerminalEnvVariables(stringifiedJson);
        }
    }
    async getEnvVarCollectionDescriptionsByExtension(id) {
        const terminal = this.processManager.get(id);
        if (!(terminal instanceof node_1.TerminalProcess)) {
            throw new Error(`terminal "${id}" does not exist`);
        }
        const result = new Map();
        this.collections.forEach((value, key) => {
            const prev = result.get(key[0]) || [];
            prev.push(value.description);
            result.set(key[0], prev);
        });
        return result;
    }
    async getEnvVarCollections() {
        const result = [];
        this.collections.forEach((value, [extensionIdentifier, rootUri]) => {
            result.push([extensionIdentifier, rootUri, value.persistent, { description: value.description, mutators: [...value.variableMutators.entries()] }]);
        });
        return result;
    }
};
exports.ShellTerminalServer = ShellTerminalServer;
tslib_1.__decorate([
    (0, inversify_1.inject)(environment_utils_1.EnvironmentUtils),
    tslib_1.__metadata("design:type", environment_utils_1.EnvironmentUtils)
], ShellTerminalServer.prototype, "environmentUtils", void 0);
exports.ShellTerminalServer = ShellTerminalServer = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(shell_process_1.ShellProcessFactory)),
    tslib_1.__param(1, (0, inversify_1.inject)(node_1.ProcessManager)),
    tslib_1.__param(2, (0, inversify_1.inject)(logger_1.ILogger)),
    tslib_1.__param(2, (0, inversify_1.named)('terminal:ShellTerminalServer')),
    tslib_1.__metadata("design:paramtypes", [Function, node_1.ProcessManager, Object])
], ShellTerminalServer);
//# sourceMappingURL=shell-terminal-server.js.map