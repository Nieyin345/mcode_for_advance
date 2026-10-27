"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotebookEditorWidget = exports.NOTEBOOK_EDITOR_ID_PREFIX = exports.NotebookEditorProps = exports.NotebookEditorWidgetContainerFactory = void 0;
exports.createNotebookEditorWidgetContainer = createNotebookEditorWidgetContainer;
const tslib_1 = require("tslib");
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
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const common_1 = require("../common");
const notebook_cell_list_view_1 = require("./view/notebook-cell-list-view");
const notebook_code_cell_view_1 = require("./view/notebook-code-cell-view");
const notebook_markdown_cell_view_1 = require("./view/notebook-markdown-cell-view");
const notebook_cell_toolbar_factory_1 = require("./view/notebook-cell-toolbar-factory");
const inversify_1 = require("@theia/core/shared/inversify");
const vscode_languageserver_protocol_1 = require("@theia/core/shared/vscode-languageserver-protocol");
const notebook_editor_widget_service_1 = require("./service/notebook-editor-widget-service");
const notebook_main_toolbar_1 = require("./view/notebook-main-toolbar");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const notebook_context_manager_1 = require("./service/notebook-context-manager");
const notebook_viewport_service_1 = require("./view/notebook-viewport-service");
const notebook_cell_actions_contribution_1 = require("./contributions/notebook-cell-actions-contribution");
const notebook_find_widget_1 = require("./view/notebook-find-widget");
const debounce = require("@theia/core/shared/lodash.debounce");
const cell_output_webview_1 = require("./renderers/cell-output-webview");
const notebook_view_model_1 = require("./view-model/notebook-view-model");
const PerfectScrollbar = require('react-perfect-scrollbar');
exports.NotebookEditorWidgetContainerFactory = Symbol('NotebookEditorWidgetContainerFactory');
function createNotebookEditorWidgetContainer(parent, props) {
    const child = parent.createChild();
    child.bind(exports.NotebookEditorProps).toConstantValue(props);
    const cellOutputWebviewFactory = parent.get(cell_output_webview_1.CellOutputWebviewFactory);
    child.bind(cell_output_webview_1.CellOutputWebview).toConstantValue(cellOutputWebviewFactory());
    child.bind(notebook_view_model_1.NotebookViewModel).toSelf().inSingletonScope();
    child.bind(notebook_context_manager_1.NotebookContextManager).toSelf().inSingletonScope();
    child.bind(notebook_main_toolbar_1.NotebookMainToolbarRenderer).toSelf().inSingletonScope();
    child.bind(notebook_cell_toolbar_factory_1.NotebookCellToolbarFactory).toSelf().inSingletonScope();
    child.bind(notebook_code_cell_view_1.NotebookCodeCellRenderer).toSelf().inSingletonScope();
    child.bind(notebook_markdown_cell_view_1.NotebookMarkdownCellRenderer).toSelf().inSingletonScope();
    child.bind(notebook_viewport_service_1.NotebookViewportService).toSelf().inSingletonScope();
    child.bind(NotebookEditorWidget).toSelf();
    return child;
}
exports.NotebookEditorProps = Symbol('NotebookEditorProps');
exports.NOTEBOOK_EDITOR_ID_PREFIX = 'notebook:';
let NotebookEditorWidget = class NotebookEditorWidget extends browser_1.ReactWidget {
    constructor() {
        super(...arguments);
        this.saveable = new browser_1.DelegatingSaveable();
        this.onDidChangeModelEmitter = new vscode_languageserver_protocol_1.Emitter();
        this.onDidChangeModel = this.onDidChangeModelEmitter.event;
        this.onDidChangeReadOnlyEmitter = new vscode_languageserver_protocol_1.Emitter();
        this.onDidChangeReadOnly = this.onDidChangeReadOnlyEmitter.event;
        this.onPostKernelMessageEmitter = new vscode_languageserver_protocol_1.Emitter();
        this.onPostKernelMessage = this.onPostKernelMessageEmitter.event;
        this.onDidPostKernelMessageEmitter = new vscode_languageserver_protocol_1.Emitter();
        this.onDidPostKernelMessage = this.onDidPostKernelMessageEmitter.event;
        this.onPostRendererMessageEmitter = new vscode_languageserver_protocol_1.Emitter();
        this.onPostRendererMessage = this.onPostRendererMessageEmitter.event;
        this.onDidReceiveKernelMessageEmitter = new vscode_languageserver_protocol_1.Emitter();
        this.onDidReceiveKernelMessage = this.onDidReceiveKernelMessageEmitter.event;
        this.onDidChangeOutputInputFocusEmitter = new vscode_languageserver_protocol_1.Emitter();
        this.onDidChangeOutputInputFocus = this.onDidChangeOutputInputFocusEmitter.event;
        this.renderers = new Map();
        this._ready = new promise_util_1.Deferred();
        this._findWidgetVisible = false;
        this._findWidgetRef = React.createRef();
        this.scrollBarRef = React.createRef();
        this.debounceFind = debounce(() => {
            this._findWidgetRef.current?.search({});
        }, 30, {
            trailing: true,
            maxWait: 100,
            leading: false
        });
    }
    static { this.ID = 'notebook'; }
    get notebookType() {
        return this.props.notebookType;
    }
    get ready() {
        return this._ready.promise;
    }
    get model() {
        return this._model;
    }
    get viewModel() {
        return this._viewModel;
    }
    init() {
        // ID is set by NotebookEditorWidgetFactory to include counter for multiple instances
        if (!this.id) {
            this.id = exports.NOTEBOOK_EDITOR_ID_PREFIX + this.props.uri.toString();
        }
        this.scrollOptions = {
            suppressScrollY: true
        };
        this.title.closable = true;
        this.update();
        this.toDispose.push(this.onDidChangeModelEmitter);
        this.toDispose.push(this.onDidChangeReadOnlyEmitter);
        this.renderers.set(common_1.CellKind.Markup, this.markdownCellRenderer);
        this.renderers.set(common_1.CellKind.Code, this.codeCellRenderer);
        this._ready.resolve(this.waitForData());
        this.ready.then(model => {
            if (model.cells.length === 1 && model.cells[0].source === '') {
                this.commandRegistry.executeCommand(notebook_cell_actions_contribution_1.NotebookCellCommands.EDIT_COMMAND.id, model, model.cells[0]);
                this.viewModel.setSelectedCell(model.cells[0]);
            }
            model.onDidChangeContent(changeEvents => {
                const cellEvent = changeEvents.filter(event => event.kind === common_1.NotebookCellsChangeType.Move || event.kind === common_1.NotebookCellsChangeType.ModelChange);
                if (cellEvent.length > 0) {
                    this.cellOutputWebview.cellsChanged(cellEvent);
                }
            });
        });
        this.props.error?.then(error => {
            this.error = error;
            this.update();
        });
    }
    async waitForData() {
        this._model = await this.props.notebookData;
        this.viewModel.initDataModel(this._model);
        this.cellOutputWebview.init(this._model, this);
        this.saveable.delegate = this._model;
        this.toDispose.push(this._model);
        this.toDispose.push(this._model.onDidChangeContent(() => {
            // Update the scroll bar content after the content has changed
            // Wait one frame to ensure that the content has been rendered
            (0, browser_1.animationFrame)().then(() => this.scrollBarRef.current?.updateScroll());
        }));
        this.toDispose.push(this._model.onContentChanged(() => {
            if (this._findWidgetVisible) {
                this.debounceFind();
            }
        }));
        this.toDispose.push(this._model.onDidChangeReadOnly(readOnly => {
            if (readOnly) {
                (0, browser_1.lock)(this.title);
            }
            else {
                (0, browser_1.unlock)(this.title);
            }
            this.onDidChangeReadOnlyEmitter.fire(readOnly);
            this.update();
        }));
        if (this._model.readOnly) {
            (0, browser_1.lock)(this.title);
        }
        // Ensure that the model is loaded before adding the editor
        this.notebookEditorService.addNotebookEditor(this);
        this.viewModel.selectedCell = this._model.cells[0];
        this.update();
        this.notebookContextManager.init(this);
        return this._model;
    }
    onActivateRequest(msg) {
        super.onActivateRequest(msg);
        this.node.getElementsByClassName('theia-notebook-main-container')[0]?.focus();
    }
    getResourceUri() {
        return this.props.uri;
    }
    createMoveToUri(resourceUri) {
        return this.model?.uri.withPath(resourceUri.path);
    }
    undo() {
        this._model?.undo();
    }
    redo() {
        this._model?.redo();
    }
    render() {
        if (this._model) {
            return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-main-container', tabIndex: -1, children: [(0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-overlay', children: (0, jsx_runtime_1.jsx)(notebook_find_widget_1.NotebookFindWidget, { ref: this._findWidgetRef, hidden: !this._findWidgetVisible, onClose: () => {
                                this._findWidgetVisible = false;
                                this._model?.findMatches({
                                    activeFilters: [],
                                    matchCase: false,
                                    regex: false,
                                    search: '',
                                    wholeWord: false
                                });
                                this.update();
                            }, onSearch: options => this._model?.findMatches(options) ?? [], onReplace: (matches, replaceText) => this._model?.replaceAll(matches, replaceText) }) }), this.notebookMainToolbarRenderer.render(this._model, this.node), (0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-viewport', ref: ref => { this.viewportService.viewportElement = ref || undefined; }, children: (0, jsx_runtime_1.jsx)(PerfectScrollbar, { className: 'theia-notebook-scroll-container', ref: this.scrollBarRef, onScrollY: (e) => this.viewportService.onScroll(e), children: (0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-scroll-area', children: [this.cellOutputWebview.render(), (0, jsx_runtime_1.jsx)(notebook_cell_list_view_1.NotebookCellListView, { renderers: this.renderers, notebookModel: this._model, notebookViewModel: this.viewModel, notebookContext: this.notebookContextManager, toolbarRenderer: this.cellToolbarFactory, commandRegistry: this.commandRegistry, menuRegistry: this.menuRegistry })] }) }) })] });
        }
        else if (this.error) {
            return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-main-container error-message', tabIndex: -1, children: [(0, jsx_runtime_1.jsx)("span", { className: (0, browser_1.codicon)('error') }), (0, jsx_runtime_1.jsx)("h3", { children: core_1.nls.localizeByDefault('The editor could not be opened because the file was not found.') })] });
        }
        else {
            return (0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-main-container', tabIndex: -1, children: (0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-main-loading-indicator' }) });
        }
    }
    onCloseRequest(msg) {
        super.onCloseRequest(msg);
        this.notebookEditorService.removeNotebookEditor(this);
    }
    requestOuputPresentationChange(cellHandle, output) {
        if (output) {
            this.cellOutputWebview.requestOutputPresentationUpdate(cellHandle, output);
        }
    }
    postKernelMessage(message) {
        this.onDidPostKernelMessageEmitter.fire(message);
    }
    postRendererMessage(rendererId, message) {
        this.onPostRendererMessageEmitter.fire({ rendererId, message });
    }
    recieveKernelMessage(message) {
        this.onDidReceiveKernelMessageEmitter.fire(message);
    }
    outputInputFocusChanged(focused) {
        this.onDidChangeOutputInputFocusEmitter.fire(focused);
    }
    showFindWidget() {
        if (!this._findWidgetVisible) {
            this._findWidgetVisible = true;
            this.update();
        }
        this._findWidgetRef.current?.focusSearch(this._model?.selectedText);
    }
    dispose() {
        this.cellOutputWebview.dispose();
        this.notebookContextManager.dispose();
        this.onDidChangeModelEmitter.dispose();
        this.onDidPostKernelMessageEmitter.dispose();
        this.onDidReceiveKernelMessageEmitter.dispose();
        this.onPostRendererMessageEmitter.dispose();
        this.onDidChangeOutputInputFocusEmitter.dispose();
        this.viewportService.dispose();
        this._model?.dispose();
        super.dispose();
    }
    onAfterShow(msg) {
        super.onAfterShow(msg);
        this.notebookEditorService.notebookEditorFocusChanged(this, true);
    }
    onAfterHide(msg) {
        super.onAfterHide(msg);
        this.notebookEditorService.notebookEditorFocusChanged(this, false);
    }
};
exports.NotebookEditorWidget = NotebookEditorWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_cell_toolbar_factory_1.NotebookCellToolbarFactory),
    tslib_1.__metadata("design:type", notebook_cell_toolbar_factory_1.NotebookCellToolbarFactory)
], NotebookEditorWidget.prototype, "cellToolbarFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.CommandRegistry),
    tslib_1.__metadata("design:type", core_1.CommandRegistry)
], NotebookEditorWidget.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", core_1.MenuModelRegistry)
], NotebookEditorWidget.prototype, "menuRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_editor_widget_service_1.NotebookEditorWidgetService),
    tslib_1.__metadata("design:type", notebook_editor_widget_service_1.NotebookEditorWidgetService)
], NotebookEditorWidget.prototype, "notebookEditorService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_main_toolbar_1.NotebookMainToolbarRenderer),
    tslib_1.__metadata("design:type", notebook_main_toolbar_1.NotebookMainToolbarRenderer)
], NotebookEditorWidget.prototype, "notebookMainToolbarRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_context_manager_1.NotebookContextManager),
    tslib_1.__metadata("design:type", notebook_context_manager_1.NotebookContextManager)
], NotebookEditorWidget.prototype, "notebookContextManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_code_cell_view_1.NotebookCodeCellRenderer),
    tslib_1.__metadata("design:type", notebook_code_cell_view_1.NotebookCodeCellRenderer)
], NotebookEditorWidget.prototype, "codeCellRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_markdown_cell_view_1.NotebookMarkdownCellRenderer),
    tslib_1.__metadata("design:type", notebook_markdown_cell_view_1.NotebookMarkdownCellRenderer)
], NotebookEditorWidget.prototype, "markdownCellRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.NotebookEditorProps),
    tslib_1.__metadata("design:type", Object)
], NotebookEditorWidget.prototype, "props", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_viewport_service_1.NotebookViewportService),
    tslib_1.__metadata("design:type", notebook_viewport_service_1.NotebookViewportService)
], NotebookEditorWidget.prototype, "viewportService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(cell_output_webview_1.CellOutputWebview),
    tslib_1.__metadata("design:type", Object)
], NotebookEditorWidget.prototype, "cellOutputWebview", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_view_model_1.NotebookViewModel),
    tslib_1.__metadata("design:type", notebook_view_model_1.NotebookViewModel)
], NotebookEditorWidget.prototype, "_viewModel", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], NotebookEditorWidget.prototype, "init", null);
exports.NotebookEditorWidget = NotebookEditorWidget = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookEditorWidget);
//# sourceMappingURL=notebook-editor-widget.js.map