"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
exports.TerminalFrontendContribution = exports.TerminalCommands = exports.TerminalMenus = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const browser_1 = require("@theia/core/lib/browser");
const clipboard_service_1 = require("@theia/core/lib/browser/clipboard-service");
const terminal_widget_impl_1 = require("./terminal-widget-impl");
const terminal_widget_1 = require("./base/terminal-widget");
const terminal_profile_service_1 = require("./terminal-profile-service");
const uri_command_handler_1 = require("@theia/core/lib/common/uri-command-handler");
const shell_terminal_protocol_1 = require("../common/shell-terminal-protocol");
const uri_1 = require("@theia/core/lib/common/uri");
const browser_2 = require("@theia/workspace/lib/browser");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const terminal_copy_on_selection_handler_1 = require("./terminal-copy-on-selection-handler");
const terminal_watcher_1 = require("../common/terminal-watcher");
const nls_1 = require("@theia/core/lib/common/nls");
const terminal_preferences_1 = require("../common/terminal-preferences");
const shell_terminal_profile_1 = require("./shell-terminal-profile");
const browser_3 = require("@theia/variable-resolver/lib/browser");
const color_1 = require("@theia/core/lib/common/color");
const core_1 = require("@theia/core");
const terminal_creation_handler_1 = require("./terminal-creation-handler");
var TerminalMenus;
(function (TerminalMenus) {
    TerminalMenus.TERMINAL = [...common_1.MAIN_MENU_BAR, '7_terminal'];
    TerminalMenus.TERMINAL_NEW = [...TerminalMenus.TERMINAL, '1_terminal'];
    TerminalMenus.TERMINAL_TASKS = [...TerminalMenus.TERMINAL, '2_terminal'];
    TerminalMenus.TERMINAL_TASKS_INFO = [...TerminalMenus.TERMINAL_TASKS, '3_terminal'];
    TerminalMenus.TERMINAL_TASKS_CONFIG = [...TerminalMenus.TERMINAL_TASKS, '4_terminal'];
    TerminalMenus.TERMINAL_NAVIGATOR_CONTEXT_MENU = ['navigator-context-menu', 'navigation'];
    TerminalMenus.TERMINAL_OPEN_EDITORS_CONTEXT_MENU = ['open-editors-context-menu', 'navigation'];
    TerminalMenus.TERMINAL_CONTEXT_MENU = ['terminal-context-menu'];
    TerminalMenus.TERMINAL_CONTRIBUTIONS = [...TerminalMenus.TERMINAL_CONTEXT_MENU, '5_terminal_contributions'];
    TerminalMenus.TERMINAL_TITLE_CONTRIBUTIONS = [...browser_1.SHELL_TABBAR_CONTEXT_MENU, 'terminal_title_contributions'];
})(TerminalMenus || (exports.TerminalMenus = TerminalMenus = {}));
var TerminalCommands;
(function (TerminalCommands) {
    TerminalCommands.TERMINAL_CATEGORY = 'Terminal';
    TerminalCommands.TERMINAL_CATEGORY_KEY = nls_1.nls.getDefaultKey(TerminalCommands.TERMINAL_CATEGORY);
    TerminalCommands.NEW = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:new',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Create New Terminal'
    });
    TerminalCommands.PROFILE_NEW = common_1.Command.toLocalizedCommand({
        id: 'terminal:new:profile',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Create New Integrated Terminal from a Profile'
    }, undefined, TerminalCommands.TERMINAL_CATEGORY_KEY);
    TerminalCommands.PROFILE_DEFAULT = common_1.Command.toLocalizedCommand({
        id: 'terminal:profile:default',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Choose the default Terminal Profile'
    }, undefined, TerminalCommands.TERMINAL_CATEGORY_KEY);
    TerminalCommands.NEW_ACTIVE_WORKSPACE = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:new:active:workspace',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Create New Terminal (In Active Workspace)'
    });
    TerminalCommands.TERMINAL_CLEAR = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:clear',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Clear'
    });
    TerminalCommands.TERMINAL_CONTEXT = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:context',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Open in Integrated Terminal'
    });
    TerminalCommands.SPLIT = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:split',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Split Terminal'
    });
    TerminalCommands.TERMINAL_FIND_TEXT = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:find',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Find'
    });
    TerminalCommands.TERMINAL_FIND_TEXT_CANCEL = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:find:cancel',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Hide Find'
    });
    TerminalCommands.SCROLL_LINE_UP = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:scroll:line:up',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Scroll Up (Line)'
    });
    TerminalCommands.SCROLL_LINE_DOWN = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:scroll:line:down',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Scroll Down (Line)'
    });
    TerminalCommands.SCROLL_TO_TOP = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:scroll:top',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Scroll to Top'
    });
    TerminalCommands.SCROLL_PAGE_UP = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:scroll:page:up',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Scroll Up (Page)'
    });
    TerminalCommands.SCROLL_PAGE_DOWN = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:scroll:page:down',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Scroll Down (Page)'
    });
    TerminalCommands.TOGGLE_TERMINAL = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.terminal.toggleTerminal',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Toggle Terminal'
    });
    TerminalCommands.KILL_TERMINAL = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:kill',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Kill Terminal'
    });
    TerminalCommands.SELECT_ALL = common_1.Command.toDefaultLocalizedCommand({
        id: 'terminal:select:all',
        label: 'Select All',
        category: TerminalCommands.TERMINAL_CATEGORY,
    });
    TerminalCommands.PASTE_TERMINAL = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.terminal.paste',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Paste into Active Terminal'
    });
    TerminalCommands.COPY_TERMINAL_SELECTION = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.terminal.copySelection',
        category: TerminalCommands.TERMINAL_CATEGORY,
        label: 'Copy Selection'
    });
    /**
     * Command that displays all terminals that are currently opened
     */
    TerminalCommands.SHOW_ALL_OPENED_TERMINALS = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.showAllTerminals',
        category: browser_1.CommonCommands.VIEW_CATEGORY,
        label: 'Show All Opened Terminals'
    });
})(TerminalCommands || (exports.TerminalCommands = TerminalCommands = {}));
const ENVIRONMENT_VARIABLE_COLLECTIONS_KEY = 'terminal.integrated.environmentVariableCollections';
let TerminalFrontendContribution = class TerminalFrontendContribution {
    constructor() {
        this.mergePreferencesPromise = Promise.resolve();
        this.onDidCreateTerminalEmitter = new common_1.Emitter();
        this.onDidCreateTerminal = this.onDidCreateTerminalEmitter.event;
        this.onDidChangeCurrentTerminalEmitter = new common_1.Emitter();
        this.onDidChangeCurrentTerminal = this.onDidChangeCurrentTerminalEmitter.event;
        // IDs of the most recently used terminals
        this.mostRecentlyUsedTerminalEntries = [];
    }
    init() {
        this.shell.onDidChangeCurrentWidget(() => this.updateCurrentTerminal());
        this.widgetManager.onDidCreateWidget(({ widget }) => {
            if (widget instanceof terminal_widget_1.TerminalWidget) {
                this.updateCurrentTerminal();
                this.onDidCreateTerminalEmitter.fire(widget);
                this.setLastUsedTerminal(widget);
            }
        });
        const terminalFocusKey = this.contextKeyService.createKey('terminalFocus', false);
        const terminalSearchToggle = this.contextKeyService.createKey('terminalHideSearch', false);
        const updateFocusKey = () => {
            terminalFocusKey.set(this.shell.activeWidget instanceof terminal_widget_1.TerminalWidget);
            terminalSearchToggle.set(this.terminalHideSearch);
        };
        updateFocusKey();
        this.shell.onDidChangeActiveWidget(updateFocusKey);
        this.terminalWatcher.onStoreTerminalEnvVariablesRequested(data => {
            this.storageService.setData(ENVIRONMENT_VARIABLE_COLLECTIONS_KEY, data);
        });
        this.terminalWatcher.onUpdateTerminalEnvVariablesRequested(() => {
            this.storageService.getData(ENVIRONMENT_VARIABLE_COLLECTIONS_KEY).then(data => {
                if (data) {
                    this.shellTerminalServer.restorePersisted(data);
                }
            });
        });
    }
    get terminalHideSearch() {
        if (!(this.shell.activeWidget instanceof terminal_widget_1.TerminalWidget)) {
            return false;
        }
        const searchWidget = this.shell.activeWidget.getSearchBox();
        return searchWidget.isVisible;
    }
    async onStart(app) {
        this.contributeDefaultProfiles();
        this.terminalPreferences.onPreferenceChanged(e => {
            if (e.preferenceName.startsWith('terminal.integrated.')) {
                this.mergePreferencesPromise = this.mergePreferencesPromise.finally(() => this.mergePreferences());
            }
        });
        this.mergePreferencesPromise = this.mergePreferencesPromise.finally(() => this.mergePreferences());
        // extension contributions get read after this point: need to set the default profile if necessary
        this.profileService.onAdded(id => {
            let defaultProfileId;
            switch (common_1.OS.backend.type()) {
                case common_1.OS.Type.Windows: {
                    defaultProfileId = this.terminalPreferences['terminal.integrated.defaultProfile.windows'];
                    break;
                }
                case common_1.OS.Type.Linux: {
                    defaultProfileId = this.terminalPreferences['terminal.integrated.defaultProfile.linux'];
                    break;
                }
                case common_1.OS.Type.OSX: {
                    defaultProfileId = this.terminalPreferences['terminal.integrated.defaultProfile.osx'];
                    break;
                }
            }
            if (defaultProfileId) {
                this.profileService.setDefaultProfile(defaultProfileId);
            }
        });
    }
    async initializeLayout() {
        await this.preferenceService.ready;
        // `terminal.grouping.mode` is defined in @theia/terminal-manager, which this package
        // cannot depend on. Reading via generic PreferenceService; undefined safely
        // falls through to standard terminal behavior.
        const groupingMode = this.preferenceService.get('terminal.grouping.mode');
        if (groupingMode === 'tree') {
            return;
        }
        try {
            const termWidget = await this.newTerminal({});
            await termWidget.start();
            // Use shell.addWidget directly (not this.open()) to add the terminal
            // to the bottom panel without expanding it on startup.
            this.shell.addWidget(termWidget, { area: 'bottom' });
        }
        catch (error) {
            this.logger.error('Failed to initialize terminal in default layout', error);
        }
    }
    async contributeDefaultProfiles() {
        if (common_1.OS.backend.isWindows) {
            this.contributedProfileStore.registerTerminalProfile('cmd', new shell_terminal_profile_1.ShellTerminalProfile(this, {
                shellPath: await this.resolveShellPath([
                    '${env:windir}\\Sysnative\\cmd.exe',
                    '${env:windir}\\System32\\cmd.exe'
                ])
            }));
        }
        else {
            this.contributedProfileStore.registerTerminalProfile('SHELL', new shell_terminal_profile_1.ShellTerminalProfile(this, {
                shellPath: await this.resolveShellPath('${SHELL}'),
                shellArgs: ['-l'],
                iconClass: 'codicon codicon-terminal'
            }));
        }
        // contribute default profiles based on legacy preferences
    }
    async mergePreferences() {
        let profiles;
        let defaultProfile;
        let legacyShellPath;
        let legacyShellArgs;
        const removed = new Set(this.userProfileStore.all.map(([id, profile]) => id));
        switch (common_1.OS.backend.type()) {
            case common_1.OS.Type.Windows: {
                profiles = this.terminalPreferences['terminal.integrated.profiles.windows'];
                defaultProfile = this.terminalPreferences['terminal.integrated.defaultProfile.windows'];
                legacyShellPath = this.terminalPreferences['terminal.integrated.shell.windows'] ?? undefined;
                legacyShellArgs = this.terminalPreferences['terminal.integrated.shellArgs.windows'];
                break;
            }
            case common_1.OS.Type.Linux: {
                profiles = this.terminalPreferences['terminal.integrated.profiles.linux'];
                defaultProfile = this.terminalPreferences['terminal.integrated.defaultProfile.linux'];
                legacyShellPath = this.terminalPreferences['terminal.integrated.shell.linux'] ?? undefined;
                legacyShellArgs = this.terminalPreferences['terminal.integrated.shellArgs.linux'];
                break;
            }
            case common_1.OS.Type.OSX: {
                profiles = this.terminalPreferences['terminal.integrated.profiles.osx'];
                defaultProfile = this.terminalPreferences['terminal.integrated.defaultProfile.osx'];
                legacyShellPath = this.terminalPreferences['terminal.integrated.shell.osx'] ?? undefined;
                legacyShellArgs = this.terminalPreferences['terminal.integrated.shellArgs.osx'];
                break;
            }
        }
        if (profiles) {
            for (const id of Object.getOwnPropertyNames(profiles)) {
                const profile = profiles[id];
                removed.delete(id);
                if (profile) {
                    const shellPath = await this.resolveShellPath(profile.path);
                    if (shellPath) {
                        const options = {
                            shellPath: shellPath,
                            shellArgs: profile.args ? await this.variableResolver.resolve(profile.args) : undefined,
                            useServerTitle: profile.overrideName ? false : undefined,
                            env: profile.env ? await this.variableResolver.resolve(profile.env) : undefined,
                            title: profile.overrideName ? id : undefined
                        };
                        this.userProfileStore.registerTerminalProfile(id, new shell_terminal_profile_1.ShellTerminalProfile(this, options));
                    }
                }
                else {
                    this.userProfileStore.registerTerminalProfile(id, terminal_profile_service_1.NULL_PROFILE);
                }
            }
        }
        if (legacyShellPath) {
            this.userProfileStore.registerTerminalProfile('Legacy Shell Preferences', new shell_terminal_profile_1.ShellTerminalProfile(this, {
                shellPath: legacyShellPath,
                shellArgs: legacyShellArgs
            }));
            // if no other default is set, use the legacy preferences as default if they exist
            this.profileService.setDefaultProfile('Legacy Shell Preferences');
        }
        if (defaultProfile && this.profileService.getProfile(defaultProfile)) {
            this.profileService.setDefaultProfile(defaultProfile);
        }
        for (const id of removed) {
            this.userProfileStore.unregisterTerminalProfile(id);
        }
    }
    async resolveShellPath(path) {
        if (!path) {
            return undefined;
        }
        if (typeof path === 'string') {
            path = [path];
        }
        for (const p of path) {
            const resolved = await this.variableResolver.resolve(p);
            if (resolved) {
                const resolvedURI = uri_1.default.fromFilePath(resolved);
                if (await this.fileService.exists(resolvedURI)) {
                    return resolved;
                }
            }
        }
        return undefined;
    }
    onWillStop() {
        const preferenceValue = this.terminalPreferences['terminal.integrated.confirmOnExit'];
        if (preferenceValue !== 'never') {
            const allTerminals = this.widgetManager.getWidgets(terminal_widget_impl_1.TERMINAL_WIDGET_FACTORY_ID);
            if (allTerminals.length) {
                return {
                    prepare: async () => {
                        if (preferenceValue === 'always') {
                            return allTerminals.length;
                        }
                        else {
                            const activeTerminals = await Promise.all(allTerminals.map(widget => widget.hasChildProcesses()))
                                .then(hasChildProcesses => hasChildProcesses.filter(hasChild => hasChild));
                            return activeTerminals.length;
                        }
                    },
                    action: async (activeTerminalCount) => activeTerminalCount === 0 || this.confirmExitWithActiveTerminals(activeTerminalCount),
                    reason: 'Active integrated terminal',
                };
            }
        }
    }
    async confirmExitWithActiveTerminals(activeTerminalCount) {
        const msg = activeTerminalCount === 1
            ? nls_1.nls.localizeByDefault('Do you want to terminate the active terminal session?')
            : nls_1.nls.localizeByDefault('Do you want to terminate the {0} active terminal sessions?', activeTerminalCount);
        const safeToExit = await new browser_1.ConfirmDialog({
            title: '',
            msg,
            ok: nls_1.nls.localizeByDefault('Terminate'),
            cancel: browser_1.Dialog.CANCEL,
        }).open();
        return safeToExit === true;
    }
    get currentTerminal() {
        return this._currentTerminal;
    }
    setCurrentTerminal(current) {
        if (this._currentTerminal !== current) {
            this._currentTerminal = current;
            this.onDidChangeCurrentTerminalEmitter.fire(this._currentTerminal);
        }
    }
    updateCurrentTerminal() {
        const widget = this.shell.currentWidget;
        if (widget instanceof terminal_widget_1.TerminalWidget) {
            this.setCurrentTerminal(widget);
        }
        else if (!this._currentTerminal || !this._currentTerminal.isVisible) {
            this.setCurrentTerminal(undefined);
        }
    }
    getLastUsedTerminalId() {
        const mostRecent = this.mostRecentlyUsedTerminalEntries[this.mostRecentlyUsedTerminalEntries.length - 1];
        if (mostRecent) {
            return mostRecent.id;
        }
    }
    get lastUsedTerminal() {
        const id = this.getLastUsedTerminalId();
        if (id) {
            return this.getById(id);
        }
    }
    setLastUsedTerminal(lastUsedTerminal) {
        const lastUsedTerminalId = lastUsedTerminal.id;
        const entryIndex = this.mostRecentlyUsedTerminalEntries.findIndex(entry => entry.id === lastUsedTerminalId);
        let toDispose;
        if (entryIndex >= 0) {
            toDispose = this.mostRecentlyUsedTerminalEntries[entryIndex].disposables;
            this.mostRecentlyUsedTerminalEntries.splice(entryIndex, 1);
        }
        else {
            toDispose = new common_1.DisposableCollection();
            toDispose.push(lastUsedTerminal.onDidChangeVisibility((isVisible) => {
                if (isVisible) {
                    this.setLastUsedTerminal(lastUsedTerminal);
                }
            }));
            toDispose.push(lastUsedTerminal.onDidDispose(() => {
                const index = this.mostRecentlyUsedTerminalEntries.findIndex(entry => entry.id === lastUsedTerminalId);
                if (index >= 0) {
                    this.mostRecentlyUsedTerminalEntries[index].disposables.dispose();
                    this.mostRecentlyUsedTerminalEntries.splice(index, 1);
                }
            }));
        }
        const newEntry = { id: lastUsedTerminalId, disposables: toDispose };
        if (lastUsedTerminal.isVisible) {
            this.mostRecentlyUsedTerminalEntries.push(newEntry);
        }
        else {
            this.mostRecentlyUsedTerminalEntries = [newEntry, ...this.mostRecentlyUsedTerminalEntries];
        }
    }
    get all() {
        return this.widgetManager.getWidgets(terminal_widget_impl_1.TERMINAL_WIDGET_FACTORY_ID);
    }
    getById(id) {
        return this.all.find(terminal => terminal.id === id);
    }
    getByTerminalId(terminalId) {
        return this.all.find(terminal => terminal.terminalId === terminalId);
    }
    getDefaultShell() {
        return this.shellTerminalServer.getDefaultShell();
    }
    registerCommands(commands) {
        commands.registerCommand(TerminalCommands.NEW, {
            execute: (widget) => {
                const fromWidget = this.withWidget(widget, terminal => terminal);
                const ref = fromWidget === false ? this.lastUsedTerminal : fromWidget;
                const widgetOptions = ref ? { ref, mode: 'tab-after' } : undefined;
                return this.openTerminal(widgetOptions);
            }
        });
        commands.registerCommand(TerminalCommands.PROFILE_NEW, {
            execute: async () => {
                const profile = await this.selectTerminalProfile(nls_1.nls.localize('theia/terminal/selectProfile', 'Select a profile for the new terminal'));
                if (!profile) {
                    return;
                }
                this.openTerminal(undefined, profile[1]);
            }
        });
        commands.registerCommand(TerminalCommands.PROFILE_DEFAULT, {
            execute: () => this.chooseDefaultProfile()
        });
        commands.registerCommand(TerminalCommands.NEW_ACTIVE_WORKSPACE, {
            execute: () => this.openActiveWorkspaceTerminal()
        });
        commands.registerCommand(TerminalCommands.SPLIT, {
            execute: (widget) => this.withWidget(widget, terminal => this.splitTerminal(terminal)),
            isEnabled: w => this.withWidget(w, () => true),
            isVisible: w => this.withWidget(w, () => true),
        });
        commands.registerCommand(TerminalCommands.TERMINAL_CLEAR);
        commands.registerHandler(TerminalCommands.TERMINAL_CLEAR.id, {
            execute: () => this.currentTerminal?.clearOutput()
        });
        commands.registerCommand(TerminalCommands.TERMINAL_CONTEXT, uri_command_handler_1.UriAwareCommandHandler.MonoSelect(this.selectionService, {
            execute: uri => this.openInTerminal(uri)
        }));
        commands.registerCommand(TerminalCommands.TERMINAL_FIND_TEXT);
        commands.registerHandler(TerminalCommands.TERMINAL_FIND_TEXT.id, {
            isEnabled: () => {
                if (this.shell.activeWidget instanceof terminal_widget_1.TerminalWidget) {
                    return !this.shell.activeWidget.getSearchBox().isVisible;
                }
                return false;
            },
            execute: () => {
                const termWidget = this.shell.activeWidget;
                const terminalSearchBox = termWidget.getSearchBox();
                terminalSearchBox.show();
            }
        });
        commands.registerCommand(TerminalCommands.TERMINAL_FIND_TEXT_CANCEL);
        commands.registerHandler(TerminalCommands.TERMINAL_FIND_TEXT_CANCEL.id, {
            isEnabled: () => {
                if (this.shell.activeWidget instanceof terminal_widget_1.TerminalWidget) {
                    return this.shell.activeWidget.getSearchBox().isVisible;
                }
                return false;
            },
            execute: () => {
                const termWidget = this.shell.activeWidget;
                const terminalSearchBox = termWidget.getSearchBox();
                terminalSearchBox.hide();
            }
        });
        commands.registerCommand(TerminalCommands.SCROLL_LINE_UP, {
            isEnabled: () => this.shell.activeWidget instanceof terminal_widget_1.TerminalWidget,
            isVisible: () => false,
            execute: () => {
                this.shell.activeWidget.scrollLineUp();
            }
        });
        commands.registerCommand(TerminalCommands.SCROLL_LINE_DOWN, {
            isEnabled: () => this.shell.activeWidget instanceof terminal_widget_1.TerminalWidget,
            isVisible: () => false,
            execute: () => {
                this.shell.activeWidget.scrollLineDown();
            }
        });
        commands.registerCommand(TerminalCommands.SCROLL_TO_TOP, {
            isEnabled: () => this.shell.activeWidget instanceof terminal_widget_1.TerminalWidget,
            isVisible: () => false,
            execute: () => {
                this.shell.activeWidget.scrollToTop();
            }
        });
        commands.registerCommand(TerminalCommands.SCROLL_PAGE_UP, {
            isEnabled: () => this.shell.activeWidget instanceof terminal_widget_1.TerminalWidget,
            isVisible: () => false,
            execute: () => {
                this.shell.activeWidget.scrollPageUp();
            }
        });
        commands.registerCommand(TerminalCommands.SCROLL_PAGE_DOWN, {
            isEnabled: () => this.shell.activeWidget instanceof terminal_widget_1.TerminalWidget,
            isVisible: () => false,
            execute: () => {
                this.shell.activeWidget.scrollPageDown();
            }
        });
        commands.registerCommand(TerminalCommands.TOGGLE_TERMINAL, {
            execute: () => this.toggleTerminal()
        });
        commands.registerCommand(TerminalCommands.KILL_TERMINAL, {
            isEnabled: () => !!this.currentTerminal,
            execute: () => this.currentTerminal?.close()
        });
        commands.registerCommand(TerminalCommands.SELECT_ALL, {
            isEnabled: () => !!this.currentTerminal,
            execute: () => this.currentTerminal?.selectAll()
        });
        commands.registerCommand(TerminalCommands.PASTE_TERMINAL, {
            isEnabled: () => !!this.getPasteTargetTerminal(),
            execute: async () => {
                const terminal = this.getPasteTargetTerminal();
                if (!terminal) {
                    return;
                }
                const text = await this.clipboardService.readText();
                if (text) {
                    terminal.paste(text);
                }
            }
        });
        commands.registerCommand(TerminalCommands.COPY_TERMINAL_SELECTION, {
            isEnabled: () => !!this.getCopySourceTerminal(),
            execute: () => {
                const terminal = this.getCopySourceTerminal();
                if (!terminal) {
                    return;
                }
                this.copyHandler.syncCopy(terminal.getSelection());
            }
        });
    }
    getPasteTargetTerminal() {
        const terminal = this.shell.activeWidget;
        if (terminal instanceof terminal_widget_1.TerminalWidget && this.terminalPreferences['terminal.enablePaste']) {
            return terminal;
        }
        return undefined;
    }
    getCopySourceTerminal() {
        const terminal = this.shell.activeWidget;
        if (terminal instanceof terminal_widget_1.TerminalWidget && terminal.hasSelection() && this.terminalPreferences['terminal.enableCopy']) {
            return terminal;
        }
        return undefined;
    }
    toggleTerminal() {
        const terminals = this.shell.getWidgets('bottom').filter(w => w instanceof terminal_widget_1.TerminalWidget);
        if (terminals.length === 0) {
            this.openTerminal();
            return;
        }
        if (!this.shell.isExpanded('bottom')) {
            this.shell.expandPanel('bottom');
            terminals[0].activate();
        }
        else {
            const visibleTerminal = terminals.find(t => t.isVisible);
            if (!visibleTerminal) {
                this.shell.bottomPanel.activateWidget(terminals[0]);
            }
            else if (this.shell.activeWidget !== visibleTerminal) {
                this.shell.bottomPanel.activateWidget(visibleTerminal);
            }
            else {
                this.shell.collapsePanel('bottom');
            }
        }
    }
    async openInTerminal(uri) {
        // Determine folder path of URI
        let stat;
        try {
            stat = await this.fileService.resolve(uri);
        }
        catch {
            return;
        }
        // Use folder if a file was selected
        const cwd = (stat.isDirectory) ? uri.toString() : uri.parent.toString();
        // Open terminal
        const termWidget = await this.newTerminal({ cwd });
        termWidget.start();
        this.open(termWidget);
    }
    registerMenus(menus) {
        menus.registerSubmenu(TerminalMenus.TERMINAL, terminal_widget_impl_1.TerminalWidgetImpl.LABEL);
        menus.registerMenuAction(TerminalMenus.TERMINAL_NEW, {
            commandId: TerminalCommands.NEW.id,
            label: nls_1.nls.localizeByDefault('New Terminal'),
            order: '0'
        });
        menus.registerMenuAction(TerminalMenus.TERMINAL_NEW, {
            commandId: TerminalCommands.PROFILE_NEW.id,
            label: nls_1.nls.localize('theia/terminal/profileNew', 'New Terminal (With Profile)...'),
            order: '1'
        });
        menus.registerMenuAction(TerminalMenus.TERMINAL_NEW, {
            commandId: TerminalCommands.PROFILE_DEFAULT.id,
            label: nls_1.nls.localize('theia/terminal/profileDefault', 'Choose Default Profile...'),
            order: '3'
        });
        menus.registerMenuAction(TerminalMenus.TERMINAL_NEW, {
            commandId: TerminalCommands.SPLIT.id,
            order: '3'
        });
        menus.registerMenuAction(TerminalMenus.TERMINAL_NAVIGATOR_CONTEXT_MENU, {
            commandId: TerminalCommands.TERMINAL_CONTEXT.id,
            order: 'z'
        });
        menus.registerMenuAction(TerminalMenus.TERMINAL_OPEN_EDITORS_CONTEXT_MENU, {
            commandId: TerminalCommands.TERMINAL_CONTEXT.id,
            order: 'z'
        });
        menus.registerMenuAction([...TerminalMenus.TERMINAL_CONTEXT_MENU, '_1'], {
            commandId: TerminalCommands.NEW_ACTIVE_WORKSPACE.id,
            label: nls_1.nls.localizeByDefault('New Terminal')
        });
        menus.registerMenuAction([...TerminalMenus.TERMINAL_CONTEXT_MENU, '_1'], {
            commandId: TerminalCommands.SPLIT.id
        });
        menus.registerMenuAction([...TerminalMenus.TERMINAL_CONTEXT_MENU, '_2'], {
            commandId: TerminalCommands.COPY_TERMINAL_SELECTION.id,
            label: nls_1.nls.localizeByDefault('Copy')
        });
        menus.registerMenuAction([...TerminalMenus.TERMINAL_CONTEXT_MENU, '_2'], {
            commandId: TerminalCommands.PASTE_TERMINAL.id,
            label: nls_1.nls.localizeByDefault('Paste')
        });
        menus.registerMenuAction([...TerminalMenus.TERMINAL_CONTEXT_MENU, '_2'], {
            commandId: TerminalCommands.SELECT_ALL.id
        });
        menus.registerMenuAction([...TerminalMenus.TERMINAL_CONTEXT_MENU, '_3'], {
            commandId: TerminalCommands.TERMINAL_CLEAR.id
        });
        menus.registerMenuAction([...TerminalMenus.TERMINAL_CONTEXT_MENU, '_4'], {
            commandId: TerminalCommands.KILL_TERMINAL.id
        });
        menus.registerSubmenu(TerminalMenus.TERMINAL_CONTRIBUTIONS, '');
        menus.registerSubmenu(TerminalMenus.TERMINAL_TITLE_CONTRIBUTIONS, '', { when: 'isTerminalTab' });
    }
    registerToolbarItems(toolbar) {
        toolbar.registerItem({
            id: TerminalCommands.NEW.id,
            command: TerminalCommands.NEW.id,
            icon: (0, browser_1.codicon)('add'),
            tooltip: TerminalCommands.NEW.label,
            isVisible: w => this.withWidget(w, () => true),
        });
        toolbar.registerItem({
            id: TerminalCommands.SPLIT.id,
            command: TerminalCommands.SPLIT.id,
            icon: (0, browser_1.codicon)('split-horizontal'),
            tooltip: TerminalCommands.SPLIT.label
        });
    }
    registerKeybindings(keybindings) {
        /* Register passthrough keybindings for combinations recognized by
           xterm.js and converted to control characters.
             See: https://github.com/xtermjs/xterm.js/blob/v3/src/Terminal.ts#L1684 */
        /* Register ctrl + k (the passed Key) as a passthrough command in the
           context of the terminal.  */
        const regCtrl = (k) => {
            keybindings.registerKeybinding({
                command: browser_1.KeybindingRegistry.PASSTHROUGH_PSEUDO_COMMAND,
                keybinding: browser_1.KeyCode.createKeyCode({ key: k, ctrl: true }).toString(),
                when: 'terminalFocus',
            });
        };
        /* Register alt + k (the passed Key) as a passthrough command in the
           context of the terminal.  */
        const regAlt = (k) => {
            keybindings.registerKeybinding({
                command: browser_1.KeybindingRegistry.PASSTHROUGH_PSEUDO_COMMAND,
                keybinding: browser_1.KeyCode.createKeyCode({ key: k, alt: true }).toString(),
                when: 'terminalFocus'
            });
        };
        /* ctrl-space (000 - NUL).  */
        regCtrl(browser_1.Key.SPACE);
        /* ctrl-A (001/1/0x1) through ctrl-Z (032/26/0x1A).  */
        for (let i = 0; i < 26; i++) {
            regCtrl({
                keyCode: browser_1.Key.KEY_A.keyCode + i,
                code: 'Key' + String.fromCharCode('A'.charCodeAt(0) + i)
            });
        }
        /* ctrl-[ or ctrl-3 (033/27/0x1B - ESC).  */
        regCtrl(browser_1.Key.BRACKET_LEFT);
        regCtrl(browser_1.Key.DIGIT3);
        /* ctrl-\ or ctrl-4 (034/28/0x1C - FS).  */
        regCtrl(browser_1.Key.BACKSLASH);
        regCtrl(browser_1.Key.DIGIT4);
        /* ctrl-] or ctrl-5 (035/29/0x1D - GS).  */
        regCtrl(browser_1.Key.BRACKET_RIGHT);
        regCtrl(browser_1.Key.DIGIT5);
        /* ctrl-6 (036/30/0x1E - RS).  */
        regCtrl(browser_1.Key.DIGIT6);
        /* ctrl-7 (037/31/0x1F - US).  */
        regCtrl(browser_1.Key.DIGIT7);
        /* ctrl-8 (177/127/0x7F - DEL).  */
        regCtrl(browser_1.Key.DIGIT8);
        /* alt-A (0x1B 0x62) through alt-Z (0x1B 0x7A).  */
        for (let i = 0; i < 26; i++) {
            regAlt({
                keyCode: browser_1.Key.KEY_A.keyCode + i,
                code: 'Key' + String.fromCharCode('A'.charCodeAt(0) + i)
            });
        }
        /* alt-` (0x1B 0x60).  */
        regAlt(browser_1.Key.BACKQUOTE);
        /* alt-0 (0x1B 0x30) through alt-9 (0x1B 0x39).  */
        for (let i = 0; i < 10; i++) {
            regAlt({
                keyCode: browser_1.Key.DIGIT0.keyCode + i,
                code: 'Digit' + String.fromCharCode('0'.charCodeAt(0) + i)
            });
        }
        if (common_1.isOSX) {
            // selectAll on OSX
            keybindings.registerKeybinding({
                command: browser_1.KeybindingRegistry.PASSTHROUGH_PSEUDO_COMMAND,
                keybinding: 'ctrlcmd+a',
                when: 'terminalFocus'
            });
        }
        keybindings.registerKeybinding({
            command: TerminalCommands.NEW.id,
            keybinding: 'ctrl+shift+`'
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.NEW_ACTIVE_WORKSPACE.id,
            keybinding: 'ctrl+`'
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.TERMINAL_CLEAR.id,
            keybinding: 'ctrlcmd+k',
            when: 'terminalFocus'
        });
        // A passthrough binding claims ctrlcmd+v for the terminal (winning over the global
        // CommonCommands.PASTE binding via the local terminalFocus context) but runs no command,
        // letting the keystroke reach xterm's native paste event. That avoids the permission-gated
        // Clipboard API (navigator.clipboard.readText) that the PASTE_TERMINAL command requires, while
        // preserving bracketed paste. terminal.enablePaste is enforced in TerminalWidgetImpl.customKeyHandler.
        keybindings.registerKeybinding({
            command: browser_1.KeybindingRegistry.PASSTHROUGH_PSEUDO_COMMAND,
            keybinding: 'ctrlcmd+v',
            when: 'terminalFocus'
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.COPY_TERMINAL_SELECTION.id,
            keybinding: 'ctrlcmd+c',
            when: 'terminalFocus'
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.TERMINAL_FIND_TEXT.id,
            keybinding: 'ctrlcmd+f',
            when: 'terminalFocus'
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.TERMINAL_FIND_TEXT_CANCEL.id,
            keybinding: 'esc',
            when: 'terminalHideSearch'
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.SCROLL_LINE_UP.id,
            keybinding: 'ctrl+shift+up',
            when: 'terminalFocus'
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.SCROLL_LINE_DOWN.id,
            keybinding: 'ctrl+shift+down',
            when: 'terminalFocus'
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.SCROLL_TO_TOP.id,
            keybinding: 'shift-home',
            when: 'terminalFocus'
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.SCROLL_PAGE_UP.id,
            keybinding: 'shift-pageUp',
            when: 'terminalFocus'
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.SCROLL_PAGE_DOWN.id,
            keybinding: 'shift-pageDown',
            when: 'terminalFocus'
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.TOGGLE_TERMINAL.id,
            keybinding: 'ctrl+`',
        });
        keybindings.registerKeybinding({
            command: TerminalCommands.SELECT_ALL.id,
            keybinding: 'ctrlcmd+a',
            when: 'terminalFocus'
        });
    }
    async newTerminal(options) {
        const widget = await this.widgetManager.getOrCreateWidget(terminal_widget_impl_1.TERMINAL_WIDGET_FACTORY_ID, {
            created: (0, terminal_widget_impl_1.nextTerminalCreationToken)(),
            ...options
        });
        return widget;
    }
    async open(widget, options) {
        const handlers = this.terminalCreationHandlers.getContributions(true)
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
        for (const handler of handlers) {
            if (await handler.onWillOpenTerminal(widget, options)) {
                return;
            }
        }
    }
    async selectTerminalCwd() {
        return new Promise(async (resolve) => {
            const roots = this.workspaceService.tryGetRoots();
            if (roots.length === 0) {
                resolve(undefined);
            }
            else if (roots.length === 1) {
                resolve(roots[0].resource.toString());
            }
            else {
                const items = roots.map(({ resource }) => ({
                    label: this.labelProvider.getName(resource),
                    description: this.labelProvider.getLongName(resource),
                    resource
                }));
                const selectedItem = await this.quickInputService?.showQuickPick(items, {
                    placeholder: nls_1.nls.localizeByDefault('Select current working directory for new terminal')
                });
                resolve(selectedItem?.resource?.toString());
            }
        });
    }
    async selectTerminalProfile(placeholder) {
        return new Promise(async (resolve) => {
            const profiles = this.profileService.all;
            if (profiles.length === 0) {
                resolve(undefined);
            }
            else {
                const items = profiles.map(([id, profile]) => ({
                    label: id,
                    profile
                }));
                const selectedItem = await this.quickInputService?.showQuickPick(items, {
                    placeholder
                });
                resolve(selectedItem ? [selectedItem.label, selectedItem.profile] : undefined);
            }
        });
    }
    async splitTerminal(referenceTerminal) {
        if (referenceTerminal || this.currentTerminal) {
            const ref = referenceTerminal ?? this.currentTerminal;
            await this.openTerminal({ ref, mode: 'split-right' });
        }
    }
    async openTerminal(options, terminalProfile) {
        let profile = terminalProfile;
        if (!terminalProfile) {
            profile = this.profileService.defaultProfile;
            if (!profile) {
                throw new Error('There are no profiles registered');
            }
        }
        if (profile instanceof shell_terminal_profile_1.ShellTerminalProfile) {
            if (this.workspaceService.workspace) {
                const cwd = await this.selectTerminalCwd();
                if (!cwd) {
                    return;
                }
                profile = profile.modify({ cwd });
            }
        }
        const termWidget = await profile?.start();
        if (!!termWidget) {
            this.open(termWidget, { widgetOptions: options });
        }
    }
    async chooseDefaultProfile() {
        const result = await this.selectTerminalProfile(nls_1.nls.localizeByDefault('Select your default terminal profile'));
        if (!result) {
            return;
        }
        this.preferenceService.set(`terminal.integrated.defaultProfile.${common_1.OS.backend.type().toLowerCase()}`, result[0], common_1.PreferenceScope.User);
    }
    async openActiveWorkspaceTerminal(options) {
        const termWidget = await this.newTerminal({});
        termWidget.start();
        this.open(termWidget, { widgetOptions: options });
    }
    withWidget(widget, fn) {
        if (widget instanceof terminal_widget_1.TerminalWidget) {
            return fn(widget);
        }
        return false;
    }
    /**
     * It should be aligned with https://code.visualstudio.com/api/references/theme-color#integrated-terminal-colors
     */
    registerColors(colors) {
        colors.register({
            id: 'terminal.background',
            defaults: {
                dark: 'panel.background',
                light: 'panel.background',
                hcDark: 'panel.background',
                hcLight: 'panel.background'
            },
            description: nls_1.nls.localizeByDefault('The background color of the terminal, this allows coloring the terminal differently to the panel.')
        });
        colors.register({
            id: 'terminal.foreground',
            defaults: {
                light: '#333333',
                dark: '#CCCCCC',
                hcDark: '#FFFFFF',
                hcLight: '#292929'
            },
            description: nls_1.nls.localizeByDefault('The foreground color of the terminal.')
        });
        colors.register({
            id: 'terminalCursor.foreground',
            description: nls_1.nls.localizeByDefault('The foreground color of the terminal cursor.')
        });
        colors.register({
            id: 'terminalCursor.background',
            description: nls_1.nls.localizeByDefault('The background color of the terminal cursor. Allows customizing the color of a character overlapped by a block cursor.')
        });
        colors.register({
            id: 'terminal.selectionBackground',
            defaults: {
                light: 'editor.selectionBackground',
                dark: 'editor.selectionBackground',
                hcDark: 'editor.selectionBackground',
                hcLight: 'editor.selectionBackground'
            },
            description: nls_1.nls.localizeByDefault('The selection background color of the terminal.')
        });
        colors.register({
            id: 'terminal.inactiveSelectionBackground',
            defaults: {
                light: color_1.Color.transparent('terminal.selectionBackground', 0.5),
                dark: color_1.Color.transparent('terminal.selectionBackground', 0.5),
                hcDark: color_1.Color.transparent('terminal.selectionBackground', 0.7),
                hcLight: color_1.Color.transparent('terminal.selectionBackground', 0.5),
            },
            description: nls_1.nls.localizeByDefault('The selection background color of the terminal when it does not have focus.')
        });
        colors.register({
            id: 'terminal.selectionForeground',
            defaults: {
                light: undefined,
                dark: undefined,
                hcDark: '#000000',
                hcLight: '#ffffff'
            },
            // eslint-disable-next-line max-len
            description: nls_1.nls.localizeByDefault('The selection foreground color of the terminal. When this is null the selection foreground will be retained and have the minimum contrast ratio feature applied.')
        });
        colors.register({
            id: 'terminal.border',
            defaults: {
                light: 'panel.border',
                dark: 'panel.border',
                hcDark: 'panel.border',
                hcLight: 'panel.border'
            },
            description: nls_1.nls.localizeByDefault('The color of the border that separates split panes within the terminal. This defaults to panel.border.')
        });
        // eslint-disable-next-line guard-for-in
        for (const id in terminal_preferences_1.terminalAnsiColorMap) {
            const entry = terminal_preferences_1.terminalAnsiColorMap[id];
            const colorName = id.substring(13);
            colors.register({
                id,
                defaults: entry.defaults,
                description: nls_1.nls.localizeByDefault("'{0}' ANSI color in the terminal.", colorName)
            });
        }
    }
};
exports.TerminalFrontendContribution = TerminalFrontendContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ApplicationShell),
    tslib_1.__metadata("design:type", browser_1.ApplicationShell)
], TerminalFrontendContribution.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(shell_terminal_protocol_1.ShellTerminalServerProxy),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "shellTerminalServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.WidgetManager),
    tslib_1.__metadata("design:type", browser_1.WidgetManager)
], TerminalFrontendContribution.prototype, "widgetManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], TerminalFrontendContribution.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.SelectionService),
    tslib_1.__metadata("design:type", common_1.SelectionService)
], TerminalFrontendContribution.prototype, "selectionService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.LabelProvider),
    tslib_1.__metadata("design:type", browser_1.LabelProvider)
], TerminalFrontendContribution.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.QuickInputService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "quickInputService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.WorkspaceService),
    tslib_1.__metadata("design:type", browser_2.WorkspaceService)
], TerminalFrontendContribution.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(terminal_profile_service_1.TerminalProfileService),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "profileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(terminal_profile_service_1.UserTerminalProfileStore),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "userProfileStore", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(terminal_profile_service_1.ContributedTerminalProfileStore),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "contributedProfileStore", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(terminal_watcher_1.TerminalWatcher),
    tslib_1.__metadata("design:type", terminal_watcher_1.TerminalWatcher)
], TerminalFrontendContribution.prototype, "terminalWatcher", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_3.VariableResolverService),
    tslib_1.__metadata("design:type", browser_3.VariableResolverService)
], TerminalFrontendContribution.prototype, "variableResolver", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.StorageService),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "storageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(terminal_preferences_1.TerminalPreferences),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "terminalPreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(terminal_copy_on_selection_handler_1.TerminalCopyOnSelectionHandler),
    tslib_1.__metadata("design:type", terminal_copy_on_selection_handler_1.TerminalCopyOnSelectionHandler)
], TerminalFrontendContribution.prototype, "copyHandler", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(clipboard_service_1.ClipboardService),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "clipboardService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(terminal_creation_handler_1.TerminalCreationHandler),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "terminalCreationHandlers", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('terminal:TerminalFrontendContribution'),
    tslib_1.__metadata("design:type", Object)
], TerminalFrontendContribution.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], TerminalFrontendContribution.prototype, "init", null);
exports.TerminalFrontendContribution = TerminalFrontendContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TerminalFrontendContribution);
//# sourceMappingURL=terminal-frontend-contribution.js.map