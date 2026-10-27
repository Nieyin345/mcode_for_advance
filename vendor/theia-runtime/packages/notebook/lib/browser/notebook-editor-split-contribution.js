"use strict";
// *****************************************************************************
// Copyright (C) 2025 TypeFox and others.
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
exports.NotebookEditorSplitContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const notebook_editor_widget_1 = require("./notebook-editor-widget");
const notebook_open_handler_1 = require("./notebook-open-handler");
/**
 * Implementation of SplitEditorContribution for notebook editors (NotebookEditorWidget).
 * Delegates to NotebookOpenHandler.openToSide which handles counter management for splits.
 */
let NotebookEditorSplitContribution = class NotebookEditorSplitContribution {
    canHandle(widget) {
        return widget instanceof notebook_editor_widget_1.NotebookEditorWidget ? 100 : 0;
    }
    async split(widget, splitMode) {
        const uri = widget.getResourceUri();
        if (!uri) {
            return undefined;
        }
        const newNotebook = await this.notebookOpenHandler.openToSide(uri, {
            notebookType: widget.notebookType,
            widgetOptions: { mode: splitMode, ref: widget }
        });
        return newNotebook;
    }
};
exports.NotebookEditorSplitContribution = NotebookEditorSplitContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_open_handler_1.NotebookOpenHandler),
    tslib_1.__metadata("design:type", notebook_open_handler_1.NotebookOpenHandler)
], NotebookEditorSplitContribution.prototype, "notebookOpenHandler", void 0);
exports.NotebookEditorSplitContribution = NotebookEditorSplitContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookEditorSplitContribution);
//# sourceMappingURL=notebook-editor-split-contribution.js.map