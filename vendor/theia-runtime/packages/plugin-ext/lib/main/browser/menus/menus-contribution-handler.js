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
exports.MenusContributionPointHandler = void 0;
const tslib_1 = require("tslib");
/* eslint-disable @typescript-eslint/no-explicit-any */
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const common_1 = require("@theia/core/lib/common");
const tab_bar_toolbar_1 = require("@theia/core/lib/browser/shell/tab-bar-toolbar");
const scm_widget_1 = require("@theia/scm/lib/browser/scm-widget");
const scm_repositories_widget_1 = require("@theia/scm/lib/browser/scm-repositories-widget");
const scm_history_graph_widget_1 = require("@theia/scm/lib/browser/scm-history-graph-widget");
const browser_1 = require("@theia/core/lib/browser");
const vscode_theia_menu_mappings_1 = require("./vscode-theia-menu-mappings");
const plugin_menu_command_adapter_1 = require("./plugin-menu-command-adapter");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const plugin_shared_style_1 = require("../plugin-shared-style");
const themables_1 = require("@theia/monaco-editor-core/esm/vs/base/common/themables");
let MenusContributionPointHandler = class MenusContributionPointHandler {
    constructor() {
        this.initialized = false;
    }
    initialize() {
        this.initialized = true;
        this.tabBarToolbar.registerMenuDelegate(vscode_theia_menu_mappings_1.PLUGIN_EDITOR_TITLE_MENU, widget => vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.is(widget));
        this.menuRegistry.registerSubmenu(vscode_theia_menu_mappings_1.PLUGIN_EDITOR_TITLE_RUN_MENU, 'EditorTitleRunMenu');
        this.tabBarToolbar.registerItem({
            id: this.tabBarToolbar.toElementId(vscode_theia_menu_mappings_1.PLUGIN_EDITOR_TITLE_RUN_MENU),
            menuPath: vscode_theia_menu_mappings_1.PLUGIN_EDITOR_TITLE_RUN_MENU,
            icon: (0, browser_1.codicon)('debug-alt'),
            text: core_1.nls.localizeByDefault('Run or Debug...'),
            command: '',
            group: 'navigation',
            isVisible: widget => vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.is(widget)
        });
        this.tabBarToolbar.registerMenuDelegate(vscode_theia_menu_mappings_1.PLUGIN_SCM_TITLE_MENU, widget => widget instanceof scm_widget_1.ScmWidget);
        this.tabBarToolbar.registerMenuDelegate(scm_repositories_widget_1.SCM_SOURCE_CONTROL_TITLE_MENU, widget => widget instanceof scm_repositories_widget_1.ScmRepositoriesWidget);
        this.tabBarToolbar.registerMenuDelegate(scm_history_graph_widget_1.SCM_HISTORY_TITLE_MENU, widget => widget instanceof scm_history_graph_widget_1.ScmHistoryGraphWidget);
        this.tabBarToolbar.registerMenuDelegate(vscode_theia_menu_mappings_1.PLUGIN_VIEW_TITLE_MENU, widget => !vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.is(widget));
    }
    getMatchingTheiaMenuPaths(contributionPoint) {
        return vscode_theia_menu_mappings_1.codeToTheiaMappings.get(contributionPoint);
    }
    handle(plugin) {
        const allMenus = plugin.contributes?.menus;
        if (!allMenus) {
            return core_1.Disposable.NULL;
        }
        if (!this.initialized) {
            this.initialize();
        }
        const toDispose = new core_1.DisposableCollection();
        const submenus = plugin.contributes?.submenus ?? [];
        for (const submenu of submenus) {
            const iconClass = submenu.icon && this.toIconClass(submenu.icon, toDispose);
            this.menuRegistry.registerSubmenu([submenu.id], submenu.label, { icon: iconClass });
        }
        for (const [contributionPoint, items] of Object.entries(allMenus)) {
            for (const item of items) {
                try {
                    if (contributionPoint === 'commandPalette') {
                        toDispose.push(this.registerCommandPaletteAction(item));
                    }
                    else {
                        let targets = this.getMatchingTheiaMenuPaths(contributionPoint);
                        if (!targets) {
                            targets = [[contributionPoint]];
                        }
                        const { group, order } = this.parseGroup(item.group);
                        const { submenu, command } = item;
                        if (submenu && command) {
                            this.logger.warn(`Menu item ${command} from plugin ${plugin.metadata.model.id} contributed both submenu and command. Only command will be registered.`);
                        }
                        if (command) {
                            targets.forEach(target => {
                                const menuPath = group ? [...target, group] : target;
                                const cmd = this.commandRegistry.getCommand(command);
                                if (!cmd) {
                                    this.logger.debug(`No label for action menu node: No command "${command}" exists.`);
                                    return;
                                }
                                const label = cmd.label || cmd.id;
                                const icon = cmd.iconClass;
                                const action = {
                                    id: command,
                                    sortString: order || '',
                                    when: item.when,
                                    isVisible: (effectiveMenuPath, contextMatcher, context, ...args) => {
                                        if (item.when && !contextMatcher.match(item.when, context)) {
                                            return false;
                                        }
                                        return this.commandRegistry.isVisible(command, ...this.pluginMenuCommandAdapter.getArgumentAdapter(effectiveMenuPath)(...args));
                                    },
                                    icon: icon,
                                    label: label,
                                    isEnabled: (effeciveMenuPath, ...args) => this.commandRegistry.isEnabled(command, ...this.pluginMenuCommandAdapter.getArgumentAdapter(effeciveMenuPath)(...args)),
                                    run: (effeciveMenuPath, ...args) => this.commandRegistry.executeCommand(command, ...this.pluginMenuCommandAdapter.getArgumentAdapter(effeciveMenuPath)(...args)),
                                    isToggled: (effectiveMenuPath) => false,
                                    getAccelerator: (context) => {
                                        const bindings = this.keybindingRegistry.getKeybindingsForCommand(command);
                                        // Only consider the first active keybinding.
                                        if (bindings.length) {
                                            const binding = bindings.find(b => this.keybindingRegistry.isEnabledInScope(b, context));
                                            if (binding) {
                                                const asciiOnly = core_1.environment.electron.is();
                                                return this.keybindingRegistry.acceleratorFor(binding, '+', asciiOnly);
                                            }
                                        }
                                        return [];
                                    }
                                };
                                toDispose.push(this.menuRegistry.registerCommandMenu(menuPath, action));
                            });
                        }
                        else if (submenu) {
                            targets.forEach(target => toDispose.push(this.menuRegistry.linkCompoundMenuNode({
                                newParentPath: group ? [...target, group] : target,
                                submenuPath: [submenu],
                                order: order,
                                when: item.when
                            })));
                        }
                    }
                }
                catch (error) {
                    this.logger.warn(`Failed to register a menu item for plugin ${plugin.metadata.model.id} contributed to ${contributionPoint}`, item);
                    this.logger.debug(error);
                }
            }
        }
        return toDispose;
    }
    parseGroup(rawGroup) {
        if (!rawGroup) {
            return {};
        }
        const separatorIndex = rawGroup.lastIndexOf('@');
        if (separatorIndex > -1) {
            return { group: rawGroup.substring(0, separatorIndex), order: rawGroup.substring(separatorIndex + 1) || undefined };
        }
        return { group: rawGroup };
    }
    registerCommandPaletteAction(menu) {
        if (menu.command && menu.when) {
            return this.quickCommandService.pushCommandContext(menu.command, menu.when);
        }
        return core_1.Disposable.NULL;
    }
    toIconClass(url, toDispose) {
        if (typeof url === 'string') {
            const asThemeIcon = themables_1.ThemeIcon.fromString(url);
            if (asThemeIcon) {
                return themables_1.ThemeIcon.asClassName(asThemeIcon);
            }
        }
        const reference = this.style.toIconClass(url);
        toDispose.push(reference);
        return reference.object.iconClass;
    }
};
exports.MenusContributionPointHandler = MenusContributionPointHandler;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", common_1.MenuModelRegistry)
], MenusContributionPointHandler.prototype, "menuRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.CommandRegistry),
    tslib_1.__metadata("design:type", core_1.CommandRegistry)
], MenusContributionPointHandler.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(tab_bar_toolbar_1.TabBarToolbarRegistry),
    tslib_1.__metadata("design:type", tab_bar_toolbar_1.TabBarToolbarRegistry)
], MenusContributionPointHandler.prototype, "tabBarToolbar", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_menu_command_adapter_1.PluginMenuCommandAdapter),
    tslib_1.__metadata("design:type", plugin_menu_command_adapter_1.PluginMenuCommandAdapter)
], MenusContributionPointHandler.prototype, "pluginMenuCommandAdapter", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], MenusContributionPointHandler.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_shared_style_1.PluginSharedStyle),
    tslib_1.__metadata("design:type", plugin_shared_style_1.PluginSharedStyle)
], MenusContributionPointHandler.prototype, "style", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.KeybindingRegistry),
    tslib_1.__metadata("design:type", browser_1.KeybindingRegistry)
], MenusContributionPointHandler.prototype, "keybindingRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.QuickCommandService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", browser_1.QuickCommandService)
], MenusContributionPointHandler.prototype, "quickCommandService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext:MenusContributionPointHandler'),
    tslib_1.__metadata("design:type", Object)
], MenusContributionPointHandler.prototype, "logger", void 0);
exports.MenusContributionPointHandler = MenusContributionPointHandler = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MenusContributionPointHandler);
//# sourceMappingURL=menus-contribution-handler.js.map