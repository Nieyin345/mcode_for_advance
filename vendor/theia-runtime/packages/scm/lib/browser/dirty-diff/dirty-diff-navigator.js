"use strict";
// *****************************************************************************
// Copyright (C) 2023 1C-Soft LLC and others.
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
exports.DirtyDiffController = exports.DirtyDiffNavigator = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const browser_1 = require("@theia/editor/lib/browser");
const monaco_editor_1 = require("@theia/monaco/lib/browser/monaco-editor");
const diff_computer_1 = require("./diff-computer");
const dirty_diff_widget_1 = require("./dirty-diff-widget");
let DirtyDiffNavigator = class DirtyDiffNavigator {
    constructor() {
        this.controllers = new Map();
    }
    init() {
        const dirtyDiffVisible = this.contextKeyService.createKey('dirtyDiffVisible', false);
        this.editorManager.onActiveEditorChanged(editorWidget => {
            dirtyDiffVisible.set(editorWidget && this.controllers.get(editorWidget.editor)?.isShowingChange());
        });
        this.editorManager.onCreated(editorWidget => {
            const { editor } = editorWidget;
            if (editor.uri.scheme !== 'file') {
                return;
            }
            const controller = this.createController(editor);
            controller.widgetFactory = props => {
                const widget = this.widgetFactory(props);
                if (widget.editor === this.editorManager.activeEditor?.editor) {
                    dirtyDiffVisible.set(true);
                }
                widget.onDidClose(() => {
                    if (widget.editor === this.editorManager.activeEditor?.editor) {
                        dirtyDiffVisible.set(false);
                    }
                });
                return widget;
            };
            this.controllers.set(editor, controller);
            editorWidget.disposed.connect(() => {
                this.controllers.delete(editor);
                controller.dispose();
            });
        });
    }
    handleDirtyDiffUpdate(update) {
        const controller = this.controllers.get(update.editor);
        controller?.handleDirtyDiffUpdate(update);
    }
    canNavigate() {
        return !!this.activeController?.canNavigate();
    }
    gotoNextChange() {
        this.activeController?.gotoNextChange();
    }
    gotoPreviousChange() {
        this.activeController?.gotoPreviousChange();
    }
    canShowChange() {
        return !!this.activeController?.canShowChange();
    }
    showNextChange() {
        this.activeController?.showNextChange();
    }
    showPreviousChange() {
        this.activeController?.showPreviousChange();
    }
    isShowingChange() {
        return !!this.activeController?.isShowingChange();
    }
    closeChangePeekView() {
        this.activeController?.closeWidget();
    }
    get activeController() {
        const editor = this.editorManager.activeEditor?.editor;
        return editor && this.controllers.get(editor);
    }
    createController(editor) {
        return new DirtyDiffController(editor);
    }
};
exports.DirtyDiffNavigator = DirtyDiffNavigator;
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], DirtyDiffNavigator.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.EditorManager),
    tslib_1.__metadata("design:type", browser_1.EditorManager)
], DirtyDiffNavigator.prototype, "editorManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(dirty_diff_widget_1.DirtyDiffWidgetFactory),
    tslib_1.__metadata("design:type", Function)
], DirtyDiffNavigator.prototype, "widgetFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DirtyDiffNavigator.prototype, "init", null);
exports.DirtyDiffNavigator = DirtyDiffNavigator = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DirtyDiffNavigator);
class DirtyDiffController {
    constructor(editor) {
        this.editor = editor;
        this.toDispose = new core_1.DisposableCollection();
        editor.onMouseDown(this.handleEditorMouseDown, this, this.toDispose);
    }
    dispose() {
        this.closeWidget();
        this.toDispose.dispose();
    }
    handleDirtyDiffUpdate(dirtyDiff) {
        if (dirtyDiff.editor === this.editor) {
            this.dirtyDiff = dirtyDiff;
            if (this.widget) {
                this.widget.changes = dirtyDiff.changes;
            }
        }
    }
    canNavigate() {
        return !!this.changes?.length;
    }
    gotoNextChange() {
        const { editor } = this;
        const index = this.findNextClosestChange(editor.cursor.line, false);
        const change = this.changes?.[index];
        if (change) {
            const position = diff_computer_1.LineRange.getStartPosition(change.currentRange);
            editor.cursor = position;
            editor.revealPosition(position, { vertical: 'auto' });
        }
    }
    gotoPreviousChange() {
        const { editor } = this;
        const index = this.findPreviousClosestChange(editor.cursor.line, false);
        const change = this.changes?.[index];
        if (change) {
            const position = diff_computer_1.LineRange.getStartPosition(change.currentRange);
            editor.cursor = position;
            editor.revealPosition(position, { vertical: 'auto' });
        }
    }
    canShowChange() {
        return !!(this.widget || this.widgetFactory && this.editor instanceof monaco_editor_1.MonacoEditor && this.changes?.length && this.previousRevisionUri);
    }
    showNextChange() {
        if (this.widget) {
            this.widget.showNextChange();
        }
        else {
            (this.widget = this.createWidget())?.showChange(this.findNextClosestChange(this.editor.cursor.line, true));
        }
    }
    showPreviousChange() {
        if (this.widget) {
            this.widget.showPreviousChange();
        }
        else {
            (this.widget = this.createWidget())?.showChange(this.findPreviousClosestChange(this.editor.cursor.line, true));
        }
    }
    isShowingChange() {
        return !!this.widget;
    }
    closeWidget() {
        if (this.widget) {
            this.widget.dispose();
            this.widget = undefined;
        }
    }
    get changes() {
        return this.dirtyDiff?.changes;
    }
    get previousRevisionUri() {
        return this.dirtyDiff?.previousRevisionUri;
    }
    createWidget() {
        const { widgetFactory, editor, changes, previousRevisionUri } = this;
        if (widgetFactory && editor instanceof monaco_editor_1.MonacoEditor && changes?.length && previousRevisionUri) {
            const widget = widgetFactory({ editor, previousRevisionUri });
            widget.changes = changes;
            widget.onDidClose(() => {
                this.widget = undefined;
            });
            return widget;
        }
    }
    findNextClosestChange(line, inclusive) {
        const length = this.changes?.length;
        if (!length) {
            return -1;
        }
        for (let i = 0; i < length; i++) {
            const { currentRange } = this.changes[i];
            if (inclusive) {
                if (diff_computer_1.LineRange.getEndPosition(currentRange).line >= line) {
                    return i;
                }
            }
            else {
                if (diff_computer_1.LineRange.getStartPosition(currentRange).line > line) {
                    return i;
                }
            }
        }
        return 0;
    }
    findPreviousClosestChange(line, inclusive) {
        const length = this.changes?.length;
        if (!length) {
            return -1;
        }
        for (let i = length - 1; i >= 0; i--) {
            const { currentRange } = this.changes[i];
            if (inclusive) {
                if (diff_computer_1.LineRange.getStartPosition(currentRange).line <= line) {
                    return i;
                }
            }
            else {
                if (diff_computer_1.LineRange.getEndPosition(currentRange).line < line) {
                    return i;
                }
            }
        }
        return length - 1;
    }
    handleEditorMouseDown({ event, target }) {
        if (event.button !== 0) {
            return;
        }
        const { range, type, element } = target;
        if (!range || type !== browser_1.MouseTargetType.GUTTER_LINE_DECORATIONS || !element || element.className.indexOf('dirty-diff-glyph') < 0) {
            return;
        }
        const gutterOffsetX = target.detail.offsetX - element.offsetLeft;
        if (gutterOffsetX < -3 || gutterOffsetX > 3) { // dirty diff decoration on hover is 6px wide
            return; // to avoid colliding with folding
        }
        const index = this.findNextClosestChange(range.start.line, true);
        if (index < 0) {
            return;
        }
        if (index === this.widget?.currentChangeIndex) {
            this.closeWidget();
            return;
        }
        if (!this.widget) {
            this.widget = this.createWidget();
        }
        this.widget?.showChange(index);
    }
}
exports.DirtyDiffController = DirtyDiffController;
//# sourceMappingURL=dirty-diff-navigator.js.map