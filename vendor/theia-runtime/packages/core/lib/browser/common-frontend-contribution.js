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
exports.CommonFrontendContribution = exports.CLASSNAME_OS_LINUX = exports.CLASSNAME_OS_WINDOWS = exports.CLASSNAME_OS_MAC = exports.RECENT_COMMANDS_STORAGE_KEY = exports.supportPaste = exports.supportCopy = exports.supportCut = exports.CommonCommands = exports.CommonMenus = void 0;
const tslib_1 = require("tslib");
/* eslint-disable max-len, @typescript-eslint/indent */
const debounce = require("lodash.debounce");
const inversify_1 = require("inversify");
const menu_1 = require("../common/menu");
const common_menus_1 = require("./common-menus");
Object.defineProperty(exports, "CommonMenus", { enumerable: true, get: function () { return common_menus_1.CommonMenus; } });
const command_1 = require("../common/command");
const common_commands_1 = require("./common-commands");
Object.defineProperty(exports, "CommonCommands", { enumerable: true, get: function () { return common_commands_1.CommonCommands; } });
const uri_command_handler_1 = require("../common/uri-command-handler");
const selection_service_1 = require("../common/selection-service");
const message_service_1 = require("../common/message-service");
const opener_service_1 = require("../browser/opener-service");
const application_shell_1 = require("./shell/application-shell");
const tab_bars_1 = require("./shell/tab-bars");
const about_dialog_1 = require("./about-dialog");
const uri_1 = require("../common/uri");
const context_key_service_1 = require("./context-key-service");
const os_1 = require("../common/os");
const resource_context_key_1 = require("./resource-context-key");
const selection_1 = require("../common/selection");
const storage_service_1 = require("./storage-service");
const navigatable_1 = require("./navigatable");
const quick_view_service_1 = require("./quick-input/quick-view-service");
const environment_1 = require("@theia/application-package/lib/environment");
const icon_theme_service_1 = require("./icon-theme-service");
const color_1 = require("../common/color");
const core_preferences_1 = require("../common/core-preferences");
const theming_1 = require("./theming");
const clipboard_service_1 = require("./clipboard-service");
const encoding_registry_1 = require("./encoding-registry");
const encodings_1 = require("../common/encodings");
const env_variables_1 = require("../common/env-variables");
const authentication_service_1 = require("./authentication-service");
const saveable_1 = require("./saveable");
const quick_input_1 = require("./quick-input");
const localization_1 = require("../common/i18n/localization");
const nls_1 = require("../common/nls");
const current_widget_command_adapter_1 = require("./shell/current-widget-command-adapter");
const dialogs_1 = require("./dialogs");
const window_service_1 = require("./window/window-service");
const secondary_window_service_1 = require("./window/secondary-window-service");
const frontend_application_config_provider_1 = require("./frontend-application-config-provider");
const decoration_style_1 = require("./decoration-style");
const widgets_1 = require("./widgets");
const saveable_service_1 = require("./saveable-service");
const user_working_directory_provider_1 = require("./user-working-directory-provider");
const common_1 = require("../common");
const language_quick_pick_service_1 = require("./i18n/language-quick-pick-service");
const undo_redo_handler_1 = require("./undo-redo-handler");
const promise_util_1 = require("../common/promise-util");
exports.supportCut = environment_1.environment.electron.is() || document.queryCommandSupported('cut');
exports.supportCopy = environment_1.environment.electron.is() || document.queryCommandSupported('copy');
// Browsers block programmatic paste (document.execCommand('paste') is a no-op and
// document.queryCommandSupported('paste') returns false), so supportPaste is effectively
// electron-only. Keeping it false in browsers is intentional: the ctrlcmd+v keybinding stays
// unregistered, so native paste events reach widget-level listeners (e.g. the navigator), and
// menu paste is handled by dedicated handlers using the async clipboard API.
exports.supportPaste = environment_1.environment.electron.is() || document.queryCommandSupported('paste');
exports.RECENT_COMMANDS_STORAGE_KEY = 'commands';
exports.CLASSNAME_OS_MAC = 'mac';
exports.CLASSNAME_OS_WINDOWS = 'windows';
exports.CLASSNAME_OS_LINUX = 'linux';
let CommonFrontendContribution = class CommonFrontendContribution {
    constructor(shell, selectionService, messageService, openerService, aboutDialog, localizationProvider, saveResourceService) {
        this.shell = shell;
        this.selectionService = selectionService;
        this.messageService = messageService;
        this.openerService = openerService;
        this.aboutDialog = aboutDialog;
        this.localizationProvider = localizationProvider;
        this.saveResourceService = saveResourceService;
        this.commonDecorationsStyleSheet = decoration_style_1.DecorationStyle.createStyleSheet('coreCommonDecorationsStyle');
        this.shouldPreventClose = false;
    }
    async configure(app) {
        // FIXME: This request blocks valuable startup time (~200ms).
        const configDirUri = await this.environments.getConfigDirUri();
        // Global settings
        this.encodingRegistry.registerOverride({
            encoding: encodings_1.UTF8,
            parent: new uri_1.default(configDirUri)
        });
        this.contextKeyService.createKey('isLinux', os_1.OS.type() === os_1.OS.Type.Linux);
        this.contextKeyService.createKey('isMac', os_1.OS.type() === os_1.OS.Type.OSX);
        this.contextKeyService.createKey('isWindows', os_1.OS.type() === os_1.OS.Type.Windows);
        this.contextKeyService.createKey('isWeb', !this.isElectron());
        // Note: the 'inputFocus' context key is tracked by Monaco's ContextKeyService
        // which sets it for <input>, <textarea>, and elements with EditContext (Monaco editors).
        // We no longer track it separately to avoid race conditions between two focusin listeners.
        this.pinnedKey = this.contextKeyService.createKey('activeEditorIsPinned', false);
        this.updatePinnedKey();
        this.shell.onDidChangeActiveWidget(() => this.updatePinnedKey());
        this.initResourceContextKeys();
        this.registerCtrlWHandling();
        this.setOsClass();
        this.updateStyles();
        this.preferences.ready.then(() => this.setSashProperties());
        this.preferences.onPreferenceChanged(e => this.handlePreferenceChange(e, app));
        app.shell.initialized.then(() => {
            app.shell.leftPanelHandler.addBottomMenu({
                id: 'settings-menu',
                iconClass: (0, widgets_1.codicon)('settings-gear'),
                title: nls_1.nls.localizeByDefault(common_commands_1.CommonCommands.MANAGE_CATEGORY),
                menuPath: menu_1.MANAGE_MENU,
                order: 0,
            });
            const accountsMenu = {
                id: 'accounts-menu',
                iconClass: (0, widgets_1.codicon)('account'),
                title: nls_1.nls.localizeByDefault('Accounts'),
                menuPath: menu_1.ACCOUNTS_MENU,
                order: 1,
                onDidBadgeChange: this.authenticationService.onDidUpdateSignInCount
            };
            this.authenticationService.onDidRegisterAuthenticationProvider(() => {
                app.shell.leftPanelHandler.addBottomMenu(accountsMenu);
            });
            this.authenticationService.onDidUnregisterAuthenticationProvider(() => {
                if (this.authenticationService.getProviderIds().length === 0) {
                    app.shell.leftPanelHandler.removeBottomMenu(accountsMenu.id);
                }
            });
        });
    }
    setOsClass() {
        const osClass = this.getOsClass();
        document.body.classList.add(osClass);
        // The OS class selects the platform-specific font stacks in os.css. Secondary windows
        // have their own document, so apply it there as well.
        this.secondaryWindowService.onWindowLoaded(win => win.document.body.classList.add(osClass));
    }
    getOsClass() {
        if (os_1.isOSX) {
            return exports.CLASSNAME_OS_MAC;
        }
        else if (os_1.isWindows) {
            return exports.CLASSNAME_OS_WINDOWS;
        }
        else {
            return exports.CLASSNAME_OS_LINUX;
        }
    }
    updateStyles() {
        document.body.classList.remove('theia-editor-highlightModifiedTabs');
        if (this.preferences['workbench.editor.highlightModifiedTabs']) {
            document.body.classList.add('theia-editor-highlightModifiedTabs');
        }
    }
    updatePinnedKey() {
        const activeTab = this.shell.findTabBar();
        const pinningTarget = activeTab && this.shell.findTitle(activeTab);
        const value = pinningTarget && (0, widgets_1.isPinned)(pinningTarget);
        this.pinnedKey.set(value);
    }
    handlePreferenceChange(e, app) {
        switch (e.preferenceName) {
            case 'workbench.editor.highlightModifiedTabs': {
                this.updateStyles();
                break;
            }
            case 'window.menuBarVisibility': {
                const menuBarVisibility = this.preferences['window.menuBarVisibility'];
                const mainMenuId = 'main-menu';
                if (menuBarVisibility === 'compact') {
                    this.shell.leftPanelHandler.addTopMenu({
                        id: mainMenuId,
                        iconClass: `theia-compact-menu ${(0, widgets_1.codicon)('menu')}`,
                        title: nls_1.nls.localizeByDefault('Application Menu'),
                        menuPath: menu_1.MAIN_MENU_BAR,
                        order: 0,
                    });
                }
                else {
                    app.shell.leftPanelHandler.removeTopMenu(mainMenuId);
                }
                break;
            }
            case 'workbench.sash.hoverDelay':
            case 'workbench.sash.size': {
                this.setSashProperties();
                break;
            }
        }
    }
    setSashProperties() {
        const sashRule = `:root {
            --theia-sash-hoverDelay: ${this.preferences['workbench.sash.hoverDelay']}ms;
            --theia-sash-width: ${this.preferences['workbench.sash.size']}px;
        }`;
        decoration_style_1.DecorationStyle.deleteStyleRule(':root', this.commonDecorationsStyleSheet);
        this.commonDecorationsStyleSheet.insertRule(sashRule);
    }
    onStart() {
        this.setupHtmlLanguageAttributes(document.documentElement);
        this.storageService.getData(exports.RECENT_COMMANDS_STORAGE_KEY, { recent: [] })
            .then(tasks => this.commandRegistry.recent = tasks.recent);
    }
    setupHtmlLanguageAttributes(element) {
        nls_1.nls.setHtmlLang(element);
        nls_1.nls.setHtmlNoTranslate(element);
    }
    onStop() {
        const recent = this.commandRegistry.recent;
        this.storageService.setData(exports.RECENT_COMMANDS_STORAGE_KEY, { recent });
        window.localStorage.setItem(icon_theme_service_1.IconThemeService.STORAGE_KEY, this.iconThemes.current);
        window.localStorage.setItem(theming_1.ThemeService.STORAGE_KEY, this.themeService.getCurrentTheme().id);
    }
    initResourceContextKeys() {
        const updateContextKeys = () => {
            const selection = this.selectionService.selection;
            const resourceUri = navigatable_1.Navigatable.is(selection) && selection.getResourceUri() || selection_1.UriSelection.getUri(selection);
            this.resourceContextKey.set(resourceUri);
        };
        updateContextKeys();
        this.selectionService.onSelectionChanged(updateContextKeys);
    }
    registerMenus(registry) {
        registry.registerSubmenu(common_menus_1.CommonMenus.FILE, nls_1.nls.localizeByDefault('File'));
        registry.registerSubmenu(common_menus_1.CommonMenus.EDIT, nls_1.nls.localizeByDefault('Edit'));
        registry.registerSubmenu(common_menus_1.CommonMenus.VIEW, nls_1.nls.localizeByDefault('View'));
        registry.registerSubmenu(common_menus_1.CommonMenus.HELP, nls_1.nls.localizeByDefault('Help'));
        // For plugins contributing create new file commands/menu-actions
        registry.registerSubmenu(common_menus_1.CommonMenus.FILE_NEW_CONTRIBUTIONS, nls_1.nls.localizeByDefault('New File...'));
        registry.registerMenuAction(common_menus_1.CommonMenus.FILE_SAVE, {
            commandId: common_commands_1.CommonCommands.SAVE.id
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.FILE_SAVE, {
            commandId: common_commands_1.CommonCommands.SAVE_ALL.id
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.FILE_AUTOSAVE, {
            commandId: common_commands_1.CommonCommands.AUTO_SAVE.id
        });
        registry.registerSubmenu(common_menus_1.CommonMenus.FILE_SETTINGS_SUBMENU, nls_1.nls.localizeByDefault(common_commands_1.CommonCommands.PREFERENCES_CATEGORY));
        registry.registerMenuAction(common_menus_1.CommonMenus.EDIT_UNDO, {
            commandId: common_commands_1.CommonCommands.UNDO.id,
            order: '0'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.EDIT_UNDO, {
            commandId: common_commands_1.CommonCommands.REDO.id,
            order: '1'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.EDIT_FIND, {
            commandId: common_commands_1.CommonCommands.FIND.id,
            order: '0'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.EDIT_FIND, {
            commandId: common_commands_1.CommonCommands.REPLACE.id,
            order: '1'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.EDIT_CLIPBOARD, {
            commandId: common_commands_1.CommonCommands.CUT.id,
            order: '0'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.EDIT_CLIPBOARD, {
            commandId: common_commands_1.CommonCommands.COPY.id,
            order: '1'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.EDIT_CLIPBOARD, {
            commandId: common_commands_1.CommonCommands.PASTE.id,
            order: '2'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.EDIT_CLIPBOARD, {
            commandId: common_commands_1.CommonCommands.COPY_PATH.id,
            order: '3'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.VIEW_APPEARANCE_SUBMENU_BAR, {
            commandId: common_commands_1.CommonCommands.TOGGLE_BOTTOM_PANEL.id,
            order: '1'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.VIEW_APPEARANCE_SUBMENU_BAR, {
            commandId: common_commands_1.CommonCommands.TOGGLE_STATUS_BAR.id,
            order: '2',
            label: nls_1.nls.localizeByDefault('Toggle Status Bar Visibility')
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.VIEW_APPEARANCE_SUBMENU_BAR, {
            commandId: common_commands_1.CommonCommands.COLLAPSE_ALL_PANELS.id,
            order: '3'
        });
        registry.registerMenuAction(tab_bars_1.SHELL_TABBAR_CONTEXT_CLOSE, {
            commandId: common_commands_1.CommonCommands.CLOSE_TAB.id,
            label: nls_1.nls.localizeByDefault('Close'),
            order: '0'
        });
        registry.registerMenuAction(tab_bars_1.SHELL_TABBAR_CONTEXT_CLOSE, {
            commandId: common_commands_1.CommonCommands.CLOSE_OTHER_TABS.id,
            label: nls_1.nls.localizeByDefault('Close Others'),
            order: '1'
        });
        registry.registerMenuAction(tab_bars_1.SHELL_TABBAR_CONTEXT_CLOSE, {
            commandId: common_commands_1.CommonCommands.CLOSE_RIGHT_TABS.id,
            label: nls_1.nls.localizeByDefault('Close to the Right'),
            order: '2'
        });
        registry.registerMenuAction(tab_bars_1.SHELL_TABBAR_CONTEXT_CLOSE, {
            commandId: common_commands_1.CommonCommands.CLOSE_SAVED_TABS.id,
            label: nls_1.nls.localizeByDefault('Close Saved'),
            order: '3',
        });
        registry.registerMenuAction(tab_bars_1.SHELL_TABBAR_CONTEXT_CLOSE, {
            commandId: common_commands_1.CommonCommands.CLOSE_ALL_TABS.id,
            label: nls_1.nls.localizeByDefault('Close All'),
            order: '4'
        });
        registry.registerMenuAction(tab_bars_1.SHELL_TABBAR_CONTEXT_SPLIT, {
            commandId: common_commands_1.CommonCommands.COLLAPSE_PANEL.id,
            label: common_commands_1.CommonCommands.COLLAPSE_PANEL.label,
            order: '5'
        });
        registry.registerMenuAction(tab_bars_1.SHELL_TABBAR_CONTEXT_SPLIT, {
            commandId: common_commands_1.CommonCommands.TOGGLE_MAXIMIZED.id,
            label: common_commands_1.CommonCommands.TOGGLE_MAXIMIZED.label,
            order: '6'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.VIEW_APPEARANCE_SUBMENU_SCREEN, {
            commandId: common_commands_1.CommonCommands.TOGGLE_MAXIMIZED.id,
            label: common_commands_1.CommonCommands.TOGGLE_MAXIMIZED.label,
            order: '6'
        });
        registry.registerMenuAction(tab_bars_1.SHELL_TABBAR_CONTEXT_COPY, {
            commandId: common_commands_1.CommonCommands.COPY_PATH.id,
            label: common_commands_1.CommonCommands.COPY_PATH.label,
            order: '1',
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.VIEW_APPEARANCE_SUBMENU_BAR, {
            commandId: common_commands_1.CommonCommands.SHOW_MENU_BAR.id,
            label: nls_1.nls.localizeByDefault('Toggle Menu Bar'),
            order: '0'
        });
        registry.registerMenuAction(tab_bars_1.SHELL_TABBAR_CONTEXT_PIN, {
            commandId: common_commands_1.CommonCommands.PIN_TAB.id,
            label: nls_1.nls.localizeByDefault('Pin'),
            order: '7'
        });
        registry.registerMenuAction(tab_bars_1.SHELL_TABBAR_CONTEXT_PIN, {
            commandId: common_commands_1.CommonCommands.UNPIN_TAB.id,
            label: nls_1.nls.localizeByDefault('Unpin'),
            order: '8'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.HELP, {
            commandId: common_commands_1.CommonCommands.ABOUT_COMMAND.id,
            label: common_commands_1.CommonCommands.ABOUT_COMMAND.label,
            order: '9'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.VIEW_PRIMARY, {
            commandId: common_commands_1.CommonCommands.OPEN_VIEW.id
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.FILE_SETTINGS_SUBMENU_THEME, {
            commandId: common_commands_1.CommonCommands.SELECT_COLOR_THEME.id
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.FILE_SETTINGS_SUBMENU_THEME, {
            commandId: common_commands_1.CommonCommands.SELECT_ICON_THEME.id
        });
        registry.registerSubmenu(common_menus_1.CommonMenus.MANAGE_SETTINGS_THEMES, nls_1.nls.localizeByDefault('Themes'), { sortString: 'a50' });
        registry.registerMenuAction(common_menus_1.CommonMenus.MANAGE_SETTINGS_THEMES, {
            commandId: common_commands_1.CommonCommands.SELECT_COLOR_THEME.id,
            order: '0'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.MANAGE_SETTINGS_THEMES, {
            commandId: common_commands_1.CommonCommands.SELECT_ICON_THEME.id,
            order: '1'
        });
        registry.registerSubmenu(common_menus_1.CommonMenus.VIEW_APPEARANCE_SUBMENU, nls_1.nls.localizeByDefault('Appearance'));
        registry.registerMenuAction(common_menus_1.CommonMenus.FILE_NEW_TEXT, {
            commandId: common_commands_1.CommonCommands.NEW_UNTITLED_TEXT_FILE.id,
            label: nls_1.nls.localizeByDefault('New Text File'),
            order: 'a'
        });
        registry.registerMenuAction(common_menus_1.CommonMenus.FILE_NEW_TEXT, {
            commandId: common_commands_1.CommonCommands.PICK_NEW_FILE.id,
            label: nls_1.nls.localizeByDefault('New File...'),
            order: 'a1'
        });
    }
    registerCommands(commandRegistry) {
        commandRegistry.registerCommand(common_commands_1.CommonCommands.OPEN, uri_command_handler_1.UriAwareCommandHandler.MultiSelect(this.selectionService, {
            execute: uris => uris.map(uri => (0, opener_service_1.open)(this.openerService, uri)),
        }));
        commandRegistry.registerCommand(common_commands_1.CommonCommands.CUT, {
            execute: () => {
                if (exports.supportCut) {
                    const active = document.activeElement;
                    if (environment_1.environment.electron.is() && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
                        const start = active.selectionStart ?? 0;
                        const end = active.selectionEnd ?? 0;
                        const selectedText = active.value.substring(start, end);
                        if (selectedText) {
                            this.clipboardService.writeText(selectedText);
                            document.execCommand('insertText', false, '');
                        }
                    }
                    else {
                        document.execCommand('cut');
                    }
                }
                else {
                    this.messageService.warn(nls_1.nls.localize('theia/core/cutWarn', "Please use the browser's cut command or shortcut."));
                }
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.COPY, {
            execute: () => {
                if (exports.supportCopy) {
                    const active = document.activeElement;
                    if (environment_1.environment.electron.is() && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
                        const start = active.selectionStart ?? 0;
                        const end = active.selectionEnd ?? 0;
                        const selectedText = active.value.substring(start, end);
                        if (selectedText) {
                            this.clipboardService.writeText(selectedText);
                        }
                    }
                    else {
                        document.execCommand('copy');
                    }
                }
                else {
                    this.messageService.warn(nls_1.nls.localize('theia/core/copyWarn', "Please use the browser's copy command or shortcut."));
                }
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.PASTE, {
            execute: async () => {
                if (exports.supportPaste) {
                    const active = document.activeElement;
                    if (environment_1.environment.electron.is() && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
                        const text = await this.clipboardService.readText();
                        if (text) {
                            document.execCommand('insertText', false, text);
                        }
                    }
                    else {
                        document.execCommand('paste');
                    }
                }
                else {
                    this.messageService.warn(nls_1.nls.localize('theia/core/pasteWarn', "Please use the browser's paste command or shortcut."));
                }
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.COPY_PATH, uri_command_handler_1.UriAwareCommandHandler.MultiSelect(this.selectionService, {
            isVisible: uris => Array.isArray(uris) && uris.some(uri => uri instanceof uri_1.default),
            isEnabled: uris => Array.isArray(uris) && uris.some(uri => uri instanceof uri_1.default),
            execute: async (uris) => {
                if (uris.length) {
                    const lineDelimiter = os_1.EOL;
                    const text = uris.map(resource => resource.path.fsPath()).join(lineDelimiter);
                    await this.clipboardService.writeText(text);
                }
                else {
                    await this.messageService.info(nls_1.nls.localize('theia/core/copyInfo', 'Open a file first to copy its path'));
                }
            }
        }));
        commandRegistry.registerCommand(common_commands_1.CommonCommands.UNDO, {
            execute: () => {
                this.undoRedoHandlerService.undo();
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.REDO, {
            execute: () => {
                this.undoRedoHandlerService.redo();
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.SELECT_ALL, {
            execute: () => document.execCommand('selectAll')
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.FIND, {
            execute: () => { }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.REPLACE, {
            execute: () => { }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.NEXT_TAB, {
            isEnabled: () => this.shell.currentTabBar !== undefined,
            execute: () => this.shell.activateNextTab()
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.PREVIOUS_TAB, {
            isEnabled: () => this.shell.currentTabBar !== undefined,
            execute: () => this.shell.activatePreviousTab()
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.NEXT_TAB_IN_GROUP, {
            isEnabled: () => this.shell.nextTabIndexInTabBar() !== -1,
            execute: () => this.shell.activateNextTabInTabBar()
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.PREVIOUS_TAB_IN_GROUP, {
            isEnabled: () => this.shell.previousTabIndexInTabBar() !== -1,
            execute: () => this.shell.activatePreviousTabInTabBar()
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.NEXT_TAB_GROUP, {
            isEnabled: () => this.shell.nextTabBar() !== undefined,
            execute: () => this.shell.activateNextTabBar()
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.PREVIOUS_TAB_GROUP, {
            isEnabled: () => this.shell.previousTabBar() !== undefined,
            execute: () => this.shell.activatePreviousTabBar()
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.CLOSE_TAB, new current_widget_command_adapter_1.CurrentWidgetCommandAdapter(this.shell, {
            isEnabled: title => Boolean(title?.closable),
            execute: (title, tabBar) => tabBar && this.shell.closeTabs(tabBar, candidate => candidate === title),
        }));
        commandRegistry.registerCommand(common_commands_1.CommonCommands.CLOSE_OTHER_TABS, new current_widget_command_adapter_1.CurrentWidgetCommandAdapter(this.shell, {
            isEnabled: (title, tabbar) => Boolean(tabbar?.titles.some(candidate => candidate !== title && candidate.closable)),
            execute: (title, tabbar) => tabbar && this.shell.closeTabs(tabbar, candidate => candidate !== title && candidate.closable),
        }));
        commandRegistry.registerCommand(common_commands_1.CommonCommands.CLOSE_SAVED_TABS, new current_widget_command_adapter_1.CurrentWidgetCommandAdapter(this.shell, {
            isEnabled: (_title, tabbar) => Boolean(tabbar?.titles.some(candidate => candidate.closable && !saveable_1.Saveable.isDirty(candidate.owner))),
            execute: (_title, tabbar) => tabbar && this.shell.closeTabs(tabbar, candidate => candidate.closable && !saveable_1.Saveable.isDirty(candidate.owner)),
        }));
        commandRegistry.registerCommand(common_commands_1.CommonCommands.CLOSE_RIGHT_TABS, new current_widget_command_adapter_1.CurrentWidgetCommandAdapter(this.shell, {
            isEnabled: (title, tabbar) => {
                let targetSeen = false;
                return Boolean(tabbar?.titles.some(candidate => {
                    if (targetSeen && candidate.closable) {
                        return true;
                    }
                    ;
                    if (candidate === title) {
                        targetSeen = true;
                    }
                    ;
                }));
            },
            isVisible: (_title, tabbar) => {
                const area = (tabbar && this.shell.getAreaFor(tabbar)) ?? this.shell.currentTabArea;
                return area !== undefined && area !== 'left' && area !== 'right';
            },
            execute: (title, tabbar) => {
                if (tabbar) {
                    let targetSeen = false;
                    this.shell.closeTabs(tabbar, candidate => {
                        if (targetSeen && candidate.closable) {
                            return true;
                        }
                        ;
                        if (candidate === title) {
                            targetSeen = true;
                        }
                        ;
                        return false;
                    });
                }
            }
        }));
        commandRegistry.registerCommand(common_commands_1.CommonCommands.CLOSE_ALL_TABS, new current_widget_command_adapter_1.CurrentWidgetCommandAdapter(this.shell, {
            isEnabled: (_title, tabbar) => Boolean(tabbar?.titles.some(title => title.closable)),
            execute: (_title, tabbar) => tabbar && this.shell.closeTabs(tabbar, candidate => candidate.closable),
        }));
        commandRegistry.registerCommand(common_commands_1.CommonCommands.CLOSE_MAIN_TAB, {
            isEnabled: () => {
                const currentWidget = this.shell.getCurrentWidget('main');
                return currentWidget !== undefined && currentWidget.title.closable;
            },
            execute: () => this.shell.getCurrentWidget('main').close()
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.CLOSE_OTHER_MAIN_TABS, {
            isEnabled: () => {
                const currentWidget = this.shell.getCurrentWidget('main');
                return currentWidget !== undefined &&
                    this.shell.mainAreaTabBars.some(tb => tb.titles.some(title => title.owner !== currentWidget && title.closable));
            },
            execute: () => {
                const currentWidget = this.shell.getCurrentWidget('main');
                this.shell.closeTabs('main', title => title.owner !== currentWidget && title.closable);
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.CLOSE_ALL_MAIN_TABS, {
            isEnabled: () => this.shell.mainAreaTabBars.some(tb => tb.titles.some(title => title.closable)),
            execute: () => this.shell.closeTabs('main', title => title.closable)
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.COLLAPSE_PANEL, new current_widget_command_adapter_1.CurrentWidgetCommandAdapter(this.shell, {
            isEnabled: (_title, tabbar) => {
                if (tabbar) {
                    const area = this.shell.getAreaFor(tabbar);
                    return application_shell_1.ApplicationShell.isSideArea(area) && this.shell.isExpanded(area);
                }
                return false;
            },
            isVisible: (_title, tabbar) => Boolean(tabbar && application_shell_1.ApplicationShell.isSideArea(this.shell.getAreaFor(tabbar))),
            execute: (_title, tabbar) => tabbar && this.shell.collapsePanel(this.shell.getAreaFor(tabbar))
        }));
        commandRegistry.registerCommand(common_commands_1.CommonCommands.COLLAPSE_ALL_PANELS, {
            execute: () => {
                this.shell.collapsePanel('left');
                this.shell.collapsePanel('right');
                this.shell.collapsePanel('bottom');
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.TOGGLE_BOTTOM_PANEL, {
            execute: () => {
                if (this.shell.isExpanded('bottom')) {
                    this.shell.collapsePanel('bottom');
                }
                else {
                    this.shell.expandPanel('bottom');
                }
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.TOGGLE_LEFT_PANEL, {
            isEnabled: () => this.shell.getWidgets('left').length > 0,
            execute: () => {
                if (this.shell.isExpanded('left')) {
                    this.shell.collapsePanel('left');
                }
                else {
                    this.shell.expandPanel('left');
                }
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.TOGGLE_RIGHT_PANEL, {
            isEnabled: () => this.shell.getWidgets('right').length > 0,
            execute: () => {
                if (this.shell.isExpanded('right')) {
                    this.shell.collapsePanel('right');
                }
                else {
                    this.shell.expandPanel('right');
                }
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.TOGGLE_STATUS_BAR, {
            execute: () => this.preferenceService.updateValue('workbench.statusBar.visible', !this.preferences['workbench.statusBar.visible'])
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.TOGGLE_MAXIMIZED, new current_widget_command_adapter_1.CurrentWidgetCommandAdapter(this.shell, {
            isEnabled: title => Boolean(title?.owner && this.shell.canToggleMaximized(title?.owner)),
            isVisible: title => Boolean(title?.owner && this.shell.canToggleMaximized(title?.owner)),
            execute: title => title?.owner && this.shell.toggleMaximized(title?.owner),
        }));
        commandRegistry.registerCommand(common_commands_1.CommonCommands.SHOW_MENU_BAR, {
            isEnabled: () => !this.isElectron() || !os_1.isOSX,
            isVisible: () => !this.isElectron() || !os_1.isOSX,
            execute: () => {
                const menuBarVisibility = 'window.menuBarVisibility';
                const visibility = this.preferences[menuBarVisibility];
                if (visibility !== 'compact') {
                    this.preferenceService.updateValue(menuBarVisibility, 'compact');
                }
                else {
                    this.preferenceService.updateValue(menuBarVisibility, 'classic');
                }
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.SAVE, {
            execute: () => this.save({ formatType: 1 /* FormatType.ON */ })
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.SAVE_AS, {
            isEnabled: () => this.saveResourceService.canSaveAs(this.shell.currentWidget),
            execute: () => {
                const { currentWidget } = this.shell;
                // No clue what could have happened between `isEnabled` and `execute`
                // when fetching currentWidget, so better to double-check:
                if (this.saveResourceService.canSaveAs(currentWidget)) {
                    this.saveResourceService.saveAs(currentWidget);
                }
                else {
                    this.messageService.error(nls_1.nls.localize('theia/workspace/failSaveAs', 'Cannot run "{0}" for the current widget.', common_commands_1.CommonCommands.SAVE_AS.label));
                }
            },
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.SAVE_WITHOUT_FORMATTING, {
            execute: () => this.save({ formatType: 2 /* FormatType.OFF */ })
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.SAVE_ALL, {
            execute: () => this.shell.saveAll({ formatType: 3 /* FormatType.DIRTY */ })
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.ABOUT_COMMAND, {
            execute: () => this.openAbout()
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.OPEN_VIEW, {
            execute: () => this.quickInputService?.open(quick_view_service_1.QuickViewService.PREFIX)
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.SELECT_COLOR_THEME, {
            execute: () => this.selectColorTheme()
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.SELECT_ICON_THEME, {
            execute: () => this.selectIconTheme()
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.PIN_TAB, new current_widget_command_adapter_1.CurrentWidgetCommandAdapter(this.shell, {
            isEnabled: title => Boolean(title && !(0, widgets_1.isPinned)(title)),
            execute: title => this.togglePinned(title),
        }));
        commandRegistry.registerCommand(common_commands_1.CommonCommands.UNPIN_TAB, new current_widget_command_adapter_1.CurrentWidgetCommandAdapter(this.shell, {
            isEnabled: title => Boolean(title && (0, widgets_1.isPinned)(title)),
            execute: title => this.togglePinned(title),
        }));
        commandRegistry.registerCommand(common_commands_1.CommonCommands.CONFIGURE_DISPLAY_LANGUAGE, {
            execute: () => this.configureDisplayLanguage()
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.TOGGLE_BREADCRUMBS, {
            execute: () => this.toggleBreadcrumbs(),
            isToggled: () => this.isBreadcrumbsEnabled(),
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.NEW_UNTITLED_TEXT_FILE, {
            execute: async () => {
                const untitledUri = this.untitledResourceResolver.createUntitledURI('', await this.workingDirProvider.getUserWorkingDir());
                this.untitledResourceResolver.resolve(untitledUri);
                const editor = await (0, opener_service_1.open)(this.openerService, untitledUri);
                // Wait for all of the listeners of the `onDidOpen` event to be notified
                await (0, promise_util_1.timeout)(50);
                // Afterwards, we can return from the command with the newly created editor
                // If we don't wait, we return from the command before the plugin API has been notified of the new editor
                return editor;
            }
        });
        commandRegistry.registerCommand(common_commands_1.CommonCommands.PICK_NEW_FILE, {
            execute: async () => this.showNewFilePicker()
        });
        for (const [index, ordinal] of this.getOrdinalNumbers().entries()) {
            commandRegistry.registerCommand({ id: `workbench.action.focus${ordinal}EditorGroup`, label: index === 0 ? nls_1.nls.localizeByDefault('Focus First Editor Group') : '', category: nls_1.nls.localize(common_commands_1.CommonCommands.VIEW_CATEGORY_KEY, common_commands_1.CommonCommands.VIEW_CATEGORY) }, {
                isEnabled: () => this.shell.mainAreaTabBars.length > index,
                execute: () => {
                    const widget = this.shell.mainAreaTabBars[index]?.currentTitle?.owner;
                    if (widget) {
                        this.shell.activateWidget(widget.id);
                    }
                }
            });
        }
    }
    getOrdinalNumbers() {
        return ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth'];
    }
    isElectron() {
        return environment_1.environment.electron.is();
    }
    togglePinned(title) {
        if (title) {
            (0, widgets_1.togglePinned)(title);
            this.updatePinnedKey();
        }
    }
    registerKeybindings(registry) {
        if (exports.supportCut) {
            registry.registerKeybinding({
                command: common_commands_1.CommonCommands.CUT.id,
                keybinding: 'ctrlcmd+x'
            });
        }
        if (exports.supportCopy) {
            registry.registerKeybinding({
                command: common_commands_1.CommonCommands.COPY.id,
                keybinding: 'ctrlcmd+c'
            });
        }
        if (exports.supportPaste) {
            registry.registerKeybinding({
                command: common_commands_1.CommonCommands.PASTE.id,
                keybinding: 'ctrlcmd+v'
            });
        }
        registry.registerKeybinding({
            command: common_commands_1.CommonCommands.COPY_PATH.id,
            keybinding: os_1.isWindows ? 'shift+alt+c' : 'ctrlcmd+alt+c',
            when: '!editorFocus'
        });
        registry.registerKeybindings(
        // Edition
        {
            command: common_commands_1.CommonCommands.UNDO.id,
            keybinding: 'ctrlcmd+z'
        }, {
            command: common_commands_1.CommonCommands.REDO.id,
            keybinding: os_1.isOSX ? 'ctrlcmd+shift+z' : 'ctrlcmd+y'
        }, {
            command: common_commands_1.CommonCommands.SELECT_ALL.id,
            keybinding: 'ctrlcmd+a'
        }, {
            command: common_commands_1.CommonCommands.FIND.id,
            keybinding: 'ctrlcmd+f'
        }, {
            command: common_commands_1.CommonCommands.REPLACE.id,
            keybinding: 'ctrlcmd+alt+f'
        }, 
        // Tabs
        {
            command: common_commands_1.CommonCommands.NEXT_TAB.id,
            keybinding: 'ctrl+tab'
        }, {
            command: common_commands_1.CommonCommands.NEXT_TAB.id,
            keybinding: 'ctrlcmd+alt+d'
        }, {
            command: common_commands_1.CommonCommands.PREVIOUS_TAB.id,
            keybinding: 'ctrl+shift+tab'
        }, {
            command: common_commands_1.CommonCommands.PREVIOUS_TAB.id,
            keybinding: 'ctrlcmd+alt+a'
        }, {
            command: common_commands_1.CommonCommands.CLOSE_MAIN_TAB.id,
            keybinding: this.isElectron() ? (os_1.isWindows ? 'ctrl+f4' : 'ctrlcmd+w') : 'alt+w'
        }, {
            command: common_commands_1.CommonCommands.CLOSE_OTHER_MAIN_TABS.id,
            keybinding: 'ctrlcmd+alt+t'
        }, {
            command: common_commands_1.CommonCommands.CLOSE_ALL_MAIN_TABS.id,
            keybinding: this.isElectron() ? 'ctrlCmd+k ctrlCmd+w' : 'alt+shift+w'
        }, 
        // Panels
        {
            command: common_commands_1.CommonCommands.COLLAPSE_PANEL.id,
            keybinding: 'alt+c'
        }, {
            command: common_commands_1.CommonCommands.TOGGLE_BOTTOM_PANEL.id,
            keybinding: 'ctrlcmd+j',
        }, {
            command: common_commands_1.CommonCommands.COLLAPSE_ALL_PANELS.id,
            keybinding: 'alt+shift+c',
        }, {
            command: common_commands_1.CommonCommands.TOGGLE_MAXIMIZED.id,
            keybinding: 'alt+m',
        }, 
        // Saving
        {
            command: common_commands_1.CommonCommands.SAVE.id,
            keybinding: 'ctrlcmd+s'
        }, {
            command: common_commands_1.CommonCommands.SAVE_WITHOUT_FORMATTING.id,
            keybinding: 'ctrlcmd+k s'
        }, {
            command: common_commands_1.CommonCommands.SAVE_ALL.id,
            keybinding: 'ctrlcmd+alt+s'
        }, 
        // Theming
        {
            command: common_commands_1.CommonCommands.SELECT_COLOR_THEME.id,
            keybinding: 'ctrlcmd+k ctrlcmd+t'
        }, {
            command: common_commands_1.CommonCommands.PIN_TAB.id,
            keybinding: 'ctrlcmd+k shift+enter',
            when: '!activeEditorIsPinned'
        }, {
            command: common_commands_1.CommonCommands.UNPIN_TAB.id,
            keybinding: 'ctrlcmd+k shift+enter',
            when: 'activeEditorIsPinned'
        }, {
            command: common_commands_1.CommonCommands.NEW_UNTITLED_TEXT_FILE.id,
            keybinding: this.isElectron() ? 'ctrlcmd+n' : 'alt+n',
        }, {
            command: common_commands_1.CommonCommands.PICK_NEW_FILE.id,
            keybinding: 'ctrlcmd+alt+n'
        });
        for (const [index, ordinal] of this.getOrdinalNumbers().entries()) {
            registry.registerKeybinding({
                command: `workbench.action.focus${ordinal}EditorGroup`,
                keybinding: `ctrlcmd+${(index + 1) % 10}`,
            });
        }
    }
    async save(options) {
        const widget = this.shell.currentWidget;
        this.saveResourceService.save(widget, options);
    }
    async openAbout() {
        this.aboutDialog.open(false);
    }
    /**
     * registers event listener which make sure that
     * window doesn't get closed if CMD/CTRL W is pressed.
     * Too many users have that in their muscle memory.
     * Chrome doesn't let us rebind or prevent default the keybinding, so this
     * at least doesn't close the window immediately.
     */
    registerCtrlWHandling() {
        function isCtrlCmd(event) {
            return (os_1.isOSX && event.metaKey) || (!os_1.isOSX && event.ctrlKey);
        }
        window.document.addEventListener('keydown', event => {
            this.shouldPreventClose = isCtrlCmd(event) && event.code === 'KeyW';
        });
        window.document.addEventListener('keyup', () => {
            this.shouldPreventClose = false;
        });
    }
    onWillStop() {
        if (this.shouldPreventClose || this.shell.canSaveAll()) {
            return {
                reason: 'Dirty editors present',
                action: async () => {
                    const captionsToSave = this.unsavedTabsCaptions();
                    const untitledCaptionsToSave = this.unsavedUntitledTabsCaptions();
                    const shouldExit = await this.confirmExitWithOrWithoutSaving(captionsToSave, async () => {
                        await this.saveDirty(untitledCaptionsToSave);
                        await this.shell.saveAll();
                    });
                    const allSavedOrDoNotSave = (shouldExit === true && untitledCaptionsToSave.length === 0 // Should save and cancel if any captions failed to save
                    ) || shouldExit === false; // Do not save
                    this.shouldPreventClose = !allSavedOrDoNotSave;
                    return allSavedOrDoNotSave;
                }
            };
        }
    }
    // Asks the user to confirm whether they want to exit with or without saving the changes
    async confirmExitWithOrWithoutSaving(captionsToSave, performSave) {
        const div = document.createElement('div');
        div.innerText = nls_1.nls.localizeByDefault("Your changes will be lost if you don't save them.");
        let result;
        if (captionsToSave.length > 0) {
            const span = document.createElement('span');
            span.appendChild(document.createElement('br'));
            captionsToSave.forEach(cap => {
                const b = document.createElement('b');
                b.innerText = cap;
                span.appendChild(b);
                span.appendChild(document.createElement('br'));
            });
            span.appendChild(document.createElement('br'));
            div.appendChild(span);
            result = await new dialogs_1.ConfirmSaveDialog({
                title: nls_1.nls.localizeByDefault('Do you want to save the changes to the following {0} files?', captionsToSave.length),
                msg: div,
                dontSave: nls_1.nls.localizeByDefault("Don't Save"),
                save: nls_1.nls.localizeByDefault('Save All'),
                cancel: dialogs_1.Dialog.CANCEL
            }).open();
            if (result) {
                await performSave();
            }
        }
        else {
            // fallback if not passed with an empty caption-list.
            result = (0, dialogs_1.confirmExit)();
        }
        if (result !== undefined) {
            return result === true;
        }
        else {
            return undefined;
        }
        ;
    }
    unsavedTabsCaptions() {
        return this.shell.widgets
            .filter(widget => this.saveResourceService.canSave(widget))
            .map(widget => widget.title.label);
    }
    unsavedUntitledTabsCaptions() {
        return this.shell.widgets.filter(widget => navigatable_1.NavigatableWidget.getUri(widget)?.scheme === common_1.UNTITLED_SCHEME && this.saveResourceService.canSaveAs(widget));
    }
    async configureDisplayLanguage() {
        const languageInfo = await this.languageQuickPickService.pickDisplayLanguage();
        if (languageInfo && !nls_1.nls.isSelectedLocale(languageInfo.languageId) && await this.confirmRestart(languageInfo.localizedLanguageName ?? languageInfo.languageName ?? languageInfo.languageId)) {
            nls_1.nls.setLocale(languageInfo.languageId);
            this.windowService.setSafeToShutDown();
            this.windowService.reload();
        }
    }
    /**
     * saves any dirty widget in toSave
     * side effect - will pop all widgets from toSave that was saved
     * @param toSave
     */
    async saveDirty(toSave) {
        for (const widget of toSave) {
            const saveable = saveable_1.Saveable.get(widget);
            if (saveable?.dirty) {
                await this.saveResourceService.save(widget);
                if (!this.saveResourceService.canSave(widget)) {
                    toSave.pop();
                }
            }
        }
    }
    toggleBreadcrumbs() {
        const value = this.preferenceService.get('breadcrumbs.enabled');
        this.preferenceService.set('breadcrumbs.enabled', !value, common_1.PreferenceScope.User);
    }
    isBreadcrumbsEnabled() {
        return !!this.preferenceService.get('breadcrumbs.enabled');
    }
    async confirmRestart(languageName) {
        const appName = frontend_application_config_provider_1.FrontendApplicationConfigProvider.get().applicationName;
        const shouldRestart = await new dialogs_1.ConfirmDialog({
            title: nls_1.nls.localizeByDefault('Restart {0} to switch to {1}?', appName, languageName),
            msg: nls_1.nls.localizeByDefault('To change the display language to {0}, {1} needs to restart.', languageName, appName),
            ok: nls_1.nls.localizeByDefault('Restart'),
            cancel: dialogs_1.Dialog.CANCEL,
        }).open();
        return shouldRestart === true;
    }
    selectIconTheme() {
        let resetTo = this.iconThemes.getCurrent();
        const setTheme = (id, persist) => {
            const theme = this.iconThemes.getDefinition(id);
            if (theme) {
                this.iconThemes.setCurrent(theme, persist);
            }
        };
        const previewTheme = debounce(setTheme, 200);
        let items = [];
        for (const iconTheme of this.iconThemes.definitions) {
            items.push({
                id: iconTheme.id,
                label: iconTheme.label,
                description: iconTheme.description,
            });
        }
        items = items.sort((a, b) => {
            if (a.id === 'none') {
                return -1;
            }
            return a.label.localeCompare(b.label);
        });
        this.quickInputService?.showQuickPick(items, {
            placeholder: nls_1.nls.localizeByDefault('Select File Icon Theme'),
            activeItem: items.find(item => item.id === resetTo?.id),
            onDidChangeSelection: (_, selectedItems) => {
                resetTo = undefined;
                setTheme(selectedItems[0].id, true);
            },
            onDidChangeActive: (_, activeItems) => {
                previewTheme(activeItems[0].id, false);
            },
            onDidHide: () => {
                if (resetTo) {
                    this.iconThemes.setCurrent(resetTo, false);
                }
            }
        });
    }
    selectColorTheme() {
        let resetTo = this.themeService.getCurrentTheme().id;
        const setTheme = (id, persist) => this.themeService.setCurrentTheme(id, persist);
        const previewTheme = debounce(setTheme, 200);
        const itemsByTheme = { light: [], dark: [], hc: [], hcLight: [] };
        const lightThemesSeparator = nls_1.nls.localizeByDefault('light themes');
        const darkThemesSeparator = nls_1.nls.localizeByDefault('dark themes');
        const highContrastThemesSeparator = nls_1.nls.localizeByDefault('high contrast themes');
        for (const theme of this.themeService.getThemes().sort((a, b) => a.label.localeCompare(b.label))) {
            const themeItems = itemsByTheme[theme.type];
            // Add a separator for the first item in the respective group.
            // High Contrast Themes despite dark or light should be grouped together.
            if (themeItems.length === 0 && theme.type !== 'hcLight') {
                let label = '';
                if (theme.type === 'light') {
                    label = lightThemesSeparator;
                }
                else if (theme.type === 'dark') {
                    label = darkThemesSeparator;
                }
                else {
                    label = highContrastThemesSeparator;
                }
                themeItems.push({
                    type: 'separator',
                    label
                });
            }
            themeItems.push({
                id: theme.id,
                label: theme.label,
                description: theme.description,
            });
        }
        const items = [...itemsByTheme.light, ...itemsByTheme.dark, ...itemsByTheme.hc, ...itemsByTheme.hcLight];
        this.quickInputService?.showQuickPick(items, {
            placeholder: nls_1.nls.localizeByDefault('Select Color Theme'),
            activeItem: items.find(item => item.id === resetTo),
            onDidChangeSelection: (_, selectedItems) => {
                resetTo = undefined;
                setTheme(selectedItems[0].id, true);
            },
            onDidChangeActive: (_, activeItems) => {
                previewTheme(activeItems[0].id, false);
            },
            onDidHide: () => {
                if (resetTo) {
                    setTheme(resetTo, false);
                }
            }
        });
    }
    /**
     * @todo https://github.com/eclipse-theia/theia/issues/12824
     */
    async showNewFilePicker() {
        const newFileContributions = this.menuRegistry.getMenuNode(common_menus_1.CommonMenus.FILE_NEW_CONTRIBUTIONS); // Add menus
        const items = [
            {
                label: nls_1.nls.localizeByDefault('New Text File'),
                description: nls_1.nls.localizeByDefault('Built-in'),
                execute: async () => this.commandRegistry.executeCommand(common_commands_1.CommonCommands.NEW_UNTITLED_TEXT_FILE.id)
            },
            ...newFileContributions.children
                .flatMap(node => {
                if (menu_1.CompoundMenuNode.is(node) && node.children.length > 0) {
                    return node.children;
                }
                return node;
            })
                .filter(node => menu_1.Group.is(node) || menu_1.CommandMenu.is(node))
                .map(node => {
                if (menu_1.Group.is(node)) {
                    return { type: 'separator' };
                }
                else {
                    const item = node;
                    return {
                        label: item.label,
                        execute: () => item.run(common_menus_1.CommonMenus.FILE_NEW_CONTRIBUTIONS)
                    };
                }
            })
        ];
        const CREATE_NEW_FILE_ITEM_ID = 'create-new-file';
        const hasNewFileHandler = this.commandRegistry.getActiveHandler(common_commands_1.CommonCommands.NEW_FILE.id) !== undefined;
        // Create a "Create New File" item only if there is a NEW_FILE command handler.
        const createNewFileItem = hasNewFileHandler ? {
            id: CREATE_NEW_FILE_ITEM_ID,
            label: nls_1.nls.localizeByDefault('Create New File ({0})'),
            description: nls_1.nls.localizeByDefault('Built-in'),
            execute: async () => {
                if (createNewFileItem?.value) {
                    const parent = await this.workingDirProvider.getUserWorkingDir();
                    // Exec NEW_FILE command with the file name and parent dir as arguments
                    return this.commandRegistry.executeCommand(common_commands_1.CommonCommands.NEW_FILE.id, createNewFileItem.value, parent);
                }
            }
        } : undefined;
        this.quickInputService.showQuickPick(items, {
            title: nls_1.nls.localizeByDefault('New File...'),
            placeholder: nls_1.nls.localizeByDefault('Select File Type or Enter File Name...'),
            canSelectMany: false,
            onDidChangeValue: picker => {
                if (createNewFileItem === undefined) {
                    return;
                }
                // Dynamically show or hide the "Create New File" item based on the input value.
                if (picker.value) {
                    createNewFileItem.alwaysShow = true;
                    createNewFileItem.value = picker.value;
                    createNewFileItem.label = nls_1.nls.localizeByDefault('Create New File ({0})', picker.value);
                    picker.items = [...items, createNewFileItem];
                }
                else {
                    createNewFileItem.alwaysShow = false;
                    createNewFileItem.value = undefined;
                    picker.items = items.filter(item => item !== createNewFileItem);
                }
            }
        });
    }
    registerColors(colors) {
        colors.register(
        // Base Colors should be aligned with https://code.visualstudio.com/api/references/theme-color#base-colors
        // if not yet contributed by Monaco, check runtime css variables to learn
        { id: 'selection.background', defaults: { dark: '#217daf', light: '#c0dbf1' }, description: 'Overall border color for focused elements. This color is only used if not overridden by a component.' }, { id: 'icon.foreground', defaults: { dark: '#C5C5C5', light: '#424242', hcDark: '#FFFFFF', hcLight: '#292929' }, description: 'The default color for icons in the workbench.' }, { id: 'sash.hoverBorder', defaults: { dark: color_1.Color.transparent('focusBorder', 0.99), light: color_1.Color.transparent('focusBorder', 0.99), hcDark: 'focusBorder', hcLight: 'focusBorder' }, description: 'The hover border color for draggable sashes.' }, { id: 'sash.activeBorder', defaults: { dark: 'focusBorder', light: 'focusBorder', hcDark: 'focusBorder' }, description: 'The active border color for draggable sashes.' }, 
        // Window border colors should be aligned with https://code.visualstudio.com/api/references/theme-color#window-border
        {
            id: 'window.activeBorder', defaults: {
                hcDark: 'contrastBorder',
                hcLight: 'contrastBorder'
            }, description: 'The color used for the border of the window when it is active.'
        }, {
            id: 'window.inactiveBorder', defaults: {
                hcDark: 'contrastBorder',
                hcLight: 'contrastBorder'
            },
            description: 'The color used for the border of the window when it is inactive.'
        }, 
        // Activity Bar colors should be aligned with https://code.visualstudio.com/api/references/theme-color#activity-bar
        {
            id: 'activityBar.background', defaults: {
                dark: '#333333',
                light: '#2C2C2C',
                hcDark: '#000000',
                hcLight: '#FFFFFF'
            }, description: 'Activity bar background color. The activity bar is showing on the far left or right and allows to switch between views of the side bar.'
        }, {
            id: 'activityBar.foreground', defaults: {
                dark: color_1.Color.white,
                light: color_1.Color.white,
                hcDark: color_1.Color.white,
                hcLight: 'editor.foreground'
            }, description: 'Activity bar item foreground color when it is active. The activity bar is showing on the far left or right and allows to switch between views of the side bar.',
        }, {
            id: 'activityBar.inactiveForeground', defaults: {
                dark: color_1.Color.transparent('activityBar.foreground', 0.4),
                light: color_1.Color.transparent('activityBar.foreground', 0.4),
                hcDark: color_1.Color.white,
                hcLight: 'editor.foreground'
            }, description: 'Activity bar item foreground color when it is inactive. The activity bar is showing on the far left or right and allows to switch between views of the side bar.'
        }, {
            id: 'activityBar.border', defaults: {
                hcDark: 'contrastBorder',
                hcLight: 'contrastBorder'
            }, description: 'Activity bar border color separating to the side bar. The activity bar is showing on the far left or right and allows to switch between views of the side bar.'
        }, {
            id: 'activityBar.activeBorder', defaults: {
                dark: 'activityBar.foreground',
                light: 'activityBar.foreground',
                hcLight: 'contrastBorder'
            }, description: 'Activity bar border color for the active item. The activity bar is showing on the far left or right and allows to switch between views of the side bar.'
        }, {
            id: 'activityBar.activeFocusBorder', defaults: {
                hcLight: '#B5200D'
            }, description: 'Activity bar focus border color for the active item. The activity bar is showing on the far left or right and allows to switch between views of the side bar.'
        }, { id: 'activityBar.activeBackground', description: 'Activity bar background color for the active item. The activity bar is showing on the far left or right and allows to switch between views of the side bar.' }, {
            id: 'activityBar.dropBackground', defaults: {
                dark: color_1.Color.transparent('#ffffff', 0.12),
                light: color_1.Color.transparent('#ffffff', 0.12),
                hcDark: color_1.Color.transparent('#ffffff', 0.12),
            }, description: 'Drag and drop feedback color for the activity bar items. The color should have transparency so that the activity bar entries can still shine through. The activity bar is showing on the far left or right and allows to switch between views of the side bar.'
        }, {
            id: 'activityBarBadge.background', defaults: {
                dark: '#007ACC',
                light: '#007ACC',
                hcDark: '#000000',
                hcLight: '#0F4A85'
            }, description: 'Activity notification badge background color. The activity bar is showing on the far left or right and allows to switch between views of the side bar.'
        }, {
            id: 'activityBarBadge.foreground', defaults: {
                dark: color_1.Color.white,
                light: color_1.Color.white,
                hcDark: color_1.Color.white,
                hcLight: color_1.Color.white
            }, description: 'Activity notification badge foreground color. The activity bar is showing on the far left or right and allows to switch between views of the side bar.'
        }, 
        // Side Bar should be aligned with https://code.visualstudio.com/api/references/theme-color#side-bar
        // if not yet contributed by Monaco, check runtime css variables to learn
        { id: 'sideBar.background', defaults: { dark: '#252526', light: '#F3F3F3', hcDark: '#000000', hcLight: '#FFFFFF' }, description: 'Side bar background color. The side bar is the container for views like explorer and search.' }, { id: 'sideBar.foreground', description: 'Side bar foreground color. The side bar is the container for views like explorer and search.' }, { id: 'sideBarSectionHeader.background', defaults: { dark: '#80808033', light: '#80808033' }, description: 'Side bar section header background color. The side bar is the container for views like explorer and search.' }, { id: 'sideBarSectionHeader.foreground', description: 'Side bar foreground color. The side bar is the container for views like explorer and search.' }, { id: 'sideBarSectionHeader.border', defaults: { dark: 'contrastBorder', light: 'contrastBorder', hcDark: 'contrastBorder', hcLight: 'contrastBorder' }, description: 'Side bar section header border color. The side bar is the container for views like explorer and search.' }, 
        // Lists and Trees colors should be aligned with https://code.visualstudio.com/api/references/theme-color#lists-and-trees
        // if not yet contributed by Monaco, check runtime css variables to learn.
        // TODO: Following are not yet supported/no respective elements in theia:
        // list.focusBackground, list.focusForeground, list.inactiveFocusBackground, list.filterMatchBorder,
        // list.dropBackground, listFilterWidget.outline, listFilterWidget.noMatchesOutline
        // list.invalidItemForeground => tree node needs an respective class
        { id: 'list.activeSelectionBackground', defaults: { dark: '#094771', light: '#E8E8E8', hcLight: color_1.Color.transparent('#0F4A85', 0.1) }, description: 'List/Tree background color for the selected item when the list/tree is active. An active list/tree has keyboard focus, an inactive does not.' }, { id: 'list.activeSelectionForeground', defaults: { dark: '#FFF', light: '#FFF' }, description: 'List/Tree foreground color for the selected item when the list/tree is active. An active list/tree has keyboard focus, an inactive does not.' }, { id: 'list.inactiveSelectionBackground', defaults: { dark: '#37373D', light: '#E4E6F1', hcLight: color_1.Color.transparent('#0F4A85', 0.1) }, description: 'List/Tree background color for the selected item when the list/tree is inactive. An active list/tree has keyboard focus, an inactive does not.' }, { id: 'list.inactiveSelectionForeground', description: 'List/Tree foreground color for the selected item when the list/tree is inactive. An active list/tree has keyboard focus, an inactive does not.' }, { id: 'list.hoverBackground', defaults: { dark: '#2A2D2E', light: '#F0F0F0', hcLight: color_1.Color.transparent('#0F4A85', 0.1) }, description: 'List/Tree background when hovering over items using the mouse.' }, { id: 'list.hoverForeground', description: 'List/Tree foreground when hovering over items using the mouse.' }, { id: 'list.errorForeground', defaults: { dark: '#F88070', light: '#B01011' }, description: 'Foreground color of list items containing errors.' }, { id: 'list.warningForeground', defaults: { dark: '#CCA700', light: '#855F00' }, description: 'Foreground color of list items containing warnings.' }, { id: 'list.filterMatchBackground', defaults: { dark: 'editor.findMatchHighlightBackground', light: 'editor.findMatchHighlightBackground' }, description: 'Background color of the filtered match.' }, { id: 'list.highlightForeground', defaults: { dark: '#18A3FF', light: '#0066BF', hcDark: 'focusBorder', hcLight: 'focusBorder' }, description: 'List/Tree foreground color of the match highlights when searching inside the list/tree.' }, { id: 'list.focusHighlightForeground', defaults: { dark: 'list.highlightForeground', light: 'list.activeSelectionForeground', hcDark: 'list.highlightForeground', hcLight: 'list.highlightForeground' }, description: 'List/Tree foreground color of the match highlights on actively focused items when searching inside the list/tree.' }, { id: 'tree.inactiveIndentGuidesStroke', defaults: { dark: color_1.Color.transparent('tree.indentGuidesStroke', 0.4), light: color_1.Color.transparent('tree.indentGuidesStroke', 0.4), hcDark: color_1.Color.transparent('tree.indentGuidesStroke', 0.4) }, description: 'Tree stroke color for the inactive indentation guides.' }, 
        // Editor Group & Tabs colors should be aligned with https://code.visualstudio.com/api/references/theme-color#editor-groups-tabs
        {
            id: 'editorGroup.border',
            defaults: {
                dark: '#444444',
                light: '#E7E7E7',
                hcDark: 'contrastBorder',
                hcLight: 'contrastBorder'
            },
            description: 'Color to separate multiple editor groups from each other. Editor groups are the containers of editors.'
        }, {
            id: 'editorGroup.dropBackground',
            defaults: {
                dark: color_1.Color.transparent('#53595D', 0.5),
                light: color_1.Color.transparent('#2677CB', 0.18),
                hcLight: color_1.Color.transparent('#0F4A85', 0.50)
            },
            description: 'Background color when dragging editors around. The color should have transparency so that the editor contents can still shine through.'
        }, {
            id: 'editorGroupHeader.tabsBackground',
            defaults: {
                dark: '#252526',
                light: '#F3F3F3',
            },
            description: 'Background color of the editor group title header when tabs are enabled. Editor groups are the containers of editors.'
        }, {
            id: 'editorGroupHeader.tabsBorder',
            defaults: {
                hcDark: 'contrastBorder'
            },
            description: 'Border color of the editor group title header when tabs are enabled. Editor groups are the containers of editors.'
        }, {
            id: 'tab.activeBackground',
            defaults: {
                dark: 'editor.background',
                light: 'editor.background',
                hcDark: 'editor.background',
                hcLight: 'editor.background'
            },
            description: 'Active tab background color. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.unfocusedActiveBackground',
            defaults: {
                dark: 'tab.activeBackground',
                light: 'tab.activeBackground',
                hcDark: 'tab.activeBackground',
                hcLight: 'tab.activeBackground'
            },
            description: 'Active tab background color in an unfocused group. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.inactiveBackground',
            defaults: {
                dark: '#2D2D2D',
                light: '#ECECEC'
            },
            description: 'Inactive tab background color. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.activeForeground',
            defaults: {
                dark: color_1.Color.white,
                light: '#333333',
                hcDark: color_1.Color.white,
                hcLight: '#292929'
            }, description: 'Active tab foreground color in an active group. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.inactiveForeground', defaults: {
                dark: color_1.Color.transparent('tab.activeForeground', 0.5),
                light: color_1.Color.transparent('tab.activeForeground', 0.7),
                hcDark: color_1.Color.white,
                hcLight: '#292929'
            }, description: 'Inactive tab foreground color in an active group. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.unfocusedActiveForeground', defaults: {
                dark: color_1.Color.transparent('tab.activeForeground', 0.5),
                light: color_1.Color.transparent('tab.activeForeground', 0.7),
                hcDark: color_1.Color.white,
                hcLight: '#292929'
            }, description: 'Active tab foreground color in an unfocused group. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.unfocusedInactiveForeground', defaults: {
                dark: color_1.Color.transparent('tab.inactiveForeground', 0.5),
                light: color_1.Color.transparent('tab.inactiveForeground', 0.5),
                hcDark: color_1.Color.white,
                hcLight: '#292929'
            }, description: 'Inactive tab foreground color in an unfocused group. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.border', defaults: {
                dark: '#252526',
                light: '#F3F3F3',
                hcDark: 'contrastBorder',
                hcLight: 'contrastBorder'
            }, description: 'Border to separate tabs from each other. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.activeBorder',
            description: 'Border on the bottom of an active tab. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.unfocusedActiveBorder',
            defaults: {
                dark: color_1.Color.transparent('tab.activeBorder', 0.5),
                light: color_1.Color.transparent('tab.activeBorder', 0.7)
            },
            description: 'Border on the bottom of an active tab in an unfocused group. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.activeBorderTop',
            defaults: {
                hcLight: '#B5200D'
            },
            description: 'Border to the top of an active tab. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.unfocusedActiveBorderTop', defaults: {
                dark: color_1.Color.transparent('tab.activeBorderTop', 0.5),
                light: color_1.Color.transparent('tab.activeBorderTop', 0.7),
                hcLight: '#B5200D'
            }, description: 'Border to the top of an active tab in an unfocused group. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.hoverBackground',
            description: 'Tab background color when hovering. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.unfocusedHoverBackground', defaults: {
                dark: color_1.Color.transparent('tab.hoverBackground', 0.5),
                light: color_1.Color.transparent('tab.hoverBackground', 0.7)
            }, description: 'Tab background color in an unfocused group when hovering. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.hoverBorder',
            description: 'Border to highlight tabs when hovering. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.unfocusedHoverBorder', defaults: {
                dark: color_1.Color.transparent('tab.hoverBorder', 0.5),
                light: color_1.Color.transparent('tab.hoverBorder', 0.7),
                hcLight: 'contrastBorder'
            }, description: 'Border to highlight tabs in an unfocused group when hovering. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.activeModifiedBorder', defaults: {
                dark: '#3399CC',
                light: '#33AAEE',
                hcLight: 'contrastBorder'
            }, description: 'Border on the top of modified (dirty) active tabs in an active group. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.inactiveModifiedBorder', defaults: {
                dark: color_1.Color.transparent('tab.activeModifiedBorder', 0.5),
                light: color_1.Color.transparent('tab.activeModifiedBorder', 0.5),
                hcDark: color_1.Color.white,
                hcLight: 'contrastBorder'
            }, description: 'Border on the top of modified (dirty) inactive tabs in an active group. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.unfocusedActiveModifiedBorder', defaults: {
                dark: color_1.Color.transparent('tab.activeModifiedBorder', 0.5),
                light: color_1.Color.transparent('tab.activeModifiedBorder', 0.7),
                hcDark: color_1.Color.white,
                hcLight: 'contrastBorder'
            }, description: 'Border on the top of modified (dirty) active tabs in an unfocused group. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, {
            id: 'tab.unfocusedInactiveModifiedBorder', defaults: {
                dark: color_1.Color.transparent('tab.inactiveModifiedBorder', 0.5),
                light: color_1.Color.transparent('tab.inactiveModifiedBorder', 0.5),
                hcDark: color_1.Color.white,
                hcLight: 'contrastBorder'
            }, description: 'Border on the top of modified (dirty) inactive tabs in an unfocused group. Tabs are the containers for editors in the editor area. Multiple tabs can be opened in one editor group. There can be multiple editor groups.'
        }, 
        // Status bar colors should be aligned with https://code.visualstudio.com/api/references/theme-color#status-bar-colors
        {
            id: 'statusBar.foreground', defaults: {
                dark: '#FFFFFF',
                light: '#FFFFFF',
                hcDark: '#FFFFFF',
                hcLight: 'editor.foreground'
            }, description: 'Status bar foreground color when a workspace is opened. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBar.background', defaults: {
                dark: '#007ACC',
                light: '#007ACC'
            }, description: 'Status bar background color when a workspace is opened. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBar.noFolderForeground', defaults: {
                dark: 'statusBar.foreground',
                light: 'statusBar.foreground',
                hcDark: 'statusBar.foreground',
                hcLight: 'statusBar.foreground'
            }, description: 'Status bar foreground color when no folder is opened. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBar.noFolderBackground', defaults: {
                dark: '#68217A',
                light: '#68217A'
            }, description: 'Status bar background color when no folder is opened. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBar.border', defaults: {
                hcDark: 'contrastBorder',
                hcLight: 'contrastBorder'
            }, description: 'Status bar border color separating to the sidebar and editor. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBar.noFolderBorder', defaults: {
                dark: 'statusBar.border',
                light: 'statusBar.border',
                hcDark: 'statusBar.border',
                hcLight: 'statusBar.border'
            }, description: 'Status bar border color separating to the sidebar and editor when no folder is opened. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.activeBackground', defaults: {
                dark: color_1.Color.rgba(255, 255, 255, 0.18),
                light: color_1.Color.rgba(255, 255, 255, 0.18),
                hcDark: color_1.Color.rgba(255, 255, 255, 0.18),
                hcLight: color_1.Color.rgba(0, 0, 0, 0.18)
            }, description: 'Status bar item background color when clicking. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.hoverBackground', defaults: {
                dark: color_1.Color.rgba(255, 255, 255, 0.12),
                light: color_1.Color.rgba(255, 255, 255, 0.12),
                hcDark: color_1.Color.rgba(255, 255, 255, 0.12),
                hcLight: color_1.Color.rgba(0, 0, 0, 0.12)
            }, description: 'Status bar item background color when hovering. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.hoverForeground', defaults: {
                dark: 'statusBar.foreground',
                light: 'statusBar.foreground',
                hcDark: 'statusBar.foreground',
                hcLight: 'statusBar.foreground'
            }, description: 'Status bar item foreground color when hovering. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.compactHoverBackground', defaults: {
                dark: color_1.Color.rgba(255, 255, 255, 0.20),
                light: color_1.Color.rgba(255, 255, 255, 0.20),
                hcDark: color_1.Color.rgba(255, 255, 255, 0.20),
                hcLight: color_1.Color.rgba(0, 0, 0, 0.20)
            }, description: 'Status bar item background color when hovering an item that contains two hovers. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.focusBorder', defaults: {
                dark: 'statusBar.foreground',
                light: 'statusBar.foreground',
                hcDark: 'statusBar.foreground',
                hcLight: 'statusBar.foreground'
            }, description: 'Status bar item border color when focused on keyboard navigation. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.errorBackground', defaults: {
                dark: color_1.Color.darken('errorBackground', 0.4),
                light: color_1.Color.darken('errorBackground', 0.4),
                hcDark: undefined,
                hcLight: '#B5200D'
            }, description: 'Status bar error items background color. Error items stand out from other status bar entries to indicate error conditions. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.errorForeground', defaults: {
                dark: color_1.Color.white,
                light: color_1.Color.white,
                hcDark: color_1.Color.white,
                hcLight: color_1.Color.white
            }, description: 'Status bar error items foreground color. Error items stand out from other status bar entries to indicate error conditions. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.errorHoverBackground', defaults: {
                dark: color_1.Color.lighten('statusBarItem.errorBackground', 0.2),
                light: color_1.Color.lighten('statusBarItem.errorBackground', 0.2),
                hcDark: undefined,
                hcLight: undefined
            }, description: 'Status bar error items background color when hovering. Error items stand out from other status bar entries to indicate error conditions. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.errorHoverForeground', defaults: {
                dark: 'statusBarItem.errorForeground',
                light: 'statusBarItem.errorForeground',
                hcDark: 'statusBarItem.errorForeground',
                hcLight: 'statusBarItem.errorForeground'
            }, description: 'Status bar error items foreground color when hovering. Error items stand out from other status bar entries to indicate error conditions. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.warningBackground', defaults: {
                dark: color_1.Color.darken('warningBackground', 0.4),
                light: color_1.Color.darken('warningBackground', 0.4),
                hcDark: undefined,
                hcLight: '#895503'
            }, description: 'Status bar warning items background color. Warning items stand out from other status bar entries to indicate warning conditions. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.warningForeground', defaults: {
                dark: color_1.Color.white,
                light: color_1.Color.white,
                hcDark: color_1.Color.white,
                hcLight: color_1.Color.white
            }, description: 'Status bar warning items foreground color. Warning items stand out from other status bar entries to indicate warning conditions. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.warningHoverBackground', defaults: {
                dark: color_1.Color.lighten('statusBarItem.warningBackground', 0.2),
                light: color_1.Color.lighten('statusBarItem.warningBackground', 0.2),
                hcDark: undefined,
                hcLight: undefined
            }, description: 'Status bar warning items background color when hovering. Warning items stand out from other status bar entries to indicate warning conditions. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.warningHoverForeground', defaults: {
                dark: 'statusBarItem.warningForeground',
                light: 'statusBarItem.warningForeground',
                hcDark: 'statusBarItem.warningForeground',
                hcLight: 'statusBarItem.warningForeground'
            }, description: 'Status bar warning items foreground color when hovering. Warning items stand out from other status bar entries to indicate warning conditions. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.prominentForeground', defaults: {
                dark: 'statusBar.foreground',
                light: 'statusBar.foreground',
                hcDark: 'statusBar.foreground',
                hcLight: 'statusBar.foreground'
            }, description: 'Status bar prominent items foreground color. Prominent items stand out from other status bar entries to indicate importance. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.prominentBackground', defaults: {
                dark: color_1.Color.rgba(0, 0, 0, .5),
                light: color_1.Color.rgba(0, 0, 0, .5),
                hcDark: color_1.Color.rgba(0, 0, 0, .5),
                hcLight: color_1.Color.rgba(0, 0, 0, .5),
            }, description: 'Status bar prominent items background color. Prominent items stand out from other status bar entries to indicate importance. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.prominentHoverForeground', defaults: {
                dark: 'statusBarItem.hoverForeground',
                light: 'statusBarItem.hoverForeground',
                hcDark: 'statusBarItem.hoverForeground',
                hcLight: 'statusBarItem.hoverForeground'
            }, description: 'Status bar prominent items foreground color when hovering. Prominent items stand out from other status bar entries to indicate importance. The status bar is shown in the bottom of the window.'
        }, {
            id: 'statusBarItem.prominentHoverBackground', defaults: {
                dark: 'statusBarItem.hoverBackground',
                light: 'statusBarItem.hoverBackground',
                hcDark: 'statusBarItem.hoverBackground',
                hcLight: 'statusBarItem.hoverBackground'
            }, description: 'Status bar prominent items background color when hovering. Prominent items stand out from other status bar entries to indicate importance. The status bar is shown in the bottom of the window.'
        }, 
        // editor find
        {
            id: 'editor.findMatchBackground',
            defaults: {
                light: '#A8AC94',
                dark: '#515C6A',
                hcDark: undefined,
                hcLight: undefined
            },
            description: 'Color of the current search match.'
        }, {
            id: 'editor.findMatchForeground',
            defaults: {
                light: undefined,
                dark: undefined,
                hcDark: undefined,
                hcLight: undefined
            },
            description: 'Text color of the current search match.'
        }, {
            id: 'editor.findMatchHighlightBackground',
            defaults: {
                light: '#EA5C0055',
                dark: '#EA5C0055',
                hcDark: undefined,
                hcLight: undefined
            },
            description: 'Color of the other search matches. The color must not be opaque so as not to hide underlying decorations.'
        }, {
            id: 'editor.findMatchHighlightForeground',
            defaults: {
                light: undefined,
                dark: undefined,
                hcDark: undefined,
                hcLight: undefined
            },
            description: 'Foreground color of the other search matches.'
        }, {
            id: 'editor.findRangeHighlightBackground',
            defaults: {
                dark: '#3a3d4166',
                light: '#b4b4b44d',
                hcDark: undefined,
                hcLight: undefined
            },
            description: 'Color of the range limiting the search. The color must not be opaque so as not to hide underlying decorations.'
        }, {
            id: 'editor.findMatchBorder',
            defaults: {
                light: undefined,
                dark: undefined,
                hcDark: 'activeContrastBorder',
                hcLight: 'activeContrastBorder'
            },
            description: 'Border color of the current search match.'
        }, {
            id: 'editor.findMatchHighlightBorder',
            defaults: {
                light: undefined,
                dark: undefined,
                hcDark: 'activeContrastBorder',
                hcLight: 'activeContrastBorder'
            },
            description: 'Border color of the other search matches.'
        }, {
            id: 'editor.findRangeHighlightBorder',
            defaults: {
                dark: undefined,
                light: undefined,
                hcDark: color_1.Color.transparent('activeContrastBorder', 0.4),
                hcLight: color_1.Color.transparent('activeContrastBorder', 0.4)
            },
            description: 'Border color of the range limiting the search. The color must not be opaque so as not to hide underlying decorations.'
        }, 
        // Quickinput colors should be aligned with https://code.visualstudio.com/api/references/theme-color#quick-picker
        // if not yet contributed by Monaco, check runtime css variables to learn.
        {
            id: 'quickInput.background', defaults: {
                dark: 'editorWidget.background',
                light: 'editorWidget.background',
                hcDark: 'editorWidget.background',
                hcLight: 'editorWidget.background'
            }, description: 'Quick Input background color. The Quick Input widget is the container for views like the color theme picker.'
        }, {
            id: 'quickInput.foreground', defaults: {
                dark: 'editorWidget.foreground',
                light: 'editorWidget.foreground',
                hcDark: 'editorWidget.foreground',
                hcLight: 'editorWidget.foreground'
            }, description: 'Quick Input foreground color. The Quick Input widget is the container for views like the color theme picker.'
        }, {
            id: 'quickInput.list.focusBackground', defaults: {
                dark: undefined,
                light: undefined,
                hcDark: undefined,
                hcLight: undefined
            }, description: 'quickInput.list.focusBackground deprecation. Please use quickInputList.focusBackground instead'
        }, {
            id: 'quickInputList.focusForeground', defaults: {
                dark: 'list.activeSelectionForeground',
                light: 'list.activeSelectionForeground',
                hcDark: 'list.activeSelectionForeground',
                hcLight: 'list.activeSelectionForeground'
            }, description: 'Quick picker foreground color for the focused item'
        }, {
            id: 'quickInputList.focusBackground', defaults: {
                dark: 'list.activeSelectionBackground',
                light: 'list.activeSelectionBackground',
                hcDark: undefined
            }, description: 'Quick picker background color for the focused item.'
        }, 
        // Panel colors should be aligned with https://code.visualstudio.com/api/references/theme-color#panel-colors
        {
            id: 'panel.background', defaults: {
                dark: 'editor.background', light: 'editor.background', hcDark: 'editor.background', hcLight: 'editor.background'
            }, description: 'Panel background color. Panels are shown below the editor area and contain views like output and integrated terminal.'
        }, {
            id: 'panel.border', defaults: {
                dark: color_1.Color.transparent('#808080', 0.35), light: color_1.Color.transparent('#808080', 0.35), hcDark: 'contrastBorder', hcLight: 'contrastBorder'
            }, description: 'Panel border color to separate the panel from the editor. Panels are shown below the editor area and contain views like output and integrated terminal.'
        }, {
            id: 'panel.dropBackground', defaults: {
                dark: color_1.Color.rgba(255, 255, 255, 0.12), light: color_1.Color.transparent('#2677CB', 0.18), hcDark: color_1.Color.rgba(255, 255, 255, 0.12)
            }, description: 'Drag and drop feedback color for the panel title items. The color should have transparency so that the panel entries can still shine through. Panels are shown below the editor area and contain views like output and integrated terminal.'
        }, {
            id: 'panelTitle.activeForeground', defaults: {
                dark: '#E7E7E7', light: '#424242', hcDark: color_1.Color.white, hcLight: 'editor.foreground'
            }, description: 'Title color for the active panel. Panels are shown below the editor area and contain views like output and integrated terminal.'
        }, {
            id: 'panelTitle.inactiveForeground', defaults: {
                dark: color_1.Color.transparent('panelTitle.activeForeground', 0.6), light: color_1.Color.transparent('panelTitle.activeForeground', 0.75), hcDark: color_1.Color.white, hcLight: 'editor.foreground'
            }, description: 'Title color for the inactive panel. Panels are shown below the editor area and contain views like output and integrated terminal.'
        }, {
            id: 'panelTitle.activeBorder', defaults: {
                dark: 'panelTitle.activeForeground', light: 'panelTitle.activeForeground', hcDark: 'contrastBorder', hcLight: '#B5200D'
            }, description: 'Border color for the active panel title. Panels are shown below the editor area and contain views like output and integrated terminal.'
        }, {
            id: 'panelInput.border', defaults: { light: '#ddd' },
            description: 'Input box border for inputs in the panel.'
        }, {
            id: 'imagePreview.border', defaults: {
                dark: color_1.Color.transparent('#808080', 0.35), light: color_1.Color.transparent('#808080', 0.35), hcDark: 'contrastBorder', hcLight: 'contrastBorder'
            }, description: 'Border color for image in image preview.'
        }, 
        // Title Bar colors should be aligned with https://code.visualstudio.com/api/references/theme-color#title-bar-colors
        {
            id: 'titleBar.activeForeground', defaults: {
                dark: '#CCCCCC',
                light: '#333333',
                hcDark: '#FFFFFF',
                hcLight: '#292929'
            }, description: 'Title bar foreground when the window is active. Note that this color is currently only supported on macOS.'
        }, {
            id: 'titleBar.inactiveForeground', defaults: {
                dark: color_1.Color.transparent('titleBar.activeForeground', 0.6),
                light: color_1.Color.transparent('titleBar.activeForeground', 0.6),
                hcLight: '#292929'
            }, description: 'Title bar foreground when the window is inactive. Note that this color is currently only supported on macOS.'
        }, {
            id: 'titleBar.activeBackground', defaults: {
                dark: '#3C3C3C',
                light: '#DDDDDD',
                hcDark: '#000000',
                hcLight: '#FFFFFF'
            }, description: 'Title bar background when the window is active. Note that this color is currently only supported on macOS.'
        }, {
            id: 'titleBar.inactiveBackground', defaults: {
                dark: color_1.Color.transparent('titleBar.activeBackground', 0.6),
                light: color_1.Color.transparent('titleBar.activeBackground', 0.6)
            }, description: 'Title bar background when the window is inactive. Note that this color is currently only supported on macOS.'
        }, {
            id: 'titleBar.border', defaults: {
                hcDark: 'contrastBorder',
                hcLight: 'contrastBorder'
            }, description: 'Title bar border color. Note that this color is currently only supported on macOS.'
        }, 
        // Menu Bar colors should be aligned with https://code.visualstudio.com/api/references/theme-color#menu-bar-colors
        {
            id: 'menubar.selectionForeground', defaults: {
                dark: 'titleBar.activeForeground',
                light: 'titleBar.activeForeground',
                hcDark: 'titleBar.activeForeground',
                hcLight: 'titleBar.activeForeground'
            }, description: 'Foreground color of the selected menu item in the menubar.'
        }, {
            id: 'menubar.selectionBackground', defaults: {
                dark: 'toolbar.hoverBackground',
                light: 'toolbar.hoverBackground'
            }, description: 'Background color of the selected menu item in the menubar.'
        }, {
            id: 'menubar.selectionBorder', defaults: {
                hcDark: 'activeContrastBorder', hcLight: 'activeContrastBorder'
            }, description: 'Border color of the selected menu item in the menubar.'
        }, {
            id: 'menu.border', defaults: {
                hcDark: 'contrastBorder', hcLight: 'contrastBorder'
            }, description: 'Border color of menus.'
        }, {
            id: 'menu.foreground', defaults: {
                dark: 'dropdown.foreground', light: 'foreground', hcDark: 'dropdown.foreground', hcLight: 'dropdown.foreground'
            },
            description: 'Foreground color of menu items.'
        }, {
            id: 'menu.background', defaults: {
                dark: 'dropdown.background', light: 'dropdown.background', hcDark: 'dropdown.background', hcLight: 'dropdown.background'
            }, description: 'Background color of menu items.'
        }, {
            id: 'menu.selectionForeground', defaults: {
                dark: 'list.activeSelectionForeground', light: 'list.activeSelectionForeground', hcDark: 'list.activeSelectionForeground', hcLight: 'list.activeSelectionForeground'
            }, description: 'Foreground color of the selected menu item in menus.'
        }, {
            id: 'menu.selectionBackground', defaults: {
                dark: 'list.activeSelectionBackground', light: 'list.activeSelectionBackground', hcDark: 'list.activeSelectionBackground', hcLight: 'list.activeSelectionBackground'
            },
            description: 'Background color of the selected menu item in menus.'
        }, {
            id: 'menu.selectionBorder', defaults: {
                hcDark: 'activeContrastBorder', hcLight: 'activeContrastBorder'
            }, description: 'Border color of the selected menu item in menus.'
        }, {
            id: 'menu.separatorBackground', defaults: {
                dark: '#BBBBBB', light: '#888888', hcDark: 'contrastBorder', hcLight: 'contrastBorder'
            },
            description: 'Color of a separator menu item in menus.'
        }, 
        // Welcome Page colors should be aligned with https://code.visualstudio.com/api/references/theme-color#welcome-page
        { id: 'welcomePage.background', description: 'Background color for the Welcome page.' }, { id: 'welcomePage.buttonBackground', defaults: { dark: color_1.Color.rgba(0, 0, 0, .2), light: color_1.Color.rgba(0, 0, 0, .04), hcDark: color_1.Color.black, hcLight: color_1.Color.white }, description: 'Background color for the buttons on the Welcome page.' }, { id: 'welcomePage.buttonHoverBackground', defaults: { dark: color_1.Color.rgba(200, 235, 255, .072), light: color_1.Color.rgba(0, 0, 0, .10) }, description: 'Hover background color for the buttons on the Welcome page.' }, { id: 'walkThrough.embeddedEditorBackground', defaults: { dark: color_1.Color.rgba(0, 0, 0, .4), light: '#f4f4f4' }, description: 'Background color for the embedded editors on the Interactive Playground.' }, 
        // Dropdown colors should be aligned with https://code.visualstudio.com/api/references/theme-color#dropdown-control
        {
            id: 'dropdown.background', defaults: {
                light: color_1.Color.white,
                dark: '#3C3C3C',
                hcDark: color_1.Color.black,
                hcLight: color_1.Color.white
            }, description: 'Dropdown background.'
        }, {
            id: 'dropdown.listBackground', defaults: {
                hcDark: color_1.Color.black,
                hcLight: color_1.Color.white
            }, description: 'Dropdown list background.'
        }, {
            id: 'dropdown.foreground', defaults: {
                dark: '#F0F0F0',
                hcDark: color_1.Color.white,
                hcLight: 'foreground'
            }, description: 'Dropdown foreground.'
        }, {
            id: 'dropdown.border', defaults: {
                light: '#CECECE',
                dark: 'dropdown.background',
                hcDark: 'contrastBorder',
                hcLight: 'contrastBorder'
            }, description: 'Dropdown border.'
        }, 
        // Settings Editor colors should be aligned with https://code.visualstudio.com/api/references/theme-color#settings-editor-colors
        {
            id: 'settings.headerForeground', defaults: {
                light: '#444444', dark: '#e7e7e7', hcDark: '#ffffff', hcLight: '#292929'
            }, description: 'The foreground color for a section header or active title.'
        }, {
            id: 'settings.modifiedItemIndicator', defaults: {
                light: color_1.Color.rgba(102, 175, 224),
                dark: color_1.Color.rgba(12, 125, 157),
                hcDark: color_1.Color.rgba(0, 73, 122),
                hcLight: color_1.Color.rgba(102, 175, 224)
            }, description: 'The color of the modified setting indicator.'
        }, {
            id: 'settings.dropdownBackground', defaults: {
                dark: 'dropdown.background', light: 'dropdown.background', hcDark: 'dropdown.background', hcLight: 'dropdown.background'
            },
            description: 'Settings editor dropdown background.'
        }, {
            id: 'settings.dropdownForeground', defaults: {
                dark: 'dropdown.foreground', light: 'dropdown.foreground', hcDark: 'dropdown.foreground', hcLight: 'dropdown.foreground'
            }, description: 'Settings editor dropdown foreground.'
        }, {
            id: 'settings.dropdownBorder', defaults: {
                dark: 'dropdown.border', light: 'dropdown.border', hcDark: 'dropdown.border', hcLight: 'dropdown.border'
            }, description: 'Settings editor dropdown border.'
        }, {
            id: 'settings.dropdownListBorder', defaults: {
                dark: 'editorWidget.border', light: 'editorWidget.border', hcDark: 'editorWidget.border', hcLight: 'editorWidget.border'
            }, description: 'Settings editor dropdown list border. This surrounds the options and separates the options from the description.'
        }, {
            id: 'settings.checkboxBackground', defaults: {
                dark: 'checkbox.background', light: 'checkbox.background', hcDark: 'checkbox.background', hcLight: 'checkbox.background'
            }, description: 'Settings editor checkbox background.'
        }, {
            id: 'settings.checkboxForeground', defaults: {
                dark: 'checkbox.foreground', light: 'checkbox.foreground', hcDark: 'checkbox.foreground', hcLight: 'checkbox.foreground'
            }, description: 'Settings editor checkbox foreground.'
        }, {
            id: 'settings.checkboxBorder', defaults: {
                dark: 'checkbox.border', light: 'checkbox.border', hcDark: 'checkbox.border', hcLight: 'checkbox.border'
            }, description: 'Settings editor checkbox border.'
        }, {
            id: 'settings.textInputBackground', defaults: {
                dark: 'input.background', light: 'input.background', hcDark: 'input.background', hcLight: 'input.background'
            }, description: 'Settings editor text input box background.'
        }, {
            id: 'settings.textInputForeground', defaults: {
                dark: 'input.foreground', light: 'input.foreground', hcDark: 'input.foreground', hcLight: 'input.foreground'
            }, description: 'Settings editor text input box foreground.'
        }, {
            id: 'settings.textInputBorder', defaults: {
                dark: 'input.border', light: 'input.border', hcDark: 'input.border', hcLight: 'input.background'
            }, description: 'Settings editor text input box border.'
        }, {
            id: 'settings.numberInputBackground', defaults: {
                dark: 'input.background', light: 'input.background', hcDark: 'input.background', hcLight: 'input.background'
            }, description: 'Settings editor number input box background.'
        }, {
            id: 'settings.numberInputForeground', defaults: {
                dark: 'input.foreground', light: 'input.foreground', hcDark: 'input.foreground', hcLight: 'input.foreground'
            }, description: 'Settings editor number input box foreground.'
        }, {
            id: 'settings.numberInputBorder', defaults: {
                dark: 'input.border', light: 'input.border', hcDark: 'input.border', hcLight: 'input.border'
            }, description: 'Settings editor number input box border.'
        }, {
            id: 'settings.focusedRowBackground', defaults: {
                dark: color_1.Color.transparent('#808080', 0.14),
                light: color_1.Color.transparent('#808080', 0.03),
                hcDark: undefined,
                hcLight: undefined
            }, description: 'The background color of a settings row when focused.'
        }, {
            id: 'settings.rowHoverBackground', defaults: {
                dark: color_1.Color.transparent('#808080', 0.07),
                light: color_1.Color.transparent('#808080', 0.05),
                hcDark: undefined,
                hcLight: undefined
            }, description: 'The background color of a settings row when hovered.'
        }, {
            id: 'settings.focusedRowBorder', defaults: {
                dark: color_1.Color.rgba(255, 255, 255, 0.12),
                light: color_1.Color.rgba(0, 0, 0, 0.12),
                hcDark: 'focusBorder',
                hcLight: 'focusBorder'
            }, description: "The color of the row's top and bottom border when the row is focused."
        }, 
        // Toolbar Action colors should be aligned with https://code.visualstudio.com/api/references/theme-color#action-colors
        {
            id: 'toolbar.hoverBackground', defaults: {
                dark: '#5a5d5e50', light: '#b8b8b850', hcDark: undefined, hcLight: undefined
            }, description: 'Toolbar background when hovering over actions using the mouse.'
        }, 
        // Theia Variable colors
        {
            id: 'variable.name.color', defaults: {
                dark: '#C586C0',
                light: '#9B46B0',
                hcDark: '#C586C0'
            },
            description: 'Color of a variable name.'
        }, {
            id: 'variable.value.color', defaults: {
                dark: color_1.Color.rgba(204, 204, 204, 0.6),
                light: color_1.Color.rgba(108, 108, 108, 0.8),
                hcDark: color_1.Color.rgba(204, 204, 204, 0.6)
            },
            description: 'Color of a variable value.'
        }, {
            id: 'variable.number.variable.color', defaults: {
                dark: '#B5CEA8',
                light: '#09885A',
                hcDark: '#B5CEA8'
            },
            description: 'Value color of a number variable'
        }, {
            id: 'variable.boolean.variable.color', defaults: {
                dark: '#4E94CE',
                light: '#0000FF',
                hcDark: '#4E94CE'
            },
            description: 'Value color of a boolean variable'
        }, {
            id: 'variable.string.variable.color', defaults: {
                dark: '#CE9178',
                light: '#A31515',
                hcDark: '#CE9178'
            },
            description: 'Value color of a string variable'
        }, 
        // Theia ANSI colors
        {
            id: 'ansi.black.color', defaults: {
                dark: '#A0A0A0',
                light: color_1.Color.rgba(128, 128, 128),
                hcDark: '#A0A0A0'
            },
            description: 'ANSI black color'
        }, {
            id: 'ansi.red.color', defaults: {
                dark: '#A74747',
                light: '#BE1717',
                hcDark: '#A74747'
            },
            description: 'ANSI red color'
        }, {
            id: 'ansi.green.color', defaults: {
                dark: '#348F34',
                light: '#338A2F',
                hcDark: '#348F34'
            },
            description: 'ANSI green color'
        }, {
            id: 'ansi.yellow.color', defaults: {
                dark: '#5F4C29',
                light: '#BEB817',
                hcDark: '#5F4C29'
            },
            description: 'ANSI yellow color'
        }, {
            id: 'ansi.blue.color', defaults: {
                dark: '#6286BB',
                light: color_1.Color.rgba(0, 0, 139),
                hcDark: '#6286BB'
            },
            description: 'ANSI blue color'
        }, {
            id: 'ansi.magenta.color', defaults: {
                dark: '#914191',
                light: color_1.Color.rgba(139, 0, 139),
                hcDark: '#914191'
            },
            description: 'ANSI magenta color'
        }, {
            id: 'ansi.cyan.color', defaults: {
                dark: '#218D8D',
                light: color_1.Color.rgba(0, 139, 139),
                hcDark: '#218D8D'
            },
            description: 'ANSI cyan color'
        }, {
            id: 'ansi.white.color', defaults: {
                dark: '#707070',
                light: '#BDBDBD',
                hcDark: '#707070'
            },
            description: 'ANSI white color'
        }, 
        // Theia defaults
        // Base
        {
            id: 'errorBackground',
            defaults: {
                dark: 'inputValidation.errorBackground',
                light: 'inputValidation.errorBackground',
                hcDark: 'inputValidation.errorBackground'
            }, description: 'Background color of error widgets (like alerts or notifications).'
        }, {
            id: 'successBackground',
            defaults: {
                dark: 'editorGutter.addedBackground',
                light: 'editorGutter.addedBackground',
                hcDark: 'editorGutter.addedBackground'
            }, description: 'Background color of success widgets (like alerts or notifications).'
        }, {
            id: 'warningBackground',
            defaults: {
                dark: 'editorWarning.foreground',
                light: 'editorWarning.foreground',
                hcDark: 'editorWarning.border'
            }, description: 'Background color of warning widgets (like alerts or notifications).'
        }, {
            id: 'warningForeground',
            defaults: {
                dark: 'inputValidation.warningBackground',
                light: 'inputValidation.warningBackground',
                hcDark: 'inputValidation.warningBackground'
            }, description: 'Foreground color of warning widgets (like alerts or notifications).'
        }, 
        // Statusbar
        {
            id: 'statusBar.offlineBackground',
            defaults: {
                dark: 'editorWarning.foreground',
                light: 'editorWarning.foreground',
                hcDark: 'editorWarning.foreground',
                hcLight: 'editorWarning.foreground'
            }, description: 'Background of hovered statusbar item in case the theia server is offline.'
        }, {
            id: 'statusBar.offlineForeground',
            defaults: {
                dark: 'editor.background',
                light: 'editor.background',
                hcDark: 'editor.background',
                hcLight: 'editor.background'
            }, description: 'Background of hovered statusbar item in case the theia server is offline.'
        }, {
            id: 'statusBarItem.offlineHoverBackground',
            defaults: {
                dark: color_1.Color.lighten('statusBar.offlineBackground', 0.4),
                light: color_1.Color.lighten('statusBar.offlineBackground', 0.4),
                hcDark: color_1.Color.lighten('statusBar.offlineBackground', 0.4),
                hcLight: color_1.Color.lighten('statusBar.offlineBackground', 0.4)
            }, description: 'Background of hovered statusbar item in case the theia server is offline.'
        }, {
            id: 'statusBarItem.offlineActiveBackground',
            defaults: {
                dark: color_1.Color.lighten('statusBar.offlineBackground', 0.6),
                light: color_1.Color.lighten('statusBar.offlineBackground', 0.6),
                hcDark: color_1.Color.lighten('statusBar.offlineBackground', 0.6),
                hcLight: color_1.Color.lighten('statusBar.offlineBackground', 0.6)
            }, description: 'Background of active statusbar item in case the theia server is offline.'
        }, {
            id: 'statusBarItem.remoteBackground',
            defaults: {
                dark: 'activityBarBadge.background',
                light: 'activityBarBadge.background',
                hcDark: 'activityBarBadge.background',
                hcLight: 'activityBarBadge.background'
            }, description: 'Background color for the remote indicator on the status bar.'
        }, {
            id: 'statusBarItem.remoteForeground',
            defaults: {
                dark: 'activityBarBadge.foreground',
                light: 'activityBarBadge.foreground',
                hcDark: 'activityBarBadge.foreground',
                hcLight: 'activityBarBadge.foreground'
            }, description: 'Foreground color for the remote indicator on the status bar.'
        }, {
            id: 'statusBarItem.remoteHoverBackground',
            defaults: {
                dark: color_1.Color.lighten('statusBarItem.remoteBackground', 0.2),
                light: color_1.Color.lighten('statusBarItem.remoteBackground', 0.2),
                hcDark: color_1.Color.lighten('statusBarItem.remoteBackground', 0.2),
                hcLight: color_1.Color.lighten('statusBarItem.remoteBackground', 0.2)
            }, description: 'Background color for the remote indicator on the status bar when hovering.'
        }, {
            id: 'statusBarItem.remoteHoverForeground',
            defaults: {
                dark: 'statusBarItem.remoteForeground',
                light: 'statusBarItem.remoteForeground',
                hcDark: 'statusBarItem.remoteForeground',
                hcLight: 'statusBarItem.remoteForeground'
            }, description: 'Foreground color for the remote indicator on the status bar when hovering.'
        }, 
        // Buttons
        // https://github.com/microsoft/vscode/blob/release/1.108/src/vs/platform/theme/common/colors/inputColors.ts#L112
        {
            id: 'button.foreground',
            defaults: color_1.Color.white,
            description: 'Button foreground color.'
        }, {
            id: 'button.disabledForeground',
            defaults: {
                dark: color_1.Color.transparent('button.foreground', 0.5),
                light: color_1.Color.transparent('button.foreground', 0.5),
                hcDark: color_1.Color.transparent('button.foreground', 0.5)
            }, description: 'Foreground color of disabled buttons.'
        }, {
            id: 'button.separator',
            defaults: color_1.Color.transparent('button.foreground', .4),
            description: 'Button separator color.'
        }, {
            id: 'button.background',
            defaults: {
                dark: '#0E639C',
                light: '#007ACC',
                hcDark: color_1.Color.black,
                hcLight: '#0F4A85'
            },
            description: 'Button background color.'
        }, {
            id: 'button.disabledBackground',
            defaults: {
                dark: color_1.Color.transparent('button.background', 0.5),
                light: color_1.Color.transparent('button.background', 0.5)
            }, description: 'Background color of disabled buttons.'
        }, {
            id: 'button.hoverBackground',
            defaults: {
                dark: color_1.Color.lighten('button.background', 0.2),
                light: color_1.Color.darken('button.background', 0.2),
                hcDark: 'button.background',
                hcLight: 'button.background'
            },
            description: 'Button background color when hovering.'
        }, {
            id: 'button.border',
            defaults: 'contrastBorder',
            description: 'Button border color.'
        }, {
            id: 'secondaryButton.foreground',
            defaults: {
                dark: color_1.Color.white,
                light: color_1.Color.white,
                hcDark: color_1.Color.white,
                hcLight: 'foreground'
            }, description: 'Foreground color of secondary buttons.'
        }, {
            id: 'secondaryButton.disabledForeground',
            defaults: {
                dark: color_1.Color.transparent('secondaryButton.foreground', 0.5),
                light: color_1.Color.transparent('secondaryButton.foreground', 0.5),
                hcDark: color_1.Color.transparent('secondaryButton.foreground', 0.5),
                hcLight: color_1.Color.transparent('secondaryButton.foreground', 0.5),
            }, description: 'Foreground color of disabled secondary buttons.'
        }, {
            id: 'secondaryButton.background',
            defaults: {
                dark: '#3A3D41',
                light: '#5F6A79',
                hcDark: undefined,
                hcLight: color_1.Color.white
            }, description: 'Background color of secondary buttons.'
        }, {
            id: 'secondaryButton.hoverBackground',
            defaults: {
                dark: color_1.Color.lighten('secondaryButton.background', 0.2),
                light: color_1.Color.lighten('secondaryButton.background', 0.2),
                hcDark: undefined,
                hcLight: undefined
            }, description: 'Background color when hovering secondary buttons.'
        }, {
            id: 'secondaryButton.disabledBackground',
            defaults: {
                dark: color_1.Color.transparent('secondaryButton.background', 0.6),
                light: color_1.Color.transparent('secondaryButton.background', 0.6)
            }, description: 'Background color of disabled secondary buttons.'
        }, {
            id: 'editorGutter.commentRangeForeground',
            defaults: {
                dark: '#37373d',
                light: '#d5d8e9',
                hcDark: color_1.Color.white,
                hcLight: color_1.Color.black
            }, description: 'Editor gutter decoration color for commenting ranges.'
        }, {
            id: 'editorGutter.itemGlyphForeground',
            defaults: {
                dark: 'editor.foreground',
                light: 'editor.foreground',
                hcDark: color_1.Color.black,
                hcLight: color_1.Color.white,
            },
            description: 'Editor gutter decoration color for gutter item glyphs.'
        }, {
            id: 'breadcrumb.foreground',
            defaults: {
                dark: color_1.Color.transparent('foreground', 0.8),
                light: color_1.Color.transparent('foreground', 0.8),
                hcDark: color_1.Color.transparent('foreground', 0.8),
                hcLight: color_1.Color.transparent('foreground', 0.8)
            },
            description: 'Color of breadcrumb item text'
        }, {
            id: 'breadcrumb.background',
            defaults: {
                dark: 'editor.background',
                light: 'editor.background',
                hcDark: 'editor.background',
                hcLight: 'editor.background'
            },
            description: 'Color of breadcrumb item background'
        }, {
            id: 'breadcrumb.focusForeground',
            defaults: {
                dark: color_1.Color.lighten('foreground', 0.1),
                light: color_1.Color.darken('foreground', 0.2),
                hcDark: color_1.Color.lighten('foreground', 0.1),
                hcLight: color_1.Color.lighten('foreground', 0.1)
            },
            description: 'Color of breadcrumb item text when focused'
        }, {
            id: 'breadcrumb.activeSelectionForeground',
            defaults: {
                dark: color_1.Color.lighten('foreground', 0.1),
                light: color_1.Color.darken('foreground', 0.2),
                hcDark: color_1.Color.lighten('foreground', 0.1),
                hcLight: color_1.Color.lighten('foreground', 0.1)
            },
            description: 'Color of selected breadcrumb item'
        }, {
            id: 'breadcrumbPicker.background',
            defaults: {
                dark: 'editorWidget.background',
                light: 'editorWidget.background',
                hcDark: 'editorWidget.background',
                hcLight: 'editorWidget.background'
            },
            description: 'Background color of breadcrumb item picker'
        }, {
            id: 'mainToolbar.background',
            defaults: {
                dark: color_1.Color.lighten('activityBar.background', 0.1),
                light: color_1.Color.darken('activityBar.background', 0.1),
                hcDark: color_1.Color.lighten('activityBar.background', 0.1),
                hcLight: color_1.Color.lighten('activityBar.background', 0.1)
            },
            description: 'Background color of shell\'s global toolbar'
        }, {
            id: 'mainToolbar.foreground', defaults: {
                dark: color_1.Color.darken('activityBar.foreground', 0.1),
                light: color_1.Color.lighten('activityBar.foreground', 0.1),
                hcDark: color_1.Color.lighten('activityBar.foreground', 0.1),
                hcLight: color_1.Color.lighten('activityBar.foreground', 0.1),
            }, description: 'Foreground color of active toolbar item',
        }, {
            id: 'editorHoverWidgetInternalBorder',
            defaults: {
                dark: color_1.Color.transparent('editorHoverWidget.border', 0.5),
                light: color_1.Color.transparent('editorHoverWidget.border', 0.5),
                hcDark: color_1.Color.transparent('editorHoverWidget.border', 0.5),
                hcLight: color_1.Color.transparent('editorHoverWidget.border', 0.5)
            },
            description: 'The border between subelements of a hover widget'
        });
    }
};
exports.CommonFrontendContribution = CommonFrontendContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], CommonFrontendContribution.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(resource_context_key_1.ResourceContextKey),
    tslib_1.__metadata("design:type", resource_context_key_1.ResourceContextKey)
], CommonFrontendContribution.prototype, "resourceContextKey", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(command_1.CommandRegistry),
    tslib_1.__metadata("design:type", command_1.CommandRegistry)
], CommonFrontendContribution.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(menu_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", menu_1.MenuModelRegistry)
], CommonFrontendContribution.prototype, "menuRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(storage_service_1.StorageService),
    tslib_1.__metadata("design:type", Object)
], CommonFrontendContribution.prototype, "storageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(quick_input_1.QuickInputService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], CommonFrontendContribution.prototype, "quickInputService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(icon_theme_service_1.IconThemeService),
    tslib_1.__metadata("design:type", icon_theme_service_1.IconThemeService)
], CommonFrontendContribution.prototype, "iconThemes", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(theming_1.ThemeService),
    tslib_1.__metadata("design:type", theming_1.ThemeService)
], CommonFrontendContribution.prototype, "themeService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_preferences_1.CorePreferences),
    tslib_1.__metadata("design:type", Object)
], CommonFrontendContribution.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], CommonFrontendContribution.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(clipboard_service_1.ClipboardService),
    tslib_1.__metadata("design:type", Object)
], CommonFrontendContribution.prototype, "clipboardService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(encoding_registry_1.EncodingRegistry),
    tslib_1.__metadata("design:type", encoding_registry_1.EncodingRegistry)
], CommonFrontendContribution.prototype, "encodingRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(env_variables_1.EnvVariablesServer),
    tslib_1.__metadata("design:type", Object)
], CommonFrontendContribution.prototype, "environments", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(authentication_service_1.AuthenticationService),
    tslib_1.__metadata("design:type", Object)
], CommonFrontendContribution.prototype, "authenticationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(window_service_1.WindowService),
    tslib_1.__metadata("design:type", Object)
], CommonFrontendContribution.prototype, "windowService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(secondary_window_service_1.SecondaryWindowService),
    tslib_1.__metadata("design:type", Object)
], CommonFrontendContribution.prototype, "secondaryWindowService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(user_working_directory_provider_1.UserWorkingDirectoryProvider),
    tslib_1.__metadata("design:type", user_working_directory_provider_1.UserWorkingDirectoryProvider)
], CommonFrontendContribution.prototype, "workingDirProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(language_quick_pick_service_1.LanguageQuickPickService),
    tslib_1.__metadata("design:type", language_quick_pick_service_1.LanguageQuickPickService)
], CommonFrontendContribution.prototype, "languageQuickPickService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.UntitledResourceResolver),
    tslib_1.__metadata("design:type", common_1.UntitledResourceResolver)
], CommonFrontendContribution.prototype, "untitledResourceResolver", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(undo_redo_handler_1.UndoRedoHandlerService),
    tslib_1.__metadata("design:type", undo_redo_handler_1.UndoRedoHandlerService)
], CommonFrontendContribution.prototype, "undoRedoHandlerService", void 0);
exports.CommonFrontendContribution = CommonFrontendContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(application_shell_1.ApplicationShell)),
    tslib_1.__param(1, (0, inversify_1.inject)(selection_service_1.SelectionService)),
    tslib_1.__param(2, (0, inversify_1.inject)(message_service_1.MessageService)),
    tslib_1.__param(3, (0, inversify_1.inject)(opener_service_1.OpenerService)),
    tslib_1.__param(4, (0, inversify_1.inject)(about_dialog_1.AboutDialog)),
    tslib_1.__param(5, (0, inversify_1.inject)(localization_1.AsyncLocalizationProvider)),
    tslib_1.__param(6, (0, inversify_1.inject)(saveable_service_1.SaveableService)),
    tslib_1.__metadata("design:paramtypes", [application_shell_1.ApplicationShell,
        selection_service_1.SelectionService,
        message_service_1.MessageService, Object, about_dialog_1.AboutDialog, Object, saveable_service_1.SaveableService])
], CommonFrontendContribution);
//# sourceMappingURL=common-frontend-contribution.js.map