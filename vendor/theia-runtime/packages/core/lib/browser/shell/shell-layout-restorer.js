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
var ShellLayoutRestorer_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShellLayoutRestorer = exports.RESET_LAYOUT = exports.PERSPECTIVE_LAYOUTS_STORAGE_KEY = exports.ShellLayoutTransformer = exports.ApplicationShellLayoutMigration = exports.ApplicationShellLayoutMigrationError = exports.StatefulWidget = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const widget_manager_1 = require("../widget-manager");
const storage_service_1 = require("../storage-service");
const logger_1 = require("../../common/logger");
const command_1 = require("../../common/command");
const theming_1 = require("../theming");
const contribution_provider_1 = require("../../common/contribution-provider");
const application_shell_1 = require("./application-shell");
const common_commands_1 = require("../common-commands");
const window_service_1 = require("../window/window-service");
const frontend_application_state_1 = require("../../common/frontend-application-state");
const common_1 = require("../../common");
const perspective_service_1 = require("../perspective-service");
var StatefulWidget;
(function (StatefulWidget) {
    function is(arg) {
        return (0, common_1.isObject)(arg) && (0, common_1.isFunction)(arg.storeState) && (0, common_1.isFunction)(arg.restoreState);
    }
    StatefulWidget.is = is;
})(StatefulWidget || (exports.StatefulWidget = StatefulWidget = {}));
var ApplicationShellLayoutMigrationError;
(function (ApplicationShellLayoutMigrationError) {
    const code = 'ApplicationShellLayoutMigrationError';
    function create(message) {
        return Object.assign(new Error(`Could not migrate layout to version ${application_shell_1.applicationShellLayoutVersion}.` + (message ? '\n' + message : '')), { code });
    }
    ApplicationShellLayoutMigrationError.create = create;
    function is(error) {
        return !!error && 'code' in error && error['code'] === code;
    }
    ApplicationShellLayoutMigrationError.is = is;
})(ApplicationShellLayoutMigrationError || (exports.ApplicationShellLayoutMigrationError = ApplicationShellLayoutMigrationError = {}));
exports.ApplicationShellLayoutMigration = Symbol('ApplicationShellLayoutMigration');
exports.ShellLayoutTransformer = Symbol('ShellLayoutTransformer');
exports.PERSPECTIVE_LAYOUTS_STORAGE_KEY = 'perspective-layouts';
exports.RESET_LAYOUT = command_1.Command.toLocalizedCommand({
    id: 'reset.layout',
    category: common_commands_1.CommonCommands.VIEW_CATEGORY,
    label: 'Reset Workbench Layout'
}, 'theia/core/resetWorkbenchLayout', common_commands_1.CommonCommands.VIEW_CATEGORY_KEY);
let ShellLayoutRestorer = ShellLayoutRestorer_1 = class ShellLayoutRestorer {
    constructor(widgetManager, logger, storageService) {
        this.widgetManager = widgetManager;
        this.logger = logger;
        this.storageService = storageService;
        this.storageKey = 'layout';
        this.shouldStoreLayout = true;
    }
    registerCommands(commands) {
        commands.registerCommand(exports.RESET_LAYOUT, {
            execute: async () => this.resetLayout()
        });
    }
    async resetLayout() {
        if (await this.windowService.isSafeToShutDown(frontend_application_state_1.StopReason.Reload)) {
            this.logger.info('>>> Resetting layout...');
            this.shouldStoreLayout = false;
            this.storageService.setData(this.storageKey, undefined);
            this.perspectiveService.clearSavedLayouts();
            this.storageService.setData(exports.PERSPECTIVE_LAYOUTS_STORAGE_KEY, undefined);
            this.themeService.reset();
            this.logger.info('<<< The layout has been successfully reset.');
            this.windowService.reload();
        }
    }
    storeLayout(app) {
        if (this.shouldStoreLayout) {
            try {
                this.logger.info('>>> Storing the layout...');
                this.storePerspectiveLayouts(app);
                this.logger.info('<<< The layout has been successfully stored.');
            }
            catch (error) {
                this.logger.error('Error during serialization of layout data', error);
            }
        }
    }
    storePerspectiveLayouts(app) {
        const provider = this.perspectiveService;
        const activeId = provider.getActivePerspectiveId();
        const layouts = {};
        // Snapshot current shell as the active perspective's layout
        try {
            const currentLayout = app.shell.getLayoutData();
            layouts[activeId] = this.deflate(currentLayout);
        }
        catch (error) {
            this.logger.warn(`Could not deflate layout for active perspective '${activeId}'`, error);
        }
        // Deflate all other saved (inactive) perspective layouts
        for (const perspId of provider.getSavedPerspectiveIds()) {
            if (perspId === activeId) {
                continue; // already handled above from live shell
            }
            try {
                const layout = provider.getSavedLayout(perspId);
                if (layout) {
                    layouts[perspId] = this.deflate(layout);
                }
            }
            catch (error) {
                this.logger.warn(`Could not deflate layout for perspective '${perspId}'`, error);
            }
        }
        const perspectiveIds = Object.keys(layouts);
        const onlyDefault = perspectiveIds.length <= 1 && (perspectiveIds.length === 0 || perspectiveIds[0] === provider.defaultPerspectiveId);
        if (onlyDefault) {
            // If only the default perspective has ever been used, continue writing
            // to the legacy key for backward compatibility.
            const defaultLayout = layouts[provider.defaultPerspectiveId];
            if (defaultLayout) {
                this.storageService.setData(this.storageKey, defaultLayout).catch(error => {
                    this.logger.error('Error persisting default layout', error);
                });
            }
            this.storageService.setData(exports.PERSPECTIVE_LAYOUTS_STORAGE_KEY, undefined);
        }
        else {
            const data = { activePerspectiveId: activeId, layouts };
            this.storageService.setData(exports.PERSPECTIVE_LAYOUTS_STORAGE_KEY, data).catch(error => {
                this.logger.error('Error persisting perspective layouts, clearing stored data', error);
                this.storageService.setData(exports.PERSPECTIVE_LAYOUTS_STORAGE_KEY, undefined);
            });
            // Clear the legacy key when perspectives are in use
            this.storageService.setData(this.storageKey, undefined);
        }
    }
    async restoreLayout(app) {
        this.logger.info('>>> Restoring the layout state...');
        return this.restorePerspectiveLayouts(app);
    }
    async restorePerspectiveLayouts(app) {
        const persisted = await this.storageService.getData(exports.PERSPECTIVE_LAYOUTS_STORAGE_KEY);
        let activeId;
        if (persisted) {
            activeId = persisted.activePerspectiveId;
            // Inflate all perspective layouts, apply transforms, and push to provider
            for (const [perspId, deflated] of Object.entries(persisted.layouts)) {
                try {
                    const layout = await this.inflate(deflated);
                    this.transformations.getContributions()
                        .forEach(t => t.transformLayoutOnRestore(layout));
                    this.perspectiveService.setSavedLayout(perspId, layout);
                }
                catch (error) {
                    this.logger.warn(`Could not inflate layout for perspective '${perspId}'`, error);
                }
            }
        }
        else {
            // Migration: try legacy single-layout key. The key is deliberately left in place here:
            // `storePerspectiveLayouts` rewrites it (default perspective only) or clears it (perspectives
            // in use) on shutdown, so an unclean exit right after startup doesn't lose the layout.
            const legacyData = await this.storageService.getData(this.storageKey);
            if (legacyData) {
                try {
                    const layout = await this.inflate(legacyData);
                    this.transformations.getContributions()
                        .forEach(t => t.transformLayoutOnRestore(layout));
                    this.perspectiveService.setSavedLayout(this.perspectiveService.defaultPerspectiveId, layout);
                    activeId = this.perspectiveService.defaultPerspectiveId;
                }
                catch (error) {
                    this.logger.warn('Could not inflate legacy layout for migration', error);
                }
            }
        }
        if (activeId) {
            const accepted = this.perspectiveService.setActivePerspectiveId(activeId);
            if (!accepted) {
                activeId = this.perspectiveService.getActivePerspectiveId();
            }
        }
        // Apply the active perspective's layout to the shell
        const effectiveId = activeId ?? this.perspectiveService.getActivePerspectiveId();
        let activeLayout = this.perspectiveService.getSavedLayout(effectiveId);
        // Fallback: if the active perspective has no saved layout, try the default
        if (!activeLayout && effectiveId !== this.perspectiveService.defaultPerspectiveId) {
            this.logger.warn(`No saved layout for perspective '${effectiveId}', falling back to default.`);
            const defaultId = this.perspectiveService.defaultPerspectiveId;
            this.perspectiveService.setActivePerspectiveId(defaultId);
            activeLayout = this.perspectiveService.getSavedLayout(defaultId);
        }
        if (activeLayout) {
            await app.shell.setLayoutData(activeLayout);
            const restoredId = this.perspectiveService.getActivePerspectiveId();
            this.perspectiveService.onLayoutRestored(restoredId);
            this.logger.info('<<< The layout has been successfully restored.');
            return true;
        }
        // Even with no layout to restore, ensure chrome is applied for whatever perspective is active
        this.perspectiveService.onLayoutRestored(this.perspectiveService.getActivePerspectiveId());
        this.logger.info('<<< Nothing to restore.');
        return false;
    }
    isWidgetProperty(propertyName) {
        return propertyName === 'widget';
    }
    isWidgetsProperty(propertyName) {
        return propertyName === 'widgets';
    }
    /**
     * Turns the layout data to a string representation.
     */
    deflate(data) {
        return JSON.stringify(data, (property, value) => {
            if (this.isWidgetProperty(property)) {
                const description = this.convertToDescription(value);
                return description;
            }
            else if (this.isWidgetsProperty(property)) {
                const descriptions = [];
                for (const widget of value) {
                    const description = this.convertToDescription(widget);
                    if (description) {
                        descriptions.push(description);
                    }
                }
                return descriptions;
            }
            return value;
        });
    }
    convertToDescription(widget) {
        const desc = this.widgetManager.getDescription(widget);
        if (desc) {
            if (StatefulWidget.is(widget)) {
                const innerState = widget.storeState();
                return innerState ? {
                    constructionOptions: desc,
                    innerWidgetState: this.deflate(innerState)
                } : undefined;
            }
            else {
                return {
                    constructionOptions: desc,
                    innerWidgetState: undefined
                };
            }
        }
    }
    /**
     * Creates the layout data from its string representation.
     */
    async inflate(layoutData) {
        const parseContext = new ShellLayoutRestorer_1.ParseContext();
        const layout = this.parse(layoutData, parseContext);
        const layoutVersion = Number(layout.version);
        if (typeof layoutVersion !== 'number' || Number.isNaN(layoutVersion)) {
            throw new Error('could not resolve a layout version');
        }
        if (layoutVersion !== application_shell_1.applicationShellLayoutVersion) {
            if (layoutVersion < application_shell_1.applicationShellLayoutVersion) {
                this.logger.warn(`Layout version ${layoutVersion} is behind current layout version ${application_shell_1.applicationShellLayoutVersion}, trying to migrate...`);
            }
            else {
                this.logger.warn(`Layout version ${layoutVersion} is ahead current layout version ${application_shell_1.applicationShellLayoutVersion}, trying to load anyway...`);
            }
            this.logger.info(`Please use '${exports.RESET_LAYOUT.label}' command if the layout looks bogus.`);
        }
        const migrations = this.migrations.getContributions()
            .filter(m => m.layoutVersion > layoutVersion && m.layoutVersion <= application_shell_1.applicationShellLayoutVersion)
            .sort((m, m2) => m.layoutVersion - m2.layoutVersion);
        if (migrations.length) {
            this.logger.info(`Found ${migrations.length} migrations from layout version ${layoutVersion} to version ${application_shell_1.applicationShellLayoutVersion}, migrating...`);
        }
        const context = { layout, layoutVersion, migrations };
        await this.fireWillInflateLayout(context);
        await parseContext.inflate(context);
        return layout;
    }
    async fireWillInflateLayout(context) {
        for (const migration of context.migrations) {
            if (migration.onWillInflateLayout) {
                // don't catch exceptions, if one migration fails all should fail.
                await migration.onWillInflateLayout(context);
            }
        }
    }
    parse(layoutData, parseContext) {
        return JSON.parse(layoutData, (property, value) => {
            if (this.isWidgetsProperty(property)) {
                const widgets = parseContext.filteredArray();
                const descs = value;
                for (let i = 0; i < descs.length; i++) {
                    parseContext.push(async (context) => {
                        widgets[i] = await this.convertToWidget(descs[i], context);
                    });
                }
                return widgets;
            }
            else if ((0, common_1.isObject)(value) && !Array.isArray(value)) {
                const copy = {};
                for (const p in value) {
                    if (this.isWidgetProperty(p)) {
                        parseContext.push(async (context) => {
                            copy[p] = await this.convertToWidget(value[p], context);
                        });
                    }
                    else {
                        copy[p] = value[p];
                    }
                }
                return copy;
            }
            return value;
        });
    }
    async fireWillInflateWidget(desc, context) {
        for (const migration of context.migrations) {
            if (migration.onWillInflateWidget) {
                // don't catch exceptions, if one migration fails all should fail.
                const migrated = await migration.onWillInflateWidget(desc, context);
                if (migrated) {
                    if ((0, common_1.isObject)(migrated.innerWidgetState)) {
                        // in order to inflate nested widgets
                        migrated.innerWidgetState = JSON.stringify(migrated.innerWidgetState);
                    }
                    desc = migrated;
                }
            }
        }
        return desc;
    }
    async convertToWidget(desc, context) {
        if (!desc.constructionOptions) {
            return undefined;
        }
        try {
            desc = await this.fireWillInflateWidget(desc, context);
            const widget = await this.widgetManager.getOrCreateWidget(desc.constructionOptions.factoryId, desc.constructionOptions.options);
            if (StatefulWidget.is(widget) && desc.innerWidgetState !== undefined) {
                try {
                    let oldState;
                    if (typeof desc.innerWidgetState === 'string') {
                        const parseContext = new ShellLayoutRestorer_1.ParseContext();
                        oldState = this.parse(desc.innerWidgetState, parseContext);
                        await parseContext.inflate({ ...context, parent: widget });
                    }
                    else {
                        oldState = desc.innerWidgetState;
                    }
                    widget.restoreState(oldState);
                }
                catch (e) {
                    if (ApplicationShellLayoutMigrationError.is(e)) {
                        throw e;
                    }
                    this.logger.warn(`Couldn't restore widget state for ${widget.id}. Error: ${e} `);
                }
            }
            if (widget.isDisposed) {
                return undefined;
            }
            return widget;
        }
        catch (e) {
            if (ApplicationShellLayoutMigrationError.is(e)) {
                throw e;
            }
            this.logger.warn(`Couldn't restore widget for ${desc.constructionOptions.factoryId}. Error: ${e} `);
            return undefined;
        }
    }
};
exports.ShellLayoutRestorer = ShellLayoutRestorer;
tslib_1.__decorate([
    (0, inversify_1.inject)(contribution_provider_1.ContributionProvider),
    (0, inversify_1.named)(exports.ApplicationShellLayoutMigration),
    tslib_1.__metadata("design:type", Object)
], ShellLayoutRestorer.prototype, "migrations", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(contribution_provider_1.ContributionProvider),
    (0, inversify_1.named)(exports.ShellLayoutTransformer),
    tslib_1.__metadata("design:type", Object)
], ShellLayoutRestorer.prototype, "transformations", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(window_service_1.WindowService),
    tslib_1.__metadata("design:type", Object)
], ShellLayoutRestorer.prototype, "windowService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(theming_1.ThemeService),
    tslib_1.__metadata("design:type", theming_1.ThemeService)
], ShellLayoutRestorer.prototype, "themeService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(perspective_service_1.PerspectiveServiceInternal),
    tslib_1.__metadata("design:type", Object)
], ShellLayoutRestorer.prototype, "perspectiveService", void 0);
exports.ShellLayoutRestorer = ShellLayoutRestorer = ShellLayoutRestorer_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(widget_manager_1.WidgetManager)),
    tslib_1.__param(1, (0, inversify_1.inject)(logger_1.ILogger)),
    tslib_1.__param(1, (0, inversify_1.named)('core:ShellLayoutRestorer')),
    tslib_1.__param(2, (0, inversify_1.inject)(storage_service_1.StorageService)),
    tslib_1.__metadata("design:paramtypes", [widget_manager_1.WidgetManager, Object, Object])
], ShellLayoutRestorer);
(function (ShellLayoutRestorer) {
    class ParseContext {
        constructor() {
            this.toInflate = [];
            this.toFilter = [];
        }
        /**
         * Returns an array, which will be filtered from undefined elements
         * after resolving promises, that create widgets.
         */
        filteredArray() {
            const array = [];
            this.toFilter.push(array);
            return array;
        }
        push(toInflate) {
            this.toInflate.push(toInflate);
        }
        async inflate(context) {
            const pending = [];
            while (this.toInflate.length) {
                pending.push(this.toInflate.pop()(context));
            }
            await Promise.all(pending);
            if (this.toFilter.length) {
                this.toFilter.forEach(array => {
                    for (let i = 0; i < array.length; i++) {
                        if (array[i] === undefined) {
                            array.splice(i--, 1);
                        }
                    }
                });
            }
        }
    }
    ShellLayoutRestorer.ParseContext = ParseContext;
})(ShellLayoutRestorer || (exports.ShellLayoutRestorer = ShellLayoutRestorer = {}));
//# sourceMappingURL=shell-layout-restorer.js.map