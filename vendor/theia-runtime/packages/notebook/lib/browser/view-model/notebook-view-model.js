"use strict";
// *****************************************************************************
// Copyright (C) 2025 Typefox and others.
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
exports.CellViewModel = exports.NotebookViewModel = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
/**
 * Model containing the editor state/view information of a notebook editor. The actual notebook data can be found in the {@link NotebookModel}.
 */
let NotebookViewModel = class NotebookViewModel {
    constructor() {
        this.onDidChangeSelectedCellEmitter = new core_1.Emitter();
        this.onDidChangeSelectedCell = this.onDidChangeSelectedCellEmitter.event;
        // Cell handle to CellViewModel mapping
        this.cellViewModels = new Map();
    }
    get selectedCellViewModel() {
        if (this.selectedCell) {
            return this.cellViewModels.get(this.selectedCell.handle);
        }
    }
    initDataModel(model) {
        model.onDidAddOrRemoveCell(e => {
            for (const cellId of e.newCellIds || []) {
                const cell = model.getCellByHandle(cellId);
                if (cell) {
                    this.cellViewModels.set(cell.handle, new CellViewModel(cell, () => {
                        this.cellViewModels.delete(cell.handle);
                    }));
                }
            }
            if (e.newCellIds && e.newCellIds?.length > 0 && e.externalEvent) {
                const lastNewCellHandle = e.newCellIds[e.newCellIds.length - 1];
                const newSelectedCell = model.getCellByHandle(lastNewCellHandle);
                this.setSelectedCell(newSelectedCell, true);
                this.cellViewModels.get(newSelectedCell.handle)?.requestEdit();
            }
            else if (this.selectedCell && !model.getCellByHandle(this.selectedCell.handle)) {
                const newSelectedIndex = e.rawEvent.changes[e.rawEvent.changes.length - 1].start;
                const newSelectedCell = model.cells[Math.min(newSelectedIndex, model.cells.length - 1)];
                this.setSelectedCell(newSelectedCell, false);
            }
        });
        for (const cell of model.cells) {
            this.cellViewModels.set(cell.handle, new CellViewModel(cell, () => {
                this.cellViewModels.delete(cell.handle);
            }));
        }
    }
    setSelectedCell(cell, scrollIntoView = true) {
        if (this.selectedCell !== cell) {
            this.selectedCell = cell;
            this.onDidChangeSelectedCellEmitter.fire({ cell, scrollIntoView });
        }
    }
    dispose() {
        this.onDidChangeSelectedCellEmitter.dispose();
    }
};
exports.NotebookViewModel = NotebookViewModel;
exports.NotebookViewModel = NotebookViewModel = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookViewModel);
class CellViewModel {
    get editing() {
        return this._editing;
    }
    constructor(cell, onDispose) {
        this.cell = cell;
        this.onDispose = onDispose;
        this.onDidRequestCellEditChangeEmitter = new core_1.Emitter();
        this.onDidRequestCellEditChange = this.onDidRequestCellEditChangeEmitter.event;
        this.onWillFocusCellEditorEmitter = new core_1.Emitter();
        this.onWillFocusCellEditor = this.onWillFocusCellEditorEmitter.event;
        this.onWillBlurCellEditorEmitter = new core_1.Emitter();
        this.onWillBlurCellEditor = this.onWillBlurCellEditorEmitter.event;
        this._editing = false;
        cell.toDispose.push(this);
    }
    requestEdit() {
        if (this.cell.isTextModelWritable) {
            this._editing = true;
            this.onDidRequestCellEditChangeEmitter.fire(true);
        }
    }
    requestStopEdit() {
        this._editing = false;
        this.onDidRequestCellEditChangeEmitter.fire(false);
    }
    requestFocusEditor(focusRequest) {
        this.requestEdit();
        this.onWillFocusCellEditorEmitter.fire(focusRequest);
    }
    requestBlurEditor() {
        this.requestStopEdit();
        this.onWillBlurCellEditorEmitter.fire();
    }
    dispose() {
        this.onDispose();
        this.onDidRequestCellEditChangeEmitter.dispose();
    }
}
exports.CellViewModel = CellViewModel;
//# sourceMappingURL=notebook-view-model.js.map