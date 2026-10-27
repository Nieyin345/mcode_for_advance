"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotebookCodeCellOutputs = exports.NotebookCodeCellStatus = exports.NotebookCodeCellSidebar = exports.NotebookCodeCellRenderer = void 0;
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
const inversify_1 = require("@theia/core/shared/inversify");
const React = require("@theia/core/shared/react");
const monaco_editor_1 = require("@theia/monaco/lib/browser/monaco-editor");
const notebook_renderer_registry_1 = require("../notebook-renderer-registry");
const notebook_cell_editor_1 = require("./notebook-cell-editor");
const notebook_cell_list_view_1 = require("./notebook-cell-list-view");
const notebook_cell_toolbar_factory_1 = require("./notebook-cell-toolbar-factory");
const notebook_cell_actions_contribution_1 = require("../contributions/notebook-cell-actions-contribution");
const notebook_execution_state_service_1 = require("../service/notebook-execution-state-service");
const browser_1 = require("@theia/core/lib/browser");
const common_1 = require("../../common");
const core_1 = require("@theia/core");
const notebook_context_manager_1 = require("../service/notebook-context-manager");
const notebook_viewport_service_1 = require("./notebook-viewport-service");
const editor_preferences_1 = require("@theia/editor/lib/common/editor-preferences");
const notebook_options_1 = require("../service/notebook-options");
const markdown_renderer_1 = require("@theia/core/lib/browser/markdown-rendering/markdown-renderer");
const markdown_string_1 = require("@theia/core/lib/common/markdown-rendering/markdown-string");
const notebook_cell_editor_service_1 = require("../service/notebook-cell-editor-service");
const cell_output_webview_1 = require("../renderers/cell-output-webview");
const notebook_cell_status_bar_service_1 = require("../service/notebook-cell-status-bar-service");
const label_parser_1 = require("@theia/core/lib/browser/label-parser");
const notebook_view_model_1 = require("../view-model/notebook-view-model");
let NotebookCodeCellRenderer = class NotebookCodeCellRenderer {
    render(notebookModel, cell, handle) {
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-cell-with-sidebar', ref: ref => (0, notebook_cell_list_view_1.observeCellHeight)(ref, cell), children: (0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-cell-editor-container', children: [(0, jsx_runtime_1.jsx)(notebook_cell_editor_1.CellEditor, { notebookModel: notebookModel, cell: cell, notebookViewModel: this.notebookViewModel, monacoServices: this.monacoServices, notebookContextManager: this.notebookContextManager, notebookViewportService: this.notebookViewportService, notebookCellEditorService: this.notebookCellEditorService, fontInfo: this.notebookOptionsService.editorFontInfo }), (0, jsx_runtime_1.jsx)(NotebookCodeCellStatus, { cell: cell, notebook: notebookModel, commandRegistry: this.commandRegistry, executionStateService: this.executionStateService, cellStatusBarService: this.notebookCellStatusBarService, labelParser: this.labelParser, onClick: () => this.notebookViewModel.cellViewModels.get(cell.handle)?.requestFocusEditor() })] }) });
    }
    renderSidebar(notebookModel, cell) {
        return (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)(NotebookCodeCellSidebar, { cell: cell, notebook: notebookModel, notebookCellToolbarFactory: this.notebookCellToolbarFactory }), (0, jsx_runtime_1.jsx)(NotebookCodeCellOutputs, { cell: cell, notebook: notebookModel, outputWebview: this.outputWebview, renderSidebar: () => this.notebookCellToolbarFactory.renderSidebar(notebook_cell_actions_contribution_1.NotebookCellActionContribution.OUTPUT_SIDEBAR_MENU, cell, {
                        contextMenuArgs: () => [notebookModel, cell, cell.outputs[0]]
                    }) })] });
    }
    renderDragImage(cell) {
        const dragImage = document.createElement('div');
        dragImage.className = 'theia-notebook-drag-image';
        dragImage.style.width = this.notebookContextManager.context?.clientWidth + 'px';
        dragImage.style.height = '100px';
        dragImage.style.display = 'flex';
        const fakeRunButton = document.createElement('span');
        fakeRunButton.className = `${(0, browser_1.codicon)('play')} theia-notebook-cell-status-item`;
        dragImage.appendChild(fakeRunButton);
        const fakeEditor = document.createElement('div');
        dragImage.appendChild(fakeEditor);
        const lines = cell.source.split('\n').slice(0, 5).join('\n');
        const codeSequence = this.getMarkdownCodeSequence(lines);
        const firstLine = new markdown_string_1.MarkdownStringImpl(`${codeSequence}${cell.language}\n${lines}\n${codeSequence}`, { supportHtml: true, isTrusted: false });
        fakeEditor.appendChild(this.markdownRenderer.render(firstLine).element);
        fakeEditor.classList.add('theia-notebook-cell-editor-container');
        fakeEditor.style.padding = '10px';
        return dragImage;
    }
    getMarkdownCodeSequence(input) {
        // We need a minimum of 3 backticks to start a code block.
        let longest = 2;
        let current = 0;
        for (let i = 0; i < input.length; i++) {
            const char = input.charAt(i);
            if (char === '`') {
                current++;
                if (current > longest) {
                    longest = current;
                }
            }
            else {
                current = 0;
            }
        }
        return Array(longest + 1).fill('`').join('');
    }
};
exports.NotebookCodeCellRenderer = NotebookCodeCellRenderer;
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_editor_1.MonacoEditorServices),
    tslib_1.__metadata("design:type", monaco_editor_1.MonacoEditorServices)
], NotebookCodeCellRenderer.prototype, "monacoServices", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_renderer_registry_1.NotebookRendererRegistry),
    tslib_1.__metadata("design:type", notebook_renderer_registry_1.NotebookRendererRegistry)
], NotebookCodeCellRenderer.prototype, "notebookRendererRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_cell_toolbar_factory_1.NotebookCellToolbarFactory),
    tslib_1.__metadata("design:type", notebook_cell_toolbar_factory_1.NotebookCellToolbarFactory)
], NotebookCodeCellRenderer.prototype, "notebookCellToolbarFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_execution_state_service_1.NotebookExecutionStateService),
    tslib_1.__metadata("design:type", notebook_execution_state_service_1.NotebookExecutionStateService)
], NotebookCodeCellRenderer.prototype, "executionStateService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_context_manager_1.NotebookContextManager),
    tslib_1.__metadata("design:type", notebook_context_manager_1.NotebookContextManager)
], NotebookCodeCellRenderer.prototype, "notebookContextManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_viewport_service_1.NotebookViewportService),
    tslib_1.__metadata("design:type", notebook_viewport_service_1.NotebookViewportService)
], NotebookCodeCellRenderer.prototype, "notebookViewportService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(editor_preferences_1.EditorPreferences),
    tslib_1.__metadata("design:type", Object)
], NotebookCodeCellRenderer.prototype, "editorPreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_cell_editor_service_1.NotebookCellEditorService),
    tslib_1.__metadata("design:type", notebook_cell_editor_service_1.NotebookCellEditorService)
], NotebookCodeCellRenderer.prototype, "notebookCellEditorService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.CommandRegistry),
    tslib_1.__metadata("design:type", core_1.CommandRegistry)
], NotebookCodeCellRenderer.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_options_1.NotebookOptionsService),
    tslib_1.__metadata("design:type", notebook_options_1.NotebookOptionsService)
], NotebookCodeCellRenderer.prototype, "notebookOptionsService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(markdown_renderer_1.MarkdownRenderer),
    tslib_1.__metadata("design:type", Object)
], NotebookCodeCellRenderer.prototype, "markdownRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(cell_output_webview_1.CellOutputWebview),
    tslib_1.__metadata("design:type", Object)
], NotebookCodeCellRenderer.prototype, "outputWebview", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_cell_status_bar_service_1.NotebookCellStatusBarService),
    tslib_1.__metadata("design:type", notebook_cell_status_bar_service_1.NotebookCellStatusBarService)
], NotebookCodeCellRenderer.prototype, "notebookCellStatusBarService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(label_parser_1.LabelParser),
    tslib_1.__metadata("design:type", label_parser_1.LabelParser)
], NotebookCodeCellRenderer.prototype, "labelParser", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_view_model_1.NotebookViewModel),
    tslib_1.__metadata("design:type", notebook_view_model_1.NotebookViewModel)
], NotebookCodeCellRenderer.prototype, "notebookViewModel", void 0);
exports.NotebookCodeCellRenderer = NotebookCodeCellRenderer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookCodeCellRenderer);
class NotebookCodeCellSidebar extends React.Component {
    constructor(props) {
        super(props);
        this.toDispose = new core_1.DisposableCollection();
        this.toDispose.push(props.cell.onDidCellHeightChange(() => this.forceUpdate()));
    }
    componentWillUnmount() {
        this.toDispose.dispose();
    }
    render() {
        return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-cell-sidebar-actions', style: { height: `${this.props.cell.cellHeight}px` }, children: [this.props.notebookCellToolbarFactory.renderSidebar(notebook_cell_actions_contribution_1.NotebookCellActionContribution.CODE_CELL_SIDEBAR_MENU, this.props.cell, {
                    contextMenuArgs: () => [this.props.cell], commandArgs: () => [this.props.notebook, this.props.cell]
                }), (0, jsx_runtime_1.jsx)(CodeCellExecutionOrder, { cell: this.props.cell })] });
    }
}
exports.NotebookCodeCellSidebar = NotebookCodeCellSidebar;
class NotebookCodeCellStatus extends React.Component {
    constructor(props) {
        super(props);
        this.toDispose = new core_1.DisposableCollection();
        this.statusBarItems = [];
        this.state = {
            executionTime: 0
        };
        let currentInterval;
        if (props.executionStateService) {
            this.toDispose.push(props.executionStateService.onDidChangeExecution(event => {
                if (event.affectsCell(this.props.cell.uri)) {
                    this.setState({ currentExecution: event.changed, executionTime: 0 });
                    clearInterval(currentInterval);
                    if (event.changed?.state === common_1.NotebookCellExecutionState.Executing) {
                        const startTime = Date.now();
                        // The resolution of the time display is only a single digit after the decimal point.
                        // Therefore, we only need to update the display every 100ms.
                        currentInterval = setInterval(() => {
                            this.setState({
                                executionTime: Date.now() - startTime
                            });
                        }, 100);
                    }
                }
            }));
        }
        this.toDispose.push(props.cell.onDidChangeLanguage(() => {
            this.forceUpdate();
        }));
        this.updateStatusBarItems();
        this.props.cellStatusBarService.onDidChangeItems(() => this.updateStatusBarItems());
        this.props.notebook.onContentChanged(() => this.updateStatusBarItems());
    }
    async updateStatusBarItems() {
        this.statusBarItems = await this.props.cellStatusBarService.getStatusBarItemsForCell(this.props.notebook.uri, this.props.notebook.cells.indexOf(this.props.cell), this.props.notebook.viewType, core_1.CancellationToken.None);
        this.forceUpdate();
    }
    componentWillUnmount() {
        this.toDispose.dispose();
    }
    render() {
        return (0, jsx_runtime_1.jsxs)("div", { className: 'notebook-cell-status', onClick: () => this.props.onClick(), children: [(0, jsx_runtime_1.jsxs)("div", { className: 'notebook-cell-status-left', children: [this.props.executionStateService && this.renderExecutionState(), this.statusBarItems?.length && this.renderStatusBarItems()] }), (0, jsx_runtime_1.jsx)("div", { className: 'notebook-cell-status-right', children: (0, jsx_runtime_1.jsx)("span", { className: 'notebook-cell-language-label', onClick: () => {
                            this.props.commandRegistry.executeCommand(notebook_cell_actions_contribution_1.NotebookCellCommands.CHANGE_CELL_LANGUAGE.id, this.props.notebook, this.props.cell);
                        }, children: this.props.cell.languageName }) })] });
    }
    renderExecutionState() {
        const state = this.state.currentExecution?.state;
        const { lastRunSuccess } = this.props.cell.internalMetadata;
        let iconClasses = undefined;
        let color = undefined;
        if (!state && lastRunSuccess) {
            iconClasses = (0, browser_1.codicon)('check');
            color = 'green';
        }
        else if (!state && lastRunSuccess === false) {
            iconClasses = (0, browser_1.codicon)('error');
            color = 'red';
        }
        else if (state === common_1.NotebookCellExecutionState.Pending || state === common_1.NotebookCellExecutionState.Unconfirmed) {
            iconClasses = (0, browser_1.codicon)('clock');
        }
        else if (state === common_1.NotebookCellExecutionState.Executing) {
            iconClasses = `${(0, browser_1.codicon)('sync')} theia-animation-spin`;
        }
        return (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: iconClasses &&
                (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: `${iconClasses} notebook-cell-status-item`, style: { color } }), (0, jsx_runtime_1.jsx)("div", { className: 'notebook-cell-status-item', children: this.renderTime(this.getExecutionTime()) })] }) });
    }
    getExecutionTime() {
        const { runStartTime, runEndTime } = this.props.cell.internalMetadata;
        const { executionTime } = this.state;
        if (runStartTime !== undefined && runEndTime !== undefined) {
            return runEndTime - runStartTime;
        }
        return executionTime;
    }
    renderTime(ms) {
        return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}s`;
    }
    renderStatusBarItems() {
        return (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: this.statusBarItems.flatMap((itemList, listIndex) => itemList.items.map((item, index) => this.renderStatusBarItem(item, `${listIndex}-${index}`))) });
    }
    renderStatusBarItem(item, key) {
        const content = this.props.labelParser.parse(item.text).map(part => {
            if (typeof part === 'string') {
                return part;
            }
            else {
                return (0, jsx_runtime_1.jsx)("span", { className: `codicon codicon-${part.name}` }, part.name);
            }
        });
        return (0, jsx_runtime_1.jsx)("div", { className: `cell-status-bar-item ${item.command ? 'cell-status-item-has-command' : ''}`, onClick: async () => {
                if (item.command) {
                    if (typeof item.command === 'string') {
                        this.props.commandRegistry.executeCommand(item.command);
                    }
                    else {
                        this.props.commandRegistry.executeCommand(item.command.id, ...(item.command.arguments ?? []));
                    }
                }
            }, children: content }, key);
    }
}
exports.NotebookCodeCellStatus = NotebookCodeCellStatus;
class NotebookCodeCellOutputs extends React.Component {
    constructor() {
        super(...arguments);
        this.toDispose = new core_1.DisposableCollection();
        this.outputHeight = 0;
    }
    async componentDidMount() {
        const { cell } = this.props;
        this.toDispose.push(cell.onDidChangeOutputs(() => this.forceUpdate()));
        this.toDispose.push(this.props.cell.onDidChangeOutputVisibility(() => this.forceUpdate()));
        this.toDispose.push(this.props.outputWebview.onDidRenderOutput(event => {
            if (event.cellHandle === this.props.cell.handle) {
                this.outputHeight = event.outputHeight;
                this.forceUpdate();
            }
        }));
    }
    componentWillUnmount() {
        this.toDispose.dispose();
    }
    render() {
        if (!this.props.cell.outputs?.length) {
            return (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, {});
        }
        if (this.props.cell.outputVisible) {
            return (0, jsx_runtime_1.jsx)("div", { style: { minHeight: this.outputHeight }, children: this.props.renderSidebar() });
        }
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-collapsed-output-container', children: (0, jsx_runtime_1.jsx)("i", { className: 'theia-notebook-collapsed-output', children: core_1.nls.localizeByDefault('Outputs are collapsed') }) });
    }
}
exports.NotebookCodeCellOutputs = NotebookCodeCellOutputs;
function CodeCellExecutionOrder({ cell }) {
    const [executionOrder, setExecutionOrder] = React.useState(cell.internalMetadata.executionOrder ?? ' ');
    React.useEffect(() => {
        const listener = cell.onDidChangeInternalMetadata(e => {
            setExecutionOrder(cell.internalMetadata.executionOrder ?? ' ');
        });
        return () => listener.dispose();
    }, []);
    return (0, jsx_runtime_1.jsx)("span", { className: 'theia-notebook-code-cell-execution-order', children: `[${executionOrder}]` });
}
//# sourceMappingURL=notebook-code-cell-view.js.map