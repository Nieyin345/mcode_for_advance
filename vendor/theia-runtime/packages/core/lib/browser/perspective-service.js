"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
var PerspectiveServiceImpl_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerspectiveServiceImpl = exports.WidgetAreaResolverImpl = exports.PerspectiveContribution = exports.PerspectiveServiceInternal = exports.PerspectiveService = exports.ACTIVE_PERSPECTIVE_CONTEXT_KEY = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const application_shell_1 = require("./shell/application-shell");
const frontend_application_contribution_1 = require("./frontend-application-contribution");
const view_contribution_1 = require("./shell/view-contribution");
const widget_manager_1 = require("./widget-manager");
const contribution_provider_1 = require("../common/contribution-provider");
const command_1 = require("../common/command");
const event_1 = require("../common/event");
const logger_1 = require("../common/logger");
const quick_pick_service_1 = require("../common/quick-pick-service");
const nls_1 = require("../common/nls");
const common_commands_1 = require("./common-commands");
const context_key_service_1 = require("./context-key-service");
exports.ACTIVE_PERSPECTIVE_CONTEXT_KEY = 'activePerspectiveId';
exports.PerspectiveService = Symbol('PerspectiveService');
exports.PerspectiveServiceInternal = Symbol('PerspectiveServiceInternal');
exports.PerspectiveContribution = Symbol('PerspectiveContribution');
let WidgetAreaResolverImpl = class WidgetAreaResolverImpl {
    constructor() {
        this.activePlacementMap = new Map();
    }
    setActivePlacementMap(map) {
        this.activePlacementMap = map;
    }
    resolveArea(widgetId, requestedArea) {
        return this.activePlacementMap.get(widgetId);
    }
};
exports.WidgetAreaResolverImpl = WidgetAreaResolverImpl;
exports.WidgetAreaResolverImpl = WidgetAreaResolverImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WidgetAreaResolverImpl);
let PerspectiveServiceImpl = class PerspectiveServiceImpl {
    constructor() {
        this.defaultPerspectiveId = PerspectiveServiceImpl_1.DEFAULT_PERSPECTIVE_ID;
        this.perspectives = new Map();
        this.savedLayouts = new Map();
        this.onDidChangePerspectiveEmitter = new event_1.Emitter();
        this.onDidChangePerspective = this.onDidChangePerspectiveEmitter.event;
    }
    static { PerspectiveServiceImpl_1 = this; }
    static { this.SWITCH_PERSPECTIVE_COMMAND = command_1.Command.toLocalizedCommand({
        id: 'perspective.switch',
        category: common_commands_1.CommonCommands.VIEW_CATEGORY,
        label: 'Switch Perspective (Experimental)'
    }, 'theia/core/perspective/switchPerspective', common_commands_1.CommonCommands.VIEW_CATEGORY_KEY); }
    static { this.RESET_PERSPECTIVE_COMMAND = command_1.Command.toLocalizedCommand({
        id: 'perspective.reset',
        category: common_commands_1.CommonCommands.VIEW_CATEGORY,
        label: 'Reset Perspective (Experimental)'
    }, 'theia/core/perspective/resetPerspective', common_commands_1.CommonCommands.VIEW_CATEGORY_KEY); }
    static { this.DEFAULT_PERSPECTIVE_ID = 'default'; }
    onLayoutRestored(activePerspectiveId) {
        this.updateActivePerspectiveContextKey(activePerspectiveId);
    }
    initialize() {
        this.registerPerspective({
            id: PerspectiveServiceImpl_1.DEFAULT_PERSPECTIVE_ID,
            label: nls_1.nls.localizeByDefault('Default'),
            viewPlacements: new Map()
        });
        this.activePerspectiveId = PerspectiveServiceImpl_1.DEFAULT_PERSPECTIVE_ID;
        this.updateActivePerspectiveContextKey(PerspectiveServiceImpl_1.DEFAULT_PERSPECTIVE_ID);
        if (this.contributions) {
            for (const contribution of this.contributions.getContributions()) {
                contribution.registerPerspectives(this);
            }
        }
    }
    onStop() {
        this.onDidChangePerspectiveEmitter.dispose();
    }
    updateActivePerspectiveContextKey(id) {
        this.contextKeyService?.createKey(exports.ACTIVE_PERSPECTIVE_CONTEXT_KEY, id).set(id);
    }
    registerPerspective(descriptor) {
        this.perspectives.set(descriptor.id, descriptor);
    }
    async switchPerspective(id) {
        const pending = (this.switchInProgress ?? Promise.resolve())
            .catch(() => { })
            .then(() => this.doSwitchPerspective(id));
        this.switchInProgress = pending;
        try {
            await pending;
        }
        finally {
            if (this.switchInProgress === pending) {
                this.switchInProgress = undefined;
            }
        }
    }
    async doSwitchPerspective(id) {
        if (id === this.activePerspectiveId) {
            return;
        }
        const descriptor = this.perspectives.get(id);
        if (!descriptor) {
            return;
        }
        const oldPerspective = this.getActivePerspective();
        if (oldPerspective?.onDeactivate) {
            oldPerspective.onDeactivate(this.shell);
        }
        if (this.activePerspectiveId) {
            this.savedLayouts.set(this.activePerspectiveId, this.shell.getLayoutData());
        }
        this.activePerspectiveId = id;
        this.widgetAreaResolver.setActivePlacementMap(descriptor.viewPlacements);
        try {
            const savedLayout = this.savedLayouts.get(id);
            if (savedLayout) {
                const layoutWidgetIds = this.collectWidgetIds(savedLayout);
                await this.healLayoutData(savedLayout);
                await this.shell.setLayoutData(savedLayout);
                this.detachStrayWidgets(layoutWidgetIds);
            }
            else {
                await this.applyViewPlacements(descriptor);
            }
        }
        catch (error) {
            this.logger.warn('Failed to apply layout for perspective', error);
        }
        if (descriptor.onActivate) {
            descriptor.onActivate(this.shell);
        }
        this.updateActivePerspectiveContextKey(id);
        this.onDidChangePerspectiveEmitter.fire(id);
    }
    async applyViewPlacements(descriptor) {
        for (const [viewId, area] of descriptor.viewPlacements) {
            try {
                const widget = await this.widgetManager.getOrCreateWidget(viewId);
                const currentTabBar = this.shell.getTabBarFor(widget);
                if (currentTabBar) {
                    const currentArea = this.shell.getAreaFor(widget);
                    if (currentArea === area) {
                        continue;
                    }
                }
                await this.shell.addWidget(widget, { area });
            }
            catch (error) {
                this.logger.warn('Failed to create or place widget for perspective', error);
            }
        }
        for (const [viewId] of descriptor.viewPlacements) {
            try {
                await this.shell.activateWidget(viewId);
            }
            catch (error) {
                this.logger.warn('Failed to activate widget for perspective', error);
            }
        }
        if (descriptor.primaryViews) {
            for (const viewId of Object.values(descriptor.primaryViews)) {
                if (viewId) {
                    try {
                        await this.shell.activateWidget(viewId);
                    }
                    catch (error) {
                        this.logger.warn('Failed to activate primary view for perspective', error);
                    }
                }
            }
        }
        if (descriptor.chromeOptions?.collapseAreas) {
            for (const area of descriptor.chromeOptions.collapseAreas) {
                await this.shell.collapsePanel(area);
            }
        }
    }
    async resetCurrentPerspective() {
        const pending = (this.switchInProgress ?? Promise.resolve())
            .catch(() => { })
            .then(() => this.doResetCurrentPerspective());
        this.switchInProgress = pending;
        try {
            await pending;
        }
        finally {
            if (this.switchInProgress === pending) {
                this.switchInProgress = undefined;
            }
        }
    }
    async doResetCurrentPerspective() {
        const descriptor = this.getActivePerspective();
        if (!descriptor) {
            return;
        }
        this.savedLayouts.delete(descriptor.id);
        try {
            if (descriptor.id === PerspectiveServiceImpl_1.DEFAULT_PERSPECTIVE_ID) {
                await this.resetDefaultPerspective();
            }
            else {
                await this.applyViewPlacements(descriptor);
            }
        }
        catch (error) {
            this.logger.warn('Failed to apply layout for perspective', error);
        }
        if (descriptor.onActivate) {
            descriptor.onActivate(this.shell);
        }
        this.onDidChangePerspectiveEmitter.fire(descriptor.id);
    }
    async resetDefaultPerspective() {
        // Phase 1: Relocate open views to their default areas
        for (const contribution of this.appContributions.getContributions()) {
            if (contribution instanceof view_contribution_1.AbstractViewContribution) {
                const widgetId = contribution.effectiveWidgetId;
                const targetArea = contribution.defaultViewOptions?.area;
                if (!widgetId || !targetArea) {
                    continue;
                }
                const widget = this.widgetManager.tryGetWidget(widgetId);
                if (widget && !widget.isDisposed && widget.isAttached) {
                    const currentArea = this.shell.getAreaFor(widget);
                    if (currentArea && currentArea !== targetArea) {
                        try {
                            await this.shell.addWidget(widget, { area: targetArea });
                        }
                        catch (error) {
                            this.logger.warn('Failed to relocate widget during default perspective reset', widgetId, error);
                        }
                    }
                }
            }
        }
        // Phase 2: Re-open closed views via openView({ activate: false }).
        // Non-view contributions (e.g., Terminal) are skipped to avoid side effects
        // like creating new terminal instances.
        for (const contribution of this.appContributions.getContributions()) {
            if (contribution instanceof view_contribution_1.AbstractViewContribution) {
                try {
                    await contribution.openView({ activate: false });
                }
                catch (error) {
                    this.logger.warn('Failed to open view during default perspective reset', error);
                }
            }
        }
    }
    /**
     * Views may be shared between multiple perspective. If a view exists in two or more perspectives
     * and is closed in one of them, the shared widget is disposed. When switching back to the other
     * perspective, we need to restore this widget (i.e. reopen the view).
     * @param layout
     */
    async healLayoutData(layout) {
        if (layout.leftPanel) {
            await this.healSidePanelLayout(layout.leftPanel);
        }
        if (layout.rightPanel) {
            await this.healSidePanelLayout(layout.rightPanel);
        }
        if (layout.mainPanel?.main) {
            await this.healDockAreaConfig(layout.mainPanel.main);
        }
        if (layout.bottomPanel?.config?.main) {
            await this.healDockAreaConfig(layout.bottomPanel.config.main);
        }
    }
    async healSidePanelLayout(layout) {
        if (!layout.items) {
            return;
        }
        for (const item of layout.items) {
            if (item.widget?.isDisposed) {
                try {
                    item.widget = await this.widgetManager.getOrCreateWidget(item.widget.id);
                }
                catch (error) {
                    this.logger.warn('Failed to recreate disposed widget for perspective layout', item.widget.id, error);
                    item.widget = undefined;
                }
            }
        }
    }
    async healDockAreaConfig(config) {
        if (config.type === 'tab-area') {
            for (let i = 0; i < config.widgets.length; i++) {
                const widget = config.widgets[i];
                if (widget.isDisposed) {
                    try {
                        config.widgets[i] = await this.widgetManager.getOrCreateWidget(widget.id);
                    }
                    catch (error) {
                        this.logger.warn('Failed to recreate disposed widget for perspective layout', widget.id, error);
                        config.widgets.splice(i, 1);
                        i--;
                    }
                }
            }
        }
        else if (config.type === 'split-area') {
            for (const child of config.children) {
                await this.healDockAreaConfig(child);
            }
        }
    }
    collectWidgetIds(layout) {
        const ids = new Set();
        if (layout.leftPanel) {
            this.collectSidePanelWidgetIds(layout.leftPanel, ids);
        }
        if (layout.rightPanel) {
            this.collectSidePanelWidgetIds(layout.rightPanel, ids);
        }
        if (layout.mainPanel?.main) {
            this.collectDockWidgetIds(layout.mainPanel.main, ids);
        }
        if (layout.bottomPanel?.config?.main) {
            this.collectDockWidgetIds(layout.bottomPanel.config.main, ids);
        }
        return ids;
    }
    collectSidePanelWidgetIds(layout, ids) {
        if (layout.items) {
            for (const item of layout.items) {
                if (item.widget) {
                    ids.add(item.widget.id);
                }
            }
        }
    }
    collectDockWidgetIds(config, ids) {
        if (config.type === 'tab-area') {
            for (const widget of config.widgets) {
                if (widget) {
                    ids.add(widget.id);
                }
            }
        }
        else if (config.type === 'split-area') {
            for (const child of config.children) {
                this.collectDockWidgetIds(child, ids);
            }
        }
    }
    detachStrayWidgets(layoutWidgetIds) {
        const sidePanelAreas = ['left', 'right'];
        for (const area of sidePanelAreas) {
            for (const widget of this.shell.getWidgets(area)) {
                if (!layoutWidgetIds.has(widget.id)) {
                    // Detach via parent = null rather than widget.close() to avoid
                    // disposing the widget — it may be needed by another perspective.
                    // eslint-disable-next-line no-null/no-null
                    widget.parent = null;
                }
            }
        }
    }
    getActivePerspective() {
        if (this.activePerspectiveId) {
            return this.perspectives.get(this.activePerspectiveId);
        }
        return undefined;
    }
    getAreaForView(viewId) {
        const active = this.getActivePerspective();
        if (active) {
            return active.viewPlacements.get(viewId);
        }
        return undefined;
    }
    getRegisteredPerspectives() {
        return Array.from(this.perspectives.values());
    }
    getActivePerspectiveId() {
        return this.activePerspectiveId ?? PerspectiveServiceImpl_1.DEFAULT_PERSPECTIVE_ID;
    }
    getSavedPerspectiveIds() {
        return Array.from(this.savedLayouts.keys());
    }
    getSavedLayout(perspectiveId) {
        return this.savedLayouts.get(perspectiveId);
    }
    setSavedLayout(perspectiveId, layout) {
        this.savedLayouts.set(perspectiveId, layout);
    }
    setActivePerspectiveId(id) {
        if (this.perspectives.has(id)) {
            this.activePerspectiveId = id;
            return true;
        }
        return false;
    }
    clearSavedLayouts() {
        this.savedLayouts.clear();
    }
    registerCommands(commands) {
        commands.registerCommand(PerspectiveServiceImpl_1.SWITCH_PERSPECTIVE_COMMAND, {
            execute: () => this.showPerspectivePicker(),
            isVisible: () => this.perspectives.size > 1
        });
        commands.registerCommand(PerspectiveServiceImpl_1.RESET_PERSPECTIVE_COMMAND, {
            execute: () => this.resetCurrentPerspective(),
            isEnabled: () => this.activePerspectiveId !== undefined
        });
    }
    async showPerspectivePicker() {
        if (!this.quickInputService) {
            return;
        }
        const items = this.getRegisteredPerspectives().map(p => ({
            label: p.label,
            id: p.id,
            description: this.activePerspectiveId === p.id ? nls_1.nls.localizeByDefault('Active') : undefined
        }));
        const selected = await this.quickInputService.showQuickPick(items, {
            placeholder: nls_1.nls.localize('theia/core/perspective/selectPerspective', 'Select a perspective')
        });
        if (selected?.id) {
            await this.switchPerspective(selected.id);
        }
    }
};
exports.PerspectiveServiceImpl = PerspectiveServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(application_shell_1.ApplicationShell),
    tslib_1.__metadata("design:type", application_shell_1.ApplicationShell)
], PerspectiveServiceImpl.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(widget_manager_1.WidgetManager),
    tslib_1.__metadata("design:type", widget_manager_1.WidgetManager)
], PerspectiveServiceImpl.prototype, "widgetManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(contribution_provider_1.ContributionProvider),
    (0, inversify_1.named)(exports.PerspectiveContribution),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], PerspectiveServiceImpl.prototype, "contributions", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(contribution_provider_1.ContributionProvider),
    (0, inversify_1.named)(frontend_application_contribution_1.FrontendApplicationContribution),
    tslib_1.__metadata("design:type", Object)
], PerspectiveServiceImpl.prototype, "appContributions", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(quick_pick_service_1.QuickInputService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], PerspectiveServiceImpl.prototype, "quickInputService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_1.ILogger),
    (0, inversify_1.named)('core:PerspectiveServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], PerspectiveServiceImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(application_shell_1.WidgetAreaResolver),
    tslib_1.__metadata("design:type", Object)
], PerspectiveServiceImpl.prototype, "widgetAreaResolver", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], PerspectiveServiceImpl.prototype, "contextKeyService", void 0);
exports.PerspectiveServiceImpl = PerspectiveServiceImpl = PerspectiveServiceImpl_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PerspectiveServiceImpl);
//# sourceMappingURL=perspective-service.js.map