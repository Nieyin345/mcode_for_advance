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
var CustomEditorWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomEditorWidget = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const uri_1 = require("@theia/core/lib/common/uri");
const browser_1 = require("@theia/core/lib/browser");
const saveable_service_1 = require("@theia/core/lib/browser/saveable-service");
const common_1 = require("@theia/core/lib/common");
const preview_tab_widget_1 = require("@theia/editor-preview/lib/browser/preview-tab-widget");
const webview_1 = require("../webview/webview");
let CustomEditorWidget = class CustomEditorWidget extends webview_1.WebviewWidget {
    constructor() {
        super(...arguments);
        this._modelRef = { object: undefined, dispose: () => { } };
        // ensures that saveable is available even if modelRef.object is undefined
        this.delegatingSaveable = new browser_1.DelegatingSaveable();
    }
    static { CustomEditorWidget_1 = this; }
    static { this.FACTORY_ID = 'plugin-custom-editor'; }
    static { this.SIDE_BY_SIDE_FACTORY_ID = CustomEditorWidget_1.FACTORY_ID + '.side-by-side'; }
    get isPreview() {
        return this.previewSupport.isPreview;
    }
    get onDidChangePreviewState() {
        return this.previewSupport.onDidChangePreviewState;
    }
    get modelRef() {
        return this._modelRef;
    }
    set modelRef(modelRef) {
        this._modelRef.dispose();
        this._modelRef = modelRef;
        this.delegatingSaveable.delegate = modelRef.object;
        this.doUpdateContent();
    }
    get saveable() {
        return this.delegatingSaveable;
    }
    init() {
        super.init();
        this.id = CustomEditorWidget_1.FACTORY_ID + ':' + this.identifier.id;
        this.previewSupport = new preview_tab_widget_1.PreviewTabSupport({
            title: this.title,
            saveable: this.saveable,
            toDispose: this.toDispose,
            // This tracker exists only to promote the preview on a tab-bar move; once promoted it has no further use.
            onConvertToNonPreview: () => this.tabBarTracker.dispose()
        });
        this.tabBarTracker = new browser_1.TabBarTracker(this, (oldTabBar, newTabBar) => this.previewSupport.handleTabBarChange(oldTabBar, newTabBar));
        this.toDispose.push(this.tabBarTracker);
        this.toDispose.push(this.fileService.onDidRunOperation(e => {
            if (e.isOperation(2 /* FileOperation.MOVE */)) {
                this.doMove(e.target.resource);
            }
        }));
        this.toDispose.push(common_1.Disposable.create(() => {
            if (this.selectionService.selection === this) {
                this.selectionService.selection = undefined;
            }
        }));
    }
    initializePreview() {
        this.previewSupport.initializePreview();
    }
    convertToNonPreview() {
        this.previewSupport.convertToNonPreview();
    }
    onActivateRequest(msg) {
        super.onActivateRequest(msg);
        this.selectionService.selection = this;
    }
    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        this.tabBarTracker.check();
    }
    updateID() {
        this.id = CustomEditorWidget_1.FACTORY_ID + `:${this.resource.toString()}:${this.identifier.id}`;
    }
    undo() {
        this._modelRef.object?.undo();
    }
    redo() {
        this._modelRef.object?.redo();
    }
    getResourceUri() {
        return this.resource;
    }
    createMoveToUri(resourceUri) {
        return this.resource.withPath(resourceUri.path);
    }
    storeState() {
        return {
            ...super.storeState(),
            strResource: this.resource.toString(),
            isPreview: this.isPreview
        };
    }
    restoreState(oldState) {
        const { strResource, isPreview } = oldState;
        this.resource = new uri_1.default(strResource);
        super.restoreState(oldState);
        if (isPreview) {
            this.initializePreview();
        }
    }
    onMove(handler) {
        this._moveHandler = handler;
    }
    doMove(target) {
        if (this._moveHandler) {
            this._moveHandler(target);
        }
    }
};
exports.CustomEditorWidget = CustomEditorWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ApplicationShell),
    tslib_1.__metadata("design:type", browser_1.ApplicationShell)
], CustomEditorWidget.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(saveable_service_1.SaveableService),
    tslib_1.__metadata("design:type", saveable_service_1.SaveableService)
], CustomEditorWidget.prototype, "saveService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.SelectionService),
    tslib_1.__metadata("design:type", common_1.SelectionService)
], CustomEditorWidget.prototype, "selectionService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], CustomEditorWidget.prototype, "init", null);
exports.CustomEditorWidget = CustomEditorWidget = CustomEditorWidget_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], CustomEditorWidget);
//# sourceMappingURL=custom-editor-widget.js.map