"use strict";
// *****************************************************************************
// Copyright (C) 2018 TypeFox and others.
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
var OutputWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutputWidget = void 0;
const tslib_1 = require("tslib");
require("../../src/browser/style/output.css");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/editor/lib/browser");
const monaco_editor_1 = require("@theia/monaco/lib/browser/monaco-editor");
const selection_service_1 = require("@theia/core/lib/common/selection-service");
const monaco_editor_provider_1 = require("@theia/monaco/lib/browser/monaco-editor-provider");
const disposable_1 = require("@theia/core/lib/common/disposable");
const browser_2 = require("@theia/core/lib/browser");
const output_uri_1 = require("../common/output-uri");
const output_channel_1 = require("./output-channel");
const core_1 = require("@theia/core");
const nls_1 = require("@theia/core/lib/common/nls");
const monaco = tslib_1.__importStar(require("@theia/monaco-editor-core"));
let OutputWidget = class OutputWidget extends browser_2.BaseWidget {
    static { OutputWidget_1 = this; }
    static { this.ID = 'outputView'; }
    static { this.LABEL = nls_1.nls.localizeByDefault('Output'); }
    static { this.SELECTED_CHANNEL_STORAGE_KEY = 'output-widget-selected-channel'; }
    constructor() {
        super();
        this._state = { locked: false };
        this.toDisposeOnSelectedChannelChanged = new disposable_1.DisposableCollection();
        this.onStateChangedEmitter = new core_1.Emitter();
        this.id = OutputWidget_1.ID;
        this.title.label = OutputWidget_1.LABEL;
        this.title.caption = OutputWidget_1.LABEL;
        this.title.iconClass = (0, browser_2.codicon)('output');
        this.title.closable = true;
        this.addClass('theia-output');
        this.node.tabIndex = 0;
        this.editorContainer = new NoopDragOverDockPanel({ spacing: 0, mode: 'single-document' });
        this.editorContainer.addClass('editor-container');
        this.editorContainer.node.tabIndex = -1;
    }
    init() {
        this.toDispose.pushAll([
            this.outputChannelManager.onChannelAdded(({ name }) => {
                this.tryRestorePendingChannel(name);
                this.refreshEditorWidget();
            }),
            this.outputChannelManager.onChannelDeleted(() => this.refreshEditorWidget()),
            this.outputChannelManager.onChannelWasHidden(() => this.refreshEditorWidget()),
            this.outputChannelManager.onChannelWasShown(({ preserveFocus }) => {
                // User explicitly showed a channel, clear any pending restoration
                // so we don't override their choice when the pending channel is registered later
                this.clearPendingChannelRestore();
                this.refreshEditorWidget({ preserveFocus: !!preserveFocus });
            }),
            this.outputChannelManager.onSelectedChannelChanged(() => this.refreshEditorWidget()),
            this.toDisposeOnSelectedChannelChanged,
            this.onStateChangedEmitter,
            this.onStateChanged(() => this.update())
        ]);
        this.restoreSelectedChannelFromStorage();
        this.refreshEditorWidget();
    }
    /**
     * Restore the selected channel from storage. This handles the case where the
     * Output widget was closed before the application shut down, so the widget was
     * not in the layout and `storeState`/`restoreState` never ran.
     *
     * Only applies if the manager doesn't already have a selected channel — if it
     * does, something (e.g. a `channel.show()` call) already set the selection
     * before this widget was created, and we should not override it.
     */
    async restoreSelectedChannelFromStorage() {
        const storedChannelName = await this.storageService.getData(OutputWidget_1.SELECTED_CHANNEL_STORAGE_KEY);
        if (storedChannelName
            && !this._state.selectedChannelName
            && !this._state.pendingSelectedChannelName
            && !this.outputChannelManager.selectedChannel) {
            const channel = this.outputChannelManager.getVisibleChannels().find(ch => ch.name === storedChannelName);
            if (channel) {
                this.outputChannelManager.selectedChannel = channel;
                this.refreshEditorWidget();
            }
            else {
                this._state = { ...this._state, pendingSelectedChannelName: storedChannelName };
            }
        }
        // If no restoration occurred and nothing else has set a selection,
        // fall back to the first visible channel so the widget isn't empty.
        this.ensureChannelSelected();
    }
    dispose() {
        const channelName = this.selectedChannel?.name;
        if (channelName) {
            this.storageService.setData(OutputWidget_1.SELECTED_CHANNEL_STORAGE_KEY, channelName);
        }
        super.dispose();
    }
    /**
     * Try to restore the pending channel if it matches the newly added channel.
     */
    tryRestorePendingChannel(addedChannelName) {
        const pendingName = this._state.pendingSelectedChannelName;
        if (pendingName && pendingName === addedChannelName) {
            const channel = this.outputChannelManager.getVisibleChannels().find(ch => ch.name === pendingName);
            if (channel) {
                this.outputChannelManager.selectedChannel = channel;
                this.clearPendingChannelRestore();
            }
        }
    }
    /**
     * Clear any pending channel restoration.
     * Called when the user explicitly selects a channel, so we don't override their choice.
     */
    clearPendingChannelRestore() {
        if (this._state.pendingSelectedChannelName) {
            this._state = { ...this._state, pendingSelectedChannelName: undefined };
        }
    }
    storeState() {
        const { locked, selectedChannelName } = this.state;
        const result = { locked };
        // Store the selected channel name, preferring the actual current selection
        // over any pending restoration that hasn't completed yet
        if (this.selectedChannel) {
            result.selectedChannelName = this.selectedChannel.name;
        }
        else if (selectedChannelName) {
            result.selectedChannelName = selectedChannelName;
        }
        return result;
    }
    restoreState(oldState) {
        const copy = (0, core_1.deepClone)(this.state);
        if (oldState.locked) {
            copy.locked = oldState.locked;
        }
        if (oldState.selectedChannelName) {
            copy.selectedChannelName = oldState.selectedChannelName;
            // Try to restore the selected channel in the manager if it exists
            const channels = this.outputChannelManager.getVisibleChannels();
            const channel = channels.find(ch => ch.name === oldState.selectedChannelName);
            if (channel) {
                this.outputChannelManager.selectedChannel = channel;
            }
            else {
                // Channel not yet available (e.g., registered by an extension that loads later).
                // Store as pending and wait for it to be added.
                copy.pendingSelectedChannelName = oldState.selectedChannelName;
            }
        }
        this.state = copy;
    }
    get state() {
        return this._state;
    }
    set state(state) {
        this._state = state;
        this.onStateChangedEmitter.fire(this._state);
    }
    async refreshEditorWidget({ preserveFocus } = { preserveFocus: false }) {
        const { selectedChannel } = this;
        const editorWidget = this.editorWidget;
        if (selectedChannel && editorWidget) {
            // If the input is the current one, do nothing.
            const model = editorWidget.editor.getControl().getModel();
            if (model && model.uri.toString() === selectedChannel.uri.toString()) {
                if (!preserveFocus) {
                    this.activate();
                }
                return;
            }
        }
        this.toDisposeOnSelectedChannelChanged.dispose();
        if (selectedChannel) {
            const widget = await this.createEditorWidget();
            if (widget) {
                this.editorContainer.addWidget(widget);
                this.toDisposeOnSelectedChannelChanged.pushAll([
                    disposable_1.Disposable.create(() => widget.close()),
                    selectedChannel.onContentChange(() => this.revealLastLine())
                ]);
                if (!preserveFocus) {
                    this.activate();
                }
                this.revealLastLine();
            }
        }
    }
    onAfterAttach(message) {
        super.onAfterAttach(message);
        browser_2.Widget.attach(this.editorContainer, this.node);
        this.toDisposeOnDetach.push(disposable_1.Disposable.create(() => browser_2.Widget.detach(this.editorContainer)));
    }
    onActivateRequest(message) {
        super.onActivateRequest(message);
        if (this.editor) {
            this.editor.focus();
        }
        else {
            this.node.focus();
        }
    }
    onResize(message) {
        super.onResize(message);
        browser_2.MessageLoop.sendMessage(this.editorContainer, browser_2.Widget.ResizeMessage.UnknownSize);
        for (const widget of this.editorContainer.widgets()) {
            browser_2.MessageLoop.sendMessage(widget, browser_2.Widget.ResizeMessage.UnknownSize);
        }
    }
    onAfterShow(msg) {
        super.onAfterShow(msg);
        this.onResize(browser_2.Widget.ResizeMessage.UnknownSize); // Triggers an editor widget resize. (#8361)
    }
    get onStateChanged() {
        return this.onStateChangedEmitter.event;
    }
    clear() {
        if (this.selectedChannel) {
            this.selectedChannel.clear();
        }
    }
    selectAll() {
        const editor = this.editor;
        if (editor) {
            const model = editor.getControl().getModel();
            if (model) {
                const endLine = model.getLineCount();
                const endCharacter = model.getLineMaxColumn(endLine);
                editor.getControl().setSelection(new monaco.Range(1, 1, endLine, endCharacter));
            }
        }
    }
    lock() {
        this.state = { ...(0, core_1.deepClone)(this.state), locked: true };
    }
    unlock() {
        this.state = { ...(0, core_1.deepClone)(this.state), locked: false };
    }
    get isLocked() {
        return !!this.state.locked;
    }
    revealLastLine() {
        if (this.isLocked) {
            return;
        }
        const editor = this.editor;
        if (editor) {
            const model = editor.getControl().getModel();
            if (model) {
                const lineNumber = model.getLineCount();
                const column = model.getLineMaxColumn(lineNumber);
                editor.getControl().revealPosition({ lineNumber, column }, monaco.editor.ScrollType.Smooth);
            }
        }
    }
    /**
     * If no channel is currently selected, select the first visible channel
     * as a default so the widget shows content rather than an empty view.
     */
    ensureChannelSelected() {
        if (!this.outputChannelManager.selectedChannel) {
            const firstVisible = this.outputChannelManager.getVisibleChannels()[0];
            if (firstVisible) {
                this.outputChannelManager.selectedChannel = firstVisible;
            }
        }
    }
    get selectedChannel() {
        return this.outputChannelManager.selectedChannel;
    }
    async createEditorWidget() {
        if (!this.selectedChannel) {
            return undefined;
        }
        const { name } = this.selectedChannel;
        const editor = await this.editorProvider.get(output_uri_1.OutputUri.create(name));
        return new browser_1.EditorWidget(editor, this.selectionService);
    }
    get editorWidget() {
        for (const widget of this.editorContainer.children()) {
            if (widget instanceof browser_1.EditorWidget) {
                return widget;
            }
        }
        return undefined;
    }
    get editor() {
        return monaco_editor_1.MonacoEditor.get(this.editorWidget);
    }
    getText() {
        return this.editor?.getControl().getModel()?.getValue();
    }
};
exports.OutputWidget = OutputWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(selection_service_1.SelectionService),
    tslib_1.__metadata("design:type", selection_service_1.SelectionService)
], OutputWidget.prototype, "selectionService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_editor_provider_1.MonacoEditorProvider),
    tslib_1.__metadata("design:type", monaco_editor_provider_1.MonacoEditorProvider)
], OutputWidget.prototype, "editorProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(output_channel_1.OutputChannelManager),
    tslib_1.__metadata("design:type", output_channel_1.OutputChannelManager)
], OutputWidget.prototype, "outputChannelManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.StorageService),
    tslib_1.__metadata("design:type", Object)
], OutputWidget.prototype, "storageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], OutputWidget.prototype, "init", null);
exports.OutputWidget = OutputWidget = OutputWidget_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], OutputWidget);
/**
 * Customized `DockPanel` that does not allow dropping widgets into it.
 */
class NoopDragOverDockPanel extends browser_2.DockPanel {
}
NoopDragOverDockPanel.prototype['_evtDragOver'] = () => { };
NoopDragOverDockPanel.prototype['_evtDrop'] = () => { };
NoopDragOverDockPanel.prototype['_evtDragLeave'] = () => { };
//# sourceMappingURL=output-widget.js.map