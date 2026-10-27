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
var DebugVariablesWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugVariablesWidgetSessionState = exports.DebugVariablesWidget = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const source_tree_1 = require("@theia/core/lib/browser/source-tree");
const debug_variables_source_1 = require("./debug-variables-source");
const debug_view_model_1 = require("./debug-view-model");
const nls_1 = require("@theia/core/lib/common/nls");
const browser_1 = require("@theia/core/lib/browser");
const debug_console_items_1 = require("../console/debug-console-items");
const breakpoint_manager_1 = require("../breakpoint/breakpoint-manager");
const breakpoint_marker_1 = require("../breakpoint/breakpoint-marker");
const debug_session_manager_1 = require("../debug-session-manager");
let DebugVariablesWidget = class DebugVariablesWidget extends source_tree_1.SourceTreeWidget {
    constructor() {
        super(...arguments);
        this.statePerSession = new Map();
    }
    static { DebugVariablesWidget_1 = this; }
    static { this.CONTEXT_MENU = ['debug-variables-context-menu']; }
    static { this.EDIT_MENU = [...DebugVariablesWidget_1.CONTEXT_MENU, 'a_edit']; }
    static { this.WATCH_MENU = [...DebugVariablesWidget_1.CONTEXT_MENU, 'b_watch']; }
    static { this.DATA_BREAKPOINT_MENU = [...DebugVariablesWidget_1.CONTEXT_MENU, 'c_data_breakpoints']; }
    static { this.FACTORY_ID = 'debug:variables'; }
    static createContainer(parent) {
        const child = source_tree_1.SourceTreeWidget.createContainer(parent, {
            contextMenuPath: DebugVariablesWidget_1.CONTEXT_MENU,
            virtualized: false,
            scrollIfActive: true
        });
        child.bind(debug_variables_source_1.DebugVariablesSource).toSelf();
        child.unbind(source_tree_1.SourceTreeWidget);
        child.bind(DebugVariablesWidget_1).toSelf();
        return child;
    }
    static createWidget(parent) {
        return DebugVariablesWidget_1.createContainer(parent).get(DebugVariablesWidget_1);
    }
    init() {
        super.init();
        this.id = DebugVariablesWidget_1.FACTORY_ID + ':' + this.viewModel.id;
        this.title.label = nls_1.nls.localizeByDefault('Variables');
        this.toDispose.push(this.variables);
        this.source = this.variables;
        this.toDispose.push(this.sessionManager.onDidFocusStackFrame(stackFrame => this.handleDidFocusStackFrame(stackFrame)));
        this.toDispose.push(this.sessionManager.onDidDestroyDebugSession(session => this.handleDidDestroyDebugSession(session)));
    }
    handleDidFocusStackFrame(stackFrame) {
        if (this.stackFrame !== stackFrame) {
            if (this.stackFrame) {
                const sessionState = this.getOrCreateSessionState(this.stackFrame.session);
                sessionState.setStateForStackFrame(this.stackFrame, this.superStoreState());
            }
            if (stackFrame) {
                const sessionState = this.statePerSession.get(stackFrame.session.id);
                if (sessionState) {
                    const state = sessionState.getStateForStackFrame(stackFrame);
                    if (state) {
                        this.superRestoreState(state);
                    }
                }
            }
            this.stackFrame = stackFrame;
        }
    }
    getOrCreateSessionState(session) {
        let sessionState = this.statePerSession.get(session.id);
        if (!sessionState) {
            sessionState = this.newSessionState();
            this.statePerSession.set(session.id, sessionState);
        }
        return sessionState;
    }
    newSessionState() {
        return new DebugVariablesWidgetSessionState();
    }
    handleDidDestroyDebugSession(session) {
        this.statePerSession.delete(session.id);
    }
    handleContextMenuEvent(node, event) {
        this.doHandleContextMenuEvent(node, event);
    }
    async doHandleContextMenuEvent(node, event) {
        event.stopPropagation();
        event.preventDefault();
        if (!browser_1.SelectableTreeNode.is(node) || !source_tree_1.TreeElementNode.is(node)) {
            return;
        }
        // Keep the selection for the context menu, if the widget support multi-selection and the right click happens on an already selected node.
        if (!this.props.multiSelect || !node.selected) {
            const type = !!this.props.multiSelect && this.hasCtrlCmdMask(event) ? browser_1.TreeSelection.SelectionType.TOGGLE : browser_1.TreeSelection.SelectionType.DEFAULT;
            this.model.addSelection({ node, type });
        }
        this.focusService.setFocus(node);
        const contextMenuPath = this.props.contextMenuPath;
        if (contextMenuPath) {
            const { x, y } = event.nativeEvent;
            const args = this.toContextMenuArgs(node);
            const target = event.currentTarget;
            const toDisposeOnHide = await this.getVariableCommands(node);
            setTimeout(() => this.contextMenuRenderer.render({
                menuPath: contextMenuPath,
                context: target,
                anchor: { x, y },
                args,
                onHide: () => toDisposeOnHide.dispose()
            }), 10);
        }
    }
    async getVariableCommands(node) {
        const selectedElement = node.element;
        const { viewModel: { currentSession } } = this;
        if (!currentSession?.capabilities.supportsDataBreakpoints || !(selectedElement instanceof debug_console_items_1.DebugVariable)) {
            return common_1.Disposable.NULL;
        }
        const { name, parent: { reference } } = selectedElement;
        const dataBreakpointInfo = (await currentSession.sendRequest('dataBreakpointInfo', { name, variablesReference: reference })).body;
        // eslint-disable-next-line no-null/no-null
        if (dataBreakpointInfo.dataId === null) {
            return common_1.Disposable.NULL;
        }
        const source = { type: 0 /* DataBreakpointSourceType.Variable */, variable: name };
        return new common_1.DisposableCollection(this.commandRegistry.registerCommand(common_1.Command.toDefaultLocalizedCommand({
            id: `break-on-access:${currentSession.id}:${name}`,
            label: 'Break on Value Access'
        }), {
            execute: () => this.breakpointManager.addDataBreakpoint(breakpoint_marker_1.DataBreakpoint.create({ accessType: 'readWrite', dataId: dataBreakpointInfo.dataId }, dataBreakpointInfo, source)),
            isEnabled: () => !!dataBreakpointInfo.accessTypes?.includes('readWrite'),
        }), this.menuRegistry.registerMenuAction(DebugVariablesWidget_1.DATA_BREAKPOINT_MENU, { commandId: `break-on-access:${currentSession.id}:${name}`, order: 'c' }), this.commandRegistry.registerCommand(common_1.Command.toDefaultLocalizedCommand({
            id: `break-on-read:${currentSession.id}:${name}`,
            label: 'Break on Value Read'
        }), {
            execute: () => this.breakpointManager.addDataBreakpoint(breakpoint_marker_1.DataBreakpoint.create({ accessType: 'read', dataId: dataBreakpointInfo.dataId }, dataBreakpointInfo, source)),
            isEnabled: () => !!dataBreakpointInfo.accessTypes?.includes('read'),
        }), this.menuRegistry.registerMenuAction(DebugVariablesWidget_1.DATA_BREAKPOINT_MENU, { commandId: `break-on-read:${currentSession.id}:${name}`, order: 'a' }), this.commandRegistry.registerCommand(common_1.Command.toDefaultLocalizedCommand({
            id: `break-on-write:${currentSession.id}:${name}`,
            label: 'Break on Value Change'
        }), {
            execute: () => this.breakpointManager.addDataBreakpoint(breakpoint_marker_1.DataBreakpoint.create({ accessType: 'write', dataId: dataBreakpointInfo.dataId }, dataBreakpointInfo, source)),
            isEnabled: () => !!dataBreakpointInfo.accessTypes?.includes('write'),
        }), this.menuRegistry.registerMenuAction(DebugVariablesWidget_1.DATA_BREAKPOINT_MENU, { commandId: `break-on-write:${currentSession.id}:${name}`, order: 'b' }));
    }
};
exports.DebugVariablesWidget = DebugVariablesWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_view_model_1.DebugViewModel),
    tslib_1.__metadata("design:type", debug_view_model_1.DebugViewModel)
], DebugVariablesWidget.prototype, "viewModel", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_variables_source_1.DebugVariablesSource),
    tslib_1.__metadata("design:type", debug_variables_source_1.DebugVariablesSource)
], DebugVariablesWidget.prototype, "variables", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.CommandRegistry),
    tslib_1.__metadata("design:type", common_1.CommandRegistry)
], DebugVariablesWidget.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", common_1.MenuModelRegistry)
], DebugVariablesWidget.prototype, "menuRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(breakpoint_manager_1.BreakpointManager),
    tslib_1.__metadata("design:type", breakpoint_manager_1.BreakpointManager)
], DebugVariablesWidget.prototype, "breakpointManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_session_manager_1.DebugSessionManager),
    tslib_1.__metadata("design:type", debug_session_manager_1.DebugSessionManager)
], DebugVariablesWidget.prototype, "sessionManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DebugVariablesWidget.prototype, "init", null);
exports.DebugVariablesWidget = DebugVariablesWidget = DebugVariablesWidget_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DebugVariablesWidget);
class DebugVariablesWidgetSessionState {
    constructor() {
        this.statePerStackFrame = new Map();
    }
    setStateForStackFrame(stackFrame, state) {
        this.statePerStackFrame.set(stackFrame.id, state);
    }
    getStateForStackFrame(stackFrame) {
        return this.statePerStackFrame.get(stackFrame.id);
    }
}
exports.DebugVariablesWidgetSessionState = DebugVariablesWidgetSessionState;
//# sourceMappingURL=debug-variables-widget.js.map