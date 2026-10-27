"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CellOutputWebviewImpl = exports.DEFAULT_NOTEBOOK_OUTPUT_CSS = exports.AdditionalNotebookCellOutputCss = void 0;
exports.createCellOutputWebviewContainer = createCellOutputWebviewContainer;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const inversify_1 = require("@theia/core/shared/inversify");
const uuid_1 = require("@theia/core/lib/common/uuid");
const browser_1 = require("@theia/notebook/lib/browser");
const webview_1 = require("../../webview/webview");
const browser_2 = require("@theia/core/lib/browser");
const output_webview_internal_1 = require("./output-webview-internal");
const browser_3 = require("@theia/workspace/lib/browser");
const core_1 = require("@theia/core");
const notebook_options_1 = require("@theia/notebook/lib/browser/service/notebook-options");
const common_1 = require("@theia/notebook/lib/common");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const notebook_context_keys_1 = require("@theia/notebook/lib/browser/contributions/notebook-context-keys");
exports.AdditionalNotebookCellOutputCss = Symbol('AdditionalNotebookCellOutputCss');
function createCellOutputWebviewContainer(ctx) {
    const child = ctx.createChild();
    child.bind(exports.AdditionalNotebookCellOutputCss).toConstantValue(exports.DEFAULT_NOTEBOOK_OUTPUT_CSS);
    child.bind(CellOutputWebviewImpl).toSelf();
    return child;
}
// Should be kept up-to-date with:
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/notebook/browser/view/renderers/webviewThemeMapping.ts
const mapping = new Map([
    ['theme-font-family', 'vscode-font-family'],
    ['theme-font-weight', 'vscode-font-weight'],
    ['theme-font-size', 'vscode-font-size'],
    ['theme-code-font-family', 'vscode-editor-font-family'],
    ['theme-code-font-weight', 'vscode-editor-font-weight'],
    ['theme-code-font-size', 'vscode-editor-font-size'],
    ['theme-scrollbar-background', 'vscode-scrollbarSlider-background'],
    ['theme-scrollbar-hover-background', 'vscode-scrollbarSlider-hoverBackground'],
    ['theme-scrollbar-active-background', 'vscode-scrollbarSlider-activeBackground'],
    ['theme-quote-background', 'vscode-textBlockQuote-background'],
    ['theme-quote-border', 'vscode-textBlockQuote-border'],
    ['theme-code-foreground', 'vscode-textPreformat-foreground'],
    // Editor
    ['theme-background', 'vscode-editor-background'],
    ['theme-foreground', 'vscode-editor-foreground'],
    ['theme-ui-foreground', 'vscode-foreground'],
    ['theme-link', 'vscode-textLink-foreground'],
    ['theme-link-active', 'vscode-textLink-activeForeground'],
    // Buttons
    ['theme-button-background', 'vscode-button-background'],
    ['theme-button-hover-background', 'vscode-button-hoverBackground'],
    ['theme-button-foreground', 'vscode-button-foreground'],
    ['theme-button-secondary-background', 'vscode-button-secondaryBackground'],
    ['theme-button-secondary-hover-background', 'vscode-button-secondaryHoverBackground'],
    ['theme-button-secondary-foreground', 'vscode-button-secondaryForeground'],
    ['theme-button-hover-foreground', 'vscode-button-foreground'],
    ['theme-button-focus-foreground', 'vscode-button-foreground'],
    ['theme-button-secondary-hover-foreground', 'vscode-button-secondaryForeground'],
    ['theme-button-secondary-focus-foreground', 'vscode-button-secondaryForeground'],
    // Inputs
    ['theme-input-background', 'vscode-input-background'],
    ['theme-input-foreground', 'vscode-input-foreground'],
    ['theme-input-placeholder-foreground', 'vscode-input-placeholderForeground'],
    ['theme-input-focus-border-color', 'vscode-focusBorder'],
    // Menus
    ['theme-menu-background', 'vscode-menu-background'],
    ['theme-menu-foreground', 'vscode-menu-foreground'],
    ['theme-menu-hover-background', 'vscode-menu-selectionBackground'],
    ['theme-menu-focus-background', 'vscode-menu-selectionBackground'],
    ['theme-menu-hover-foreground', 'vscode-menu-selectionForeground'],
    ['theme-menu-focus-foreground', 'vscode-menu-selectionForeground'],
    // Errors
    ['theme-error-background', 'vscode-inputValidation-errorBackground'],
    ['theme-error-foreground', 'vscode-foreground'],
    ['theme-warning-background', 'vscode-inputValidation-warningBackground'],
    ['theme-warning-foreground', 'vscode-foreground'],
    ['theme-info-background', 'vscode-inputValidation-infoBackground'],
    ['theme-info-foreground', 'vscode-foreground'],
    // Notebook:
    ['theme-notebook-output-background', 'vscode-notebook-outputContainerBackgroundColor'],
    ['theme-notebook-output-border', 'vscode-notebook-outputContainerBorderColor'],
    ['theme-notebook-cell-selected-background', 'vscode-notebook-selectedCellBackground'],
    ['theme-notebook-symbol-highlight-background', 'vscode-notebook-symbolHighlightBackground'],
    ['theme-notebook-diff-removed-background', 'vscode-diffEditor-removedTextBackground'],
    ['theme-notebook-diff-inserted-background', 'vscode-diffEditor-insertedTextBackground'],
]);
const constants = {
    'theme-input-border-width': '1px',
    'theme-button-primary-hover-shadow': 'none',
    'theme-button-secondary-hover-shadow': 'none',
    'theme-input-border-color': 'transparent',
};
exports.DEFAULT_NOTEBOOK_OUTPUT_CSS = `
:root {
    ${Array.from(mapping.entries()).map(([key, value]) => `--${key}: var(--${value});`).join('\n')}
    ${Object.entries(constants).map(([key, value]) => `--${key}: ${value};`).join('\n')}
}

body {
    padding: 0;
}

table {
    border-collapse: collapse;
    border-spacing: 0;
}
  
table th,
table td {
    border: 1px solid;
}

table > thead > tr > th {
    text-align: left;
    border-bottom: 1px solid;
}

table > thead > tr > th,
table > thead > tr > td,
table > tbody > tr > th,
table > tbody > tr > td {
    padding: 5px 10px;
}

table > tbody > tr + tr > td {
    border-top: 1px solid;
}

table,
thead,
tr,
th,
td,
tbody {
    border: none !important;
    border-color: transparent;
    border-spacing: 0;
    border-collapse: collapse;
}

table,
th,
tr {
    vertical-align: middle;
    text-align: right;
}

thead {
    font-weight: bold;
    background-color: rgba(130, 130, 130, 0.16);
}

th,
td {
    padding: 4px 8px;
}

tr:nth-child(even) {
    background-color: rgba(130, 130, 130, 0.08);
}

tbody th {
    font-weight: normal;
}
`;
let CellOutputWebviewImpl = class CellOutputWebviewImpl {
    constructor() {
        // returns the output Height
        this.onDidRenderOutputEmitter = new core_1.Emitter();
        this.onDidRenderOutput = this.onDidRenderOutputEmitter.event;
        this.id = (0, uuid_1.generateUuid)();
        this.webviewWidgetInitialized = new promise_util_1.Deferred();
        this.toDispose = new core_1.DisposableCollection();
        this.isDisposed = false;
    }
    async init(notebook, editor) {
        this.notebook = notebook;
        this.editor = editor;
        this.options = this.notebookOptionsService.computeOutputOptions();
        this.toDispose.push(this.notebookOptionsService.onDidChangeOutputOptions(options => {
            this.options = options;
            this.updateStyles();
        }));
        this.webviewWidget = await this.widgetManager.getOrCreateWidget(webview_1.WebviewWidget.FACTORY_ID, { id: this.id });
        this.webviewWidgetInitialized.resolve();
        // this.webviewWidget.parent = this.editor ?? null;
        this.webviewWidget.setContentOptions({
            allowScripts: true,
            // eslint-disable-next-line max-len
            // list taken from https://github.com/microsoft/vscode/blob/a27099233b956dddc2536d4a0d714ab36266d897/src/vs/workbench/contrib/notebook/browser/view/renderers/backLayerWebView.ts#L762-L774
            enableCommandUris: [
                'github-issues.authNow',
                'workbench.extensions.search',
                'workbench.action.openSettings',
                '_notebook.selectKernel',
                'jupyter.viewOutput',
                'workbench.action.openLargeOutput',
                'cellOutput.enableScrolling',
            ],
        });
        this.webviewWidget.setHTML(await this.createWebviewContent());
        this.notebook.onDidAddOrRemoveCell(e => {
            if (e.newCellIds) {
                const newCells = e.newCellIds.map(id => this.notebook.cells.find(cell => cell.handle === id)).filter(cell => !!cell);
                newCells.forEach(cell => this.attachCellAndOutputListeners(cell));
            }
        });
        this.notebook.cells.forEach(cell => this.attachCellAndOutputListeners(cell));
        if (this.editor) {
            this.toDispose.push(this.editor.onDidPostKernelMessage(message => {
                this.webviewWidget.sendMessage({
                    type: 'customKernelMessage',
                    message
                });
            }));
            this.toDispose.push(this.editor.onPostRendererMessage(messageObj => {
                this.webviewWidget.sendMessage({
                    type: 'customRendererMessage',
                    ...messageObj
                });
            }));
        }
        this.webviewWidget.onMessage((message) => {
            this.handleWebviewMessage(message);
        });
    }
    attachCellAndOutputListeners(cell) {
        this.toDispose.push(cell.onDidChangeOutputs(outputChange => this.updateOutputs([{
                newOutputs: outputChange.newOutputs,
                start: outputChange.start,
                deleteCount: outputChange.deleteCount,
                cellHandle: cell.handle
            }])));
        this.toDispose.push(cell.onDidChangeOutputItems(output => {
            const oldOutputIndex = cell.outputs.findIndex(o => o.outputId === output.outputId);
            this.updateOutputs([{
                    cellHandle: cell.handle,
                    newOutputs: [output],
                    start: oldOutputIndex,
                    deleteCount: 1
                }]);
        }));
        this.toDispose.push(cell.onDidCellHeightChange(height => this.setCellHeight(cell, height)));
        this.toDispose.push(cell.onDidChangeOutputVisibility(visible => {
            this.webviewWidget.sendMessage({
                type: 'outputVisibilityChanged',
                cellHandle: cell.handle,
                visible
            });
        }));
    }
    render() {
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-cell-output-webview', ref: element => {
                this.element = element ?? undefined;
                if (element) {
                    this.webviewWidgetInitialized.promise
                        .then(() => this.attachWebview())
                        .catch(error => this.logger.error('Failed to attach notebook output webview.', error));
                }
            } });
    }
    attachWebview() {
        if (this.element && !this.isAttached()) {
            this.webviewWidget.processMessage(new browser_2.Message('before-attach'));
            this.element.appendChild(this.webviewWidget.node);
            this.webviewWidget.processMessage(new browser_2.Message('after-attach'));
            this.webviewWidget.setIframeHeight(0);
        }
    }
    isAttached() {
        return this.element?.contains(this.webviewWidget.node) ?? false;
    }
    updateOutputs(updates) {
        if (this.webviewWidget.isHidden) {
            this.webviewWidget.show();
        }
        const visibleCells = this.notebook.getVisibleCells();
        const visibleCellHandleLookup = new Set(visibleCells.map(cell => cell.handle));
        const updateOutputMessage = {
            type: 'outputChanged',
            changes: updates
                .filter(update => visibleCellHandleLookup.has(update.cellHandle))
                .map(update => ({
                cellHandle: update.cellHandle,
                newOutputs: this.mapCellOutputsToWebviewOutput(update.newOutputs),
                start: update.start,
                deleteCount: update.deleteCount
            }))
        };
        if (updateOutputMessage.changes.length > 0) {
            this.webviewWidget.sendMessage(updateOutputMessage);
        }
    }
    cellsChanged(cellEvents) {
        const changes = [];
        const outputChanges = [];
        const visibleCellLookup = new Set(this.notebook.getVisibleCells());
        for (const event of cellEvents) {
            if (event.kind === common_1.NotebookCellsChangeType.Move) {
                changes.push(...event.cells.map((cell, i) => {
                    const cellMoved = {
                        type: 'cellMoved',
                        cellHandle: event.cells[0].handle, // TODO check this, ask Jonah
                        toIndex: event.newIdx,
                    };
                    return cellMoved;
                }));
            }
            else if (event.kind === common_1.NotebookCellsChangeType.ModelChange) {
                changes.push(...event.changes.map(change => {
                    const cellSpliced = {
                        type: 'cellsSpliced',
                        startCellHandle: change.startHandle,
                        deleteCount: change.deleteCount,
                        newCells: change.newItems.filter(cell => visibleCellLookup.has(cell)).map(cell => cell.handle)
                    };
                    return cellSpliced;
                }));
                outputChanges.push(...event.changes
                    .flatMap(change => change.newItems)
                    .filter(cell => visibleCellLookup.has(cell) && cell.outputs.length)
                    .map(newCell => ({
                    start: 0,
                    deleteCount: 0,
                    cellHandle: newCell.handle,
                    newOutputs: this.mapCellOutputsToWebviewOutput(newCell.outputs)
                })));
            }
        }
        this.webviewWidget.sendMessage({
            type: 'cellsChanged',
            changes: changes.filter(e => e)
        });
        if (outputChanges.length > 0) {
            this.webviewWidget.sendMessage({
                type: 'outputChanged',
                changes: outputChanges
            });
        }
    }
    mapCellOutputsToWebviewOutput(outputs) {
        return outputs.map(output => ({
            id: output.outputId,
            items: output.outputs.map(item => ({ mime: item.mime, data: item.data.buffer })),
            metadata: output.metadata
        }));
    }
    /**
     * Currently not used, but could be useful in a subclasses
     *
     * @param index cell index
     * @param cellHandle cell handle
     * @param visibleCells  visible cells
     * @returns visible cell index or -1 if not found
     */
    toVisibleCellIndex(index, cellHandle, visibleCells) {
        const cell = this.notebook.cells[index];
        if (cell.handle === cellHandle) {
            return visibleCells.indexOf(cell);
        }
        // in case of deletion index points to a non-existing cell
        return -1;
    }
    setCellHeight(cell, height) {
        if (!this.isDisposed) {
            this.webviewWidget.sendMessage({
                type: 'cellHeightUpdate',
                cellHandle: cell.handle,
                cellKind: cell.cellKind,
                height
            });
        }
    }
    async requestOutputPresentationUpdate(cellHandle, output) {
        const selectedMime = await this.quickPickService.show(output.outputs.map(item => ({ label: item.mime })), { description: core_1.nls.localizeByDefault('Select mimetype to render for current output') });
        if (selectedMime) {
            this.webviewWidget.sendMessage({
                type: 'changePreferredMimetype',
                cellHandle,
                outputId: output.outputId,
                mimeType: selectedMime.label
            });
        }
    }
    handleWebviewMessage(message) {
        if (!this.editor) {
            throw new Error('No editor found for cell output webview');
        }
        switch (message.type) {
            case 'initialized':
                this.updateOutputs(this.notebook.getVisibleCells().map(cell => ({
                    cellHandle: cell.handle,
                    newOutputs: cell.outputs,
                    start: 0,
                    deleteCount: 0
                })));
                this.updateStyles();
                break;
            case 'customRendererMessage':
                this.messagingService.getScoped(this.editor.id).postMessage(message.rendererId, message.message);
                break;
            case 'didRenderOutput':
                this.webviewWidget.setIframeHeight(message.bodyHeight);
                this.onDidRenderOutputEmitter.fire({
                    cellHandle: message.cellHandle,
                    outputId: message.outputId,
                    outputHeight: message.outputHeight
                });
                break;
            case 'did-scroll-wheel':
                this.editor.node.getElementsByClassName('theia-notebook-viewport')[0].children[0].scrollBy(message.deltaX, message.deltaY);
                break;
            case 'customKernelMessage':
                this.editor.recieveKernelMessage(message.message);
                break;
            case 'inputFocusChanged':
                this.editor?.outputInputFocusChanged(message.focused);
                break;
            case 'cellFocusChanged':
                const selectedCell = this.notebook.getCellByHandle(message.cellHandle);
                if (selectedCell) {
                    this.editor.viewModel.setSelectedCell(selectedCell);
                }
                break;
            case 'webviewFocusChanged':
                if (message.focused) {
                    window.getSelection()?.empty();
                }
                this.contextKeyService.setContext(notebook_context_keys_1.NOTEBOOK_OUTPUT_FOCUSED, message.focused);
                break;
            case 'cellHeightRequest':
                const cellHeight = this.notebook.getCellByHandle(message.cellHandle)?.cellHeight ?? 0;
                this.webviewWidget.sendMessage({
                    type: 'cellHeightUpdate',
                    cellHandle: message.cellHandle,
                    height: cellHeight
                });
                break;
            case 'bodyHeightChange':
                this.webviewWidget.setIframeHeight(message.height);
                break;
        }
    }
    getPreloads() {
        const kernel = this.notebookKernelService.getSelectedOrSuggestedKernel(this.notebook);
        const kernelPreloads = kernel?.preloadUris.map(uri => uri.toString()) ?? [];
        const staticPreloads = this.notebookRendererRegistry.staticNotebookPreloads
            .filter(preload => preload.type === this.notebook.viewType)
            .map(preload => preload.entrypoint);
        return kernelPreloads.concat(staticPreloads);
    }
    updateStyles() {
        this.webviewWidget.sendMessage({
            type: 'notebookStyles',
            styles: this.generateStyles()
        });
    }
    generateStyles() {
        return {
            'notebook-output-node-left-padding': `${this.options.outputNodeLeftPadding}px`,
            'notebook-cell-output-font-size': `${this.options.outputFontSize || this.options.fontSize}px`,
            'notebook-cell-output-line-height': `${this.options.outputLineHeight}px`,
            'notebook-cell-output-max-height': `${this.options.outputLineHeight * this.options.outputLineLimit}px`,
            'notebook-cell-output-font-family': this.options.outputFontFamily || this.options.fontFamily,
        };
    }
    async createWebviewContent() {
        const isWorkspaceTrusted = await this.workspaceTrustService.getWorkspaceTrust();
        const preloads = this.preloadsScriptString(isWorkspaceTrusted);
        const content = `
                <html>
                    <head>
                        <meta charset="UTF-8">
                        <style>
                            ${this.additionalOutputCss}
                        </style>
                    </head>
                    <body>
                        <script type="module">${preloads}</script>
                    </body>
                </html>
                `;
        return content;
    }
    preloadsScriptString(isWorkspaceTrusted) {
        const ctx = {
            isWorkspaceTrusted,
            rendererData: this.notebookRendererRegistry.notebookRenderers,
            renderOptions: {
                lineLimit: this.options.outputLineLimit,
                outputScrolling: this.options.outputScrolling,
                outputWordWrap: this.options.outputWordWrap,
            },
            staticPreloadsData: this.getPreloads()
        };
        // TS will try compiling `import()` in webviewPreloads, so use a helper function instead
        // of using `import(...)` directly
        return `
            const __import = (x) => import(x);
                (${output_webview_internal_1.outputWebviewPreload})(JSON.parse(decodeURIComponent("${encodeURIComponent(JSON.stringify(ctx))}")))`;
    }
    dispose() {
        this.isDisposed = true;
        this.toDispose.dispose();
    }
};
exports.CellOutputWebviewImpl = CellOutputWebviewImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.NotebookRendererMessagingService),
    tslib_1.__metadata("design:type", browser_1.NotebookRendererMessagingService)
], CellOutputWebviewImpl.prototype, "messagingService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.WidgetManager),
    tslib_1.__metadata("design:type", browser_2.WidgetManager)
], CellOutputWebviewImpl.prototype, "widgetManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_3.WorkspaceTrustService),
    tslib_1.__metadata("design:type", browser_3.WorkspaceTrustService)
], CellOutputWebviewImpl.prototype, "workspaceTrustService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.NotebookRendererRegistry),
    tslib_1.__metadata("design:type", browser_1.NotebookRendererRegistry)
], CellOutputWebviewImpl.prototype, "notebookRendererRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.NotebookEditorWidgetService),
    tslib_1.__metadata("design:type", browser_1.NotebookEditorWidgetService)
], CellOutputWebviewImpl.prototype, "notebookEditorWidgetService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.NotebookKernelService),
    tslib_1.__metadata("design:type", browser_1.NotebookKernelService)
], CellOutputWebviewImpl.prototype, "notebookKernelService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.QuickPickService),
    tslib_1.__metadata("design:type", Object)
], CellOutputWebviewImpl.prototype, "quickPickService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext:CellOutputWebviewImpl'),
    tslib_1.__metadata("design:type", Object)
], CellOutputWebviewImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.AdditionalNotebookCellOutputCss),
    tslib_1.__metadata("design:type", String)
], CellOutputWebviewImpl.prototype, "additionalOutputCss", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_options_1.NotebookOptionsService),
    tslib_1.__metadata("design:type", notebook_options_1.NotebookOptionsService)
], CellOutputWebviewImpl.prototype, "notebookOptionsService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], CellOutputWebviewImpl.prototype, "contextKeyService", void 0);
exports.CellOutputWebviewImpl = CellOutputWebviewImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], CellOutputWebviewImpl);
//# sourceMappingURL=cell-output-webview.js.map