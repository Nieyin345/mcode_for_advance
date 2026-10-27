"use strict";
// *****************************************************************************
// Copyright (C) 2021 SAP SE or an SAP affiliate company and others.
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
exports.CustomEditorOpener = void 0;
const browser_1 = require("@theia/core/lib/browser");
const common_1 = require("../../../common");
const custom_editor_widget_1 = require("./custom-editor-widget");
const uuid_1 = require("@theia/core/lib/common/uuid");
const core_1 = require("@theia/core");
const preview_tab_widget_1 = require("@theia/editor-preview/lib/browser/preview-tab-widget");
const editor_preview_preferences_1 = require("@theia/editor-preview/lib/common/editor-preview-preferences");
const glob_1 = require("@theia/core/lib/common/glob");
const uri_components_1 = require("../../../common/uri-components");
/**
 * Schemes that never match a custom editor's `filenamePattern`, mirroring the
 * excluded schemes in VS Code's `editorResolverService#globMatchesResource`.
 * Theia has no scheme constants for `extension` and `vscode-workspace-trust`,
 * so those are referenced by their literal values.
 */
const nonMatchingSchemes = new Set([
    'extension',
    uri_components_1.Schemes.webviewPanel,
    'vscode-workspace-trust',
    uri_components_1.Schemes.vscodeSettings
]);
class CustomEditorOpener {
    constructor(editor, shell, widgetManager, editorRegistry, preferenceService) {
        this.editor = editor;
        this.shell = shell;
        this.widgetManager = widgetManager;
        this.editorRegistry = editorRegistry;
        this.preferenceService = preferenceService;
        this.onDidOpenCustomEditorEmitter = new core_1.Emitter();
        this.onDidOpenCustomEditor = this.onDidOpenCustomEditorEmitter.event;
        this.pendingWidgetPromises = new Map();
        this.id = CustomEditorOpener.toCustomEditorId(this.editor.viewType);
        this.label = this.editor.displayName;
    }
    static toCustomEditorId(editorViewType) {
        return `custom-editor-${editorViewType}`;
    }
    canHandle(uri, options) {
        let priority = 0;
        const { selector } = this.editor;
        if (browser_1.DiffUris.isDiffUri(uri)) {
            const [left, right] = browser_1.DiffUris.decode(uri);
            if (this.matches(selector, right) && this.matches(selector, left)) {
                if ((0, browser_1.getDefaultHandler)(right, this.preferenceService) === this.editor.viewType) {
                    priority = browser_1.defaultHandlerPriority;
                }
                else {
                    priority = this.getPriority();
                }
            }
        }
        else if (this.matches(selector, uri)) {
            if ((0, browser_1.getDefaultHandler)(uri, this.preferenceService) === this.editor.viewType) {
                priority = browser_1.defaultHandlerPriority;
            }
            else {
                priority = this.getPriority();
            }
        }
        return priority;
    }
    canOpenWith(uri) {
        if (this.matches(this.editor.selector, uri)) {
            return this.getPriority();
        }
        return 0;
    }
    getPriority() {
        switch (this.editor.priority) {
            case common_1.CustomEditorPriority.default: return 500;
            case common_1.CustomEditorPriority.builtin: return 400;
            /** `option` should not open the custom-editor by default. */
            case common_1.CustomEditorPriority.option: return 1;
            default: return 200;
        }
    }
    async openCustomEditor(uri, options) {
        let widget;
        let isNewWidget = false;
        const uriString = uri.toString();
        const preview = this.isPreviewEnabled(options);
        let widgetPromise = this.pendingWidgetPromises.get(uriString);
        if (widgetPromise) {
            widget = await widgetPromise;
        }
        else {
            const widgets = this.widgetManager.getWidgets(custom_editor_widget_1.CustomEditorWidget.FACTORY_ID);
            widget = widgets.find(w => w.viewType === this.editor.viewType && w.resource.toString() === uriString);
            if (!widget) {
                isNewWidget = true;
                const id = (0, uuid_1.generateUuid)();
                widgetPromise = this.widgetManager.getOrCreateWidget(custom_editor_widget_1.CustomEditorWidget.FACTORY_ID, { id }).then(async (w) => {
                    try {
                        w.viewType = this.editor.viewType;
                        w.resource = uri;
                        w.updateID();
                        if (preview) {
                            w.initializePreview();
                        }
                        await this.editorRegistry.resolveWidget(w);
                        if (options?.widgetOptions) {
                            await this.shell.addWidget(w, options.widgetOptions);
                            if (preview) {
                                // Dispose the superseded preview as soon as the new preview tab attaches.
                                preview_tab_widget_1.PreviewTabWidget.disposeOtherPreviews(this.shell, w);
                            }
                        }
                        return w;
                    }
                    catch (e) {
                        w.dispose();
                        throw e;
                    }
                }).finally(() => this.pendingWidgetPromises.delete(uriString));
                this.pendingWidgetPromises.set(uriString, widgetPromise);
                widget = await widgetPromise;
            }
        }
        if (!isNewWidget && !preview && widget.isPreview) {
            widget.convertToNonPreview();
        }
        if (options?.mode === 'activate') {
            await this.shell.activateWidget(widget.id);
        }
        else if (options?.mode === 'reveal') {
            await this.shell.revealWidget(widget.id);
        }
        if (isNewWidget) {
            this.onDidOpenCustomEditorEmitter.fire([widget, options]);
        }
        return widget;
    }
    isPreviewEnabled(options) {
        return !!options?.preview && !!this.preferenceService.get(editor_preview_preferences_1.ENABLE_PREVIEW_PREFERENCE);
    }
    async openSideBySide(uri, options) {
        const [leftUri, rightUri] = browser_1.DiffUris.decode(uri);
        const widget = await this.widgetManager.getOrCreateWidget(custom_editor_widget_1.CustomEditorWidget.SIDE_BY_SIDE_FACTORY_ID, { uri: uri.toString(), viewType: this.editor.viewType });
        if (!widget.panes.length) { // a new widget
            const trackedDisposables = new core_1.DisposableCollection(widget);
            try {
                const createPane = async (paneUri) => {
                    let pane = await this.openCustomEditor(paneUri);
                    if (pane.isAttached) {
                        await this.shell.closeWidget(pane.id);
                        if (!pane.isDisposed) { // user canceled
                            return undefined;
                        }
                        pane = await this.openCustomEditor(paneUri);
                    }
                    return pane;
                };
                const rightPane = await createPane(rightUri);
                if (!rightPane) {
                    trackedDisposables.dispose();
                    return undefined;
                }
                trackedDisposables.push(rightPane);
                const leftPane = await createPane(leftUri);
                if (!leftPane) {
                    trackedDisposables.dispose();
                    return undefined;
                }
                trackedDisposables.push(leftPane);
                widget.addPane(leftPane);
                widget.addPane(rightPane);
                // dispose the widget if either of its panes gets externally disposed
                leftPane.disposed.connect(() => widget.dispose());
                rightPane.disposed.connect(() => widget.dispose());
                if (options?.widgetOptions) {
                    await this.shell.addWidget(widget, options.widgetOptions);
                }
            }
            catch (e) {
                trackedDisposables.dispose();
                console.error(e);
                throw e;
            }
        }
        if (options?.mode === 'activate') {
            await this.shell.activateWidget(widget.id);
        }
        else if (options?.mode === 'reveal') {
            await this.shell.revealWidget(widget.id);
        }
        return widget;
    }
    async open(uri, options) {
        options = { ...options };
        options.mode ??= 'activate';
        options.widgetOptions ??= { area: 'main' };
        return browser_1.DiffUris.isDiffUri(uri) ? this.openSideBySide(uri, options) : this.openCustomEditor(uri, options);
    }
    matches(selectors, resource) {
        return selectors.some(selector => this.selectorMatches(selector, resource));
    }
    selectorMatches(selector, resource) {
        if (nonMatchingSchemes.has(resource.scheme)) {
            // These schemes match no glob pattern, mirroring VS Code's `globMatchesResource`.
            return false;
        }
        if (selector.filenamePattern) {
            const filenamePattern = selector.filenamePattern.toLowerCase();
            // Mirror VS Code's editor-association matching (editorResolverService#globMatchesResource):
            // a pattern containing a path separator is matched against the full `scheme:path`,
            // a plain pattern is matched against the basename only.
            const target = filenamePattern.includes('/')
                ? `${resource.scheme}:${resource.path.toString()}`.toLowerCase()
                : resource.path.base.toLowerCase();
            if ((0, glob_1.match)(filenamePattern, target)) {
                return true;
            }
        }
        return false;
    }
}
exports.CustomEditorOpener = CustomEditorOpener;
//# sourceMappingURL=custom-editor-opener.js.map