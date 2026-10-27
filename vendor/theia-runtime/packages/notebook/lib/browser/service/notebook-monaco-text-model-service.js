"use strict";
// *****************************************************************************
// Copyright (C) 2024 TypeFox and others.
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
exports.NotebookMonacoTextModelService = exports.NotebookMonacoEditorModelFilter = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const monaco_text_model_service_1 = require("@theia/monaco/lib/browser/monaco-text-model-service");
const notebook_common_1 = require("../../common/notebook-common");
let NotebookMonacoEditorModelFilter = class NotebookMonacoEditorModelFilter {
    constructor() {
        this.onDidCreateCellModelEmitter = new core_1.Emitter();
    }
    get onDidCreateCellModel() {
        return this.onDidCreateCellModelEmitter.event;
    }
    filter(model) {
        const applies = model.uri.startsWith(notebook_common_1.CellUri.cellUriScheme);
        if (applies) {
            // If the model is for a notebook cell, we emit the event to notify the listeners.
            // We create our own event here, as we don't want to propagate the creation of the cell to the plugin host.
            // Instead, we want to do that ourselves once the notebook model is completely initialized.
            this.onDidCreateCellModelEmitter.fire(model);
        }
        return applies;
    }
};
exports.NotebookMonacoEditorModelFilter = NotebookMonacoEditorModelFilter;
exports.NotebookMonacoEditorModelFilter = NotebookMonacoEditorModelFilter = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookMonacoEditorModelFilter);
/**
 * special service for creating monaco textmodels for notebook cells.
 * Its for optimization purposes since there is alot of overhead otherwise with calling the backend to create a document for each cell and other smaller things.
 */
let NotebookMonacoTextModelService = class NotebookMonacoTextModelService {
    getOrCreateNotebookCellModelReference(uri) {
        return this.monacoTextModelService.createModelReference(uri);
    }
    async createTextModelsForNotebook(notebook) {
        await Promise.all(notebook.cells.map(cell => cell.resolveTextModel()));
    }
    get onDidCreateNotebookCellModel() {
        return this.notebookMonacoEditorModelFilter.onDidCreateCellModel;
    }
};
exports.NotebookMonacoTextModelService = NotebookMonacoTextModelService;
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_text_model_service_1.MonacoTextModelService),
    tslib_1.__metadata("design:type", monaco_text_model_service_1.MonacoTextModelService)
], NotebookMonacoTextModelService.prototype, "monacoTextModelService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(NotebookMonacoEditorModelFilter),
    tslib_1.__metadata("design:type", NotebookMonacoEditorModelFilter)
], NotebookMonacoTextModelService.prototype, "notebookMonacoEditorModelFilter", void 0);
exports.NotebookMonacoTextModelService = NotebookMonacoTextModelService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookMonacoTextModelService);
//# sourceMappingURL=notebook-monaco-text-model-service.js.map