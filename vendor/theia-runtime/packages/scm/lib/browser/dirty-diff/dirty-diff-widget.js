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
exports.DirtyDiffWidget = exports.DirtyDiffWidgetFactory = exports.DirtyDiffWidgetProps = exports.PLUGIN_SCM_CHANGE_TITLE_MENU = exports.SCM_CHANGE_TITLE_MENU = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const vscode_languageserver_protocol_1 = require("@theia/core/shared/vscode-languageserver-protocol");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const monaco_editor_provider_1 = require("@theia/monaco/lib/browser/monaco-editor-provider");
const monaco_editor_peek_view_widget_1 = require("@theia/monaco/lib/browser/monaco-editor-peek-view-widget");
const diff_computer_1 = require("./diff-computer");
const scm_colors_1 = require("../scm-colors");
const monaco = require("@theia/monaco-editor-core");
exports.SCM_CHANGE_TITLE_MENU = ['scm-change-title-menu'];
/** Reserved for plugin contributions, corresponds to contribution point 'scm/change/title'. */
exports.PLUGIN_SCM_CHANGE_TITLE_MENU = ['plugin-scm-change-title-menu'];
exports.DirtyDiffWidgetProps = Symbol('DirtyDiffWidgetProps');
exports.DirtyDiffWidgetFactory = Symbol('DirtyDiffWidgetFactory');
let DirtyDiffWidget = class DirtyDiffWidget {
    constructor(props, editorProvider, contextKeyService, menuModelRegistry) {
        this.props = props;
        this.editorProvider = editorProvider;
        this.contextKeyService = contextKeyService;
        this.menuModelRegistry = menuModelRegistry;
        this.onDidCloseEmitter = new core_1.Emitter();
        this.onDidClose = this.onDidCloseEmitter.event;
        this.index = -1;
        this.peekView = new DirtyDiffPeekView(this);
        this.peekView.onDidClose(e => this.onDidCloseEmitter.fire(e));
        this.diffEditorPromise = this.peekView.create();
    }
    get changes() {
        return this._changes ?? [];
    }
    set changes(changes) {
        this.handleChangedChanges(changes);
    }
    get editor() {
        return this.props.editor;
    }
    get uri() {
        return this.editor.uri;
    }
    get previousRevisionUri() {
        return this.props.previousRevisionUri;
    }
    get currentChange() {
        return this.changes[this.index];
    }
    get currentChangeIndex() {
        return this.index;
    }
    handleChangedChanges(updated) {
        if (!updated.length) {
            return this.dispose();
        }
        if (this.currentChange) {
            const { previousRange: { start, end } } = this.currentChange;
            // Same change or first after it.
            const newIndex = updated.findIndex(candidate => (candidate.previousRange.start === start && candidate.previousRange.end === end)
                || candidate.previousRange.start > start);
            if (newIndex !== -1) {
                this.index = newIndex;
            }
            else {
                this.index = Math.min(this.index, updated.length - 1);
            }
            this.showCurrentChange();
        }
        else {
            this.index = -1;
        }
        this._changes = updated;
        this.updateHeading();
    }
    showChange(index) {
        if (index >= 0 && index < this.changes.length) {
            this.index = index;
            this.showCurrentChange();
        }
    }
    showNextChange() {
        const index = this.index;
        const length = this.changes.length;
        if (length > 0 && (index < 0 || length > 1)) {
            this.index = index < 0 ? 0 : cycle(index, 1, length);
            this.showCurrentChange();
        }
    }
    showPreviousChange() {
        const index = this.index;
        const length = this.changes.length;
        if (length > 0 && (index < 0 || length > 1)) {
            this.index = index < 0 ? length - 1 : cycle(index, -1, length);
            this.showCurrentChange();
        }
    }
    async getContentWithSelectedChanges(predicate) {
        const changes = this.changes.filter(predicate);
        const diffEditor = await this.diffEditorPromise;
        return applyChanges(changes, diffEditor.originalModel.textEditorModel, diffEditor.modifiedModel.textEditorModel);
    }
    dispose() {
        this.peekView.dispose();
        this.onDidCloseEmitter.dispose();
    }
    showCurrentChange() {
        this.updateHeading();
        const { previousRange, currentRange } = this.changes[this.index];
        this.peekView.show(vscode_languageserver_protocol_1.Position.create(diff_computer_1.LineRange.getEndPosition(currentRange).line, 0), this.computeHeightInLines()).then(async () => {
            this.editor.focus();
            const diffEditor = await this.diffEditorPromise;
            if (diffEditor.isDisposed()) {
                return;
            }
            let startLine = diff_computer_1.LineRange.getStartPosition(currentRange).line;
            let endLine = diff_computer_1.LineRange.getEndPosition(currentRange).line;
            if (diff_computer_1.LineRange.isEmpty(currentRange)) { // the change is a removal
                ++endLine;
            }
            else if (!diff_computer_1.LineRange.isEmpty(previousRange)) { // the change is a modification
                --startLine;
                ++endLine;
            }
            diffEditor.diffEditor.revealLinesInCenter(startLine + 1, endLine + 1, // monaco line numbers are 1-based
            monaco.editor.ScrollType.Immediate);
        });
    }
    updateHeading() {
        this.peekView.setTitle(this.computePrimaryHeading(), this.computeSecondaryHeading());
    }
    computePrimaryHeading() {
        return this.uri.path.base;
    }
    computeSecondaryHeading() {
        const index = this.index + 1;
        const length = this.changes.length;
        return length > 1 ? core_1.nls.localizeByDefault('{0} of {1} changes', index, length) :
            core_1.nls.localizeByDefault('{0} of {1} change', index, length);
    }
    computeHeightInLines() {
        const editor = this.editor.getControl();
        const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
        const editorHeight = editor.getLayoutInfo().height;
        const editorHeightInLines = Math.floor(editorHeight / lineHeight);
        const { previousRange, currentRange } = this.changes[this.index];
        const changeHeightInLines = diff_computer_1.LineRange.getLineCount(currentRange) + diff_computer_1.LineRange.getLineCount(previousRange);
        return Math.min(changeHeightInLines + /* padding */ 8, Math.floor(editorHeightInLines / 3));
    }
};
exports.DirtyDiffWidget = DirtyDiffWidget;
exports.DirtyDiffWidget = DirtyDiffWidget = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(exports.DirtyDiffWidgetProps)),
    tslib_1.__param(1, (0, inversify_1.inject)(monaco_editor_provider_1.MonacoEditorProvider)),
    tslib_1.__param(2, (0, inversify_1.inject)(context_key_service_1.ContextKeyService)),
    tslib_1.__param(3, (0, inversify_1.inject)(core_1.MenuModelRegistry)),
    tslib_1.__metadata("design:paramtypes", [Object, monaco_editor_provider_1.MonacoEditorProvider, Object, core_1.MenuModelRegistry])
], DirtyDiffWidget);
function cycle(index, offset, length) {
    return (index + offset + length) % length;
}
// adapted from https://github.com/microsoft/vscode/blob/823d54f86ee13eb357bc6e8e562e89d793f3c43b/extensions/git/src/staging.ts
function applyChanges(changes, original, modified) {
    const result = [];
    let currentLine = 1;
    for (const change of changes) {
        const { previousRange, currentRange } = change;
        const isInsertion = diff_computer_1.LineRange.isEmpty(previousRange);
        const isDeletion = diff_computer_1.LineRange.isEmpty(currentRange);
        const convert = (range) => {
            let startLineNumber;
            let endLineNumber;
            if (!diff_computer_1.LineRange.isEmpty(range)) {
                startLineNumber = range.start + 1;
                endLineNumber = range.end;
            }
            else {
                startLineNumber = range.start;
                endLineNumber = 0;
            }
            return [startLineNumber, endLineNumber];
        };
        const [originalStartLineNumber, originalEndLineNumber] = convert(previousRange);
        const [modifiedStartLineNumber, modifiedEndLineNumber] = convert(currentRange);
        let toLine = isInsertion ? originalStartLineNumber + 1 : originalStartLineNumber;
        let toCharacter = 1;
        // if this is a deletion at the very end of the document,
        // we need to account for a newline at the end of the last line,
        // which may have been deleted
        if (isDeletion && originalEndLineNumber === original.getLineCount()) {
            toLine--;
            toCharacter = original.getLineMaxColumn(toLine);
        }
        result.push(original.getValueInRange(new monaco.Range(currentLine, 1, toLine, toCharacter)));
        if (!isDeletion) {
            let fromLine = modifiedStartLineNumber;
            let fromCharacter = 1;
            // if this is an insertion at the very end of the document,
            // we must start the next range after the last character of the previous line,
            // in order to take the correct eol
            if (isInsertion && originalStartLineNumber === original.getLineCount()) {
                fromLine--;
                fromCharacter = modified.getLineMaxColumn(fromLine);
            }
            result.push(modified.getValueInRange(new monaco.Range(fromLine, fromCharacter, modifiedEndLineNumber + 1, 1)));
        }
        currentLine = isInsertion ? originalStartLineNumber + 1 : originalEndLineNumber + 1;
    }
    result.push(original.getValueInRange(new monaco.Range(currentLine, 1, original.getLineCount() + 1, 1)));
    return result.join('');
}
class DirtyDiffPeekView extends monaco_editor_peek_view_widget_1.MonacoEditorPeekViewWidget {
    constructor(widget) {
        super(widget.editor, { isResizeable: true, showArrow: true, frameWidth: 1, keepEditorSelection: true, className: 'dirty-diff' });
        this.widget = widget;
    }
    async create() {
        try {
            this.bodyElement = document.createElement('div');
            this.bodyElement.classList.add('body');
            super.create();
            this.diffEditorPromise = this.widget.editorProvider.createEmbeddedDiffEditor(this.editor, this.bodyElement, this.widget.previousRevisionUri);
            const diffEditor = await this.diffEditorPromise;
            this.diffEditor = diffEditor;
            this.toDispose.push(diffEditor);
            return diffEditor;
        }
        catch (e) {
            this.dispose();
            throw e;
        }
    }
    async show(rangeOrPos, heightInLines) {
        const { diffEditorPromise } = this;
        if (!diffEditorPromise) {
            throw new Error('Call the create() method first');
        }
        const diffEditor = await diffEditorPromise;
        if (diffEditor.isDisposed()) {
            return;
        }
        const borderColor = this.getBorderColor();
        this.style({
            arrowColor: borderColor,
            frameColor: borderColor,
            headerBackgroundColor: monaco_editor_peek_view_widget_1.peekViewTitleBackground,
            primaryHeadingColor: monaco_editor_peek_view_widget_1.peekViewTitleForeground,
            secondaryHeadingColor: monaco_editor_peek_view_widget_1.peekViewTitleInfoForeground
        });
        this.updateActions();
        super.show(rangeOrPos, heightInLines);
        diffEditor.handleVisibilityChanged(true);
        return new Promise(resolve => {
            // The diff computation is asynchronous and may complete before or after we register the listener.
            // This can happen when the file is already open in another editor, causing the model to be cached
            // and the diff to compute almost instantly. To handle this race condition, we check if the diff
            // is already available before waiting for onDidUpdateDiff.
            // setTimeout is needed because the non-side-by-side diff editor might still not have created the view zones;
            // otherwise, the first change shown might not be properly revealed in the diff editor.
            // See also https://github.com/microsoft/vscode/blob/b30900b56c4b3ca6c65d7ab92032651f4cb23f15/src/vs/workbench/contrib/scm/browser/dirtydiffDecorator.ts#L248
            if (diffEditor.diffEditor.getLineChanges()) {
                setTimeout(() => resolve());
                return;
            }
            const disposable = diffEditor.diffEditor.onDidUpdateDiff(() => setTimeout(() => {
                resolve();
                disposable.dispose();
            }));
        });
    }
    hide() {
        const { diffEditor } = this;
        if (diffEditor && !diffEditor.isDisposed()) {
            diffEditor.handleVisibilityChanged(false);
        }
        super.hide();
    }
    getBorderColor() {
        const { currentChange } = this.widget;
        if (!currentChange) {
            return monaco_editor_peek_view_widget_1.peekViewBorder;
        }
        if (diff_computer_1.Change.isAddition(currentChange)) {
            return scm_colors_1.ScmColors.editorGutterAddedBackground;
        }
        else if (diff_computer_1.Change.isRemoval(currentChange)) {
            return scm_colors_1.ScmColors.editorGutterDeletedBackground;
        }
        else {
            return scm_colors_1.ScmColors.editorGutterModifiedBackground;
        }
    }
    updateActions() {
        this.clearActions();
        const { contextKeyService, menuModelRegistry } = this.widget;
        contextKeyService.with({
            originalResourceScheme: this.widget.previousRevisionUri.scheme,
            originalResource: this.widget.previousRevisionUri.toString(),
        }, () => {
            for (const menuPath of [exports.SCM_CHANGE_TITLE_MENU, exports.PLUGIN_SCM_CHANGE_TITLE_MENU]) {
                const menu = menuModelRegistry.getMenu(menuPath);
                if (menu) {
                    for (const item of menu.children) {
                        if (core_1.CommandMenu.is(item)) {
                            const { id, label, icon } = item;
                            const itemPath = [...menuPath, id];
                            if (icon && item.isVisible(itemPath, contextKeyService, undefined, this.widget)) {
                                // Close editor on successful contributed action.
                                // https://github.com/microsoft/vscode/blob/1.99.3/src/vs/workbench/contrib/scm/browser/quickDiffWidget.ts#L357-L361
                                this.addAction(id, label, icon, item.isEnabled(itemPath, this.widget), () => {
                                    item.run(itemPath, this.widget).then(() => this.dispose());
                                });
                            }
                        }
                    }
                }
            }
        });
        this.addAction('dirtydiff.next', core_1.nls.localizeByDefault('Show Next Change'), (0, browser_1.codicon)('arrow-down'), true, () => this.widget.showNextChange());
        this.addAction('dirtydiff.previous', core_1.nls.localizeByDefault('Show Previous Change'), (0, browser_1.codicon)('arrow-up'), true, () => this.widget.showPreviousChange());
        this.addAction('peekview.close', core_1.nls.localizeByDefault('Close'), (0, browser_1.codicon)('close'), true, () => this.dispose());
    }
    fillContainer(container) {
        this.setCssClass('peekview-widget');
        this.headElement = document.createElement('div');
        this.headElement.classList.add('head');
        container.appendChild(this.headElement);
        container.appendChild(this.bodyElement);
        this.fillHead(this.headElement);
    }
    fillHead(container) {
        super.fillHead(container, true);
    }
    doLayoutBody(height, width) {
        super.doLayoutBody(height, width);
        this.layout(height, width);
        this.height = height;
    }
    onWidth(width) {
        super.onWidth(width);
        const { height } = this;
        if (height !== undefined) {
            this.layout(height, width);
        }
    }
    layout(height, width) {
        this.diffEditor?.diffEditor.layout({ height, width });
    }
    doRevealRange(range) {
        this.editor.revealPosition(vscode_languageserver_protocol_1.Position.create(range.end.line, 0), { vertical: 'centerIfOutsideViewport' });
    }
}
//# sourceMappingURL=dirty-diff-widget.js.map