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
exports.TextEditorSplitContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const editor_widget_1 = require("./editor-widget");
const editor_manager_1 = require("./editor-manager");
/**
 * Implementation of SplitEditorContribution for text editors (EditorWidget).
 */
let TextEditorSplitContribution = class TextEditorSplitContribution {
    canHandle(widget) {
        return widget instanceof editor_widget_1.EditorWidget ? 100 : 0;
    }
    async split(widget, splitMode) {
        const selection = widget.editor.selection;
        const newEditor = await this.editorManager.openToSide(widget.editor.uri, {
            selection,
            widgetOptions: { mode: splitMode, ref: widget }
        });
        // Preserve the view state (scroll position, etc.) from the original editor
        const oldEditorState = widget.editor.storeViewState();
        newEditor.editor.restoreViewState(oldEditorState);
        return newEditor;
    }
};
exports.TextEditorSplitContribution = TextEditorSplitContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(editor_manager_1.EditorManager),
    tslib_1.__metadata("design:type", editor_manager_1.EditorManager)
], TextEditorSplitContribution.prototype, "editorManager", void 0);
exports.TextEditorSplitContribution = TextEditorSplitContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TextEditorSplitContribution);
//# sourceMappingURL=text-editor-split-contribution.js.map