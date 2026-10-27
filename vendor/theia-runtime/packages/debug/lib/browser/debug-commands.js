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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugBreakpointWidgetCommands = exports.DebugEditorContextCommands = exports.DebugSessionContextCommands = exports.DebugThreadContextCommands = exports.DebugCommands = exports.DebugMenus = void 0;
exports.nlsEnableBreakpoint = nlsEnableBreakpoint;
exports.nlsDisableBreakpoint = nlsDisableBreakpoint;
const common_1 = require("@theia/core/lib/common");
const browser_1 = require("@theia/core/lib/browser");
const nls_1 = require("@theia/core/lib/common/nls");
var DebugMenus;
(function (DebugMenus) {
    DebugMenus.DEBUG = [...common_1.MAIN_MENU_BAR, '6_debug'];
    DebugMenus.DEBUG_CONTROLS = [...DebugMenus.DEBUG, 'a_controls'];
    DebugMenus.DEBUG_CONFIGURATION = [...DebugMenus.DEBUG, 'b_configuration'];
    DebugMenus.DEBUG_THREADS = [...DebugMenus.DEBUG, 'c_threads'];
    DebugMenus.DEBUG_SESSIONS = [...DebugMenus.DEBUG, 'd_sessions'];
    DebugMenus.DEBUG_BREAKPOINT = [...DebugMenus.DEBUG, 'e_breakpoint'];
    DebugMenus.DEBUG_NEW_BREAKPOINT = [...DebugMenus.DEBUG_BREAKPOINT, 'a_new_breakpoint'];
    DebugMenus.DEBUG_BREAKPOINTS = [...DebugMenus.DEBUG, 'f_breakpoints'];
})(DebugMenus || (exports.DebugMenus = DebugMenus = {}));
function nlsEditBreakpoint(breakpoint) {
    return nls_1.nls.localizeByDefault('Edit {0}...', nls_1.nls.localizeByDefault(breakpoint));
}
function nlsRemoveBreakpoint(breakpoint) {
    return nls_1.nls.localizeByDefault('Remove {0}', nls_1.nls.localizeByDefault(breakpoint));
}
function nlsEnableBreakpoint(breakpoint) {
    return nls_1.nls.localizeByDefault('Enable {0}', nls_1.nls.localizeByDefault(breakpoint));
}
function nlsDisableBreakpoint(breakpoint) {
    return nls_1.nls.localizeByDefault('Disable {0}', nls_1.nls.localizeByDefault(breakpoint));
}
var DebugCommands;
(function (DebugCommands) {
    DebugCommands.DEBUG_CATEGORY = 'Debug';
    DebugCommands.DEBUG_CATEGORY_KEY = nls_1.nls.getDefaultKey(DebugCommands.DEBUG_CATEGORY);
    DebugCommands.START = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.debug.start',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Start Debugging',
        iconClass: (0, browser_1.codicon)('debug-alt')
    });
    DebugCommands.START_NO_DEBUG = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.debug.run',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Start Without Debugging'
    });
    DebugCommands.STOP = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.debug.stop',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Stop',
        iconClass: (0, browser_1.codicon)('debug-stop')
    });
    DebugCommands.RESTART = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.debug.restart',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Restart',
        iconClass: (0, browser_1.codicon)('debug-restart')
    });
    DebugCommands.OPEN_CONFIGURATIONS = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.configurations.open',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Open Configurations'
    });
    DebugCommands.ADD_CONFIGURATION = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.configurations.add',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Add Configuration...'
    });
    DebugCommands.STEP_OVER = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.debug.stepOver',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Step Over',
        iconClass: (0, browser_1.codicon)('debug-step-over')
    });
    DebugCommands.STEP_INTO = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.debug.stepInto',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Step Into',
        iconClass: (0, browser_1.codicon)('debug-step-into')
    });
    DebugCommands.STEP_OUT = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.debug.stepOut',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Step Out',
        iconClass: (0, browser_1.codicon)('debug-step-out')
    });
    DebugCommands.CONTINUE = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.debug.continue',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Continue',
        iconClass: (0, browser_1.codicon)('debug-continue')
    });
    DebugCommands.PAUSE = common_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.debug.pause',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Pause',
        iconClass: (0, browser_1.codicon)('debug-pause')
    });
    DebugCommands.CONTINUE_ALL = common_1.Command.toLocalizedCommand({
        id: 'debug.thread.continue.all',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Continue All',
        iconClass: (0, browser_1.codicon)('debug-continue')
    }, 'theia/debug/continueAll', DebugCommands.DEBUG_CATEGORY_KEY);
    DebugCommands.PAUSE_ALL = common_1.Command.toLocalizedCommand({
        id: 'debug.thread.pause.all',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Pause All',
        iconClass: (0, browser_1.codicon)('debug-pause')
    }, 'theia/debug/pauseAll', DebugCommands.DEBUG_CATEGORY_KEY);
    DebugCommands.TOGGLE_BREAKPOINT = common_1.Command.toDefaultLocalizedCommand({
        id: 'editor.debug.action.toggleBreakpoint',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Toggle Breakpoint',
    });
    DebugCommands.INLINE_BREAKPOINT = common_1.Command.toDefaultLocalizedCommand({
        id: 'editor.debug.action.inlineBreakpoint',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Inline Breakpoint',
    });
    DebugCommands.ADD_CONDITIONAL_BREAKPOINT = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.breakpoint.add.conditional',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Add Conditional Breakpoint...',
    });
    DebugCommands.ADD_LOGPOINT = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.breakpoint.add.logpoint',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Add Logpoint...',
    });
    DebugCommands.ADD_FUNCTION_BREAKPOINT = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.breakpoint.add.function',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Add Function Breakpoint',
    });
    DebugCommands.ADD_DATA_BREAKPOINT = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.breakpoint.add.data',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Add Data Breakpoint at Address'
    });
    DebugCommands.ENABLE_SELECTED_BREAKPOINTS = common_1.Command.toLocalizedCommand({
        id: 'debug.breakpoint.enableSelected',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Enable Selected Breakpoints',
    }, 'theia/debug/enableSelectedBreakpoints', DebugCommands.DEBUG_CATEGORY_KEY);
    DebugCommands.ENABLE_ALL_BREAKPOINTS = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.breakpoint.enableAll',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Enable All Breakpoints',
    });
    DebugCommands.DISABLE_SELECTED_BREAKPOINTS = common_1.Command.toLocalizedCommand({
        id: 'debug.breakpoint.disableSelected',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Disable Selected Breakpoints',
    }, 'theia/debug/disableSelectedBreakpoints', DebugCommands.DEBUG_CATEGORY_KEY);
    DebugCommands.DISABLE_ALL_BREAKPOINTS = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.breakpoint.disableAll',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Disable All Breakpoints',
    });
    DebugCommands.EDIT_BREAKPOINT = common_1.Command.toLocalizedCommand({
        id: 'debug.breakpoint.edit',
        category: DebugCommands.DEBUG_CATEGORY,
        originalLabel: 'Edit Breakpoint...',
        label: nlsEditBreakpoint('Breakpoint')
    }, '', DebugCommands.DEBUG_CATEGORY_KEY);
    DebugCommands.EDIT_LOGPOINT = common_1.Command.toLocalizedCommand({
        id: 'debug.logpoint.edit',
        category: DebugCommands.DEBUG_CATEGORY,
        originalLabel: 'Edit Logpoint...',
        label: nlsEditBreakpoint('Logpoint')
    }, '', DebugCommands.DEBUG_CATEGORY_KEY);
    DebugCommands.EDIT_BREAKPOINT_CONDITION = common_1.Command.toLocalizedCommand({
        id: 'debug.breakpoint.editCondition',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Edit Condition...'
    }, '', DebugCommands.DEBUG_CATEGORY_KEY);
    DebugCommands.REMOVE_BREAKPOINT = common_1.Command.toLocalizedCommand({
        id: 'debug.breakpoint.remove',
        category: DebugCommands.DEBUG_CATEGORY,
        originalLabel: 'Remove Breakpoint',
        label: nlsRemoveBreakpoint('Breakpoint')
    }, '', DebugCommands.DEBUG_CATEGORY_KEY);
    DebugCommands.REMOVE_LOGPOINT = common_1.Command.toLocalizedCommand({
        id: 'debug.logpoint.remove',
        category: DebugCommands.DEBUG_CATEGORY,
        originalLabel: 'Remove Logpoint',
        label: nlsRemoveBreakpoint('Logpoint')
    }, '', DebugCommands.DEBUG_CATEGORY_KEY);
    DebugCommands.REMOVE_SELECTED_BREAKPOINTS = common_1.Command.toLocalizedCommand({
        id: 'debug.breakpoint.removeSelected',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Remove Selected Breakpoints',
    }, '', DebugCommands.DEBUG_CATEGORY_KEY);
    DebugCommands.REMOVE_ALL_BREAKPOINTS = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.breakpoint.removeAll',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Remove All Breakpoints',
    });
    DebugCommands.TOGGLE_BREAKPOINTS_ENABLED = common_1.Command.toLocalizedCommand({
        id: 'debug.breakpoint.toggleEnabled',
        label: 'Toggle Enable Breakpoints',
    });
    DebugCommands.SHOW_HOVER = common_1.Command.toDefaultLocalizedCommand({
        id: 'editor.debug.action.showDebugHover',
        label: 'Debug: Show Hover'
    });
    DebugCommands.EVALUATE_IN_DEBUG_CONSOLE = common_1.Command.toDefaultLocalizedCommand({
        id: 'editor.debug.action.selectionToRepl',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Evaluate in Debug Console'
    });
    DebugCommands.ADD_TO_WATCH = common_1.Command.toDefaultLocalizedCommand({
        id: 'editor.debug.action.selectionToWatch',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Add to Watch'
    });
    DebugCommands.JUMP_TO_CURSOR = common_1.Command.toDefaultLocalizedCommand({
        id: 'editor.debug.action.jumpToCursor',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Jump to Cursor'
    });
    DebugCommands.RUN_TO_CURSOR = common_1.Command.toDefaultLocalizedCommand({
        id: 'editor.debug.action.runToCursor',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Run to Cursor'
    });
    DebugCommands.RUN_TO_LINE = common_1.Command.toDefaultLocalizedCommand({
        id: 'editor.debug.action.runToLine',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Run to Line'
    });
    DebugCommands.RESTART_FRAME = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.frame.restart',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Restart Frame',
    });
    DebugCommands.COPY_CALL_STACK = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.callStack.copy',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Copy Call Stack',
    });
    DebugCommands.SET_VARIABLE_VALUE = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.variable.setValue',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Set Value',
    });
    DebugCommands.COPY_VARIABLE_VALUE = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.variable.copyValue',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Copy Value',
    });
    DebugCommands.COPY_VARIABLE_AS_EXPRESSION = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.variable.copyAsExpression',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Copy as Expression',
    });
    DebugCommands.WATCH_VARIABLE = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.variable.watch',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Add to Watch',
    });
    DebugCommands.ADD_WATCH_EXPRESSION = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.watch.addExpression',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Add Expression'
    });
    DebugCommands.EDIT_WATCH_EXPRESSION = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.watch.editExpression',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Edit Expression'
    });
    DebugCommands.COPY_WATCH_EXPRESSION_VALUE = common_1.Command.toLocalizedCommand({
        id: 'debug.watch.copyExpressionValue',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Copy Expression Value'
    }, 'theia/debug/copyExpressionValue', DebugCommands.DEBUG_CATEGORY_KEY);
    DebugCommands.REMOVE_WATCH_EXPRESSION = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.watch.removeExpression',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Remove Expression'
    });
    DebugCommands.COLLAPSE_ALL_WATCH_EXPRESSIONS = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.watch.collapseAllExpressions',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Collapse All'
    });
    DebugCommands.REMOVE_ALL_WATCH_EXPRESSIONS = common_1.Command.toDefaultLocalizedCommand({
        id: 'debug.watch.removeAllExpressions',
        category: DebugCommands.DEBUG_CATEGORY,
        label: 'Remove All Expressions'
    });
})(DebugCommands || (exports.DebugCommands = DebugCommands = {}));
var DebugThreadContextCommands;
(function (DebugThreadContextCommands) {
    DebugThreadContextCommands.STEP_OVER = {
        id: 'debug.thread.context.context.next'
    };
    DebugThreadContextCommands.STEP_INTO = {
        id: 'debug.thread.context.stepin'
    };
    DebugThreadContextCommands.STEP_OUT = {
        id: 'debug.thread.context.stepout'
    };
    DebugThreadContextCommands.CONTINUE = {
        id: 'debug.thread.context.continue'
    };
    DebugThreadContextCommands.PAUSE = {
        id: 'debug.thread.context.pause'
    };
    DebugThreadContextCommands.TERMINATE = {
        id: 'debug.thread.context.terminate'
    };
})(DebugThreadContextCommands || (exports.DebugThreadContextCommands = DebugThreadContextCommands = {}));
var DebugSessionContextCommands;
(function (DebugSessionContextCommands) {
    DebugSessionContextCommands.STOP = {
        id: 'debug.session.context.stop'
    };
    DebugSessionContextCommands.RESTART = {
        id: 'debug.session.context.restart'
    };
    DebugSessionContextCommands.PAUSE_ALL = {
        id: 'debug.session.context.pauseAll'
    };
    DebugSessionContextCommands.CONTINUE_ALL = {
        id: 'debug.session.context.continueAll'
    };
    DebugSessionContextCommands.REVEAL = {
        id: 'debug.session.context.reveal'
    };
})(DebugSessionContextCommands || (exports.DebugSessionContextCommands = DebugSessionContextCommands = {}));
var DebugEditorContextCommands;
(function (DebugEditorContextCommands) {
    DebugEditorContextCommands.ADD_BREAKPOINT = {
        id: 'debug.editor.context.addBreakpoint'
    };
    DebugEditorContextCommands.ADD_CONDITIONAL_BREAKPOINT = {
        id: 'debug.editor.context.addBreakpoint.conditional'
    };
    DebugEditorContextCommands.ADD_LOGPOINT = {
        id: 'debug.editor.context.add.logpoint'
    };
    DebugEditorContextCommands.REMOVE_BREAKPOINT = {
        id: 'debug.editor.context.removeBreakpoint'
    };
    DebugEditorContextCommands.EDIT_BREAKPOINT = {
        id: 'debug.editor.context.edit.breakpoint'
    };
    DebugEditorContextCommands.ENABLE_BREAKPOINT = {
        id: 'debug.editor.context.enableBreakpoint'
    };
    DebugEditorContextCommands.DISABLE_BREAKPOINT = {
        id: 'debug.editor.context.disableBreakpoint'
    };
    DebugEditorContextCommands.REMOVE_LOGPOINT = {
        id: 'debug.editor.context.logpoint.remove'
    };
    DebugEditorContextCommands.EDIT_LOGPOINT = {
        id: 'debug.editor.context.logpoint.edit'
    };
    DebugEditorContextCommands.ENABLE_LOGPOINT = {
        id: 'debug.editor.context.logpoint.enable'
    };
    DebugEditorContextCommands.DISABLE_LOGPOINT = {
        id: 'debug.editor.context.logpoint.disable'
    };
    DebugEditorContextCommands.JUMP_TO_CURSOR = {
        id: 'debug.editor.context.jumpToCursor'
    };
    DebugEditorContextCommands.RUN_TO_LINE = {
        id: 'debug.editor.context.runToLine'
    };
})(DebugEditorContextCommands || (exports.DebugEditorContextCommands = DebugEditorContextCommands = {}));
var DebugBreakpointWidgetCommands;
(function (DebugBreakpointWidgetCommands) {
    DebugBreakpointWidgetCommands.ACCEPT = {
        id: 'debug.breakpointWidget.accept'
    };
    DebugBreakpointWidgetCommands.CLOSE = {
        id: 'debug.breakpointWidget.close'
    };
})(DebugBreakpointWidgetCommands || (exports.DebugBreakpointWidgetCommands = DebugBreakpointWidgetCommands = {}));
//# sourceMappingURL=debug-commands.js.map