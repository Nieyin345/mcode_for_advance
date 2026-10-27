"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileNavigatorWidget = exports.CLASS = exports.LABEL = exports.FILE_NAVIGATOR_ID = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
const uri_1 = require("@theia/core/lib/common/uri");
const common_1 = require("@theia/core/lib/common");
const browser_1 = require("@theia/core/lib/browser");
const browser_2 = require("@theia/filesystem/lib/browser");
const browser_3 = require("@theia/workspace/lib/browser");
const navigator_tree_1 = require("./navigator-tree");
const navigator_model_1 = require("./navigator-model");
const core_1 = require("@theia/core");
const navigator_context_key_service_1 = require("./navigator-context-key-service");
const navigator_file_clipboard_1 = require("./navigator-file-clipboard");
const nls_1 = require("@theia/core/lib/common/nls");
const abstract_navigator_tree_widget_1 = require("./abstract-navigator-tree-widget");
exports.FILE_NAVIGATOR_ID = 'files';
exports.LABEL = nls_1.nls.localizeByDefault('No Folder Opened');
exports.CLASS = 'theia-Files';
let FileNavigatorWidget = class FileNavigatorWidget extends abstract_navigator_tree_widget_1.AbstractNavigatorTreeWidget {
    constructor(props, model, contextMenuRenderer) {
        super(props, model, contextMenuRenderer);
        this.model = model;
        this.canOpenWorkspaceFileAndFolder = core_1.isOSX || !core_1.environment.electron.is();
        this.openWorkspace = () => this.doOpenWorkspace();
        this.openFolder = () => this.doOpenFolder();
        this.addFolder = () => this.doAddFolder();
        this.keyUpHandler = (e) => {
            if (browser_1.Key.ENTER.keyCode === e.keyCode) {
                e.target.click();
            }
        };
        this.id = exports.FILE_NAVIGATOR_ID;
        this.addClass(exports.CLASS);
    }
    init() {
        super.init();
        // This ensures that the context menu command to hide this widget receives the label 'Folders'
        // regardless of the name of workspace. See ViewContainer.updateToolbarItems.
        const dataset = { ...this.title.dataset, visibilityCommandLabel: nls_1.nls.localizeByDefault('Folders') };
        this.title.dataset = dataset;
        this.updateSelectionContextKeys();
        this.toDispose.pushAll([
            this.model.onSelectionChanged(() => this.updateSelectionContextKeys()),
            this.model.onExpansionChanged(node => {
                if (node.expanded && node.children.length === 1) {
                    const child = node.children[0];
                    if (browser_1.ExpandableTreeNode.is(child) && !child.expanded) {
                        this.model.expandNode(child);
                    }
                }
            })
        ]);
    }
    doUpdateRows() {
        super.doUpdateRows();
        this.title.label = exports.LABEL;
        if (navigator_tree_1.WorkspaceNode.is(this.model.root)) {
            if (this.model.root.name === navigator_tree_1.WorkspaceNode.name) {
                const rootNode = this.model.root.children[0];
                if (navigator_tree_1.WorkspaceRootNode.is(rootNode)) {
                    this.title.label = this.toNodeName(rootNode);
                    this.title.caption = this.labelProvider.getLongName(rootNode.uri);
                }
            }
            else {
                this.title.label = this.toNodeName(this.model.root);
                this.title.caption = this.title.label;
            }
        }
        else {
            this.title.caption = this.title.label;
        }
    }
    getContainerTreeNode() {
        const root = this.model.root;
        if (this.workspaceService.isMultiRootWorkspaceOpened) {
            return root;
        }
        if (navigator_tree_1.WorkspaceNode.is(root)) {
            return root.children[0];
        }
        return undefined;
    }
    renderTree(model) {
        if (this.model.root && this.isEmptyMultiRootWorkspace(model)) {
            return this.renderEmptyMultiRootWorkspace();
        }
        return super.renderTree(model);
    }
    shouldShowWelcomeView() {
        return this.model.root === undefined;
    }
    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        this.addClipboardListener(this.node, 'copy', e => this.handleCopy(e));
        this.addClipboardListener(this.node, 'paste', e => this.handlePaste(e));
    }
    handleCopy(event) {
        const uris = this.model.selectedFileStatNodes.map(node => node.uri.toString());
        if (uris.length > 0 && event.clipboardData) {
            const content = uris.join('\n');
            event.clipboardData.setData('text/plain', content);
            this.fileClipboard.set(content);
        }
        event.preventDefault();
    }
    handlePaste(event) {
        if (event.clipboardData) {
            const raw = event.clipboardData.getData('text/plain');
            // the consume decision must be made synchronously, before pasteFiles completes
            if (this.canPasteFiles(raw)) {
                event.preventDefault();
                this.pasteFiles(raw).catch(error => this.messageService.error(error.message));
            }
        }
    }
    /**
     * Whether {@link pasteFiles} would handle a paste, i.e. a paste target is selected and,
     * if already known, the clipboard text is not empty.
     *
     * @param raw the clipboard text, if it has been obtained already
     */
    canPasteFiles(raw) {
        return raw !== '' && this.model.selectedFileStatNodes.length > 0;
    }
    /**
     * Pastes the files given as newline-separated URIs or absolute paths into the selected directory.
     *
     * @param raw the clipboard text, expected to hold one file URI or absolute file system path per line
     * @returns `true` if the paste was handled, i.e. clipboard text and a paste target were available;
     *   the promise resolves once all file copies have completed
     */
    async pasteFiles(raw) {
        if (!this.canPasteFiles(raw)) {
            return false;
        }
        const target = this.model.selectedFileStatNodes[0];
        const sources = this.parsePastedUris(raw);
        if (sources.length === 0) {
            this.messageService.info(nls_1.nls.localize('theia/navigator/nothingToPaste', 'The clipboard does not contain workspace files that can be pasted here.'));
            return true;
        }
        await Promise.all(sources.map(source => this.model.copy(source, target)));
        return true;
    }
    parsePastedUris(raw) {
        const uris = [];
        for (const file of raw.split('\n')) {
            const trimmed = file.trim();
            if (!trimmed) {
                continue;
            }
            const source = this.asPastedFileUri(trimmed);
            if (source && this.workspaceService.getWorkspaceRootUri(source)) {
                uris.push(source);
            }
        }
        return uris;
    }
    /** Interprets the given clipboard line as a URI or an absolute file system path, e.g. from the Copy Path command. */
    asPastedFileUri(candidate) {
        // check for absolute paths first: Windows paths like C:\foo also parse as URLs (scheme 'c:')
        if (candidate.startsWith('/') || candidate.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(candidate)) {
            return uri_1.default.fromFilePath(candidate);
        }
        try {
            new URL(candidate);
            return new uri_1.default(candidate);
        }
        catch {
            return undefined;
        }
    }
    doOpenWorkspace() {
        this.commandService.executeCommand(browser_3.WorkspaceCommands.OPEN_WORKSPACE.id);
    }
    doOpenFolder() {
        this.commandService.executeCommand(browser_3.WorkspaceCommands.OPEN_FOLDER.id);
    }
    doAddFolder() {
        this.commandService.executeCommand(browser_3.WorkspaceCommands.ADD_FOLDER.id);
    }
    /**
     * When a multi-root workspace is opened, a user can remove all the folders from it.
     * Instead of displaying an empty navigator tree, this will show a button to add more folders.
     */
    renderEmptyMultiRootWorkspace() {
        return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-navigator-container', children: [(0, jsx_runtime_1.jsx)("div", { className: 'center', children: nls_1.nls.localizeByDefault('You have not yet added a folder to the workspace.\n{0}', '') }), (0, jsx_runtime_1.jsx)("div", { className: 'open-workspace-button-container', children: (0, jsx_runtime_1.jsx)("button", { className: 'theia-button open-workspace-button', title: nls_1.nls.localizeByDefault('Add Folder to Workspace'), onClick: this.addFolder, onKeyUp: this.keyUpHandler, children: nls_1.nls.localizeByDefault('Open Folder') }) })] });
    }
    isEmptyMultiRootWorkspace(model) {
        return navigator_tree_1.WorkspaceNode.is(model.root) && model.root.children.length === 0;
    }
    tapNode(node) {
        if (node && this.corePreferences['workbench.list.openMode'] === 'singleClick') {
            this.model.previewNode(node);
        }
        super.tapNode(node);
    }
    onAfterShow(msg) {
        super.onAfterShow(msg);
        this.contextKeyService.explorerViewletVisible.set(true);
    }
    onAfterHide(msg) {
        super.onAfterHide(msg);
        this.contextKeyService.explorerViewletVisible.set(false);
    }
    updateSelectionContextKeys() {
        this.contextKeyService.explorerResourceIsFolder.set(browser_2.DirNode.is(this.model.selectedNodes[0]));
        // As `FileStatNode` only created if `FileService.resolve` was successful, we can safely assume that
        // a valid `FileSystemProvider` is available for the selected node. So we skip an additional check
        // for provider availability here and check the node type.
        this.contextKeyService.isFileSystemResource.set(browser_2.FileStatNodeData.is(this.model.selectedNodes[0]));
    }
};
exports.FileNavigatorWidget = FileNavigatorWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.CommandService),
    tslib_1.__metadata("design:type", Object)
], FileNavigatorWidget.prototype, "commandService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(navigator_context_key_service_1.NavigatorContextKeyService),
    tslib_1.__metadata("design:type", navigator_context_key_service_1.NavigatorContextKeyService)
], FileNavigatorWidget.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_3.WorkspaceService),
    tslib_1.__metadata("design:type", browser_3.WorkspaceService)
], FileNavigatorWidget.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(navigator_file_clipboard_1.NavigatorFileClipboard),
    tslib_1.__metadata("design:type", navigator_file_clipboard_1.NavigatorFileClipboard)
], FileNavigatorWidget.prototype, "fileClipboard", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.MessageService),
    tslib_1.__metadata("design:type", common_1.MessageService)
], FileNavigatorWidget.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], FileNavigatorWidget.prototype, "init", null);
exports.FileNavigatorWidget = FileNavigatorWidget = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(browser_1.TreeProps)),
    tslib_1.__param(1, (0, inversify_1.inject)(navigator_model_1.FileNavigatorModel)),
    tslib_1.__param(2, (0, inversify_1.inject)(browser_1.ContextMenuRenderer)),
    tslib_1.__metadata("design:paramtypes", [Object, navigator_model_1.FileNavigatorModel,
        browser_1.ContextMenuRenderer])
], FileNavigatorWidget);
//# sourceMappingURL=navigator-widget.js.map