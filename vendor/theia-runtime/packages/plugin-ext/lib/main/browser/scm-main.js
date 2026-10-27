"use strict";
// *****************************************************************************
// Copyright (C) 2019-2021 Red Hat, Inc. and others.
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
exports.ScmMainImpl = exports.PluginScmProvider = exports.PluginScmHistoryProvider = exports.PluginScmResource = exports.PluginScmResourceGroup = void 0;
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// code copied and modified from https://github.com/microsoft/vscode/blob/1.52.1/src/vs/workbench/api/browser/mainThreadSCM.ts
const plugin_api_rpc_1 = require("../../common/plugin-api-rpc");
const scm_service_1 = require("@theia/scm/lib/browser/scm-service");
const event_1 = require("@theia/core/lib/common/event");
const cancellation_1 = require("@theia/core/lib/common/cancellation");
const disposable_1 = require("@theia/core/lib/common/disposable");
const uri_1 = require("@theia/core/lib/common/uri");
const vscode_uri_1 = require("@theia/core/shared/vscode-uri");
const color_registry_1 = require("@theia/core/lib/browser/color-registry");
const plugin_shared_style_1 = require("./plugin-shared-style");
const themables_1 = require("@theia/monaco-editor-core/esm/vs/base/common/themables");
class PluginScmResourceGroup {
    get hideWhenEmpty() { return !!this.features.hideWhenEmpty; }
    get contextValue() { return this.features.contextValue; }
    constructor(handle, provider, features, label, id) {
        this.handle = handle;
        this.provider = provider;
        this.features = features;
        this.label = label;
        this.id = id;
        this.resources = [];
        this.onDidSpliceEmitter = new event_1.Emitter();
        this.onDidSplice = this.onDidSpliceEmitter.event;
        this.onDidChangeEmitter = new event_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
    }
    splice(start, deleteCount, toInsert) {
        this.resources.splice(start, deleteCount, ...toInsert);
        this.onDidSpliceEmitter.fire({ start, deleteCount, toInsert });
    }
    updateGroup(features) {
        this.features = { ...this.features, ...features };
        this.onDidChangeEmitter.fire();
    }
    updateGroupLabel(label) {
        this.label = label;
        this.onDidChangeEmitter.fire();
    }
    dispose() { }
}
exports.PluginScmResourceGroup = PluginScmResourceGroup;
class PluginScmResource {
    constructor(proxy, sourceControlHandle, groupHandle, handle, sourceUri, group, decorations, contextValue, command) {
        this.proxy = proxy;
        this.sourceControlHandle = sourceControlHandle;
        this.groupHandle = groupHandle;
        this.handle = handle;
        this.sourceUri = sourceUri;
        this.group = group;
        this.decorations = decorations;
        this.contextValue = contextValue;
        this.command = command;
    }
    open() {
        return this.proxy.$executeResourceCommand(this.sourceControlHandle, this.groupHandle, this.handle);
    }
}
exports.PluginScmResource = PluginScmResource;
function historyItemRefFromDto(dto) {
    return {
        id: dto.id,
        name: dto.name,
        description: dto.description,
        revision: dto.revision,
        icon: dto.icon ? (themables_1.ThemeIcon.isThemeIcon(dto.icon) ? themables_1.ThemeIcon.asClassName(dto.icon) :
            'light' in dto.icon ? vscode_uri_1.URI.revive(dto.icon.light).toString() : vscode_uri_1.URI.revive(dto.icon).toString()) : undefined,
        category: dto.category,
    };
}
function historyItemFromDto(dto) {
    return {
        id: dto.id,
        parentIds: dto.parentIds,
        subject: dto.subject ?? '',
        message: typeof dto.message === 'string' ? dto.message : dto.message?.value,
        author: dto.author,
        authorEmail: dto.authorEmail,
        authorIcon: dto.authorIcon ? (themables_1.ThemeIcon.isThemeIcon(dto.authorIcon) ? themables_1.ThemeIcon.asClassName(dto.authorIcon) :
            'light' in dto.authorIcon ? vscode_uri_1.URI.revive(dto.authorIcon.light).toString() : vscode_uri_1.URI.revive(dto.authorIcon).toString()) : undefined,
        displayId: dto.displayId,
        timestamp: dto.timestamp,
        // Passed through as-is so that the provider's own links, commands and `isTrusted`
        // declaration survive; flattening to `value` would strip the command allow-list.
        tooltip: dto.tooltip,
        statistics: dto.statistics ? {
            files: dto.statistics.files,
            insertions: dto.statistics.insertions,
            deletions: dto.statistics.deletions,
        } : undefined,
        references: dto.references ? dto.references.map(historyItemRefFromDto) : undefined,
    };
}
function historyItemChangeFromDto(dto) {
    return {
        uri: vscode_uri_1.URI.revive(dto.uri).toString(),
        originalUri: dto.originalUri ? vscode_uri_1.URI.revive(dto.originalUri).toString() : undefined,
        modifiedUri: dto.modifiedUri ? vscode_uri_1.URI.revive(dto.modifiedUri).toString() : undefined,
        renameUri: dto.renameUri ? vscode_uri_1.URI.revive(dto.renameUri).toString() : undefined,
    };
}
class PluginScmHistoryProvider {
    get currentHistoryItemRef() { return this._currentHistoryItemRef; }
    get currentHistoryItemRemoteRef() { return this._currentHistoryItemRemoteRef; }
    get currentHistoryItemBaseRef() { return this._currentHistoryItemBaseRef; }
    constructor(proxy, handle) {
        this.proxy = proxy;
        this.handle = handle;
        this.onDidChangeCurrentHistoryItemRefsEmitter = new event_1.Emitter();
        this.onDidChangeCurrentHistoryItemRefs = this.onDidChangeCurrentHistoryItemRefsEmitter.event;
        this.onDidChangeHistoryItemRefsEmitter = new event_1.Emitter();
        this.onDidChangeHistoryItemRefs = this.onDidChangeHistoryItemRefsEmitter.event;
        this.disposables = new disposable_1.DisposableCollection();
        this.pendingRequests = new Set();
        this.disposables.push(this.onDidChangeCurrentHistoryItemRefsEmitter);
        this.disposables.push(this.onDidChangeHistoryItemRefsEmitter);
    }
    updateFromFeatures(features) {
        if (features.currentHistoryItemRef !== undefined) {
            this._currentHistoryItemRef = features.currentHistoryItemRef ? historyItemRefFromDto(features.currentHistoryItemRef) : undefined;
        }
        if (features.currentHistoryItemRemoteRef !== undefined) {
            this._currentHistoryItemRemoteRef = features.currentHistoryItemRemoteRef ? historyItemRefFromDto(features.currentHistoryItemRemoteRef) : undefined;
        }
        if (features.currentHistoryItemBaseRef !== undefined) {
            this._currentHistoryItemBaseRef = features.currentHistoryItemBaseRef ? historyItemRefFromDto(features.currentHistoryItemBaseRef) : undefined;
        }
    }
    fireDidChangeCurrentHistoryItemRefs() {
        this.onDidChangeCurrentHistoryItemRefsEmitter.fire();
    }
    fireDidChangeHistoryItemRefs(event) {
        this.onDidChangeHistoryItemRefsEmitter.fire({
            added: event.added.map(historyItemRefFromDto),
            removed: event.removed.map(historyItemRefFromDto),
            modified: event.modified.map(historyItemRefFromDto),
        });
    }
    async provideHistoryItemRefs(historyItemRefs, token) {
        const cts = new cancellation_1.CancellationTokenSource();
        const listener = token.onCancellationRequested(() => cts.cancel());
        this.pendingRequests.add(cts);
        try {
            const result = await this.proxy.$provideHistoryItemRefs(this.handle, historyItemRefs, cts.token);
            if (!result) {
                return undefined;
            }
            return result.map(historyItemRefFromDto);
        }
        finally {
            listener.dispose();
            this.pendingRequests.delete(cts);
            cts.dispose();
        }
    }
    async provideHistoryItems(options, token) {
        const dto = {
            skip: options.skip,
            limit: options.limit,
            historyItemRefs: options.historyItemRefs ? [...options.historyItemRefs] : undefined,
            filterText: options.filterText,
        };
        const cts = new cancellation_1.CancellationTokenSource();
        const listener = token.onCancellationRequested(() => cts.cancel());
        this.pendingRequests.add(cts);
        try {
            const result = await this.proxy.$provideHistoryItems(this.handle, dto, cts.token);
            if (!result) {
                return undefined;
            }
            return result.map(historyItemFromDto);
        }
        finally {
            listener.dispose();
            this.pendingRequests.delete(cts);
            cts.dispose();
        }
    }
    async provideHistoryItemChanges(historyItemId, historyItemParentId, token) {
        const cts = new cancellation_1.CancellationTokenSource();
        const listener = token.onCancellationRequested(() => cts.cancel());
        this.pendingRequests.add(cts);
        try {
            const result = await this.proxy.$provideHistoryItemChanges(this.handle, historyItemId, historyItemParentId, cts.token);
            if (!result) {
                return undefined;
            }
            return result.map(historyItemChangeFromDto);
        }
        finally {
            listener.dispose();
            this.pendingRequests.delete(cts);
            cts.dispose();
        }
    }
    async resolveHistoryItem(historyItemId, token) {
        const cts = new cancellation_1.CancellationTokenSource();
        const listener = token.onCancellationRequested(() => cts.cancel());
        this.pendingRequests.add(cts);
        try {
            const result = await this.proxy.$resolveHistoryItem(this.handle, historyItemId, cts.token);
            if (!result) {
                return undefined;
            }
            return historyItemFromDto(result);
        }
        finally {
            listener.dispose();
            this.pendingRequests.delete(cts);
            cts.dispose();
        }
    }
    async resolveHistoryItemRefsCommonAncestor(historyItemRefs, token) {
        const cts = new cancellation_1.CancellationTokenSource();
        const listener = token.onCancellationRequested(() => cts.cancel());
        this.pendingRequests.add(cts);
        try {
            return await this.proxy.$resolveHistoryItemRefsCommonAncestor(this.handle, historyItemRefs, cts.token) ?? undefined;
        }
        finally {
            listener.dispose();
            this.pendingRequests.delete(cts);
            cts.dispose();
        }
    }
    dispose() {
        for (const cts of this.pendingRequests) {
            cts.cancel();
            cts.dispose();
        }
        this.pendingRequests.clear();
        this.disposables.dispose();
    }
}
exports.PluginScmHistoryProvider = PluginScmHistoryProvider;
class PluginScmProvider {
    get id() { return this._id; }
    get actionButton() { return this._actionButton; }
    get historyProvider() {
        return this._historyProvider;
    }
    get providerContextValue() { return this.features.contextValue; }
    get handle() { return this._handle; }
    get label() { return this._label; }
    get rootUri() { return this._rootUri ? this._rootUri.toString() : ''; }
    get contextValue() { return this._contextValue; }
    get commitTemplate() { return this.features.commitTemplate || ''; }
    get acceptInputCommand() {
        const command = this.features.acceptInputCommand;
        if (command) {
            const scmCommand = command;
            scmCommand.command = command.id;
            return scmCommand;
        }
    }
    get statusBarCommands() {
        const commands = this.features.statusBarCommands;
        return commands?.map(command => {
            const scmCommand = command;
            scmCommand.command = command.id;
            return scmCommand;
        });
    }
    get count() { return this.features.count; }
    get onDidChangeStatusBarCommands() { return this.onDidChangeStatusBarCommandsEmitter.event; }
    constructor(proxy, colors, sharedStyle, _handle, _contextValue, _label, _rootUri, disposables, parentHandle) {
        this.proxy = proxy;
        this.colors = colors;
        this.sharedStyle = sharedStyle;
        this._handle = _handle;
        this._contextValue = _contextValue;
        this._label = _label;
        this._rootUri = _rootUri;
        this.disposables = disposables;
        this.parentHandle = parentHandle;
        this._id = this.contextValue;
        this.groups = [];
        this.groupsByHandle = Object.create(null);
        this.onDidChangeResourcesEmitter = new event_1.Emitter();
        this.onDidChangeResources = this.onDidChangeResourcesEmitter.event;
        this.features = {};
        this.onDidChangeCommitTemplateEmitter = new event_1.Emitter();
        this.onDidChangeCommitTemplate = this.onDidChangeCommitTemplateEmitter.event;
        this.onDidChangeStatusBarCommandsEmitter = new event_1.Emitter();
        this.onDidChangeEmitter = new event_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this.onDidChangeActionButtonEmitter = new event_1.Emitter();
        this.onDidChangeActionButton = this.onDidChangeActionButtonEmitter.event;
    }
    updateSourceControl(features) {
        this.features = { ...this.features, ...features };
        if (typeof features.hasHistoryProvider !== 'undefined') {
            if (features.hasHistoryProvider && !this._historyProvider) {
                this._historyProvider = new PluginScmHistoryProvider(this.proxy, this.handle);
            }
            else if (!features.hasHistoryProvider && this._historyProvider) {
                this._historyProvider.dispose();
                this._historyProvider = undefined;
            }
        }
        this.onDidChangeEmitter.fire();
        if (this._historyProvider) {
            this._historyProvider.updateFromFeatures(features);
        }
        if (typeof features.commitTemplate !== 'undefined') {
            this.onDidChangeCommitTemplateEmitter.fire(this.commitTemplate);
        }
        if (typeof features.statusBarCommands !== 'undefined') {
            this.onDidChangeStatusBarCommandsEmitter.fire(this.statusBarCommands);
        }
    }
    registerGroups(resourceGroups) {
        const groups = resourceGroups.map(resourceGroup => {
            const { handle, id, label, features } = resourceGroup;
            const group = new PluginScmResourceGroup(handle, this, features, label, id);
            this.groupsByHandle[handle] = group;
            return group;
        });
        this.groups.splice(this.groups.length, 0, ...groups);
    }
    updateGroup(handle, features) {
        const group = this.groupsByHandle[handle];
        if (!group) {
            return;
        }
        group.updateGroup(features);
    }
    updateGroupLabel(handle, label) {
        const group = this.groupsByHandle[handle];
        if (!group) {
            return;
        }
        group.updateGroupLabel(label);
    }
    spliceGroupResourceStates(splices) {
        for (const splice of splices) {
            const groupHandle = splice.handle;
            const groupSlices = splice.splices;
            const group = this.groupsByHandle[groupHandle];
            if (!group) {
                console.warn(`SCM group ${groupHandle} not found in provider ${this.label}`);
                continue;
            }
            // reverse the splices sequence in order to apply them correctly
            groupSlices.reverse();
            for (const groupSlice of groupSlices) {
                const { start, deleteCount, rawResources } = groupSlice;
                const resources = rawResources.map(rawResource => {
                    const { handle, sourceUri, icons, tooltip, strikeThrough, faded, contextValue, command } = rawResource;
                    const icon = this.toIconClass(icons[0]);
                    const iconDark = this.toIconClass(icons[1]) || icon;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const colorVariable = rawResource.colorId && this.colors.toCssVariableName(rawResource.colorId);
                    const decorations = {
                        icon,
                        iconDark,
                        tooltip,
                        strikeThrough,
                        // TODO remove the letter and colorId fields when the FileDecorationProvider is applied, see https://github.com/eclipse-theia/theia/pull/8911
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        letter: rawResource.letter || '',
                        color: colorVariable && `var(${colorVariable})`,
                        faded
                    };
                    return new PluginScmResource(this.proxy, this.handle, groupHandle, handle, new uri_1.default(vscode_uri_1.URI.revive(sourceUri)), group, decorations, contextValue || undefined, command);
                });
                group.splice(start, deleteCount, resources);
            }
        }
        this.onDidChangeResourcesEmitter.fire();
    }
    toIconClass(icon) {
        if (!icon) {
            return undefined;
        }
        if (themables_1.ThemeIcon.isThemeIcon(icon)) {
            return themables_1.ThemeIcon.asClassName(icon);
        }
        const reference = this.sharedStyle.toIconClass(icon);
        this.disposables.push(reference);
        return reference.object.iconClass;
    }
    unregisterGroup(handle) {
        const group = this.groupsByHandle[handle];
        if (!group) {
            return;
        }
        delete this.groupsByHandle[handle];
        this.groups.splice(this.groups.indexOf(group), 1);
    }
    updateActionButton(actionButton) {
        this._actionButton = actionButton;
        this.onDidChangeActionButtonEmitter.fire(actionButton);
    }
    dispose() {
        this._historyProvider?.dispose();
        this._historyProvider = undefined;
    }
}
exports.PluginScmProvider = PluginScmProvider;
class ScmMainImpl {
    constructor(rpc, container) {
        this.repositories = new Map();
        this.repositoryDisposables = new Map();
        this.disposables = new disposable_1.DisposableCollection();
        this.proxy = rpc.getProxy(plugin_api_rpc_1.MAIN_RPC_CONTEXT.SCM_EXT);
        this.scmService = container.get(scm_service_1.ScmService);
        this.colors = container.get(color_registry_1.ColorRegistry);
        this.sharedStyle = container.get(plugin_shared_style_1.PluginSharedStyle);
    }
    dispose() {
        this.repositories.forEach(r => r.dispose());
        this.repositories.clear();
        this.repositoryDisposables.forEach(d => d.dispose());
        this.repositoryDisposables.clear();
        this.disposables.dispose();
    }
    async $registerSourceControl(handle, id, label, rootUri, parentHandle) {
        const provider = new PluginScmProvider(this.proxy, this.colors, this.sharedStyle, handle, id, label, rootUri ? vscode_uri_1.URI.revive(rootUri) : undefined, this.disposables, parentHandle);
        const parentRepo = parentHandle !== undefined ? this.repositories.get(parentHandle) : undefined;
        const repository = this.scmService.registerScmProvider(provider, {
            input: {
                validator: async (value) => {
                    const result = await this.proxy.$validateInput(handle, value, value.length);
                    return result && { message: result[0], type: result[1] };
                }
            },
            parentRootUri: parentRepo?.provider.rootUri
        });
        this.repositories.set(handle, repository);
        const disposables = new disposable_1.DisposableCollection(this.scmService.onDidChangeSelectedRepository(r => {
            if (r === repository) {
                this.proxy.$setSelectedSourceControl(handle);
            }
        }), repository.input.onDidChange(() => this.proxy.$onInputBoxValueChange(handle, repository.input.value)));
        if (this.scmService.selectedRepository === repository) {
            setTimeout(() => this.proxy.$setSelectedSourceControl(handle), 0);
        }
        if (repository.input.value) {
            setTimeout(() => this.proxy.$onInputBoxValueChange(handle, repository.input.value), 0);
        }
        this.repositoryDisposables.set(handle, disposables);
    }
    async $updateSourceControl(handle, features) {
        const repository = this.repositories.get(handle);
        if (!repository) {
            return;
        }
        const provider = repository.provider;
        provider.updateSourceControl(features);
    }
    async $unregisterSourceControl(handle) {
        const repository = this.repositories.get(handle);
        if (!repository) {
            return;
        }
        // Defensively cascade-dispose any children (e.g. worktrees) whose parent
        // is being unregistered. The plugin API exposes onDidDisposeParent, but if
        // a plugin fails to propagate it (or races with an external change like a
        // worktree being removed on disk), children would otherwise be orphaned
        // in the Repositories view. Children are torn down inline (not recursively)
        // to keep the iteration over `this.repositories` safe and to tolerate a
        // plugin-side RPC for the child arriving first.
        const childHandles = [];
        for (const [childHandle, childRepo] of this.repositories) {
            if (childHandle !== handle && childRepo.provider.parentHandle === handle) {
                childHandles.push(childHandle);
            }
        }
        for (const childHandle of childHandles) {
            const childRepository = this.repositories.get(childHandle);
            if (!childRepository) {
                continue;
            }
            this.repositoryDisposables.get(childHandle)?.dispose();
            this.repositoryDisposables.delete(childHandle);
            childRepository.dispose();
            this.repositories.delete(childHandle);
        }
        this.repositoryDisposables.get(handle)?.dispose();
        this.repositoryDisposables.delete(handle);
        repository.dispose();
        this.repositories.delete(handle);
    }
    $registerGroups(sourceControlHandle, groups, splices) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        const provider = repository.provider;
        provider.registerGroups(groups);
        provider.spliceGroupResourceStates(splices);
    }
    $updateGroup(sourceControlHandle, groupHandle, features) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        const provider = repository.provider;
        provider.updateGroup(groupHandle, features);
    }
    $updateGroupLabel(sourceControlHandle, groupHandle, label) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        const provider = repository.provider;
        provider.updateGroupLabel(groupHandle, label);
    }
    $spliceResourceStates(sourceControlHandle, splices) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        const provider = repository.provider;
        provider.spliceGroupResourceStates(splices);
    }
    $unregisterGroup(sourceControlHandle, handle) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        const provider = repository.provider;
        provider.unregisterGroup(handle);
    }
    $setInputBoxValue(sourceControlHandle, value) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        repository.input.value = value;
    }
    $setInputBoxPlaceholder(sourceControlHandle, placeholder) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        repository.input.placeholder = placeholder;
    }
    $setInputBoxVisible(sourceControlHandle, visible) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        repository.input.visible = visible;
    }
    $setInputBoxEnabled(sourceControlHandle, enabled) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        repository.input.enabled = enabled;
    }
    $setActionButton(sourceControlHandle, actionButton) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        const provider = repository.provider;
        // Convert from RPC Command (with .id) to ScmCommand (with .command)
        const converted = actionButton ? {
            command: {
                title: actionButton.command.title,
                tooltip: actionButton.command.tooltip,
                command: actionButton.command.id,
                arguments: actionButton.command.arguments
            },
            secondaryCommands: actionButton.secondaryCommands?.map(row => row.map(cmd => ({
                title: cmd.title,
                tooltip: cmd.tooltip,
                command: cmd.id,
                arguments: cmd.arguments
            }))),
            enabled: actionButton.enabled,
            description: actionButton.description
        } : undefined;
        provider.updateActionButton(converted);
    }
    $onDidChangeCurrentHistoryItemRefs(sourceControlHandle) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        const provider = repository.provider;
        const historyProvider = provider.historyProvider;
        historyProvider?.fireDidChangeCurrentHistoryItemRefs();
    }
    $onDidChangeHistoryItemRefs(sourceControlHandle, event) {
        const repository = this.repositories.get(sourceControlHandle);
        if (!repository) {
            return;
        }
        const provider = repository.provider;
        const historyProvider = provider.historyProvider;
        historyProvider?.fireDidChangeHistoryItemRefs(event);
    }
}
exports.ScmMainImpl = ScmMainImpl;
//# sourceMappingURL=scm-main.js.map