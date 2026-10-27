"use strict";
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
var TerminalServiceExtImpl_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PseudoTerminal = exports.TerminalExtImpl = exports.EnvironmentVariableCollectionImpl = exports.TerminalServiceExtImpl = void 0;
const tslib_1 = require("tslib");
const coreutils_1 = require("@theia/core/shared/@lumino/coreutils");
const inversify_1 = require("@theia/core/shared/inversify");
const plugin_api_rpc_1 = require("../common/plugin-api-rpc");
const rpc_protocol_1 = require("../common/rpc-protocol");
const event_1 = require("@theia/core/lib/common/event");
const collections_1 = require("@theia/core/lib/common/collections");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const Converter = require("./type-converters");
const types_impl_1 = require("./types-impl");
const shell_terminal_protocol_1 = require("@theia/terminal/lib/common/shell-terminal-protocol");
const plugin_icon_path_1 = require("./plugin-icon-path");
/**
 * Provides high level terminal plugin api to use in the Theia plugins.
 * This service allow(with help proxy) create and use terminal emulator.
 */
let TerminalServiceExtImpl = class TerminalServiceExtImpl {
    static { TerminalServiceExtImpl_1 = this; }
    static { this.nextProviderId = 0; }
    constructor(rpc) {
        this._terminals = new Map();
        /**
         * Stores the API objects (Proxies) returned to plugins for each terminal.
         * This ensures that events fire with the same object instance that plugins received,
         * allowing strict equality checks (===) to work correctly.
         */
        this._terminalApiObjects = new Map();
        this._pseudoTerminals = new Map();
        this.terminalLinkProviders = new Map();
        this.terminalObservers = new Map();
        this.terminalProfileProviders = new Map();
        this.onDidCloseTerminalEmitter = new event_1.Emitter();
        this.onDidCloseTerminal = this.onDidCloseTerminalEmitter.event;
        this.onDidOpenTerminalEmitter = new event_1.Emitter();
        this.onDidOpenTerminal = this.onDidOpenTerminalEmitter.event;
        this.onDidChangeActiveTerminalEmitter = new event_1.Emitter();
        this.onDidChangeActiveTerminal = this.onDidChangeActiveTerminalEmitter.event;
        this.onDidChangeTerminalStateEmitter = new event_1.Emitter();
        this.onDidChangeTerminalState = this.onDidChangeTerminalStateEmitter.event;
        this.environmentVariableCollections = new collections_1.MultiKeyMap(2);
        this.onDidChangeShellEmitter = new event_1.Emitter();
        this.onDidChangeShell = this.onDidChangeShellEmitter.event;
        this.proxy = rpc.getProxy(plugin_api_rpc_1.PLUGIN_RPC_CONTEXT.TERMINAL_MAIN);
    }
    get terminals() {
        return [...this._terminals.keys()].map(id => this.getApiObject(id)).filter((t) => t !== undefined);
    }
    get defaultShell() {
        return this.shell || '';
    }
    async $setShell(shell) {
        if (this.shell !== shell) {
            this.shell = shell;
            this.onDidChangeShellEmitter.fire(shell);
        }
    }
    createTerminal(plugin, nameOrOptions, shellPath, shellArgs, apiObjectWrapper) {
        const id = `plugin-terminal-${coreutils_1.UUID.uuid4()}`;
        let options;
        let pseudoTerminal = undefined;
        if (typeof nameOrOptions === 'object') {
            if ('pty' in nameOrOptions) {
                pseudoTerminal = nameOrOptions.pty;
                options = {
                    name: nameOrOptions.name,
                };
                this._pseudoTerminals.set(id, new PseudoTerminal(id, this.proxy, pseudoTerminal));
            }
            else {
                options = nameOrOptions;
            }
        }
        else {
            options = {
                name: nameOrOptions,
                shellPath: shellPath,
                shellArgs: shellArgs
            };
        }
        let parentId;
        if (options.location && typeof options.location === 'object' && 'parentTerminal' in options.location) {
            const parentTerminal = options.location.parentTerminal;
            // Check both the API proxy objects and the raw terminals, since
            // plugins receive the proxy but _terminals stores the raw object.
            for (const [k, v] of this._terminalApiObjects) {
                if (v === parentTerminal) {
                    parentId = k;
                    break;
                }
            }
            if (!parentId) {
                for (const [k, v] of this._terminals) {
                    if (v === parentTerminal) {
                        parentId = k;
                        break;
                    }
                }
            }
        }
        if (typeof nameOrOptions === 'object' && 'iconPath' in nameOrOptions) {
            const iconPath = nameOrOptions.iconPath;
            options.iconUrl = plugin_icon_path_1.PluginIconPath.toUrl(iconPath, plugin) ?? types_impl_1.ThemeIcon.get(iconPath);
        }
        if (typeof nameOrOptions === 'object' && 'color' in nameOrOptions) {
            options.color = nameOrOptions.color;
        }
        this.proxy.$createTerminal(id, options, parentId, !!pseudoTerminal);
        let creationOptions = options;
        // make sure to pass ExtensionTerminalOptions as creation options
        if (typeof nameOrOptions === 'object' && 'pty' in nameOrOptions) {
            creationOptions = nameOrOptions;
        }
        const terminal = this.obtainTerminal(id, options.name || 'Terminal', creationOptions);
        // If a wrapper function is provided, wrap the terminal and register the API object
        // This ensures events fire with the same object instance that plugins received
        if (apiObjectWrapper) {
            const apiObject = apiObjectWrapper(terminal);
            this._terminalApiObjects.set(id, apiObject);
            return apiObject;
        }
        return terminal;
    }
    attachPtyToTerminal(terminalId, pty) {
        this._pseudoTerminals.set(terminalId.toString(), new PseudoTerminal(terminalId, this.proxy, pty, true));
    }
    obtainTerminal(id, name, options) {
        let terminal = this._terminals.get(id);
        if (!terminal) {
            terminal = new TerminalExtImpl(this.proxy, options ?? {});
            this._terminals.set(id, terminal);
        }
        terminal.name = name;
        return terminal;
    }
    /**
     * Gets the API object for a terminal by ID, falling back to the raw terminal if not set.
     */
    getApiObject(id) {
        return this._terminalApiObjects.get(id) ?? this._terminals.get(id);
    }
    $terminalOnInput(id, data) {
        const terminal = this._pseudoTerminals.get(id);
        if (!terminal) {
            return;
        }
        terminal.emitOnInput(data);
    }
    $terminalOnInteraction(id) {
        const terminal = this._terminals.get(id);
        if (!terminal) {
            return;
        }
        if (!terminal.state.isInteractedWith) {
            terminal.state = { ...terminal.state, isInteractedWith: true };
            const apiObject = this.getApiObject(id);
            if (apiObject) {
                this.onDidChangeTerminalStateEmitter.fire(apiObject);
            }
        }
    }
    $terminalShellTypeChanged(id, shellType) {
        const terminal = this._terminals.get(id);
        if (!terminal) {
            return;
        }
        if (terminal.state.shell !== shellType) {
            terminal.state = { ...terminal.state, shell: shellType };
            const apiObject = this.getApiObject(id);
            if (apiObject) {
                this.onDidChangeTerminalStateEmitter.fire(apiObject);
            }
        }
    }
    $terminalSizeChanged(id, clos, rows) {
        const terminal = this._pseudoTerminals.get(id);
        if (!terminal) {
            return;
        }
        terminal.emitOnResize(clos, rows);
    }
    $terminalCreated(id, name) {
        const terminal = this.obtainTerminal(id, name);
        terminal.id.resolve(id);
        const apiObject = this.getApiObject(id);
        if (apiObject) {
            this.onDidOpenTerminalEmitter.fire(apiObject);
        }
    }
    $terminalNameChanged(id, name) {
        const terminal = this._terminals.get(id);
        if (terminal) {
            terminal.name = name;
        }
    }
    $terminalOpened(id, processId, terminalId, cols, rows) {
        const terminal = this._terminals.get(id);
        if (terminal) {
            // resolve for existing clients
            terminal.deferredProcessId.resolve(processId);
            // install new if terminal is reconnected
            terminal.deferredProcessId = new promise_util_1.Deferred();
            terminal.deferredProcessId.resolve(processId);
        }
        // Switch the pseudoterminal keyed by terminalId to be keyed by terminal ID
        const tId = terminalId.toString();
        if (this._pseudoTerminals.has(tId)) {
            const pseudo = this._pseudoTerminals.get(tId);
            if (pseudo) {
                this._pseudoTerminals.set(id, pseudo);
            }
            this._pseudoTerminals.delete(tId);
        }
        const pseudoTerminal = this._pseudoTerminals.get(id);
        if (pseudoTerminal) {
            pseudoTerminal.emitOnOpen(cols, rows);
        }
    }
    $terminalClosed(id, exitStatus) {
        const terminal = this._terminals.get(id);
        if (terminal) {
            terminal.exitStatus = exitStatus ?? { code: undefined, reason: types_impl_1.TerminalExitReason.Unknown };
            const apiObject = this.getApiObject(id);
            if (apiObject) {
                this.onDidCloseTerminalEmitter.fire(apiObject);
            }
            this._terminals.delete(id);
            this._terminalApiObjects.delete(id);
        }
        const pseudoTerminal = this._pseudoTerminals.get(id);
        if (pseudoTerminal) {
            pseudoTerminal.emitOnClose();
            this._pseudoTerminals.delete(id);
        }
    }
    get activeTerminal() {
        return this.activeTerminalId && this.getApiObject(this.activeTerminalId) || undefined;
    }
    $currentTerminalChanged(id) {
        this.activeTerminalId = id;
        this.onDidChangeActiveTerminalEmitter.fire(this.activeTerminal);
    }
    registerTerminalLinkProvider(provider) {
        const providerId = (TerminalServiceExtImpl_1.nextProviderId++).toString();
        this.terminalLinkProviders.set(providerId, provider);
        this.proxy.$registerTerminalLinkProvider(providerId);
        return types_impl_1.Disposable.create(() => {
            this.proxy.$unregisterTerminalLinkProvider(providerId);
            this.terminalLinkProviders.delete(providerId);
        });
    }
    registerTerminalProfileProvider(id, provider) {
        this.terminalProfileProviders.set(id, provider);
        return types_impl_1.Disposable.create(() => {
            this.terminalProfileProviders.delete(id);
        });
    }
    /** @stubbed */
    registerTerminalQuickFixProvider(id, provider) {
        return types_impl_1.Disposable.NULL;
    }
    registerTerminalObserver(observer) {
        const id = (TerminalServiceExtImpl_1.nextProviderId++).toString();
        this.terminalObservers.set(id, observer);
        this.proxy.$registerTerminalObserver(id, observer.nrOfLinesToMatch, observer.outputMatcherRegex);
        return types_impl_1.Disposable.create(() => {
            this.proxy.$unregisterTerminalObserver(id);
            this.terminalObservers.delete(id);
        });
    }
    $reportOutputMatch(observerId, groups) {
        const observer = this.terminalObservers.get(observerId);
        if (observer) {
            observer.matchOccurred(groups);
        }
        else {
            throw new Error(`reporting matches for unregistered observer: ${observerId} `);
        }
    }
    isExtensionTerminalOptions(options) {
        return 'pty' in options;
    }
    async $startProfile(profileId, cancellationToken) {
        const provider = this.terminalProfileProviders.get(profileId);
        if (!provider) {
            throw new Error(`No terminal profile provider with id '${profileId}'`);
        }
        const profile = await provider.provideTerminalProfile(cancellationToken);
        if (!profile) {
            throw new Error(`Profile with id ${profileId} could not be created`);
        }
        const id = `plugin-terminal-${coreutils_1.UUID.uuid4()}`;
        const options = profile.options;
        if (this.isExtensionTerminalOptions(options)) {
            this._pseudoTerminals.set(id, new PseudoTerminal(id, this.proxy, options.pty));
            return this.proxy.$createTerminal(id, { name: options.name }, undefined, true);
        }
        else {
            return this.proxy.$createTerminal(id, profile.options);
        }
    }
    async $provideTerminalLinks(line, terminalId, token) {
        const links = [];
        const terminal = this.getApiObject(terminalId);
        if (terminal) {
            for (const [providerId, provider] of this.terminalLinkProviders) {
                const providedLinks = await provider.provideTerminalLinks({ line, terminal }, token);
                if (providedLinks) {
                    links.push(...providedLinks.map(link => ({ ...link, providerId })));
                }
            }
        }
        return links;
    }
    async $handleTerminalLink(link) {
        const provider = this.terminalLinkProviders.get(link.providerId);
        if (!provider) {
            throw Error('Terminal link provider not found');
        }
        await provider.handleTerminalLink(link);
    }
    /*---------------------------------------------------------------------------------------------
     *  Copyright (c) Microsoft Corporation. All rights reserved.
     *  Licensed under the MIT License. See License.txt in the project root for license information.
     *--------------------------------------------------------------------------------------------*/
    // some code copied and modified from https://github.com/microsoft/vscode/blob/1.49.0/src/vs/workbench/api/common/extHostTerminalService.ts
    getEnvironmentVariableCollection(extensionIdentifier, rootUri = shell_terminal_protocol_1.NO_ROOT_URI) {
        const that = this;
        let collection = this.environmentVariableCollections.get([extensionIdentifier, rootUri]);
        if (!collection) {
            collection = new class extends EnvironmentVariableCollectionImpl {
                getScoped(scope) {
                    return that.getEnvironmentVariableCollection(extensionIdentifier, scope.workspaceFolder?.uri.toString());
                }
            }(true);
            this.setEnvironmentVariableCollection(extensionIdentifier, rootUri, collection);
        }
        return collection;
    }
    syncEnvironmentVariableCollection(extensionIdentifier, rootUri, collection) {
        const serialized = [...collection.map.entries()];
        this.proxy.$setEnvironmentVariableCollection(collection.persistent, extensionIdentifier, rootUri, {
            mutators: serialized,
            description: Converter.fromMarkdownOrString(collection.description)
        });
    }
    setEnvironmentVariableCollection(pluginIdentifier, rootUri, collection) {
        this.environmentVariableCollections.set([pluginIdentifier, rootUri], collection);
        collection.onDidChangeCollection(() => {
            // When any collection value changes send this immediately, this is done to ensure
            // following calls to createTerminal will be created with the new environment. It will
            // result in more noise by sending multiple updates when called but collections are
            // expected to be small.
            this.syncEnvironmentVariableCollection(pluginIdentifier, rootUri, collection);
        });
    }
    $initEnvironmentVariableCollections(collections) {
        collections.forEach(entry => {
            const extensionIdentifier = entry[0];
            const rootUri = entry[1];
            const collection = new EnvironmentVariableCollectionImpl(entry[2], entry[3]);
            this.setEnvironmentVariableCollection(extensionIdentifier, rootUri, collection);
        });
    }
};
exports.TerminalServiceExtImpl = TerminalServiceExtImpl;
exports.TerminalServiceExtImpl = TerminalServiceExtImpl = TerminalServiceExtImpl_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(rpc_protocol_1.RPCProtocol)),
    tslib_1.__metadata("design:paramtypes", [Object])
], TerminalServiceExtImpl);
class EnvironmentVariableCollectionImpl {
    get description() { return this._description; }
    set description(value) {
        this._description = value;
        this.onDidChangeCollectionEmitter.fire();
    }
    get persistent() { return this._persistent; }
    set persistent(value) {
        this._persistent = value;
        this.onDidChangeCollectionEmitter.fire();
    }
    constructor(persistent, serialized) {
        this.map = new Map();
        this._persistent = true;
        this.onDidChangeCollectionEmitter = new event_1.Emitter();
        this.onDidChangeCollection = this.onDidChangeCollectionEmitter.event;
        this._persistent = persistent;
        this.map = new Map(serialized?.mutators);
    }
    getScoped(scope) {
        throw new Error('Cannot get scoped from a regular env var collection');
    }
    get size() {
        return this.map.size;
    }
    replace(variable, value, options) {
        this._setIfDiffers(variable, { value, type: types_impl_1.EnvironmentVariableMutatorType.Replace, options: options ?? { applyAtProcessCreation: true } });
    }
    append(variable, value, options) {
        this._setIfDiffers(variable, { value, type: types_impl_1.EnvironmentVariableMutatorType.Append, options: options ?? { applyAtProcessCreation: true } });
    }
    prepend(variable, value, options) {
        this._setIfDiffers(variable, { value, type: types_impl_1.EnvironmentVariableMutatorType.Prepend, options: options ?? { applyAtProcessCreation: true } });
    }
    _setIfDiffers(variable, mutator) {
        const current = this.map.get(variable);
        if (!current || current.value !== mutator.value || current.type !== mutator.type) {
            this.map.set(variable, mutator);
            this.onDidChangeCollectionEmitter.fire();
        }
    }
    get(variable) {
        return this.map.get(variable);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    forEach(callback, thisArg) {
        this.map.forEach((value, key) => callback.call(thisArg, key, value, this));
    }
    delete(variable) {
        this.map.delete(variable);
        this.onDidChangeCollectionEmitter.fire();
    }
    clear() {
        this.map.clear();
        this.onDidChangeCollectionEmitter.fire();
    }
}
exports.EnvironmentVariableCollectionImpl = EnvironmentVariableCollectionImpl;
class TerminalExtImpl {
    get processId() {
        return this.deferredProcessId.promise;
    }
    constructor(proxy, options) {
        this.proxy = proxy;
        this.options = options;
        this.id = new promise_util_1.Deferred();
        this.deferredProcessId = new promise_util_1.Deferred();
        this.state = { isInteractedWith: false, shell: undefined };
        /** @stubbed Terminal Shell Ingration */
        this.shellIntegration = undefined;
        this.creationOptions = this.options;
    }
    sendText(text, shouldExecute = true) {
        this.id.promise.then(id => this.proxy.$sendText(id, text, shouldExecute));
    }
    show(preserveFocus) {
        this.id.promise.then(id => this.proxy.$show(id, preserveFocus));
    }
    hide() {
        this.id.promise.then(id => this.proxy.$hide(id));
    }
    dispose() {
        this.id.promise.then(id => this.proxy.$dispose(id));
    }
}
exports.TerminalExtImpl = TerminalExtImpl;
class PseudoTerminal {
    constructor(id, proxy, pseudoTerminal, waitOnExit) {
        this.proxy = proxy;
        this.pseudoTerminal = pseudoTerminal;
        pseudoTerminal.onDidWrite(data => {
            if (typeof id === 'string') {
                this.proxy.$write(id, data);
            }
            else {
                this.proxy.$writeByTerminalId(id, data);
            }
        });
        if (pseudoTerminal.onDidClose) {
            pseudoTerminal.onDidClose((e = undefined) => {
                if (typeof id === 'string') {
                    this.proxy.$dispose(id);
                }
                else {
                    this.proxy.$disposeByTerminalId(id, waitOnExit);
                }
            });
        }
        if (pseudoTerminal.onDidOverrideDimensions) {
            pseudoTerminal.onDidOverrideDimensions(e => {
                if (e) {
                    if (typeof id === 'string') {
                        this.proxy.$resize(id, e.columns, e.rows);
                    }
                    else {
                        this.proxy.$resizeByTerminalId(id, e.columns, e.rows);
                    }
                }
            });
        }
        if (pseudoTerminal.onDidChangeName) {
            pseudoTerminal.onDidChangeName(name => {
                if (typeof id === 'string') {
                    this.proxy.$setName(id, name);
                }
                else {
                    this.proxy.$setNameByTerminalId(id, name);
                }
            });
        }
    }
    emitOnClose() {
        this.pseudoTerminal.close();
    }
    emitOnInput(data) {
        if (this.pseudoTerminal.handleInput) {
            this.pseudoTerminal.handleInput(data);
        }
    }
    emitOnOpen(cols, rows) {
        this.pseudoTerminal.open({
            rows,
            columns: cols,
        });
    }
    emitOnResize(cols, rows) {
        if (this.pseudoTerminal.setDimensions) {
            this.pseudoTerminal.setDimensions({ columns: cols, rows });
        }
    }
}
exports.PseudoTerminal = PseudoTerminal;
//# sourceMappingURL=terminal-ext.js.map