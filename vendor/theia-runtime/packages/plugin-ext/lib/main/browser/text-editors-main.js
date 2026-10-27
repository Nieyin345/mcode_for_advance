"use strict";
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
exports.TextEditorsMainImpl = void 0;
const plugin_api_rpc_1 = require("../../common/plugin-api-rpc");
const disposable_1 = require("@theia/core/lib/common/disposable");
const errors_1 = require("../../common/errors");
const languages_main_1 = require("./languages-main");
const monaco_bulk_edit_service_1 = require("@theia/monaco/lib/browser/monaco-bulk-edit-service");
const endpoint_1 = require("@theia/core/lib/browser/endpoint");
const monaco = require("@theia/monaco-editor-core");
const bulkEditService_1 = require("@theia/monaco-editor-core/esm/vs/editor/browser/services/bulkEditService");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const codeEditorService_1 = require("@theia/monaco-editor-core/esm/vs/editor/browser/services/codeEditorService");
const core_1 = require("@theia/core");
const diff_uris_1 = require("@theia/core/lib/browser/diff-uris");
const types_impl_1 = require("../../plugin/types-impl");
const diff_computer_1 = require("@theia/scm/lib/browser/dirty-diff/diff-computer");
const scm_decorations_service_1 = require("@theia/scm/lib/browser/decorations/scm-decorations-service");
const notebooks_main_1 = require("./notebooks/notebooks-main");
const browser_1 = require("@theia/notebook/lib/browser");
class TextEditorsMainImpl {
    constructor(editorsAndDocuments, documents, rpc, container) {
        this.editorsAndDocuments = editorsAndDocuments;
        this.documents = documents;
        this.toDispose = new disposable_1.DisposableCollection();
        this.editorsToDispose = new Map();
        this.fileEndpoint = new endpoint_1.Endpoint({ path: 'file' }).getRestUrl();
        this.proxy = rpc.getProxy(plugin_api_rpc_1.MAIN_RPC_CONTEXT.TEXT_EDITORS_EXT);
        this.bulkEditService = container.get(monaco_bulk_edit_service_1.MonacoBulkEditService);
        this.notebookService = container.get(browser_1.NotebookService);
        this.scmDecorationsService = container.get(scm_decorations_service_1.ScmDecorationsService);
        this.toDispose.push(editorsAndDocuments);
        this.toDispose.push(editorsAndDocuments.onTextEditorAdd(editors => editors.forEach(this.onTextEditorAdd, this)));
        this.toDispose.push(editorsAndDocuments.onTextEditorRemove(editors => editors.forEach(this.onTextEditorRemove, this)));
        this.toDispose.push(this.scmDecorationsService.onDirtyDiffUpdate(update => this.onDirtyDiffUpdate(update)));
    }
    dispose() {
        this.toDispose.dispose();
    }
    onTextEditorAdd(editor) {
        const id = editor.getId();
        const toDispose = new disposable_1.DisposableCollection(editor.onPropertiesChangedEvent(e => {
            this.proxy.$acceptEditorPropertiesChanged(id, e);
        }), disposable_1.Disposable.create(() => this.editorsToDispose.delete(id)));
        this.editorsToDispose.set(id, toDispose);
        this.toDispose.push(toDispose);
        const diffEditor = editor.getDiffEditor();
        if (diffEditor) {
            const pushDiffEditorInfo = () => this.pushDiffEditorDiffInformation(id, editor);
            toDispose.push(diffEditor.diffEditor.onDidUpdateDiff(pushDiffEditorInfo));
            pushDiffEditorInfo();
        }
    }
    onDirtyDiffUpdate(update) {
        const editorUri = update.editor.uri.toString();
        const editorIds = this.findEditorIdsByUri(editorUri, true);
        if (editorIds.length === 0) {
            return;
        }
        const originalUri = update.previousRevisionUri?.toComponents();
        const changes = update.changes.map(change => {
            let kind;
            if (diff_computer_1.Change.isAddition(change)) {
                kind = types_impl_1.TextEditorChangeKind.Addition;
            }
            else if (diff_computer_1.Change.isRemoval(change)) {
                kind = types_impl_1.TextEditorChangeKind.Deletion;
            }
            else {
                kind = types_impl_1.TextEditorChangeKind.Modification;
            }
            return {
                original: {
                    startLineNumber: change.previousRange.start + 1,
                    endLineNumberExclusive: change.previousRange.end + 1
                },
                modified: {
                    startLineNumber: change.currentRange.start + 1,
                    endLineNumberExclusive: change.currentRange.end + 1
                },
                kind
            };
        });
        // Push diff information to all editors with this URI (regular editors and diff editor modified sides).
        for (const editorId of editorIds) {
            const editor = this.editorsAndDocuments.getEditor(editorId);
            if (!editor) {
                continue;
            }
            const model = editor.getModel();
            const modifiedUri = core_1.URI.fromComponents(model.uri).toComponents();
            this.proxy.$acceptEditorDiffInformation(editorId, [{
                    documentVersion: model.getVersionId(),
                    original: originalUri,
                    modified: modifiedUri,
                    changes,
                    isStale: false
                }]);
        }
    }
    pushDiffEditorDiffInformation(id, editor) {
        const diffEditor = editor.getDiffEditor();
        if (!diffEditor) {
            return;
        }
        let originalUri;
        let modifiedUri;
        try {
            const [left, right] = diff_uris_1.DiffUris.decode(diffEditor.uri);
            originalUri = left.toComponents();
            modifiedUri = right.toComponents();
        }
        catch {
            // Not a valid DiffUri; fall back to model URIs
            originalUri = new core_1.URI(diffEditor.originalModel.uri).toComponents();
            modifiedUri = new core_1.URI(diffEditor.modifiedModel.uri).toComponents();
        }
        const lineChanges = diffEditor.diffInformation;
        const changes = lineChanges.map(change => {
            let kind;
            if (change.originalEndLineNumber === 0) {
                kind = types_impl_1.TextEditorChangeKind.Addition;
            }
            else if (change.modifiedEndLineNumber === 0) {
                kind = types_impl_1.TextEditorChangeKind.Deletion;
            }
            else {
                kind = types_impl_1.TextEditorChangeKind.Modification;
            }
            // ILineChange uses 1-based lines where 0 means empty range.
            // TextEditorLineRange uses 1-based startLineNumber and endLineNumberExclusive.
            const toLineRange = (start, end) => end === 0
                ? { startLineNumber: start + 1, endLineNumberExclusive: start + 1 }
                : { startLineNumber: start, endLineNumberExclusive: end + 1 };
            return {
                original: toLineRange(change.originalStartLineNumber, change.originalEndLineNumber),
                modified: toLineRange(change.modifiedStartLineNumber, change.modifiedEndLineNumber),
                kind
            };
        });
        const model = editor.getModel();
        this.proxy.$acceptEditorDiffInformation(id, [{
                documentVersion: model.getVersionId(),
                original: originalUri,
                modified: modifiedUri,
                changes,
                isStale: false
            }]);
    }
    findEditorIdsByUri(uri, excludeDiffEditors = false) {
        const ids = [];
        for (const id of this.editorsToDispose.keys()) {
            const editor = this.editorsAndDocuments.getEditor(id);
            if (editor && editor.getModel().uri.toString() === uri) {
                if (excludeDiffEditors && editor.getDiffEditor()) {
                    continue;
                }
                ids.push(id);
            }
        }
        return ids;
    }
    onTextEditorRemove(id) {
        const disposables = this.editorsToDispose.get(id);
        if (disposables) {
            disposables.dispose();
        }
    }
    $tryShowTextDocument(uri, options) {
        return this.documents.$tryShowDocument(uri, options);
    }
    $trySetOptions(id, options) {
        if (!this.editorsAndDocuments.getEditor(id)) {
            return Promise.reject((0, errors_1.disposed)(`TextEditor: ${id}`));
        }
        this.editorsAndDocuments.getEditor(id).setConfiguration(options);
        return Promise.resolve();
    }
    $trySetSelections(id, selections) {
        if (!this.editorsAndDocuments.getEditor(id)) {
            return Promise.reject((0, errors_1.disposed)(`TextEditor: ${id}`));
        }
        this.editorsAndDocuments.getEditor(id).setSelections(selections);
        return Promise.resolve();
    }
    $tryRevealRange(id, range, revealType) {
        if (!this.editorsAndDocuments.getEditor(id)) {
            return Promise.reject((0, errors_1.disposed)(`TextEditor(${id})`));
        }
        this.editorsAndDocuments.getEditor(id).revealRange(new monaco.Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn), revealType);
        return Promise.resolve();
    }
    $tryApplyEdits(id, modelVersionId, edits, opts) {
        if (!this.editorsAndDocuments.getEditor(id)) {
            return Promise.reject((0, errors_1.disposed)(`TextEditor(${id})`));
        }
        return Promise.resolve(this.editorsAndDocuments.getEditor(id).applyEdits(modelVersionId, edits, opts));
    }
    async $tryApplyWorkspaceEdit(dto, metadata) {
        const [notebookEdits, monacoEdits] = core_1.ArrayUtils.partition(dto.edits, edit => plugin_api_rpc_1.WorkspaceNotebookCellEditDto.is(edit));
        try {
            if (notebookEdits.length > 0) {
                const workspaceEdit = (0, notebooks_main_1.toNotebookWorspaceEdit)({ edits: notebookEdits });
                return this.notebookService.applyWorkspaceEdit(workspaceEdit);
            }
            if (monacoEdits.length > 0) {
                const workspaceEdit = (0, languages_main_1.toMonacoWorkspaceEdit)({ edits: monacoEdits });
                const edits = bulkEditService_1.ResourceEdit.convert(workspaceEdit);
                const { isApplied } = await this.bulkEditService.apply(edits, { respectAutoSaveConfig: metadata?.isRefactoring });
                return isApplied;
            }
            return false;
        }
        catch {
            return false;
        }
    }
    $tryInsertSnippet(id, template, ranges, opts) {
        if (!this.editorsAndDocuments.getEditor(id)) {
            return Promise.reject((0, errors_1.disposed)(`TextEditor(${id})`));
        }
        return Promise.resolve(this.editorsAndDocuments.getEditor(id).insertSnippet(template, ranges, opts));
    }
    $registerTextEditorDecorationType(key, options) {
        this.injectRemoteUris(options);
        standaloneServices_1.StandaloneServices.get(codeEditorService_1.ICodeEditorService).registerDecorationType('Plugin decoration', key, options);
        this.toDispose.push(disposable_1.Disposable.create(() => this.$removeTextEditorDecorationType(key)));
    }
    injectRemoteUris(options) {
        if (options.before) {
            options.before.contentIconPath = this.toRemoteUri(options.before.contentIconPath);
        }
        if (options.after) {
            options.after.contentIconPath = this.toRemoteUri(options.after.contentIconPath);
        }
        if ('gutterIconPath' in options) {
            options.gutterIconPath = this.toRemoteUri(options.gutterIconPath);
        }
        if ('dark' in options && options.dark) {
            this.injectRemoteUris(options.dark);
        }
        if ('light' in options && options.light) {
            this.injectRemoteUris(options.light);
        }
    }
    toRemoteUri(uri) {
        if (uri && uri.scheme === 'file') {
            return this.fileEndpoint.withQuery(core_1.URI.fromComponents(uri).toString()).toComponents();
        }
        return uri;
    }
    $removeTextEditorDecorationType(key) {
        standaloneServices_1.StandaloneServices.get(codeEditorService_1.ICodeEditorService).removeDecorationType(key);
    }
    $tryHideEditor(id) {
        return this.editorsAndDocuments.hideEditor(id);
    }
    $trySetDecorations(id, key, ranges) {
        if (!this.editorsAndDocuments.getEditor(id)) {
            return Promise.reject((0, errors_1.disposed)(`TextEditor(${id})`));
        }
        this.editorsAndDocuments.getEditor(id).setDecorations(key, ranges);
        return Promise.resolve();
    }
    $trySetDecorationsFast(id, key, ranges) {
        if (!this.editorsAndDocuments.getEditor(id)) {
            return Promise.reject((0, errors_1.disposed)(`TextEditor(${id})`));
        }
        this.editorsAndDocuments.getEditor(id).setDecorationsFast(key, ranges);
        return Promise.resolve();
    }
    $save(uri) {
        return this.editorsAndDocuments.save(core_1.URI.fromComponents(uri)).then(u => u?.toComponents());
    }
    $saveAs(uri) {
        return this.editorsAndDocuments.saveAs(core_1.URI.fromComponents(uri)).then(u => u?.toComponents());
    }
    $saveAll(includeUntitled) {
        return this.editorsAndDocuments.saveAll(includeUntitled);
    }
    $getDiffInformation(id) {
        return Promise.resolve(this.editorsAndDocuments.getDiffInformation(id));
    }
}
exports.TextEditorsMainImpl = TextEditorsMainImpl;
//# sourceMappingURL=text-editors-main.js.map