"use strict";
// *****************************************************************************
// Copyright (C) 2024 Typefox and others.
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
exports.NotebookCellEditorService = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const notebook_editor_widget_service_1 = require("./notebook-editor-widget-service");
const common_1 = require("../../common");
const monaco_editor_service_1 = require("@theia/monaco/lib/browser/monaco-editor-service");
let NotebookCellEditorService = class NotebookCellEditorService {
    constructor() {
        this.onDidChangeCellEditorsEmitter = new core_1.Emitter();
        this.onDidChangeCellEditors = this.onDidChangeCellEditorsEmitter.event;
        this.onDidChangeFocusedCellEditorEmitter = new core_1.Emitter();
        this.onDidChangeFocusedCellEditor = this.onDidChangeFocusedCellEditorEmitter.event;
        this.currentCellEditors = new Map();
    }
    init() {
        this.notebookEditorWidgetService.onDidChangeCurrentEditor(editor => {
            // if defocus notebook editor or another notebook editor is focused, clear the active cell
            if (!editor || (this.currentActiveCell && common_1.CellUri.parse(this.currentActiveCell.uri)?.notebook.toString() !== editor?.model?.uri.toString())) {
                this.currentActiveCell = undefined;
                // eslint-disable-next-line no-null/no-null
                this.monacoEditorService.setActiveCodeEditor(null);
                this.onDidChangeFocusedCellEditorEmitter.fire(undefined);
            }
        });
    }
    get allCellEditors() {
        return Array.from(this.currentCellEditors.values());
    }
    editorCreated(uri, editor) {
        this.currentCellEditors.set(uri.toString(), editor);
        this.onDidChangeCellEditorsEmitter.fire();
    }
    editorDisposed(uri) {
        this.currentCellEditors.delete(uri.toString());
        this.onDidChangeCellEditorsEmitter.fire();
    }
    editorFocusChanged(editor) {
        if (editor) {
            this.currentActiveCell = editor;
            this.monacoEditorService.setActiveCodeEditor(editor.getControl());
            this.onDidChangeFocusedCellEditorEmitter.fire(editor);
        }
    }
    getActiveCell() {
        return this.currentActiveCell;
    }
    getActiveEditor() {
        return this.getActiveCell()?.getControl();
    }
};
exports.NotebookCellEditorService = NotebookCellEditorService;
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_editor_widget_service_1.NotebookEditorWidgetService),
    tslib_1.__metadata("design:type", notebook_editor_widget_service_1.NotebookEditorWidgetService)
], NotebookCellEditorService.prototype, "notebookEditorWidgetService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_editor_service_1.MonacoEditorService),
    tslib_1.__metadata("design:type", monaco_editor_service_1.MonacoEditorService)
], NotebookCellEditorService.prototype, "monacoEditorService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], NotebookCellEditorService.prototype, "init", null);
exports.NotebookCellEditorService = NotebookCellEditorService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookCellEditorService);
//# sourceMappingURL=notebook-cell-editor-service.js.map