"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CellEditor = exports.FIND_MATCH_DECORATION = exports.CURRENT_FIND_MATCH_DECORATION = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
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
const React = require("@theia/core/shared/react");
const simple_monaco_editor_1 = require("@theia/monaco/lib/browser/simple-monaco-editor");
const monaco_editor_provider_1 = require("@theia/monaco/lib/browser/monaco-editor-provider");
const contextkey_1 = require("@theia/monaco-editor-core/esm/vs/platform/contextkey/common/contextkey");
const core_1 = require("@theia/core");
const notebook_context_keys_1 = require("../contributions/notebook-context-keys");
const editorExtensions_1 = require("@theia/monaco-editor-core/esm/vs/editor/browser/editorExtensions");
const textModel_1 = require("@theia/monaco-editor-core/esm/vs/editor/common/model/textModel");
const model_1 = require("@theia/monaco-editor-core/esm/vs/editor/common/model");
const browser_1 = require("@theia/core/lib/browser");
const DEFAULT_EDITOR_OPTIONS = {
    ...monaco_editor_provider_1.MonacoEditorProvider.inlineOptions,
    minHeight: -1,
    maxHeight: -1,
    scrollbar: {
        ...monaco_editor_provider_1.MonacoEditorProvider.inlineOptions.scrollbar,
        alwaysConsumeMouseWheel: false
    },
    lineDecorationsWidth: 10,
};
exports.CURRENT_FIND_MATCH_DECORATION = textModel_1.ModelDecorationOptions.register({
    description: 'current-find-match',
    stickiness: 1 /* TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges */,
    zIndex: 13,
    className: 'currentFindMatch',
    inlineClassName: 'currentFindMatchInline',
    showIfCollapsed: true,
    overviewRuler: {
        color: 'editorOverviewRuler.findMatchForeground',
        position: model_1.OverviewRulerLane.Center
    }
});
exports.FIND_MATCH_DECORATION = textModel_1.ModelDecorationOptions.register({
    description: 'find-match',
    stickiness: 1 /* TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges */,
    zIndex: 10,
    className: 'findMatch',
    inlineClassName: 'findMatchInline',
    showIfCollapsed: true,
    overviewRuler: {
        color: 'editorOverviewRuler.findMatchForeground',
        position: model_1.OverviewRulerLane.Center
    }
});
class CellEditor extends React.Component {
    constructor() {
        super(...arguments);
        this.toDispose = new core_1.DisposableCollection();
        this.matches = [];
        this.oldMatchDecorations = [];
        this.handleResize = () => {
            this.editor?.refresh();
        };
    }
    componentDidMount() {
        const cellViewModel = this.props.notebookViewModel.cellViewModels.get(this.props.cell.handle);
        if (!cellViewModel) {
            throw new Error('CellViewModel not found for cell ' + this.props.cell.handle);
        }
        this.disposeEditor();
        this.toDispose.push(cellViewModel.onWillFocusCellEditor(focusRequest => {
            this.editor?.getControl().focus();
            const lineCount = this.editor?.getControl().getModel()?.getLineCount();
            if (focusRequest && lineCount !== undefined) {
                this.editor?.getControl().setPosition(focusRequest === 'lastLine' ?
                    { lineNumber: lineCount, column: 1 } :
                    { lineNumber: focusRequest, column: 1 }, 'keyboard');
            }
            const currentLine = this.editor?.getControl().getPosition()?.lineNumber;
            this.props.notebookContextManager.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_CURSOR_FIRST_LINE, currentLine === 1);
            this.props.notebookContextManager.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_CURSOR_LAST_LINE, currentLine === lineCount);
        }));
        this.toDispose.push(cellViewModel.onWillBlurCellEditor(() => this.blurEditor()));
        this.toDispose.push(this.props.cell.onDidChangeEditorOptions(options => {
            this.editor?.getControl().updateOptions(options);
        }));
        this.toDispose.push(this.props.cell.onDidChangeLanguage(language => {
            this.editor?.setLanguage(language);
        }));
        this.toDispose.push(this.props.cell.onDidFindMatches(matches => {
            this.matches = matches;
            (0, browser_1.animationFrame)().then(() => this.setMatches());
        }));
        this.toDispose.push(this.props.cell.onDidSelectFindMatch(match => this.centerEditorInView()));
        this.toDispose.push(this.props.notebookViewModel.onDidChangeSelectedCell(e => {
            if (e.cell !== this.props.cell && this.editor?.getControl().hasTextFocus()) {
                this.blurEditor();
            }
        }));
        if (!this.props.notebookViewportService || (this.container && this.props.notebookViewportService.isElementInViewport(this.container))) {
            this.initEditor();
        }
        else {
            const disposable = this.props.notebookViewportService?.onDidChangeViewport(() => {
                if (!this.editor && this.container && this.props.notebookViewportService.isElementInViewport(this.container)) {
                    this.initEditor();
                    disposable.dispose();
                }
            });
            this.toDispose.push(disposable);
        }
        this.toDispose.push(this.props.cell.onDidRequestCenterEditor(() => {
            this.centerEditorInView();
        }));
    }
    componentWillUnmount() {
        if (this.resizeObserver) {
            if (this.container) {
                this.resizeObserver.unobserve(this.container);
            }
            this.resizeObserver.disconnect();
            this.resizeObserver = undefined;
        }
        this.disposeEditor();
    }
    disposeEditor() {
        if (this.editor) {
            this.props.notebookCellEditorService.editorDisposed(this.editor.uri);
        }
        this.toDispose.dispose();
        this.toDispose = new core_1.DisposableCollection();
    }
    centerEditorInView() {
        const editorDomNode = this.editor?.getControl().getDomNode();
        if (editorDomNode) {
            editorDomNode.scrollIntoView({
                behavior: 'instant',
                block: 'center'
            });
        }
        else {
            this.container?.scrollIntoView({
                behavior: 'instant',
                block: 'center'
            });
        }
    }
    async initEditor() {
        const { cell, notebookModel, monacoServices } = this.props;
        if (this.container) {
            const editorNode = this.container;
            editorNode.style.height = '';
            const editorModel = await cell.resolveTextModel();
            const uri = cell.uri;
            this.editor = new simple_monaco_editor_1.SimpleMonacoEditor(uri, editorModel, editorNode, monacoServices, { ...DEFAULT_EDITOR_OPTIONS, ...cell.editorOptions }, [[contextkey_1.IContextKeyService, this.props.notebookContextManager.scopedStore]], { contributions: editorExtensions_1.EditorExtensionsRegistry.getEditorContributions().filter(c => c.id !== 'editor.contrib.findController') });
            this.toDispose.push(this.editor);
            // Monaco's EditContext API uses a plain <div> for text input instead of a <textarea>.
            // PerfectScrollbar's keyboard handler checks isEditable(activeElement) which only recognizes
            // input/textarea/select/button/[contenteditable] elements. Setting contenteditable on the
            // EditContext div makes PerfectScrollbar skip keyboard handling when the editor has focus,
            // preventing Space/PageUp/PageDown/Home/End/arrows from scrolling the notebook container.
            const editContextElement = editorNode.querySelector('.native-edit-context');
            if (editContextElement) {
                editContextElement.setAttribute('contenteditable', 'false');
            }
            this.editor.setLanguage(cell.language);
            this.toDispose.push(this.editor.getControl().onDidContentSizeChange(() => {
                editorNode.style.height = this.editor.getControl().getContentHeight() + 7 + 'px';
                this.editor.setSize({ width: -1, height: this.editor.getControl().getContentHeight() });
            }));
            this.toDispose.push(this.editor.onDocumentContentChanged(e => {
                notebookModel.cellDirtyChanged(cell, true);
            }));
            this.toDispose.push(this.editor.getControl().onDidFocusEditorText(() => {
                this.props.notebookViewModel.setSelectedCell(cell, false);
                this.props.notebookCellEditorService.editorFocusChanged(this.editor);
            }));
            this.toDispose.push(this.editor.getControl().onDidBlurEditorText(() => {
                if (this.props.notebookCellEditorService.getActiveCell()?.uri.toString() === this.props.cell.uri.toString()) {
                    this.props.notebookCellEditorService.editorFocusChanged(undefined);
                }
            }));
            this.toDispose.push(this.editor.getControl().onDidChangeCursorSelection(e => {
                const selectedText = this.editor.getControl().getModel().getValueInRange(e.selection);
                // TODO handle secondary selections
                this.props.cell.selection = {
                    start: { line: e.selection.startLineNumber - 1, character: e.selection.startColumn - 1 },
                    end: { line: e.selection.endLineNumber - 1, character: e.selection.endColumn - 1 }
                };
                this.props.notebookModel.selectedText = selectedText;
            }));
            this.toDispose.push(this.editor.getControl().onDidChangeCursorPosition(e => {
                if (e.secondaryPositions.length === 0) {
                    this.props.notebookContextManager.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_CURSOR_FIRST_LINE, e.position.lineNumber === 1);
                    this.props.notebookContextManager.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_CURSOR_LAST_LINE, e.position.lineNumber === this.editor.getControl().getModel().getLineCount());
                }
                else {
                    this.props.notebookContextManager.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_CURSOR_FIRST_LINE, false);
                    this.props.notebookContextManager.scopedStore.setContext(notebook_context_keys_1.NOTEBOOK_CELL_CURSOR_LAST_LINE, false);
                }
            }));
            this.props.notebookCellEditorService.editorCreated(uri, this.editor);
            this.setMatches();
            if (this.props.notebookViewModel.selectedCell === cell) {
                this.editor.getControl().focus();
            }
        }
    }
    setMatches() {
        if (!this.editor) {
            return;
        }
        const decorations = [];
        for (const match of this.matches) {
            const decoration = match.selected ? exports.CURRENT_FIND_MATCH_DECORATION : exports.FIND_MATCH_DECORATION;
            decorations.push({
                range: {
                    startLineNumber: match.range.start.line,
                    startColumn: match.range.start.character,
                    endLineNumber: match.range.end.line,
                    endColumn: match.range.end.character
                },
                options: decoration
            });
        }
        this.oldMatchDecorations = this.editor.getControl()
            .changeDecorations(accessor => accessor.deltaDecorations(this.oldMatchDecorations, decorations)) ?? [];
    }
    setContainer(component) {
        if (this.resizeObserver && this.container) {
            this.resizeObserver.unobserve(this.container);
        }
        this.container = component ?? undefined;
        if (this.container) {
            if (!this.resizeObserver) {
                this.resizeObserver = new ResizeObserver(() => {
                    this.handleResize();
                });
            }
            this.resizeObserver.observe(this.container);
        }
    }
    ;
    estimateHeight() {
        const lineHeight = this.props.fontInfo?.lineHeight ?? 20;
        return this.props.cell.text.split(core_1.OS.backend.EOL).length * lineHeight + 10 + 7 + 'px';
    }
    render() {
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-cell-editor', id: this.props.cell.uri.toString(), ref: container => this.setContainer(container), style: { height: this.editor ? undefined : this.estimateHeight() } });
    }
    blurEditor() {
        let parent = this.container?.parentElement;
        while (parent && !parent.classList.contains('theia-notebook-cell')) {
            parent = parent.parentElement;
        }
        if (parent) {
            parent.focus();
        }
    }
}
exports.CellEditor = CellEditor;
//# sourceMappingURL=notebook-cell-editor.js.map