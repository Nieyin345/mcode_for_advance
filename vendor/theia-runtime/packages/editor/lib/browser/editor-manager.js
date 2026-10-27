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
exports.ActiveEditorAccess = exports.CurrentEditorAccess = exports.EditorAccess = exports.EditorManager = exports.EditorSelectionResolver = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const browser_1 = require("@theia/core/lib/browser");
const editor_widget_1 = require("./editor-widget");
const editor_1 = require("./editor");
const editor_widget_factory_1 = require("./editor-widget-factory");
const navigation_location_service_1 = require("./navigation/navigation-location-service");
const preferences_1 = require("@theia/core/lib/common/preferences");
const core_1 = require("@theia/core");
exports.EditorSelectionResolver = Symbol('EditorSelectionResolver');
let EditorManager = class EditorManager extends browser_1.NavigatableWidgetOpenHandler {
    constructor() {
        super(...arguments);
        this.id = editor_widget_factory_1.EditorWidgetFactory.ID;
        this.label = common_1.nls.localizeByDefault('Text Editor');
        this.onActiveEditorChangedEmitter = new common_1.Emitter();
        /**
         * Emit when the active editor is changed.
         */
        this.onActiveEditorChanged = this.onActiveEditorChangedEmitter.event;
        this.onCurrentEditorChangedEmitter = new common_1.Emitter();
        /**
         * Emit when the current editor is changed.
         */
        this.onCurrentEditorChanged = this.onCurrentEditorChangedEmitter.event;
        this.selectionResolvers = [];
        this.recentlyVisibleEditors = [];
    }
    init() {
        super.init();
        this.selectionResolvers = common_1.Prioritizeable.prioritizeAllSync(this.resolverContributions.getContributions(), resolver => resolver.priority ?? 0).map(p => p.value);
        this.shell.onDidChangeActiveWidget(() => this.updateActiveEditor());
        this.shell.onDidChangeCurrentWidget(() => this.updateCurrentEditor());
        this.shell.onDidDoubleClickMainArea(() => this.commands.executeCommand(browser_1.CommonCommands.NEW_UNTITLED_TEXT_FILE.id));
        this.onCreated(widget => {
            widget.onDidChangeVisibility(() => {
                if (widget.isVisible) {
                    this.addRecentlyVisible(widget);
                }
                this.updateCurrentEditor();
            });
            widget.disposed.connect(() => {
                this.removeRecentlyVisible(widget);
                this.updateCurrentEditor();
            });
        });
        for (const widget of this.all) {
            if (widget.isVisible) {
                this.addRecentlyVisible(widget);
            }
        }
        this.updateCurrentEditor();
    }
    /**
     * Registers a dynamic selection resolver.
     * The resolver is added to the sorted list of selection resolvers and can later be disposed to remove it.
     *
     * @param resolver The selection resolver to register.
     * @returns A Disposable that unregisters the resolver when disposed.
     */
    registerSelectionResolver(resolver) {
        this.selectionResolvers.push(resolver);
        this.selectionResolvers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
        return {
            dispose: () => {
                const index = this.selectionResolvers.indexOf(resolver);
                if (index !== -1) {
                    this.selectionResolvers.splice(index, 1);
                }
            }
        };
    }
    getByUri(uri, options) {
        return this.getWidget(uri, options);
    }
    getOrCreateByUri(uri, options) {
        return this.getOrCreateWidget(uri, options);
    }
    createByUri(uri, options) {
        return this.getOrCreateByUri(uri, { ...options, counter: this.nextCounter() });
    }
    /** @deprecated since 1.72.0. Use {@link recentlyVisibleEditors} instead. */
    get recentlyVisibleIds() {
        return this.recentlyVisibleEditors.map(w => w.id);
    }
    get recentlyVisible() {
        return this.recentlyVisibleEditors[0];
    }
    addRecentlyVisible(widget) {
        this.removeRecentlyVisible(widget);
        this.recentlyVisibleEditors.unshift(widget);
    }
    removeRecentlyVisible(widget) {
        const index = this.recentlyVisibleEditors.indexOf(widget);
        if (index !== -1) {
            this.recentlyVisibleEditors.splice(index, 1);
        }
    }
    /**
     * The active editor.
     * If there is an active editor (one that has focus), active and current are the same.
     */
    get activeEditor() {
        return this._activeEditor;
    }
    setActiveEditor(active) {
        if (this._activeEditor !== active) {
            this._activeEditor = active;
            this.onActiveEditorChangedEmitter.fire(this._activeEditor);
        }
    }
    updateActiveEditor() {
        const widget = this.shell.activeWidget;
        if (widget instanceof editor_widget_1.EditorWidget) {
            this.addRecentlyVisible(widget);
            this.setActiveEditor(widget);
        }
        else {
            this.setActiveEditor(undefined);
        }
    }
    /**
     * The most recently activated editor (which might not have the focus anymore, hence it is not active).
     * If no editor has focus, e.g. when a context menu is shown, the active editor is `undefined`, but current might be the editor that was active before the menu popped up.
     */
    get currentEditor() {
        return this._currentEditor;
    }
    setCurrentEditor(current) {
        if (this._currentEditor !== current) {
            this._currentEditor = current;
            this.onCurrentEditorChangedEmitter.fire(this._currentEditor);
        }
    }
    updateCurrentEditor() {
        const widget = this.shell.currentWidget;
        if (widget instanceof editor_widget_1.EditorWidget) {
            this.setCurrentEditor(widget);
        }
        else if (!this._currentEditor || !this._currentEditor.isVisible || this.currentEditor !== this.recentlyVisible) {
            this.setCurrentEditor(this.recentlyVisible);
        }
    }
    canHandle(uri, options) {
        if (browser_1.DiffUris.isDiffUri(uri)) {
            const [/* left */ , right] = browser_1.DiffUris.decode(uri);
            uri = right;
        }
        if ((0, browser_1.getDefaultHandler)(uri, this.preferenceService) === 'default') {
            return browser_1.defaultHandlerPriority;
        }
        return 100;
    }
    async open(uri, options) {
        this.navigationLocationService.startNavigation();
        try {
            if (options?.counter === undefined) {
                const insertionOptions = this.shell.getInsertionOptions(options?.widgetOptions);
                // Definitely creating a new tabbar - no widget can match.
                if (insertionOptions.addOptions.mode?.startsWith('split')) {
                    return await super.open(uri, { counter: this.nextCounter(), ...options });
                }
                // Check the target tabbar for an existing widget.
                const tabbar = insertionOptions.addOptions.ref && this.shell.getTabBarFor(insertionOptions.addOptions.ref);
                if (tabbar) {
                    // Note: there can be multiple editor widgets with the given URI in the target tabbar
                    // (e.g., a regular editor widget and an editor widget within the 3-way merge editor).
                    // Try to find the most recently visible editor widget with the given URI in the target tabbar.
                    const currentUri = uri.toString();
                    const predicate = (widget) => widget.editor.uri.toString() === currentUri && tabbar.titles.find(title => title.owner.contains(widget));
                    const existingWidget = this.recentlyVisibleEditors.find(predicate) ?? this.all.find(predicate);
                    if (existingWidget) {
                        const { id } = this.extractIdFromWidget(existingWidget);
                        return await super.open(uri, { counter: id, ...options });
                    }
                }
                // If the user has opted to prefer to open an existing editor even if it's on a different tab, check if we have anything about the URI.
                if (this.preferenceService.get('workbench.editor.revealIfOpen', false)) {
                    const counter = this.getCounterForUri(uri);
                    if (counter !== undefined) {
                        return await super.open(uri, { counter, ...options });
                    }
                }
                // Open a new widget.
                return await super.open(uri, { counter: this.nextCounter(), ...options });
            }
            return await super.open(uri, options);
        }
        finally {
            this.navigationLocationService.endNavigation();
        }
    }
    /**
     * Opens an editor to the side of the current editor. Defaults to opening to the right.
     * To modify direction, pass options with `{widgetOptions: {mode: ...}}`
     */
    openToSide(uri, options) {
        const counter = this.nextCounter();
        const splitOptions = { widgetOptions: { mode: 'split-right' }, ...options, counter };
        return this.open(uri, splitOptions);
    }
    async doOpen(widget, uri, options) {
        await super.doOpen(widget, uri, options);
        await this.revealSelection(widget, uri, options);
    }
    async revealSelection(widget, uri, options) {
        let inputSelection = options?.selection;
        if (!inputSelection) {
            inputSelection = await this.resolveSelection(widget, options ?? {}, uri);
        }
        // this logic could be moved into a 'EditorSelectionResolver'
        if (!inputSelection && uri) {
            // support file:///some/file.js#73,84
            // support file:///some/file.js#L73
            const match = /^L?(\d+)(?:,(\d+))?/.exec(uri.fragment);
            if (match) {
                inputSelection = {
                    start: {
                        line: parseInt(match[1]) - 1,
                        character: match[2] ? parseInt(match[2]) - 1 : 0
                    }
                };
            }
        }
        if (inputSelection) {
            const selection = this.getSelection(widget, inputSelection);
            const editor = widget.editor;
            if (editor_1.Position.is(selection)) {
                editor.cursor = selection;
                editor.revealPosition(selection, { vertical: options?.revealOption ?? 'center' });
            }
            else if (editor_1.Range.is(selection)) {
                editor.cursor = selection.end;
                editor.selection = { ...selection, direction: 'ltr' };
                editor.revealRange(selection, { at: options?.revealOption ?? 'center' });
            }
        }
    }
    async resolveSelection(widget, options, uri) {
        if (options.selection) {
            return options.selection;
        }
        for (const resolver of this.selectionResolvers) {
            try {
                const selection = await resolver.resolveSelection(widget, options, uri);
                if (selection) {
                    return selection;
                }
            }
            catch (error) {
                this.logger.error(error);
            }
        }
        return undefined;
    }
    getSelection(widget, selection) {
        const { start, end } = selection;
        if (editor_1.Position.is(start)) {
            if (editor_1.Position.is(end)) {
                return widget.editor.document.toValidRange({ start, end });
            }
            return widget.editor.document.toValidPosition(start);
        }
        const line = start && start.line !== undefined && start.line >= 0 ? start.line : undefined;
        if (line === undefined) {
            return undefined;
        }
        const character = start && start.character !== undefined && start.character >= 0 ? start.character : widget.editor.document.getLineMaxColumn(line);
        const endLine = end && end.line !== undefined && end.line >= 0 ? end.line : undefined;
        if (endLine === undefined) {
            return { line, character };
        }
        const endCharacter = end && end.character !== undefined && end.character >= 0 ? end.character : widget.editor.document.getLineMaxColumn(endLine);
        return {
            start: { line, character },
            end: { line: endLine, character: endCharacter }
        };
    }
    extractIdFromWidget(widget) {
        const uri = widget.editor.uri.toString();
        const id = Number(widget.id.slice(widget.id.lastIndexOf(':') + 1));
        return { id, uri };
    }
    nextCounter() {
        return Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - 100) + 100);
    }
    getCounterForUri(uri) {
        const idWithoutCounter = editor_widget_factory_1.EditorWidgetFactory.createID(uri);
        const counterOfMostRecentlyVisibleEditor = this.recentlyVisibleEditors.find(widget => widget.id.startsWith(idWithoutCounter))?.id.slice(idWithoutCounter.length + 1);
        return counterOfMostRecentlyVisibleEditor === undefined ? undefined : parseInt(counterOfMostRecentlyVisibleEditor);
    }
    createWidgetOptions(uri, options) {
        const navigatableOptions = super.createWidgetOptions(uri, options);
        navigatableOptions.counter = options?.counter ?? this.getCounterForUri(uri) ?? this.nextCounter();
        return navigatableOptions;
    }
};
exports.EditorManager = EditorManager;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.CommandService),
    tslib_1.__metadata("design:type", Object)
], EditorManager.prototype, "commands", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preferences_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], EditorManager.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ContributionProvider),
    (0, inversify_1.named)(exports.EditorSelectionResolver),
    tslib_1.__metadata("design:type", Object)
], EditorManager.prototype, "resolverContributions", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(navigation_location_service_1.NavigationLocationService),
    tslib_1.__metadata("design:type", navigation_location_service_1.NavigationLocationService)
], EditorManager.prototype, "navigationLocationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('editor:EditorManager'),
    tslib_1.__metadata("design:type", Object)
], EditorManager.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], EditorManager.prototype, "init", null);
exports.EditorManager = EditorManager = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], EditorManager);
/**
 * Provides direct access to the underlying text editor.
 */
let EditorAccess = class EditorAccess {
    /**
     * The URI of the underlying document from the editor.
     */
    get uri() {
        const editor = this.editor;
        if (editor) {
            return editor.uri.toString();
        }
        return undefined;
    }
    /**
     * The selection location from the text editor.
     */
    get selection() {
        const editor = this.editor;
        if (editor) {
            const uri = editor.uri.toString();
            const range = editor.selection;
            return {
                range,
                uri
            };
        }
        return undefined;
    }
    /**
     * The unique identifier of the language the current editor belongs to.
     */
    get languageId() {
        const editor = this.editor;
        if (editor) {
            return editor.document.languageId;
        }
        return undefined;
    }
    /**
     * The text editor.
     */
    get editor() {
        const editorWidget = this.editorWidget();
        if (editorWidget) {
            return editorWidget.editor;
        }
        return undefined;
    }
};
exports.EditorAccess = EditorAccess;
tslib_1.__decorate([
    (0, inversify_1.inject)(EditorManager),
    tslib_1.__metadata("design:type", EditorManager)
], EditorAccess.prototype, "editorManager", void 0);
exports.EditorAccess = EditorAccess = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], EditorAccess);
/**
 * Provides direct access to the currently active text editor.
 */
let CurrentEditorAccess = class CurrentEditorAccess extends EditorAccess {
    editorWidget() {
        return this.editorManager.currentEditor;
    }
};
exports.CurrentEditorAccess = CurrentEditorAccess;
exports.CurrentEditorAccess = CurrentEditorAccess = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], CurrentEditorAccess);
/**
 * Provides access to the active text editor.
 */
let ActiveEditorAccess = class ActiveEditorAccess extends EditorAccess {
    editorWidget() {
        return this.editorManager.activeEditor;
    }
};
exports.ActiveEditorAccess = ActiveEditorAccess;
exports.ActiveEditorAccess = ActiveEditorAccess = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ActiveEditorAccess);
(function (EditorAccess) {
    EditorAccess.CURRENT = 'current-editor-access';
    EditorAccess.ACTIVE = 'active-editor-access';
})(EditorAccess || (exports.EditorAccess = EditorAccess = {}));
//# sourceMappingURL=editor-manager.js.map