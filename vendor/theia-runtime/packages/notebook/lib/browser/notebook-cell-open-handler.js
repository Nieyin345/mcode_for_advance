"use strict";
// *****************************************************************************
// Copyright (C) 2023 TypeFox and others.
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
exports.NotebookCellOpenHandler = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const notebook_editor_widget_service_1 = require("./service/notebook-editor-widget-service");
const common_1 = require("../common");
let NotebookCellOpenHandler = class NotebookCellOpenHandler {
    constructor() {
        this.id = 'notebook-cell-opener';
    }
    canHandle(uri, options) {
        return uri.scheme === common_1.CellUri.cellUriScheme ? 200 : 0;
    }
    open(uri, options) {
        const params = new URLSearchParams(uri.query);
        const executionCountParam = params.get('execution_count');
        const lineParam = params.get('line');
        if (!executionCountParam || !lineParam) {
            this.logger.error('Invalid vscode-notebook-cell URI: missing execution_count or line parameter', uri.toString(true));
            return;
        }
        const executionCount = parseInt(executionCountParam);
        const cell = this.notebookEditorWidgetService.currentEditor?.model?.cells
            .find(c => c.metadata.execution_count === executionCount);
        this.notebookEditorWidgetService.currentEditor?.viewModel.cellViewModels.get(cell?.handle ?? -1)?.requestFocusEditor();
    }
};
exports.NotebookCellOpenHandler = NotebookCellOpenHandler;
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_editor_widget_service_1.NotebookEditorWidgetService),
    tslib_1.__metadata("design:type", notebook_editor_widget_service_1.NotebookEditorWidgetService)
], NotebookCellOpenHandler.prototype, "notebookEditorWidgetService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('notebook:NotebookCellOpenHandler'),
    tslib_1.__metadata("design:type", Object)
], NotebookCellOpenHandler.prototype, "logger", void 0);
exports.NotebookCellOpenHandler = NotebookCellOpenHandler = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookCellOpenHandler);
//# sourceMappingURL=notebook-cell-open-handler.js.map