"use strict";
// *****************************************************************************
// Copyright (C) 2018-2021 Google and others.
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
exports.EditorPreviewManager = void 0;
const tslib_1 = require("tslib");
const browser_1 = require("@theia/editor/lib/browser");
const inversify_1 = require("@theia/core/shared/inversify");
const editor_preview_preferences_1 = require("../common/editor-preview-preferences");
const editor_preview_widget_factory_1 = require("./editor-preview-widget-factory");
const preview_tab_widget_1 = require("./preview-tab-widget");
const frontend_application_state_1 = require("@theia/core/lib/browser/frontend-application-state");
let EditorPreviewManager = class EditorPreviewManager extends browser_1.EditorManager {
    constructor() {
        super(...arguments);
        this.id = editor_preview_widget_factory_1.EditorPreviewWidgetFactory.ID;
        /**
         * Until the layout has been restored, widget state is not reliable, so we ignore creation events.
         */
        this.layoutIsSet = false;
    }
    init() {
        super.init();
        // All editors are created, but not all are opened. This sets up the logic to swap previews when the editor is attached.
        this.onCreated((widget) => {
            if (this.layoutIsSet && widget.isPreview) {
                const oneTimeDisposable = widget.onDidChangeVisibility(() => {
                    this.handleNewPreview(widget);
                    oneTimeDisposable.dispose();
                });
            }
        });
        this.preferences.onPreferenceChanged(change => {
            if (change.preferenceName === editor_preview_preferences_1.ENABLE_PREVIEW_PREFERENCE && !this.preferences[editor_preview_preferences_1.ENABLE_PREVIEW_PREFERENCE]) {
                this.shell.widgets.forEach(widget => {
                    if (preview_tab_widget_1.PreviewTabWidget.is(widget) && widget.isPreview) {
                        widget.convertToNonPreview();
                    }
                });
            }
        });
        this.stateService.reachedState('initialized_layout').then(() => {
            const editors = this.all;
            const currentPreview = editors.find(editor => editor.isPreview);
            if (currentPreview) {
                this.handleNewPreview(currentPreview);
            }
            this.layoutIsSet = true;
        });
        document.addEventListener('dblclick', this.convertEditorOnDoubleClick.bind(this));
    }
    async doOpen(widget, uri, options) {
        const { preview, widgetOptions = { area: 'main' }, mode = 'activate' } = options ?? {};
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, widgetOptions);
        }
        else if (!preview && widget.isPreview) {
            widget.convertToNonPreview();
        }
        if (mode === 'activate') {
            await this.shell.activateWidget(widget.id);
        }
        else if (mode === 'reveal') {
            await this.shell.revealWidget(widget.id);
        }
        await this.revealSelection(widget, uri, options);
    }
    handleNewPreview(newPreviewWidget) {
        preview_tab_widget_1.PreviewTabWidget.disposeOtherPreviews(this.shell, newPreviewWidget);
    }
    tryGetPendingWidget(uri, options) {
        return super.tryGetPendingWidget(uri, { ...options, preview: true }) ??
            super.tryGetPendingWidget(uri, { ...options, preview: false });
    }
    async getWidget(uri, options) {
        return (await super.getWidget(uri, { ...options, preview: true })) ?? super.getWidget(uri, { ...options, preview: false });
    }
    async getOrCreateWidget(uri, options) {
        return this.tryGetPendingWidget(uri, options) ?? super.getOrCreateWidget(uri, options);
    }
    createWidgetOptions(uri, options) {
        const navigatableOptions = super.createWidgetOptions(uri, options);
        navigatableOptions.preview = !!(options?.preview && this.preferences[editor_preview_preferences_1.ENABLE_PREVIEW_PREFERENCE]);
        return navigatableOptions;
    }
    convertEditorOnDoubleClick(event) {
        const widget = this.shell.findTargetedWidget(event);
        if (preview_tab_widget_1.PreviewTabWidget.is(widget) && widget.isPreview) {
            widget.convertToNonPreview();
        }
    }
};
exports.EditorPreviewManager = EditorPreviewManager;
tslib_1.__decorate([
    (0, inversify_1.inject)(editor_preview_preferences_1.EditorPreviewPreferences),
    tslib_1.__metadata("design:type", Object)
], EditorPreviewManager.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(frontend_application_state_1.FrontendApplicationStateService),
    tslib_1.__metadata("design:type", frontend_application_state_1.FrontendApplicationStateService)
], EditorPreviewManager.prototype, "stateService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], EditorPreviewManager.prototype, "init", null);
exports.EditorPreviewManager = EditorPreviewManager = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], EditorPreviewManager);
//# sourceMappingURL=editor-preview-manager.js.map