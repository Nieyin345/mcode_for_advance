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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginVscodeCommandsContribution = exports.VscodeCommands = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const application_shell_mouse_tracker_1 = require("@theia/core/lib/browser/shell/application-shell-mouse-tracker");
const command_1 = require("@theia/core/lib/common/command");
const uri_1 = require("@theia/core/lib/common/uri");
const browser_2 = require("@theia/editor/lib/browser");
const documents_main_1 = require("@theia/plugin-ext/lib/main/browser/documents-main");
const type_converters_1 = require("@theia/plugin-ext/lib/plugin/type-converters");
const browser_3 = require("@theia/workspace/lib/browser");
const workspace_service_1 = require("@theia/workspace/lib/browser/workspace-service");
const diff_service_1 = require("@theia/workspace/lib/browser/diff-service");
const inversify_1 = require("@theia/core/shared/inversify");
const vscode_uri_1 = require("@theia/core/shared/vscode-uri");
const plugin_protocol_1 = require("@theia/plugin-ext/lib/common/plugin-protocol");
const terminal_frontend_contribution_1 = require("@theia/terminal/lib/browser/terminal-frontend-contribution");
const quick_open_workspace_1 = require("@theia/workspace/lib/browser/quick-open-workspace");
const terminal_service_1 = require("@theia/terminal/lib/browser/base/terminal-service");
const navigator_contribution_1 = require("@theia/navigator/lib/browser/navigator-contribution");
const browser_4 = require("@theia/navigator/lib/browser");
const tree_selection_1 = require("@theia/core/lib/browser/tree/tree-selection");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const browser_5 = require("@theia/callhierarchy/lib/browser");
const browser_6 = require("@theia/typehierarchy/lib/browser");
const monaco_text_model_service_1 = require("@theia/monaco/lib/browser/monaco-text-model-service");
const hierarchy_types_converters_1 = require("@theia/plugin-ext/lib/main/browser/hierarchy/hierarchy-types-converters");
const custom_editor_opener_1 = require("@theia/plugin-ext/lib/main/browser/custom-editors/custom-editor-opener");
const nls_1 = require("@theia/core/lib/common/nls");
const window_service_1 = require("@theia/core/lib/browser/window/window-service");
const monaco = require("@theia/monaco-editor-core");
const plugin_vscode_uri_1 = require("../common/plugin-vscode-uri");
const vscode_theia_menu_mappings_1 = require("@theia/plugin-ext/lib/main/browser/menus/vscode-theia-menu-mappings");
const outline_view_contribution_1 = require("@theia/outline-view/lib/browser/outline-view-contribution");
const monaco_languages_1 = require("@theia/monaco/lib/browser/monaco-languages");
const scm_contribution_1 = require("@theia/scm/lib/browser/scm-contribution");
const merge_editor_1 = require("@theia/scm/lib/browser/merge-editor/merge-editor");
var VscodeCommands;
(function (VscodeCommands) {
    VscodeCommands.GET_CODE_EXCHANGE_ENDPOINTS = {
        id: 'workbench.getCodeExchangeProxyEndpoints' // this command is used in the github auth built-in
        // see: https://github.com/microsoft/vscode/blob/191be39e5ac872e03f9d79cc859d9917f40ad935/extensions/github-authentication/src/githubServer.ts#L60
    };
    VscodeCommands.OPEN = {
        id: 'vscode.open'
    };
    VscodeCommands.OPEN_WITH = {
        id: 'vscode.openWith'
    };
    VscodeCommands.OPEN_FOLDER = {
        id: 'vscode.openFolder'
    };
    VscodeCommands.DIFF = {
        id: 'vscode.diff'
    };
    VscodeCommands.INSTALL_EXTENSION_FROM_ID_OR_URI = {
        id: 'workbench.extensions.installExtension'
    };
    VscodeCommands.UNINSTALL_EXTENSION = {
        id: 'workbench.extensions.uninstallExtension'
    };
    // see https://github.com/microsoft/vscode/blob/2fc07b811f760549dab9be9d2bedd06c51dfcb9a/src/vs/workbench/contrib/extensions/common/extensions.ts#L246
    VscodeCommands.INSTALL_EXTENSION_FROM_VSIX_COMMAND = {
        id: 'workbench.extensions.command.installFromVSIX'
    };
})(VscodeCommands || (exports.VscodeCommands = VscodeCommands = {}));
function isInDirection(source, candidate, direction) {
    const sourceCenter = rectCenter(source);
    const candidateCenter = rectCenter(candidate);
    switch (direction) {
        case 'left':
            return candidateCenter.x < sourceCenter.x;
        case 'right':
            return candidateCenter.x > sourceCenter.x;
        case 'up':
            return candidateCenter.y < sourceCenter.y;
        case 'down':
            return candidateCenter.y > sourceCenter.y;
    }
}
function score(source, candidate, direction) {
    const horizontal = direction === 'left' || direction === 'right';
    const sourceCenter = rectCenter(source);
    const candidateCenter = rectCenter(candidate);
    const orthogonalOverlap = horizontal
        ? intervalOverlap(source.top, source.bottom, candidate.top, candidate.bottom)
        : intervalOverlap(source.left, source.right, candidate.left, candidate.right);
    return [
        orthogonalOverlap > 0 ? 0 : 1,
        Math.max(0, -orthogonalOverlap),
        directionalDistance(source, candidate, direction),
        horizontal ? Math.abs(sourceCenter.y - candidateCenter.y) : Math.abs(sourceCenter.x - candidateCenter.x),
        horizontal ? candidate.top : candidate.left
    ];
}
function compareScore(left, right) {
    return left[0] - right[0]
        || left[1] - right[1]
        || left[2] - right[2]
        || left[3] - right[3]
        || left[4] - right[4];
}
function directionalDistance(source, candidate, direction) {
    switch (direction) {
        case 'left':
            return Math.max(0, source.left - candidate.right);
        case 'right':
            return Math.max(0, candidate.left - source.right);
        case 'up':
            return Math.max(0, source.top - candidate.bottom);
        case 'down':
            return Math.max(0, candidate.top - source.bottom);
    }
}
function rectCenter(rect) {
    return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
    };
}
function intervalOverlap(start, end, candidateStart, candidateEnd) {
    return Math.min(end, candidateEnd) - Math.max(start, candidateStart);
}
let PluginVscodeCommandsContribution = class PluginVscodeCommandsContribution {
    async openWith(commandId, resource, columnOrOptions, openerId) {
        if (!resource) {
            throw new Error(`${commandId} command requires at least URI argument.`);
        }
        if (!vscode_uri_1.URI.isUri(resource)) {
            throw new Error(`Invalid argument for ${commandId} command with URI argument. Found ${resource}`);
        }
        let options;
        if (typeof columnOrOptions === 'number') {
            options = {
                viewColumn: columnOrOptions
            };
        }
        else if (columnOrOptions) {
            options = {
                ...columnOrOptions
            };
        }
        const uri = new uri_1.default(resource);
        const editorOptions = documents_main_1.DocumentsMainImpl.toEditorOpenerOptions(this.shell, options);
        let openHandler;
        if (typeof openerId === 'string') {
            const lowerViewType = openerId.toLowerCase();
            const openers = await this.openerService.getOpeners();
            for (const opener of openers) {
                const idLowerCase = opener.id.toLowerCase();
                if (lowerViewType === idLowerCase) {
                    openHandler = opener;
                    break;
                }
            }
        }
        else {
            openHandler = await this.openerService.getOpener(uri, editorOptions);
        }
        if (openHandler) {
            await openHandler.open(uri, editorOptions);
            return true;
        }
        return false;
    }
    navigateEditorGroup(direction) {
        const current = this.currentMainAreaTabBar();
        const currentRect = current && this.getEditorGroupRect(current);
        if (!current || current.titles.length === 0 || !currentRect) {
            return false;
        }
        const candidates = [];
        const candidateRects = [];
        for (const tabBar of this.shell.mainAreaTabBars) {
            if (tabBar === current || tabBar.titles.length === 0) {
                continue;
            }
            const candidateRect = this.getEditorGroupRect(tabBar);
            if (candidateRect) {
                candidates.push(tabBar);
                candidateRects.push(candidateRect);
            }
        }
        const index = this.findClosestEditorGroup(currentRect, candidateRects, direction);
        return index === -1 ? false : this.activateEditorGroup(candidates[index]);
    }
    findClosestEditorGroup(source, candidates, direction) {
        let bestIndex = -1;
        let bestScore;
        for (let index = 0; index < candidates.length; index++) {
            const candidate = candidates[index];
            if (!isInDirection(source, candidate, direction)) {
                continue;
            }
            const candidateScore = score(source, candidate, direction);
            if (!bestScore || compareScore(candidateScore, bestScore) < 0) {
                bestIndex = index;
                bestScore = candidateScore;
            }
        }
        return bestIndex;
    }
    navigateEditorGroups() {
        const current = this.currentMainAreaTabBar();
        const tabBars = this.shell.mainAreaTabBars.filter(tabBar => tabBar.titles.length > 0);
        if (!current || tabBars.length < 2) {
            return false;
        }
        const currentIndex = tabBars.indexOf(current);
        if (currentIndex === -1) {
            return false;
        }
        const target = tabBars[(currentIndex + 1) % tabBars.length];
        return this.activateEditorGroup(target);
    }
    currentMainAreaTabBar() {
        const mainAreaTabBars = this.shell.mainAreaTabBars;
        const currentTabBar = this.shell.currentTabBar;
        if (currentTabBar && mainAreaTabBars.includes(currentTabBar)) {
            return currentTabBar;
        }
        const currentEditor = this.editorManager.currentEditor || this.editorManager.activeEditor;
        if (currentEditor) {
            const tabBar = this.shell.getTabBarFor(currentEditor);
            if (tabBar && mainAreaTabBars.includes(tabBar)) {
                return tabBar;
            }
        }
        return undefined;
    }
    getEditorGroupRect(tabBar) {
        const title = tabBar.currentTitle || tabBar.titles[0];
        const rects = [
            tabBar.node.getBoundingClientRect(),
            title?.owner.node.getBoundingClientRect()
        ].filter((rect) => !!rect && rect.width > 0 && rect.height > 0);
        if (rects.length === 0) {
            return undefined;
        }
        const left = Math.min(...rects.map(rect => rect.left));
        const right = Math.max(...rects.map(rect => rect.right));
        const top = Math.min(...rects.map(rect => rect.top));
        const bottom = Math.max(...rects.map(rect => rect.bottom));
        return { left, right, top, bottom, width: right - left, height: bottom - top };
    }
    activateEditorGroup(tabBar) {
        let title = tabBar.currentTitle;
        if (!title && tabBar.titles.length > 0) {
            tabBar.currentIndex = 0;
            title = tabBar.currentTitle;
        }
        if (!title) {
            return false;
        }
        this.shell.activateWidget(title.owner.id);
        return true;
    }
    registerCommands(commands) {
        commands.registerCommand(VscodeCommands.GET_CODE_EXCHANGE_ENDPOINTS, {
            execute: () => undefined // this is a dummy implementation: only used in the case of web apps, which is not supported yet.
        });
        commands.registerCommand(VscodeCommands.OPEN, {
            isVisible: () => false,
            execute: async (resource, columnOrOptions) => {
                if (typeof resource === 'string') {
                    resource = vscode_uri_1.URI.parse(resource);
                }
                try {
                    await this.openWith(VscodeCommands.OPEN.id, resource, columnOrOptions);
                }
                catch (error) {
                    const message = nls_1.nls.localizeByDefault("Unable to open '{0}'", resource.path);
                    const reason = nls_1.nls.localizeByDefault('Error: {0}', error.message);
                    this.messageService.error(`${message}\n${reason}`);
                    this.logger.warn(error);
                }
            }
        });
        commands.registerCommand(VscodeCommands.OPEN_WITH, {
            isVisible: () => false,
            execute: async (resource, viewType, columnOrOptions) => {
                if (!viewType) {
                    throw new Error(`Running the contributed command: ${VscodeCommands.OPEN_WITH} failed.`);
                }
                if (viewType.toLowerCase() === 'default') {
                    return commands.executeCommand(VscodeCommands.OPEN.id, resource, columnOrOptions);
                }
                let result = await this.openWith(VscodeCommands.OPEN_WITH.id, resource, columnOrOptions, viewType);
                if (!result) {
                    result = await this.openWith(VscodeCommands.OPEN_WITH.id, resource, columnOrOptions, custom_editor_opener_1.CustomEditorOpener.toCustomEditorId(viewType));
                }
                if (!result) {
                    throw new Error(`Could not find an editor for '${viewType}'`);
                }
            }
        });
        commands.registerCommand(VscodeCommands.OPEN_FOLDER, {
            isVisible: () => false,
            execute: async (resource, arg = {}) => {
                if (!resource) {
                    return commands.executeCommand(browser_3.WorkspaceCommands.OPEN_WORKSPACE.id);
                }
                if (!vscode_uri_1.URI.isUri(resource)) {
                    throw new Error(`Invalid argument for ${VscodeCommands.OPEN_FOLDER.id} command with URI argument. Found ${resource}`);
                }
                let options;
                if (typeof arg === 'boolean') {
                    options = { preserveWindow: !arg };
                }
                else {
                    options = { preserveWindow: !arg.forceNewWindow };
                }
                this.workspaceService.open(new uri_1.default(resource), options);
            }
        });
        commands.registerCommand(VscodeCommands.DIFF, {
            isVisible: () => false,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            execute: async (left, right, label, options) => {
                if (!left || !right) {
                    throw new Error(`${VscodeCommands.DIFF} command requires at least two URI arguments. Found left=${left}, right=${right} as arguments`);
                }
                if (!vscode_uri_1.URI.isUri(left)) {
                    throw new Error(`Invalid argument for ${VscodeCommands.DIFF.id} command with left argument. Expecting URI left type but found ${left}`);
                }
                if (!vscode_uri_1.URI.isUri(right)) {
                    throw new Error(`Invalid argument for ${VscodeCommands.DIFF.id} command with right argument. Expecting URI right type but found ${right}`);
                }
                const leftURI = new uri_1.default(left);
                const editorOptions = documents_main_1.DocumentsMainImpl.toEditorOpenerOptions(this.shell, options);
                await this.diffService.openDiffEditor(leftURI, new uri_1.default(right), label, editorOptions);
            }
        });
        // https://code.visualstudio.com/docs/getstarted/keybindings#_navigation
        /*
         * internally, in VS Code, any widget opened in the main area is represented as an editor
         * operations below apply to them, but not to side-bar widgets, like the explorer
         *
         * in Theia, there are not such difference and any widget can be put in any area
         * because of it we filter out editors from views based on `NavigatableWidget.is`
         * and apply actions only to them
         */
        if (!core_1.environment.electron.is() || core_1.isOSX) {
            commands.registerCommand({ id: 'workbench.action.files.openFileFolder' }, {
                execute: () => commands.executeCommand(browser_3.WorkspaceCommands.OPEN.id)
            });
            commands.registerAlias('workbench.action.files.openFileFolder', browser_3.WorkspaceCommands.OPEN.id);
        }
        commands.registerCommand({ id: 'workbench.action.files.openFile' }, {
            execute: () => commands.executeCommand(browser_3.WorkspaceCommands.OPEN_FILE.id)
        });
        commands.registerAlias('workbench.action.files.openFile', browser_3.WorkspaceCommands.OPEN_FILE.id);
        commands.registerCommand({ id: 'workbench.action.files.openFolder' }, {
            execute: () => commands.executeCommand(browser_3.WorkspaceCommands.OPEN_FOLDER.id)
        });
        commands.registerAlias('workbench.action.files.openFolder', browser_3.WorkspaceCommands.OPEN_FOLDER.id);
        commands.registerCommand({ id: 'workbench.action.addRootFolder' }, {
            execute: () => commands.executeCommand(browser_3.WorkspaceCommands.ADD_FOLDER.id)
        });
        commands.registerAlias('workbench.action.addRootFolder', browser_3.WorkspaceCommands.ADD_FOLDER.id);
        commands.registerCommand({ id: 'workbench.action.saveWorkspaceAs' }, {
            execute: () => commands.executeCommand(browser_3.WorkspaceCommands.SAVE_WORKSPACE_AS.id)
        });
        commands.registerAlias('workbench.action.saveWorkspaceAs', browser_3.WorkspaceCommands.SAVE_WORKSPACE_AS.id);
        commands.registerCommand({ id: 'workbench.action.gotoLine' }, {
            execute: () => commands.executeCommand(browser_2.EditorCommands.GOTO_LINE_COLUMN.id)
        });
        commands.registerAlias('workbench.action.gotoLine', browser_2.EditorCommands.GOTO_LINE_COLUMN.id);
        commands.registerCommand({ id: 'workbench.action.quickOpen' }, {
            execute: (prefix) => this.quickInput.open(typeof prefix === 'string' ? prefix : '')
        });
        commands.registerCommand({ id: 'workbench.action.openSettings' }, {
            execute: (query) => commands.executeCommand(browser_1.CommonCommands.OPEN_PREFERENCES.id, query)
        });
        commands.registerAlias('workbench.action.openSettings', browser_1.CommonCommands.OPEN_PREFERENCES.id);
        commands.registerCommand({ id: 'workbench.action.openWorkspaceConfigFile' }, {
            execute: () => commands.executeCommand(browser_3.WorkspaceCommands.OPEN_WORKSPACE_FILE.id)
        });
        commands.registerAlias('workbench.action.openWorkspaceConfigFile', browser_3.WorkspaceCommands.OPEN_WORKSPACE_FILE.id);
        commands.registerCommand({ id: 'workbench.files.action.refreshFilesExplorer' }, {
            execute: () => commands.executeCommand(navigator_contribution_1.FileNavigatorCommands.REFRESH_NAVIGATOR.id)
        });
        commands.registerAlias('workbench.files.action.refreshFilesExplorer', navigator_contribution_1.FileNavigatorCommands.REFRESH_NAVIGATOR.id);
        commands.registerCommand(VscodeCommands.INSTALL_EXTENSION_FROM_ID_OR_URI, {
            execute: async (vsixUriOrExtensionId) => {
                if (typeof vsixUriOrExtensionId === 'string') {
                    let extensionId = vsixUriOrExtensionId;
                    let opts;
                    const versionedId = plugin_protocol_1.PluginIdentifiers.idAndVersionFromVersionedId(vsixUriOrExtensionId);
                    if (versionedId) {
                        extensionId = versionedId.id;
                        opts = { version: versionedId.version, ignoreOtherVersions: true };
                    }
                    await this.pluginServer.install(plugin_vscode_uri_1.VSCodeExtensionUri.fromId(extensionId).toString(), undefined, opts);
                }
                else {
                    await this.deployPlugin(vsixUriOrExtensionId);
                }
            }
        });
        commands.registerCommand(VscodeCommands.INSTALL_EXTENSION_FROM_VSIX_COMMAND, {
            execute: async (uris) => {
                if ((0, core_1.isArray)(uris)) {
                    await Promise.all(uris.map(async (vsix) => {
                        await this.deployPlugin(vsix);
                    }));
                }
                else {
                    await this.deployPlugin(uris);
                }
            }
        });
        commands.registerCommand(VscodeCommands.UNINSTALL_EXTENSION, {
            execute: async (id) => {
                if (!id) {
                    throw new Error(nls_1.nls.localizeByDefault('Extension id required.'));
                }
                const idAndVersion = plugin_protocol_1.PluginIdentifiers.idAndVersionFromVersionedId(id);
                if (!idAndVersion) {
                    throw new Error(`Invalid extension id: ${id}\nExpected format: <publisher>.<name>@<version>.`);
                }
                await this.pluginServer.uninstall(plugin_protocol_1.PluginIdentifiers.idAndVersionToVersionedId(idAndVersion));
            }
        });
        commands.registerCommand({ id: 'workbench.action.files.save', }, {
            execute: (uri) => {
                if (uri) {
                    const uriString = uri.toString();
                    const widget = this.shell.widgets.find(w => {
                        const resourceUri = browser_1.Saveable.is(w) && browser_1.NavigatableWidget.is(w) && w.getResourceUri();
                        return (resourceUri && resourceUri.toString()) === uriString;
                    });
                    if (browser_1.Saveable.is(widget)) {
                        browser_1.Saveable.save(widget);
                    }
                }
                else {
                    this.shell.save();
                }
            }
        });
        commands.registerCommand({ id: 'workbench.action.files.saveAll', }, {
            execute: () => this.shell.saveAll()
        });
        commands.registerCommand({ id: 'workbench.action.closeActiveEditor' }, {
            execute: () => commands.executeCommand(browser_1.CommonCommands.CLOSE_MAIN_TAB.id)
        });
        commands.registerAlias('workbench.action.closeActiveEditor', browser_1.CommonCommands.CLOSE_MAIN_TAB.id);
        commands.registerCommand({ id: 'workbench.action.closeOtherEditors' }, {
            execute: async (uri) => {
                let editor = this.editorManager.currentEditor || this.shell.currentWidget;
                if (uri) {
                    const uriString = uri.toString();
                    editor = this.editorManager.all.find(e => {
                        const resourceUri = e.getResourceUri();
                        return (resourceUri && resourceUri.toString()) === uriString;
                    });
                }
                const toClose = this.shell.widgets.filter(widget => widget !== editor && vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.is(widget));
                await this.shell.closeMany(toClose);
            }
        });
        const performActionOnGroup = (cb, uri) => {
            let editor = this.editorManager.currentEditor || this.shell.currentWidget;
            if (uri) {
                const uriString = uri.toString();
                editor = this.editorManager.all.find(e => {
                    const resourceUri = e.getResourceUri();
                    return (resourceUri && resourceUri.toString()) === uriString;
                });
            }
            if (editor) {
                const tabBar = this.shell.getTabBarFor(editor);
                if (tabBar) {
                    cb(tabBar, ({ owner }) => vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.is(owner));
                }
            }
        };
        commands.registerCommand({
            id: 'workbench.action.closeEditorsInGroup',
            label: nls_1.nls.localizeByDefault('Close All Editors in Group')
        }, {
            execute: (uri) => performActionOnGroup(this.shell.closeTabs, uri)
        });
        commands.registerCommand({
            id: 'workbench.files.saveAllInGroup',
            label: nls_1.nls.localizeByDefault('Save All in Group')
        }, {
            execute: (uri) => performActionOnGroup(this.shell.saveTabs, uri)
        });
        commands.registerCommand({ id: 'workbench.action.closeEditorsInOtherGroups' }, {
            execute: () => {
                const editor = this.editorManager.currentEditor || this.shell.currentWidget;
                if (editor) {
                    const editorTabBar = this.shell.getTabBarFor(editor);
                    for (const tabBar of this.shell.allTabBars) {
                        if (tabBar !== editorTabBar) {
                            this.shell.closeTabs(tabBar, ({ owner }) => vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.is(owner));
                        }
                    }
                }
            }
        });
        commands.registerCommand({ id: 'workbench.action.closeEditorsToTheLeft' }, {
            execute: () => {
                const editor = this.editorManager.currentEditor || this.shell.currentWidget;
                if (editor) {
                    const tabBar = this.shell.getTabBarFor(editor);
                    if (tabBar) {
                        let left = true;
                        this.shell.closeTabs(tabBar, ({ owner }) => {
                            if (owner === editor) {
                                left = false;
                                return false;
                            }
                            return left && vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.is(owner);
                        });
                    }
                }
            }
        });
        commands.registerCommand({ id: 'workbench.action.closeEditorsToTheRight' }, {
            execute: () => {
                const editor = this.editorManager.currentEditor || this.shell.currentWidget;
                if (editor) {
                    const tabBar = this.shell.getTabBarFor(editor);
                    if (tabBar) {
                        let left = true;
                        this.shell.closeTabs(tabBar, ({ owner }) => {
                            if (owner === editor) {
                                left = false;
                                return false;
                            }
                            return !left && vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.is(owner);
                        });
                    }
                }
            }
        });
        commands.registerCommand({ id: 'workbench.action.closeAllEditors' }, {
            execute: async () => {
                const toClose = this.shell.widgets.filter(widget => vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.is(widget));
                await this.shell.closeMany(toClose);
            }
        });
        commands.registerCommand({ id: 'workbench.action.nextEditor' }, {
            execute: () => this.shell.activateNextTab()
        });
        commands.registerCommand({ id: 'workbench.action.previousEditor' }, {
            execute: () => this.shell.activatePreviousTab()
        });
        commands.registerCommand({
            id: 'workbench.action.navigateLeft',
            label: nls_1.nls.localizeByDefault('Navigate to the View on the Left'),
            category: nls_1.nls.localizeByDefault('View')
        }, {
            execute: () => this.navigateEditorGroup('left')
        });
        commands.registerCommand({
            id: 'workbench.action.navigateRight',
            label: nls_1.nls.localizeByDefault('Navigate to the View on the Right'),
            category: nls_1.nls.localizeByDefault('View')
        }, {
            execute: () => this.navigateEditorGroup('right')
        });
        commands.registerCommand({
            id: 'workbench.action.navigateUp',
            label: nls_1.nls.localizeByDefault('Navigate to the View Above'),
            category: nls_1.nls.localizeByDefault('View')
        }, {
            execute: () => this.navigateEditorGroup('up')
        });
        commands.registerCommand({
            id: 'workbench.action.navigateDown',
            label: nls_1.nls.localizeByDefault('Navigate to the View Below'),
            category: nls_1.nls.localizeByDefault('View')
        }, {
            execute: () => this.navigateEditorGroup('down')
        });
        commands.registerCommand({
            id: 'workbench.action.navigateEditorGroups',
            label: nls_1.nls.localizeByDefault('Navigate Between Editor Groups'),
            category: nls_1.nls.localizeByDefault('View')
        }, {
            execute: () => this.navigateEditorGroups()
        });
        commands.registerCommand({ id: 'workbench.action.navigateBack' }, {
            execute: () => commands.executeCommand(browser_2.EditorCommands.GO_BACK.id)
        });
        commands.registerAlias('workbench.action.navigateBack', browser_2.EditorCommands.GO_BACK.id);
        commands.registerCommand({ id: 'workbench.action.navigateForward' }, {
            execute: () => commands.executeCommand(browser_2.EditorCommands.GO_FORWARD.id)
        });
        commands.registerAlias('workbench.action.navigateForward', browser_2.EditorCommands.GO_FORWARD.id);
        commands.registerCommand({ id: 'workbench.action.navigateToLastEditLocation' }, {
            execute: () => commands.executeCommand(browser_2.EditorCommands.GO_LAST_EDIT.id)
        });
        commands.registerAlias('workbench.action.navigateToLastEditLocation', browser_2.EditorCommands.GO_LAST_EDIT.id);
        commands.registerCommand({ id: 'openInTerminal' }, {
            execute: (resource) => this.terminalContribution.openInTerminal(new uri_1.default(resource.toString()))
        });
        commands.registerCommand({ id: 'workbench.action.reloadWindow' }, {
            execute: () => {
                this.windowService.reload();
            }
        });
        /**
         * TODO:
         * Open Next: workbench.action.openNextRecentlyUsedEditorInGroup
         * Open Previous: workbench.action.openPreviousRecentlyUsedEditorInGroup
         * Copy Path of Active File: workbench.action.files.copyPathOfActiveFile
         * Reveal Active File in Windows: workbench.action.files.revealActiveFileInWindows
         * Show Opened File in New Window: workbench.action.files.showOpenedFileInNewWindow
         * Compare Opened File With: workbench.files.action.compareFileWith
         */
        // Register built-in language service commands
        // see https://code.visualstudio.com/api/references/commands
        /* eslint-disable @typescript-eslint/no-explicit-any */
        // TODO register other `vscode.execute...` commands.
        // see https://github.com/microsoft/vscode/blob/master/src/vs/workbench/api/common/extHostApiCommands.ts
        commands.registerCommand({
            id: 'vscode.executeDefinitionProvider'
        }, {
            execute: ((resource, position) => commands.executeCommand('_executeDefinitionProvider', monaco.Uri.from(resource), position))
        });
        commands.registerCommand({
            id: 'vscode.executeDeclarationProvider'
        }, {
            execute: ((resource, position) => commands.executeCommand('_executeDeclarationProvider', monaco.Uri.from(resource), position))
        });
        commands.registerCommand({
            id: 'vscode.executeTypeDefinitionProvider'
        }, {
            execute: ((resource, position) => commands.executeCommand('_executeTypeDefinitionProvider', monaco.Uri.from(resource), position))
        });
        commands.registerCommand({
            id: 'vscode.executeImplementationProvider'
        }, {
            execute: ((resource, position) => commands.executeCommand('_executeImplementationProvider', monaco.Uri.from(resource), position))
        });
        commands.registerCommand({
            id: 'vscode.executeHoverProvider'
        }, {
            execute: ((resource, position) => commands.executeCommand('_executeHoverProvider', monaco.Uri.from(resource), position))
        });
        commands.registerCommand({
            id: 'vscode.executeDocumentHighlights'
        }, {
            execute: ((resource, position) => commands.executeCommand('_executeDocumentHighlights', monaco.Uri.from(resource), position))
        });
        commands.registerCommand({
            id: 'vscode.executeReferenceProvider'
        }, {
            execute: ((resource, position) => commands.executeCommand('_executeReferenceProvider', monaco.Uri.from(resource), position))
        });
        commands.registerCommand({
            id: 'vscode.executeDocumentSymbolProvider'
        }, {
            execute: (resource) => commands.executeCommand('_executeDocumentSymbolProvider', monaco.Uri.parse(resource.toString())).then((value) => {
                if (!Array.isArray(value) || value === undefined) {
                    return undefined;
                }
                return value.map(loc => (0, type_converters_1.toMergedSymbol)(resource, loc));
            })
        });
        commands.registerCommand({
            id: 'vscode.executeFormatDocumentProvider'
        }, {
            execute: ((resource, options) => commands.executeCommand('_executeFormatDocumentProvider', monaco.Uri.from(resource), options))
        });
        commands.registerCommand({
            id: 'vscode.executeFormatRangeProvider'
        }, {
            execute: ((resource, range, options) => commands.executeCommand('_executeFormatRangeProvider', monaco.Uri.from(resource), range, options))
        });
        commands.registerCommand({
            id: 'vscode.executeFormatOnTypeProvider'
        }, {
            execute: ((resource, position, ch, options) => commands.executeCommand('_executeFormatOnTypeProvider', monaco.Uri.from(resource), position, ch, options))
        });
        commands.registerCommand({
            id: 'vscode.executeFoldingRangeProvider'
        }, {
            execute: ((resource, position) => commands.executeCommand('_executeFoldingRangeProvider', monaco.Uri.from(resource), position))
        });
        commands.registerCommand({
            id: 'vscode.executeCodeActionProvider'
        }, {
            execute: ((resource, range, kind, itemResolveCount) => commands.executeCommand('_executeCodeActionProvider', monaco.Uri.from(resource), range, kind, itemResolveCount))
        });
        commands.registerCommand({
            id: 'vscode.executeCompletionItemProvider'
        }, {
            execute: ((resource, position, triggerCharacter, itemResolveCount) => commands.executeCommand('_executeCompletionItemProvider', monaco.Uri.from(resource), { lineNumber: position.line, column: position.character }, triggerCharacter, itemResolveCount))
        });
        commands.registerCommand({
            id: 'vscode.executeWorkspaceSymbolProvider'
        }, {
            execute: async (queryString) => (await Promise.all(this.monacoLanguages.workspaceSymbolProviders
                .map(async (provider) => provider.provideWorkspaceSymbols({ query: queryString }, new core_1.CancellationTokenSource().token))))
                .flatMap(symbols => symbols)
                .filter(symbols => !!symbols)
        });
        commands.registerCommand({
            id: 'vscode.prepareCallHierarchy'
        }, {
            execute: async (resource, position) => {
                const provider = await this.getCallHierarchyServiceForUri(resource);
                const definition = await provider?.getRootDefinition(resource.path, (0, type_converters_1.toPosition)(position), new core_1.CancellationTokenSource().token);
                if (definition) {
                    return definition.items.map(item => (0, hierarchy_types_converters_1.fromItemHierarchyDefinition)(item));
                }
                ;
                return [];
            }
        });
        commands.registerCommand({
            id: 'vscode.provideIncomingCalls'
        }, {
            execute: async (item) => {
                const resource = vscode_uri_1.URI.from(item.uri);
                const provider = await this.getCallHierarchyServiceForUri(resource);
                const incomingCalls = await provider?.getCallers((0, hierarchy_types_converters_1.toItemHierarchyDefinition)(item), new core_1.CancellationTokenSource().token);
                if (incomingCalls) {
                    return incomingCalls.map(hierarchy_types_converters_1.fromCallHierarchyCallerToModelCallHierarchyIncomingCall);
                }
                return [];
            },
        });
        commands.registerCommand({
            id: 'vscode.provideOutgoingCalls'
        }, {
            execute: async (item) => {
                const resource = vscode_uri_1.URI.from(item.uri);
                const provider = await this.getCallHierarchyServiceForUri(resource);
                const outgoingCalls = await provider?.getCallees?.((0, hierarchy_types_converters_1.toItemHierarchyDefinition)(item), new core_1.CancellationTokenSource().token);
                if (outgoingCalls) {
                    return outgoingCalls.map(hierarchy_types_converters_1.fromCallHierarchyCalleeToModelCallHierarchyOutgoingCall);
                }
                return [];
            }
        });
        commands.registerCommand({
            id: 'vscode.prepareTypeHierarchy'
        }, {
            execute: async (resource, position) => {
                const provider = await this.getTypeHierarchyServiceForUri(resource);
                const session = await provider?.prepareSession(resource.path, (0, type_converters_1.toPosition)(position), new core_1.CancellationTokenSource().token);
                return session ? session.items.map(item => (0, hierarchy_types_converters_1.fromItemHierarchyDefinition)(item)) : [];
            }
        });
        commands.registerCommand({
            id: 'vscode.provideSupertypes'
        }, {
            execute: async (item) => {
                if (!item._sessionId || !item._itemId) {
                    return [];
                }
                const resource = vscode_uri_1.URI.from(item.uri);
                const provider = await this.getTypeHierarchyServiceForUri(resource);
                const items = await provider?.provideSuperTypes(item._sessionId, item._itemId, new core_1.CancellationTokenSource().token);
                return (items ? items : []).map(typeItem => (0, hierarchy_types_converters_1.fromItemHierarchyDefinition)(typeItem));
            }
        });
        commands.registerCommand({
            id: 'vscode.provideSubtypes'
        }, {
            execute: async (item) => {
                if (!item._sessionId || !item._itemId) {
                    return [];
                }
                const resource = vscode_uri_1.URI.from(item.uri);
                const provider = await this.getTypeHierarchyServiceForUri(resource);
                const items = await provider?.provideSubTypes(item._sessionId, item._itemId, new core_1.CancellationTokenSource().token);
                return (items ? items : []).map(typeItem => (0, hierarchy_types_converters_1.fromItemHierarchyDefinition)(typeItem));
            }
        });
        commands.registerCommand({
            id: 'workbench.action.openRecent'
        }, {
            execute: () => this.quickOpenWorkspace.select()
        });
        commands.registerCommand({
            id: 'explorer.newFolder'
        }, {
            execute: () => commands.executeCommand(browser_3.WorkspaceCommands.NEW_FOLDER.id)
        });
        commands.registerAlias('explorer.newFolder', browser_3.WorkspaceCommands.NEW_FOLDER.id);
        commands.registerCommand({
            id: 'workbench.action.terminal.sendSequence'
        }, {
            execute: (args) => {
                if (args === undefined || args.text === undefined) {
                    return;
                }
                const currentTerminal = this.terminalService.currentTerminal;
                if (currentTerminal === undefined) {
                    return;
                }
                currentTerminal.sendText(args.text);
            }
        });
        commands.registerCommand({
            id: 'workbench.action.terminal.kill'
        }, {
            execute: () => {
                const currentTerminal = this.terminalService.currentTerminal;
                if (currentTerminal === undefined) {
                    return;
                }
                currentTerminal.dispose();
            }
        });
        commands.registerCommand({
            id: 'workbench.view.explorer'
        }, {
            execute: () => commands.executeCommand(navigator_contribution_1.FileNavigatorCommands.FOCUS.id)
        });
        commands.registerAlias('workbench.view.explorer', navigator_contribution_1.FileNavigatorCommands.FOCUS.id);
        commands.registerCommand({
            id: 'copyFilePath'
        }, {
            execute: () => commands.executeCommand(browser_1.CommonCommands.COPY_PATH.id)
        });
        commands.registerAlias('copyFilePath', browser_1.CommonCommands.COPY_PATH.id);
        commands.registerCommand({
            id: 'copyRelativeFilePath'
        }, {
            execute: () => commands.executeCommand(browser_3.WorkspaceCommands.COPY_RELATIVE_FILE_PATH.id)
        });
        commands.registerAlias('copyRelativeFilePath', browser_3.WorkspaceCommands.COPY_RELATIVE_FILE_PATH.id);
        commands.registerCommand({
            id: 'revealInExplorer'
        }, {
            execute: async (resource) => {
                if (!vscode_uri_1.URI.isUri(resource)) {
                    return;
                }
                let navigator = await this.shell.revealWidget(browser_4.FILE_NAVIGATOR_ID);
                if (!navigator) {
                    await this.commandService.executeCommand(navigator_contribution_1.FILE_NAVIGATOR_TOGGLE_COMMAND_ID);
                    navigator = await this.shell.revealWidget(browser_4.FILE_NAVIGATOR_ID);
                }
                if (navigator instanceof browser_4.FileNavigatorWidget) {
                    const model = navigator.model;
                    const node = await model.revealFile(new uri_1.default(resource));
                    if (tree_selection_1.SelectableTreeNode.is(node)) {
                        model.selectNode(node);
                    }
                }
            }
        });
        commands.registerCommand({
            id: 'workbench.experimental.requestUsbDevice'
        }, {
            execute: async (options) => {
                const usb = navigator.usb;
                if (!usb) {
                    return undefined;
                }
                const device = await usb.requestDevice({ filters: options?.filters ?? [] });
                if (!device) {
                    return undefined;
                }
                return {
                    deviceClass: device.deviceClass,
                    deviceProtocol: device.deviceProtocol,
                    deviceSubclass: device.deviceSubclass,
                    deviceVersionMajor: device.deviceVersionMajor,
                    deviceVersionMinor: device.deviceVersionMinor,
                    deviceVersionSubminor: device.deviceVersionSubminor,
                    manufacturerName: device.manufacturerName,
                    productId: device.productId,
                    productName: device.productName,
                    serialNumber: device.serialNumber,
                    usbVersionMajor: device.usbVersionMajor,
                    usbVersionMinor: device.usbVersionMinor,
                    usbVersionSubminor: device.usbVersionSubminor,
                    vendorId: device.vendorId,
                };
            }
        });
        commands.registerCommand({
            id: 'workbench.experimental.requestSerialPort'
        }, {
            execute: async (options) => {
                const serial = navigator.serial;
                if (!serial) {
                    return undefined;
                }
                const port = await serial.requestPort({ filters: options?.filters ?? [] });
                if (!port) {
                    return undefined;
                }
                const info = port.getInfo();
                return {
                    usbVendorId: info.usbVendorId,
                    usbProductId: info.usbProductId
                };
            }
        });
        commands.registerCommand({
            id: 'workbench.experimental.requestHidDevice'
        }, {
            execute: async (options) => {
                const hid = navigator.hid;
                if (!hid) {
                    return undefined;
                }
                const devices = await hid.requestDevice({ filters: options?.filters ?? [] });
                if (!devices.length) {
                    return undefined;
                }
                const device = devices[0];
                return {
                    opened: device.opened,
                    vendorId: device.vendorId,
                    productId: device.productId,
                    productName: device.productName,
                    collections: device.collections
                };
            }
        });
        // required by Jupyter for the show table of contents action
        commands.registerCommand({ id: 'outline.focus' }, {
            execute: () => this.outlineViewContribution.openView({ activate: true })
        });
        // required by vscode.git
        commands.registerCommand({ id: 'workbench.view.scm' }, {
            execute: async () => {
                await this.scmContribution.openView({ activate: true });
            }
        });
        commands.registerCommand({ id: '_open.mergeEditor' }, {
            execute: async (arg) => {
                const toTheiaUri = (o) => {
                    if (typeof o === 'string') {
                        return new uri_1.default(o);
                    }
                    return uri_1.default.fromComponents(o);
                };
                const baseUri = toTheiaUri(arg.base);
                const resultUri = toTheiaUri(arg.output);
                const side1Uri = typeof arg.input1 === 'string' ? toTheiaUri(arg.input1) : toTheiaUri(arg.input1.uri);
                const side2Uri = typeof arg.input2 === 'string' ? toTheiaUri(arg.input2) : toTheiaUri(arg.input2.uri);
                const uri = merge_editor_1.MergeEditorUri.encode({ baseUri, side1Uri, side2Uri, resultUri });
                let side1State = undefined;
                if (typeof arg.input1 !== 'string') {
                    const { title, description, detail } = arg.input1;
                    side1State = { title, description, detail };
                }
                let side2State = undefined;
                if (typeof arg.input2 !== 'string') {
                    const { title, description, detail } = arg.input2;
                    side2State = { title, description, detail };
                }
                const options = { widgetState: { side1State, side2State } };
                await (0, browser_1.open)(this.openerService, uri, options);
            }
        });
        // Temporary workaround: opens a single diff editor for the revealed resource.
        // TODO: GH-16280 implement a proper MultiDiffEditor widget.
        commands.registerCommand({ id: '_workbench.openMultiDiffEditor' }, {
            execute: async (options) => {
                if (!options.resources?.length) {
                    return;
                }
                const revealModified = options.reveal?.modifiedUri;
                const revealStr = revealModified ? vscode_uri_1.URI.revive(revealModified)?.toString() : undefined;
                const target = revealStr
                    ? options.resources.find(r => vscode_uri_1.URI.revive(r.modifiedUri)?.toString() === revealStr)
                    : undefined;
                const resource = target ?? options.resources[0];
                const left = vscode_uri_1.URI.revive(resource.originalUri);
                const right = vscode_uri_1.URI.revive(resource.modifiedUri);
                if (left && right) {
                    await commands.executeCommand(VscodeCommands.DIFF.id, left, right, options.title);
                }
                else if (right) {
                    await commands.executeCommand(VscodeCommands.OPEN.id, right);
                }
                else if (left) {
                    await commands.executeCommand(VscodeCommands.OPEN.id, left);
                }
            },
        });
    }
    async deployPlugin(uri) {
        const uriPath = (0, type_converters_1.isUriComponents)(uri) ? vscode_uri_1.URI.revive(uri).fsPath : await this.fileService.fsPath(uri);
        return this.pluginServer.install(`local-file:${uriPath}`);
    }
    async resolveLanguageId(resource) {
        const reference = await this.textModelService.createModelReference(resource);
        const languageId = reference.object.languageId;
        reference.dispose();
        return languageId;
    }
    async getCallHierarchyServiceForUri(resource) {
        const languageId = await this.resolveLanguageId(resource);
        return this.callHierarchyProvider.get(languageId, new uri_1.default(resource));
    }
    async getTypeHierarchyServiceForUri(resource) {
        const languageId = await this.resolveLanguageId(resource);
        return this.typeHierarchyProvider.get(languageId, new uri_1.default(resource));
    }
};
exports.PluginVscodeCommandsContribution = PluginVscodeCommandsContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(command_1.CommandService),
    tslib_1.__metadata("design:type", Object)
], PluginVscodeCommandsContribution.prototype, "commandService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], PluginVscodeCommandsContribution.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.EditorManager),
    tslib_1.__metadata("design:type", browser_2.EditorManager)
], PluginVscodeCommandsContribution.prototype, "editorManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ApplicationShell),
    tslib_1.__metadata("design:type", browser_1.ApplicationShell)
], PluginVscodeCommandsContribution.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(diff_service_1.DiffService),
    tslib_1.__metadata("design:type", diff_service_1.DiffService)
], PluginVscodeCommandsContribution.prototype, "diffService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], PluginVscodeCommandsContribution.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(application_shell_mouse_tracker_1.ApplicationShellMouseTracker),
    tslib_1.__metadata("design:type", application_shell_mouse_tracker_1.ApplicationShellMouseTracker)
], PluginVscodeCommandsContribution.prototype, "mouseTracker", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.QuickInputService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], PluginVscodeCommandsContribution.prototype, "quickInput", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_service_1.WorkspaceService),
    tslib_1.__metadata("design:type", workspace_service_1.WorkspaceService)
], PluginVscodeCommandsContribution.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(terminal_frontend_contribution_1.TerminalFrontendContribution),
    tslib_1.__metadata("design:type", terminal_frontend_contribution_1.TerminalFrontendContribution)
], PluginVscodeCommandsContribution.prototype, "terminalContribution", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(quick_open_workspace_1.QuickOpenWorkspace),
    tslib_1.__metadata("design:type", quick_open_workspace_1.QuickOpenWorkspace)
], PluginVscodeCommandsContribution.prototype, "quickOpenWorkspace", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(terminal_service_1.TerminalService),
    tslib_1.__metadata("design:type", Object)
], PluginVscodeCommandsContribution.prototype, "terminalService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_protocol_1.PluginServer),
    tslib_1.__metadata("design:type", Object)
], PluginVscodeCommandsContribution.prototype, "pluginServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], PluginVscodeCommandsContribution.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_5.CallHierarchyServiceProvider),
    tslib_1.__metadata("design:type", browser_5.CallHierarchyServiceProvider)
], PluginVscodeCommandsContribution.prototype, "callHierarchyProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_6.TypeHierarchyServiceProvider),
    tslib_1.__metadata("design:type", browser_6.TypeHierarchyServiceProvider)
], PluginVscodeCommandsContribution.prototype, "typeHierarchyProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_text_model_service_1.MonacoTextModelService),
    tslib_1.__metadata("design:type", monaco_text_model_service_1.MonacoTextModelService)
], PluginVscodeCommandsContribution.prototype, "textModelService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(window_service_1.WindowService),
    tslib_1.__metadata("design:type", Object)
], PluginVscodeCommandsContribution.prototype, "windowService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], PluginVscodeCommandsContribution.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(outline_view_contribution_1.OutlineViewContribution),
    tslib_1.__metadata("design:type", outline_view_contribution_1.OutlineViewContribution)
], PluginVscodeCommandsContribution.prototype, "outlineViewContribution", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_languages_1.MonacoLanguages),
    tslib_1.__metadata("design:type", monaco_languages_1.MonacoLanguages)
], PluginVscodeCommandsContribution.prototype, "monacoLanguages", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_contribution_1.ScmContribution),
    tslib_1.__metadata("design:type", scm_contribution_1.ScmContribution)
], PluginVscodeCommandsContribution.prototype, "scmContribution", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext-vscode:PluginVscodeCommandsContribution'),
    tslib_1.__metadata("design:type", Object)
], PluginVscodeCommandsContribution.prototype, "logger", void 0);
exports.PluginVscodeCommandsContribution = PluginVscodeCommandsContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PluginVscodeCommandsContribution);
//# sourceMappingURL=plugin-vscode-commands-contribution.js.map