"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BulkEditTreeWidget = exports.BULK_EDIT_WIDGET_NAME = exports.BULK_EDIT_TREE_WIDGET_ID = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2021 SAP SE or an SAP affiliate company and others.
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
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const bulk_edit_tree_1 = require("./bulk-edit-tree");
const bulk_edit_tree_model_1 = require("./bulk-edit-tree-model");
const browser_2 = require("@theia/filesystem/lib/browser");
const uri_1 = require("@theia/core/lib/common/uri");
const browser_3 = require("@theia/editor/lib/browser");
const common_1 = require("@theia/core/lib/common");
const disposable_1 = require("@theia/core/lib/common/disposable");
const nls_1 = require("@theia/core/lib/common/nls");
exports.BULK_EDIT_TREE_WIDGET_ID = 'bulkedit';
exports.BULK_EDIT_WIDGET_NAME = nls_1.nls.localizeByDefault('Refactor Preview');
let BulkEditTreeWidget = class BulkEditTreeWidget extends browser_1.TreeWidget {
    constructor(treeProps, model, contextMenuRenderer) {
        super(treeProps, model, contextMenuRenderer);
        this.treeProps = treeProps;
        this.model = model;
        this.contextMenuRenderer = contextMenuRenderer;
        this.editorWidgets = [];
        this.id = exports.BULK_EDIT_TREE_WIDGET_ID;
        this.title.label = exports.BULK_EDIT_WIDGET_NAME;
        this.title.caption = exports.BULK_EDIT_WIDGET_NAME;
        this.title.closable = true;
        this.addClass('theia-bulk-edit-container');
        this.toDispose.push(disposable_1.Disposable.create(() => {
            this.disposeEditors();
        }));
    }
    async initModel(edits) {
        await this.model.initModel(edits, await this.getFileContentsMap(edits));
        this.quickView?.showItem(exports.BULK_EDIT_WIDGET_NAME);
    }
    tapNode(node) {
        super.tapNode(node);
        if (bulk_edit_tree_1.BulkEditNode.is(node)) {
            this.doOpen(node);
        }
    }
    handleDown(event) {
        const node = this.model.getNextSelectableNode();
        super.handleDown(event);
        if (bulk_edit_tree_1.BulkEditNode.is(node)) {
            this.doOpen(node);
        }
    }
    handleUp(event) {
        const node = this.model.getPrevSelectableNode();
        super.handleUp(event);
        if (bulk_edit_tree_1.BulkEditNode.is(node)) {
            this.doOpen(node);
        }
    }
    renderTree(model) {
        if (browser_1.CompositeTreeNode.is(model.root) && model.root.children.length > 0) {
            return super.renderTree(model);
        }
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-widget-noInfo noEdits', children: nls_1.nls.localizeByDefault('Made no edits') });
    }
    renderCaption(node, props) {
        if (bulk_edit_tree_1.BulkEditInfoNode.is(node)) {
            return this.decorateBulkEditInfoNode(node);
        }
        else if (bulk_edit_tree_1.BulkEditNode.is(node)) {
            return this.decorateBulkEditNode(node);
        }
        return 'caption';
    }
    decorateBulkEditNode(node) {
        if (node?.parent && node?.bulkEdit && ('textEdit' in node?.bulkEdit)) {
            const bulkEdit = node.bulkEdit;
            const parent = node.parent;
            if (parent?.fileContents) {
                const lines = parent.fileContents.split('\n');
                const startLineNum = +bulkEdit.textEdit?.range?.startLineNumber;
                if (lines.length > startLineNum) {
                    const startColumn = +bulkEdit.textEdit.range.startColumn;
                    const endColumn = +bulkEdit.textEdit.range.endColumn;
                    const lineText = lines[startLineNum - 1];
                    const beforeMatch = (startColumn > 26 ? '... ' : '') + lineText.substring(0, startColumn - 1).slice(-25);
                    const replacedText = lineText.substring(startColumn - 1, endColumn - 1);
                    const afterMatch = lineText.substring(startColumn - 1 + replacedText.length, startColumn - 1 + replacedText.length + 75);
                    return (0, jsx_runtime_1.jsx)("div", { className: 'bulkEditNode', children: (0, jsx_runtime_1.jsxs)("div", { className: 'message', children: [beforeMatch, (0, jsx_runtime_1.jsx)("span", { className: "replaced-text", children: replacedText }), (0, jsx_runtime_1.jsx)("span", { className: "inserted-text", children: bulkEdit.textEdit.text }), afterMatch] }) });
                }
            }
        }
    }
    decorateBulkEditInfoNode(node) {
        const icon = this.toNodeIcon(node);
        const name = this.toNodeName(node);
        const description = this.toNodeDescription(node);
        const path = this.labelProvider.getLongName(node.uri.withScheme('bulkedit'));
        return (0, jsx_runtime_1.jsxs)("div", { title: path, className: 'bulkEditInfoNode', children: [icon && (0, jsx_runtime_1.jsx)("div", { className: icon + ' file-icon' }), (0, jsx_runtime_1.jsx)("div", { className: 'name', children: name }), (0, jsx_runtime_1.jsx)("div", { className: 'path', children: description })] });
    }
    async getFileContentsMap(edits) {
        const fileContentMap = new Map();
        if (edits) {
            for (const element of edits) {
                if (element) {
                    const filePath = (('newResource' in element) && element.newResource?.path) ||
                        (('resource' in element) && element.resource.path);
                    if (filePath && !fileContentMap.has(filePath)) {
                        const fileUri = new uri_1.default(filePath).withScheme('file');
                        const resource = await this.fileResourceResolver.resolve(fileUri);
                        fileContentMap.set(filePath, await resource.readContents());
                    }
                }
            }
        }
        return fileContentMap;
    }
    async doOpen(node) {
        if (node && node.parent && node.bulkEdit && ('edit' in node.bulkEdit)) {
            const resultNode = node.parent;
            const leftUri = node.uri;
            const rightUri = await this.createReplacePreview(resultNode);
            const diffUri = browser_1.DiffUris.encode(leftUri, rightUri);
            const editorWidget = await this.editorManager.open(diffUri, this.getEditorOptions(node));
            this.editorWidgets.push(editorWidget);
        }
    }
    async createReplacePreview(bulkEditInfoNode) {
        const fileUri = bulkEditInfoNode.uri;
        let lines = [];
        if (bulkEditInfoNode?.fileContents) {
            lines = bulkEditInfoNode.fileContents.split('\n');
            bulkEditInfoNode.children.map((node) => {
                if (node.bulkEdit && ('textEdit' in node.bulkEdit)) {
                    const startLineNum = node.bulkEdit.textEdit.range.startLineNumber;
                    if (lines.length > startLineNum) {
                        const startColumn = node.bulkEdit.textEdit.range.startColumn;
                        const endColumn = node.bulkEdit.textEdit.range.endColumn;
                        const lineText = lines[startLineNum - 1];
                        const beforeMatch = lineText.substring(0, startColumn - 1);
                        const replacedText = lineText.substring(startColumn - 1, endColumn - 1);
                        const afterMatch = lineText.substring(startColumn - 1 + replacedText.length);
                        lines[startLineNum - 1] = beforeMatch + node.bulkEdit.textEdit.text + afterMatch;
                    }
                }
            });
        }
        return fileUri.withScheme(common_1.MEMORY_TEXT).withQuery(lines.join('\n'));
    }
    getEditorOptions(node) {
        let options = {};
        if (('textEdit' in node.bulkEdit) && node?.bulkEdit?.textEdit?.range) {
            options = {
                selection: {
                    start: {
                        line: node.bulkEdit.textEdit.range.startLineNumber - 1,
                        character: node.bulkEdit.textEdit.range.startColumn - 1
                    },
                    end: {
                        line: node.bulkEdit.textEdit.range.endLineNumber - 1,
                        character: node.bulkEdit.textEdit.range.endColumn - 1
                    }
                }
            };
        }
        return options;
    }
    disposeEditors() {
        this.editorWidgets.forEach(w => w.dispose());
        this.quickView?.hideItem(exports.BULK_EDIT_WIDGET_NAME);
    }
};
exports.BulkEditTreeWidget = BulkEditTreeWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.FileResourceResolver),
    tslib_1.__metadata("design:type", browser_2.FileResourceResolver)
], BulkEditTreeWidget.prototype, "fileResourceResolver", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_3.EditorManager),
    tslib_1.__metadata("design:type", browser_3.EditorManager)
], BulkEditTreeWidget.prototype, "editorManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.QuickViewService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", browser_1.QuickViewService)
], BulkEditTreeWidget.prototype, "quickView", void 0);
exports.BulkEditTreeWidget = BulkEditTreeWidget = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(browser_1.TreeProps)),
    tslib_1.__param(1, (0, inversify_1.inject)(bulk_edit_tree_model_1.BulkEditTreeModel)),
    tslib_1.__param(2, (0, inversify_1.inject)(browser_1.ContextMenuRenderer)),
    tslib_1.__metadata("design:paramtypes", [Object, bulk_edit_tree_model_1.BulkEditTreeModel,
        browser_1.ContextMenuRenderer])
], BulkEditTreeWidget);
//# sourceMappingURL=bulk-edit-tree-widget.js.map