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
exports.NotebookContextManager = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const core_1 = require("@theia/core");
const notebook_kernel_service_1 = require("./notebook-kernel-service");
const notebook_context_keys_1 = require("../contributions/notebook-context-keys");
const common_1 = require("../../common");
const notebook_execution_state_service_1 = require("./notebook-execution-state-service");
let NotebookContextManager = class NotebookContextManager {
    constructor() {
        this.toDispose = new core_1.DisposableCollection();
        this.cellContexts = new Map();
        this.cellDisposables = new core_1.DisposableCollection();
    }
    get context() {
        return this._context;
    }
    init(widget) {
        this._context = widget.node;
        this.scopedStore = this.contextKeyService.createScoped(widget.node);
        this.toDispose.dispose();
        this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_VIEW_TYPE, widget?.notebookType);
        this.notebookViewModel = widget.viewModel;
        // Kernel related keys
        const kernel = widget?.model ? this.notebookKernelService.getSelectedNotebookKernel(widget.model) : undefined;
        this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_KERNEL_SELECTED, !!kernel);
        this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_KERNEL, kernel?.id);
        this.toDispose.push(this.notebookKernelService.onDidChangeSelectedKernel(e => {
            if (e.notebook.toString() === widget?.getResourceUri()?.toString()) {
                this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_KERNEL_SELECTED, !!e.newKernel);
                this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_KERNEL, e.newKernel);
            }
        }));
        widget.model?.onDidChangeContent(events => {
            if (events.some(e => e.kind === common_1.NotebookCellsChangeType.ModelChange || e.kind === common_1.NotebookCellsChangeType.Output)) {
                this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_HAS_OUTPUTS, widget.model?.cells.some(cell => cell.outputs.length > 0));
            }
        });
        this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_HAS_OUTPUTS, !!widget.model?.cells.find(cell => cell.outputs.length > 0));
        // Cell Selection related keys
        this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_FOCUSED, !!widget.viewModel.selectedCell);
        this.selectedCellChanged(widget.viewModel.selectedCell);
        widget.viewModel.onDidChangeSelectedCell(e => {
            this.selectedCellChanged(e.cell);
            this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_FOCUSED, !!e);
        });
        this.toDispose.push(this.executionStateService.onDidChangeExecution(e => {
            if (e.notebook.toString() === widget.model?.uri.toString()) {
                this.setCellContext(e.cellHandle, notebook_context_keys_1.NOTEBOOK_CELL_EXECUTING, !!e.changed);
                this.setCellContext(e.cellHandle, notebook_context_keys_1.NOTEBOOK_CELL_EXECUTION_STATE, e.changed?.state ?? 'idle');
            }
        }));
        widget.onDidChangeOutputInputFocus(focus => {
            this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_OUTPUT_INPUT_FOCUSED, focus);
        });
    }
    selectedCellChanged(cell) {
        this.cellDisposables.dispose();
        this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_TYPE, cell ? cell.cellKind === common_1.CellKind.Code ? 'code' : 'markdown' : undefined);
        if (cell) {
            const cellViewModel = this.notebookViewModel.cellViewModels.get(cell.handle);
            this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_MARKDOWN_EDIT_MODE, cellViewModel?.editing);
            this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_EDITABLE, cell.cellKind === common_1.CellKind.Markup && !cellViewModel?.editing);
            if (cellViewModel) {
                this.cellDisposables.push(cellViewModel.onDidRequestCellEditChange(cellEdit => {
                    this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_MARKDOWN_EDIT_MODE, cellEdit);
                    this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_EDITABLE, cell.cellKind === common_1.CellKind.Markup && !cellEdit);
                }));
            }
        }
    }
    setCellContext(cellHandle, key, value) {
        let cellContext = this.cellContexts.get(cellHandle);
        if (!cellContext) {
            cellContext = {};
            this.cellContexts.set(cellHandle, cellContext);
        }
        cellContext[key] = value;
    }
    getCellContext(cellHandle) {
        return this.contextKeyService.createOverlay(Object.entries(this.cellContexts.get(cellHandle) ?? {}));
    }
    changeCellFocus(focus) {
        this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_FOCUSED, focus);
    }
    changeCellListFocus(focus) {
        this.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_LIST_FOCUSED, focus);
    }
    createContextKeyChangedEvent(affectedKeys) {
        return { affects: keys => affectedKeys.some(key => keys.has(key)) };
    }
    dispose() {
        this.toDispose.dispose();
    }
};
exports.NotebookContextManager = NotebookContextManager;
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], NotebookContextManager.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_kernel_service_1.NotebookKernelService),
    tslib_1.__metadata("design:type", notebook_kernel_service_1.NotebookKernelService)
], NotebookContextManager.prototype, "notebookKernelService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_execution_state_service_1.NotebookExecutionStateService),
    tslib_1.__metadata("design:type", notebook_execution_state_service_1.NotebookExecutionStateService)
], NotebookContextManager.prototype, "executionStateService", void 0);
exports.NotebookContextManager = NotebookContextManager = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookContextManager);
//# sourceMappingURL=notebook-context-manager.js.map