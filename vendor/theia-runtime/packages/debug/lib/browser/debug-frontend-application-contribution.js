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
exports.DebugFrontendApplicationContribution = void 0;
const tslib_1 = require("tslib");
const browser_1 = require("@theia/core/lib/browser");
const source_tree_1 = require("@theia/core/lib/browser/source-tree");
const inversify_1 = require("@theia/core/shared/inversify");
const monaco = require("@theia/monaco-editor-core");
const common_1 = require("@theia/core/lib/common");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const browser_2 = require("@theia/editor/lib/browser");
const debug_session_manager_1 = require("./debug-session-manager");
const debug_widget_1 = require("./view/debug-widget");
const breakpoint_marker_1 = require("./breakpoint/breakpoint-marker");
const breakpoint_manager_1 = require("./breakpoint/breakpoint-manager");
const debug_configuration_manager_1 = require("./debug-configuration-manager");
const debug_session_1 = require("./debug-session");
const debug_breakpoints_widget_1 = require("./view/debug-breakpoints-widget");
const debug_source_breakpoint_1 = require("./model/debug-source-breakpoint");
const debug_threads_widget_1 = require("./view/debug-threads-widget");
const debug_thread_1 = require("./model/debug-thread");
const debug_stack_frames_widget_1 = require("./view/debug-stack-frames-widget");
const debug_stack_frame_1 = require("./model/debug-stack-frame");
const debug_variables_widget_1 = require("./view/debug-variables-widget");
const debug_console_items_1 = require("./console/debug-console-items");
const debug_editor_model_1 = require("./editor/debug-editor-model");
const debug_editor_service_1 = require("./editor/debug-editor-service");
const debug_console_contribution_1 = require("./console/debug-console-contribution");
const debug_service_1 = require("../common/debug-service");
const debug_schema_updater_1 = require("./debug-schema-updater");
const debug_preferences_1 = require("../common/debug-preferences");
const debug_watch_widget_1 = require("./view/debug-watch-widget");
const debug_watch_expression_1 = require("./view/debug-watch-expression");
const debug_watch_manager_1 = require("./debug-watch-manager");
const debug_session_options_1 = require("./debug-session-options");
const debug_function_breakpoint_1 = require("./model/debug-function-breakpoint");
const debug_breakpoint_1 = require("./model/debug-breakpoint");
const nls_1 = require("@theia/core/lib/common/nls");
const debug_instruction_breakpoint_1 = require("./model/debug-instruction-breakpoint");
const debug_exception_breakpoint_1 = require("./view/debug-exception-breakpoint");
const debug_toolbar_widget_1 = require("./view/debug-toolbar-widget");
const console_widget_1 = require("@theia/console/lib/browser/console-widget");
const console_contribution_1 = require("@theia/console/lib/browser/console-contribution");
const debug_hover_widget_1 = require("./editor/debug-hover-widget");
const debug_expression_provider_1 = require("./editor/debug-expression-provider");
const debug_data_breakpoint_actions_1 = require("./breakpoint/debug-data-breakpoint-actions");
const debug_commands_1 = require("./debug-commands");
const core_1 = require("@theia/core");
let DebugFrontendApplicationContribution = class DebugFrontendApplicationContribution extends browser_1.AbstractViewContribution {
    constructor() {
        super({
            widgetId: debug_widget_1.DebugWidget.ID,
            widgetName: debug_widget_1.DebugWidget.LABEL,
            defaultWidgetOptions: {
                area: 'left',
                rank: 400
            },
            toggleCommandId: 'debug:toggle',
            toggleKeybinding: 'ctrlcmd+shift+d'
        });
        this.firstSessionStart = true;
    }
    async initializeLayout() {
        await this.openView();
    }
    async onStart() {
        this.manager.onDidCreateDebugSession(session => this.openSession(session, { reveal: false }));
        this.manager.onDidStartDebugSession(session => {
            const { noDebug } = session.configuration;
            const openDebug = session.configuration.openDebug || this.preference['debug.openDebug'];
            const internalConsoleOptions = session.configuration.internalConsoleOptions || this.preference['debug.internalConsoleOptions'];
            if (internalConsoleOptions === 'openOnSessionStart' ||
                (internalConsoleOptions === 'openOnFirstSessionStart' && this.firstSessionStart)) {
                this.console.openView({
                    reveal: true,
                    activate: false,
                });
            }
            const shouldOpenDebug = openDebug === 'openOnSessionStart' || (openDebug === 'openOnFirstSessionStart' && this.firstSessionStart);
            // Do not open debug view when suppressed via configuration
            if (!noDebug && !this.getOption(session, 'suppressDebugView') && shouldOpenDebug) {
                this.openSession(session);
            }
            this.firstSessionStart = false;
        });
        this.manager.onDidStopDebugSession(session => {
            const { openDebug } = session.configuration;
            if (!this.getOption(session, 'suppressDebugView') && openDebug === 'openOnDebugBreak') {
                this.openSession(session);
            }
        });
        this.updateStatusBar();
        this.manager.onDidChange(() => this.updateStatusBar());
        this.schemaUpdater.update();
        this.configurations.load();
        this.breakpointManager.load();
        this.watchManager.load();
    }
    onStop() {
        this.configurations.save();
        this.breakpointManager.save();
        this.watchManager.save();
    }
    onWillStop() {
        if (this.preference['debug.confirmOnExit'] === 'always' && this.manager.currentSession) {
            return {
                reason: 'active-debug-sessions',
                action: async () => {
                    if (this.manager.currentSession) {
                        const msg = this.manager.sessions.length === 1
                            ? nls_1.nls.localizeByDefault('There is an active debug session, are you sure you want to stop it?')
                            : nls_1.nls.localizeByDefault('There are active debug sessions, are you sure you want to stop them?');
                        const safeToExit = await new browser_1.ConfirmDialog({
                            title: '',
                            msg,
                            ok: nls_1.nls.localizeByDefault('Stop Debugging'),
                            cancel: browser_1.Dialog.CANCEL,
                        }).open();
                        return safeToExit === true;
                    }
                    return true;
                },
            };
        }
    }
    registerMenus(menus) {
        super.registerMenus(menus);
        const registerMenuActions = (menuPath, ...commands) => {
            for (const [index, command] of commands.entries()) {
                const label = command.label;
                const debug = `${debug_commands_1.DebugCommands.DEBUG_CATEGORY}:`;
                menus.registerMenuAction(menuPath, {
                    commandId: command.id,
                    label: label && label.startsWith(debug) && label.slice(debug.length).trimStart() || label,
                    icon: command.iconClass,
                    when: command.when,
                    order: command.order || String.fromCharCode('a'.charCodeAt(0) + index)
                });
            }
        };
        menus.registerSubmenu(debug_commands_1.DebugMenus.DEBUG, nls_1.nls.localizeByDefault('Run'));
        registerMenuActions(debug_commands_1.DebugMenus.DEBUG_CONTROLS, debug_commands_1.DebugCommands.START, debug_commands_1.DebugCommands.START_NO_DEBUG, debug_commands_1.DebugCommands.STOP, debug_commands_1.DebugCommands.RESTART);
        registerMenuActions(debug_commands_1.DebugMenus.DEBUG_CONFIGURATION, debug_commands_1.DebugCommands.OPEN_CONFIGURATIONS, debug_commands_1.DebugCommands.ADD_CONFIGURATION);
        registerMenuActions(debug_commands_1.DebugMenus.DEBUG_THREADS, debug_commands_1.DebugCommands.CONTINUE, debug_commands_1.DebugCommands.STEP_OVER, debug_commands_1.DebugCommands.STEP_INTO, debug_commands_1.DebugCommands.STEP_OUT, debug_commands_1.DebugCommands.PAUSE);
        registerMenuActions(debug_commands_1.DebugMenus.DEBUG_SESSIONS, debug_commands_1.DebugCommands.CONTINUE_ALL, debug_commands_1.DebugCommands.PAUSE_ALL);
        registerMenuActions(debug_commands_1.DebugMenus.DEBUG_BREAKPOINT, debug_commands_1.DebugCommands.TOGGLE_BREAKPOINT);
        menus.registerSubmenu(debug_commands_1.DebugMenus.DEBUG_NEW_BREAKPOINT, nls_1.nls.localizeByDefault('New Breakpoint'));
        registerMenuActions(debug_commands_1.DebugMenus.DEBUG_NEW_BREAKPOINT, debug_commands_1.DebugCommands.ADD_CONDITIONAL_BREAKPOINT, debug_commands_1.DebugCommands.INLINE_BREAKPOINT, debug_commands_1.DebugCommands.ADD_FUNCTION_BREAKPOINT, debug_commands_1.DebugCommands.ADD_LOGPOINT, debug_commands_1.DebugCommands.ADD_DATA_BREAKPOINT);
        registerMenuActions(debug_commands_1.DebugMenus.DEBUG_BREAKPOINTS, debug_commands_1.DebugCommands.ENABLE_ALL_BREAKPOINTS, debug_commands_1.DebugCommands.DISABLE_ALL_BREAKPOINTS, debug_commands_1.DebugCommands.REMOVE_ALL_BREAKPOINTS);
        registerMenuActions(debug_threads_widget_1.DebugThreadsWidget.CONTROL_MENU, { ...debug_commands_1.DebugCommands.PAUSE, ...debug_commands_1.DebugThreadContextCommands.PAUSE }, { ...debug_commands_1.DebugCommands.CONTINUE, ...debug_commands_1.DebugThreadContextCommands.CONTINUE }, { ...debug_commands_1.DebugCommands.STEP_OVER, ...debug_commands_1.DebugThreadContextCommands.STEP_OVER }, { ...debug_commands_1.DebugCommands.STEP_INTO, ...debug_commands_1.DebugThreadContextCommands.STEP_INTO }, { ...debug_commands_1.DebugCommands.STEP_OUT, ...debug_commands_1.DebugThreadContextCommands.STEP_OUT }, { ...debug_commands_1.DebugCommands.PAUSE_ALL, ...debug_commands_1.DebugSessionContextCommands.PAUSE_ALL }, { ...debug_commands_1.DebugCommands.CONTINUE_ALL, ...debug_commands_1.DebugSessionContextCommands.CONTINUE_ALL });
        registerMenuActions(debug_threads_widget_1.DebugThreadsWidget.TERMINATE_MENU, { ...debug_commands_1.DebugCommands.RESTART, ...debug_commands_1.DebugSessionContextCommands.RESTART }, { ...debug_commands_1.DebugCommands.STOP, ...debug_commands_1.DebugSessionContextCommands.STOP }, { ...debug_commands_1.DebugThreadContextCommands.TERMINATE, label: nls_1.nls.localizeByDefault('Terminate Thread') });
        registerMenuActions(debug_threads_widget_1.DebugThreadsWidget.OPEN_MENU, { ...debug_commands_1.DebugSessionContextCommands.REVEAL, label: nls_1.nls.localizeByDefault('Reveal') });
        registerMenuActions(debug_stack_frames_widget_1.DebugStackFramesWidget.CONTEXT_MENU, debug_commands_1.DebugCommands.RESTART_FRAME, debug_commands_1.DebugCommands.COPY_CALL_STACK);
        registerMenuActions(console_contribution_1.ConsoleContextMenu.CLIPBOARD, { ...debug_commands_1.DebugCommands.COPY_VARIABLE_VALUE, order: 'a1a' }, { ...debug_commands_1.DebugCommands.COPY_VARIABLE_AS_EXPRESSION, order: 'a1b' });
        registerMenuActions(debug_variables_widget_1.DebugVariablesWidget.EDIT_MENU, debug_commands_1.DebugCommands.SET_VARIABLE_VALUE, debug_commands_1.DebugCommands.COPY_VARIABLE_VALUE, debug_commands_1.DebugCommands.COPY_VARIABLE_AS_EXPRESSION);
        registerMenuActions(debug_variables_widget_1.DebugVariablesWidget.WATCH_MENU, debug_commands_1.DebugCommands.WATCH_VARIABLE);
        registerMenuActions(debug_hover_widget_1.DebugHoverWidget.EDIT_MENU, debug_commands_1.DebugCommands.COPY_VARIABLE_VALUE, debug_commands_1.DebugCommands.COPY_VARIABLE_AS_EXPRESSION);
        registerMenuActions(debug_hover_widget_1.DebugHoverWidget.WATCH_MENU, debug_commands_1.DebugCommands.WATCH_VARIABLE);
        registerMenuActions(debug_watch_widget_1.DebugWatchWidget.EDIT_MENU, debug_commands_1.DebugCommands.EDIT_WATCH_EXPRESSION, debug_commands_1.DebugCommands.COPY_WATCH_EXPRESSION_VALUE);
        registerMenuActions(debug_watch_widget_1.DebugWatchWidget.REMOVE_MENU, debug_commands_1.DebugCommands.REMOVE_WATCH_EXPRESSION, debug_commands_1.DebugCommands.REMOVE_ALL_WATCH_EXPRESSIONS);
        registerMenuActions(debug_breakpoints_widget_1.DebugBreakpointsWidget.EDIT_MENU, debug_commands_1.DebugCommands.EDIT_BREAKPOINT, { ...debug_commands_1.DebugCommands.ADD_DATA_BREAKPOINT, label: nls_1.nls.localizeByDefault('Edit Address...'), originalLabel: 'Edit Address...' }, debug_commands_1.DebugCommands.EDIT_LOGPOINT, debug_commands_1.DebugCommands.EDIT_BREAKPOINT_CONDITION);
        registerMenuActions(debug_breakpoints_widget_1.DebugBreakpointsWidget.REMOVE_MENU, debug_commands_1.DebugCommands.REMOVE_BREAKPOINT, debug_commands_1.DebugCommands.REMOVE_LOGPOINT, debug_commands_1.DebugCommands.REMOVE_SELECTED_BREAKPOINTS, debug_commands_1.DebugCommands.REMOVE_ALL_BREAKPOINTS);
        registerMenuActions(debug_breakpoints_widget_1.DebugBreakpointsWidget.ENABLE_MENU, debug_commands_1.DebugCommands.ENABLE_SELECTED_BREAKPOINTS, debug_commands_1.DebugCommands.DISABLE_SELECTED_BREAKPOINTS, debug_commands_1.DebugCommands.ENABLE_ALL_BREAKPOINTS, debug_commands_1.DebugCommands.DISABLE_ALL_BREAKPOINTS);
        const DEBUG_EDITOR_CONTEXT_MENU_GROUP = [...browser_2.EDITOR_CONTEXT_MENU, '2_debug'];
        registerMenuActions(DEBUG_EDITOR_CONTEXT_MENU_GROUP, debug_commands_1.DebugCommands.EVALUATE_IN_DEBUG_CONSOLE, debug_commands_1.DebugCommands.ADD_TO_WATCH, debug_commands_1.DebugCommands.JUMP_TO_CURSOR, debug_commands_1.DebugCommands.RUN_TO_CURSOR, debug_commands_1.DebugCommands.RUN_TO_LINE);
        registerMenuActions([...debug_editor_model_1.DebugEditorModel.CONTEXT_MENU, '1_breakpoint'], { ...debug_commands_1.DebugEditorContextCommands.ADD_BREAKPOINT, label: nls_1.nls.localizeByDefault('Add Breakpoint') }, { ...debug_commands_1.DebugEditorContextCommands.ADD_CONDITIONAL_BREAKPOINT, label: debug_commands_1.DebugCommands.ADD_CONDITIONAL_BREAKPOINT.label }, { ...debug_commands_1.DebugEditorContextCommands.ADD_LOGPOINT, label: debug_commands_1.DebugCommands.ADD_LOGPOINT.label }, { ...debug_commands_1.DebugEditorContextCommands.REMOVE_BREAKPOINT, label: debug_commands_1.DebugCommands.REMOVE_BREAKPOINT.label }, { ...debug_commands_1.DebugEditorContextCommands.EDIT_BREAKPOINT, label: debug_commands_1.DebugCommands.EDIT_BREAKPOINT.label }, { ...debug_commands_1.DebugEditorContextCommands.ENABLE_BREAKPOINT, label: (0, debug_commands_1.nlsEnableBreakpoint)('Breakpoint') }, { ...debug_commands_1.DebugEditorContextCommands.DISABLE_BREAKPOINT, label: (0, debug_commands_1.nlsDisableBreakpoint)('Breakpoint') }, { ...debug_commands_1.DebugEditorContextCommands.REMOVE_LOGPOINT, label: debug_commands_1.DebugCommands.REMOVE_LOGPOINT.label }, { ...debug_commands_1.DebugEditorContextCommands.EDIT_LOGPOINT, label: debug_commands_1.DebugCommands.EDIT_LOGPOINT.label }, { ...debug_commands_1.DebugEditorContextCommands.ENABLE_LOGPOINT, label: (0, debug_commands_1.nlsEnableBreakpoint)('Logpoint') }, { ...debug_commands_1.DebugEditorContextCommands.DISABLE_LOGPOINT, label: (0, debug_commands_1.nlsDisableBreakpoint)('Logpoint') });
        registerMenuActions([...debug_editor_model_1.DebugEditorModel.CONTEXT_MENU, '2_control'], { ...debug_commands_1.DebugEditorContextCommands.JUMP_TO_CURSOR, label: nls_1.nls.localizeByDefault('Jump to Cursor') }, { ...debug_commands_1.DebugEditorContextCommands.RUN_TO_LINE, label: debug_commands_1.DebugCommands.RUN_TO_LINE.label });
        menus.linkCompoundMenuNode({ newParentPath: browser_2.EDITOR_LINENUMBER_CONTEXT_MENU, submenuPath: debug_editor_model_1.DebugEditorModel.CONTEXT_MENU });
        menus.registerSubmenu(debug_toolbar_widget_1.DebugToolBar.MENU, nls_1.nls.localize('theia/debug/debugToolbarMenu', 'Debug Toolbar Menu'));
        registerMenuActions(debug_toolbar_widget_1.DebugToolBar.CONTROLS, { ...debug_commands_1.DebugCommands.CONTINUE, when: 'debugState == stopped' }, { ...debug_commands_1.DebugCommands.PAUSE, when: 'debugState != stopped' }, debug_commands_1.DebugCommands.STEP_OVER, debug_commands_1.DebugCommands.STEP_INTO, debug_commands_1.DebugCommands.STEP_OUT, debug_commands_1.DebugCommands.RESTART, debug_commands_1.DebugCommands.STOP);
    }
    registerCommands(registry) {
        super.registerCommands(registry);
        registry.registerCommand(debug_commands_1.DebugCommands.START, {
            execute: (config) => {
                const validConfig = debug_session_options_1.DebugSessionOptions.is(config) ? config : undefined;
                return this.start(false, validConfig);
            }
        });
        registry.registerCommand(debug_commands_1.DebugCommands.START_NO_DEBUG, {
            execute: (config) => {
                const validConfig = debug_session_options_1.DebugSessionOptions.is(config) ? config : undefined;
                return this.start(true, validConfig);
            }
        });
        registry.registerCommand(debug_commands_1.DebugCommands.STOP, {
            execute: () => this.manager.terminateSession(),
            isEnabled: () => this.manager.state !== debug_session_1.DebugState.Inactive
        });
        registry.registerCommand(debug_commands_1.DebugCommands.RESTART, {
            execute: () => this.manager.restartSession(),
            isEnabled: () => this.manager.state !== debug_session_1.DebugState.Inactive
        });
        registry.registerCommand(debug_commands_1.DebugCommands.OPEN_CONFIGURATIONS, {
            execute: () => this.configurations.openConfiguration()
        });
        registry.registerCommand(debug_commands_1.DebugCommands.ADD_CONFIGURATION, {
            execute: () => this.configurations.addConfiguration()
        });
        registry.registerCommand(debug_commands_1.DebugCommands.STEP_OVER, {
            execute: () => this.manager.currentThread && this.manager.currentThread.stepOver(),
            isEnabled: () => this.manager.state === debug_session_1.DebugState.Stopped
        });
        registry.registerCommand(debug_commands_1.DebugCommands.STEP_INTO, {
            execute: () => this.manager.currentThread && this.manager.currentThread.stepIn(),
            isEnabled: () => this.manager.state === debug_session_1.DebugState.Stopped
        });
        registry.registerCommand(debug_commands_1.DebugCommands.STEP_OUT, {
            execute: () => this.manager.currentThread && this.manager.currentThread.stepOut(),
            isEnabled: () => this.manager.state === debug_session_1.DebugState.Stopped
        });
        registry.registerCommand(debug_commands_1.DebugCommands.CONTINUE, {
            execute: () => {
                if (this.manager.state === debug_session_1.DebugState.Stopped && this.manager.currentThread) {
                    this.manager.currentThread.continue();
                }
            },
            // When there is a debug session, F5 should always be captured by this command
            isEnabled: () => this.manager.state !== debug_session_1.DebugState.Inactive
        });
        registry.registerCommand(debug_commands_1.DebugCommands.PAUSE, {
            execute: () => this.manager.currentThread && this.manager.currentThread.pause(),
            isEnabled: () => this.manager.state === debug_session_1.DebugState.Running
        });
        registry.registerCommand(debug_commands_1.DebugCommands.PAUSE_ALL, {
            execute: () => this.manager.currentSession && this.manager.currentSession.pauseAll(),
            isEnabled: () => !!this.manager.currentSession && !!this.manager.currentSession.runningThreads.next().value
        });
        registry.registerCommand(debug_commands_1.DebugCommands.CONTINUE_ALL, {
            execute: () => this.manager.currentSession && this.manager.currentSession.continueAll(),
            isEnabled: () => !!this.manager.currentSession && !!this.manager.currentSession.stoppedThreads.next().value
        });
        registry.registerCommand(debug_commands_1.DebugThreadContextCommands.STEP_OVER, {
            execute: () => this.selectedThread && this.selectedThread.stepOver(),
            isEnabled: () => !!this.selectedThread && this.selectedThread.stopped,
            isVisible: () => !!this.selectedThread
        });
        registry.registerCommand(debug_commands_1.DebugThreadContextCommands.STEP_INTO, {
            execute: () => this.selectedThread && this.selectedThread.stepIn(),
            isEnabled: () => !!this.selectedThread && this.selectedThread.stopped,
            isVisible: () => !!this.selectedThread
        });
        registry.registerCommand(debug_commands_1.DebugThreadContextCommands.STEP_OUT, {
            execute: () => this.selectedThread && this.selectedThread.stepOut(),
            isEnabled: () => !!this.selectedThread && this.selectedThread.stopped,
            isVisible: () => !!this.selectedThread
        });
        registry.registerCommand(debug_commands_1.DebugThreadContextCommands.CONTINUE, {
            execute: () => this.selectedThread && this.selectedThread.continue(),
            isEnabled: () => !!this.selectedThread && this.selectedThread.stopped,
            isVisible: () => !!this.selectedThread && this.selectedThread.stopped,
        });
        registry.registerCommand(debug_commands_1.DebugThreadContextCommands.PAUSE, {
            execute: () => this.selectedThread && this.selectedThread.pause(),
            isEnabled: () => !!this.selectedThread && !this.selectedThread.stopped,
            isVisible: () => !!this.selectedThread && !this.selectedThread.stopped,
        });
        registry.registerCommand(debug_commands_1.DebugThreadContextCommands.TERMINATE, {
            execute: () => this.selectedThread && this.selectedThread.terminate(),
            isEnabled: () => !!this.selectedThread && this.selectedThread.supportsTerminate,
            isVisible: () => !!this.selectedThread && this.selectedThread.supportsTerminate
        });
        registry.registerCommand(debug_commands_1.DebugSessionContextCommands.STOP, {
            execute: () => this.selectedSession && this.manager.terminateSession(this.selectedSession),
            isEnabled: () => !!this.selectedSession && this.selectedSession.state !== debug_session_1.DebugState.Inactive,
            isVisible: () => !this.selectedThread
        });
        registry.registerCommand(debug_commands_1.DebugSessionContextCommands.RESTART, {
            execute: () => this.selectedSession && this.manager.restartSession(this.selectedSession),
            isEnabled: () => !!this.selectedSession && this.selectedSession.state !== debug_session_1.DebugState.Inactive,
            isVisible: () => !this.selectedThread
        });
        registry.registerCommand(debug_commands_1.DebugSessionContextCommands.CONTINUE_ALL, {
            execute: () => this.selectedSession && this.selectedSession.continueAll(),
            isEnabled: () => !!this.selectedSession && !!this.selectedSession.stoppedThreads.next().value,
            isVisible: () => !this.selectedThread
        });
        registry.registerCommand(debug_commands_1.DebugSessionContextCommands.PAUSE_ALL, {
            execute: () => this.selectedSession && this.selectedSession.pauseAll(),
            isEnabled: () => !!this.selectedSession && !!this.selectedSession.runningThreads.next().value,
            isVisible: () => !this.selectedThread
        });
        registry.registerCommand(debug_commands_1.DebugSessionContextCommands.REVEAL, {
            execute: () => this.selectedSession && this.revealSession(this.selectedSession),
            isEnabled: () => Boolean(this.selectedSession),
            isVisible: () => !this.selectedThread && Boolean(this.selectedSession)
        });
        registry.registerCommand(debug_commands_1.DebugCommands.TOGGLE_BREAKPOINT, {
            execute: () => this.editors.toggleBreakpoint(),
            isEnabled: () => !!this.editors.model
        });
        registry.registerCommand(debug_commands_1.DebugCommands.INLINE_BREAKPOINT, {
            execute: () => this.editors.addInlineBreakpoint(),
            isEnabled: () => !!this.editors.model && !this.editors.getInlineBreakpoint()
        });
        registry.registerCommand(debug_commands_1.DebugCommands.ADD_CONDITIONAL_BREAKPOINT, {
            execute: () => this.editors.addBreakpoint('condition'),
            isEnabled: () => !!this.editors.model && !this.editors.anyBreakpoint()
        });
        registry.registerCommand(debug_commands_1.DebugCommands.ADD_LOGPOINT, {
            execute: () => this.editors.addBreakpoint('logMessage'),
            isEnabled: () => !!this.editors.model && !this.editors.anyBreakpoint()
        });
        registry.registerCommand(debug_commands_1.DebugCommands.ADD_FUNCTION_BREAKPOINT, {
            execute: async () => debug_function_breakpoint_1.DebugFunctionBreakpoint.editOrCreate(this.breakpointManager),
            isEnabled: widget => !(widget instanceof browser_1.Widget) || widget instanceof debug_breakpoints_widget_1.DebugBreakpointsWidget,
            isVisible: widget => !(widget instanceof browser_1.Widget) || widget instanceof debug_breakpoints_widget_1.DebugBreakpointsWidget
        });
        registry.registerCommand(debug_commands_1.DebugCommands.ADD_DATA_BREAKPOINT, this.AddOrEditDataBreakpointAddress);
        registry.registerCommand(debug_commands_1.DebugCommands.ENABLE_ALL_BREAKPOINTS, {
            execute: () => this.breakpointManager.enableAllBreakpoints(true),
            isEnabled: () => this.breakpointManager.hasBreakpoints()
        });
        registry.registerCommand(debug_commands_1.DebugCommands.ENABLE_SELECTED_BREAKPOINTS, {
            execute: () => this.selectedBreakpoints.forEach(breakpoint => breakpoint.setEnabled(true)),
            isVisible: () => this.selectedBreakpoints.some(breakpoint => !breakpoint.enabled),
            isEnabled: () => this.selectedBreakpoints.some(breakpoint => !breakpoint.enabled)
        });
        registry.registerCommand(debug_commands_1.DebugCommands.DISABLE_ALL_BREAKPOINTS, {
            execute: () => this.breakpointManager.enableAllBreakpoints(false),
            isEnabled: () => this.breakpointManager.hasBreakpoints()
        });
        registry.registerCommand(debug_commands_1.DebugCommands.DISABLE_SELECTED_BREAKPOINTS, {
            execute: () => this.selectedBreakpoints.forEach(breakpoint => breakpoint.setEnabled(false)),
            isVisible: () => this.selectedBreakpoints.some(breakpoint => breakpoint.enabled),
            isEnabled: () => this.selectedBreakpoints.some(breakpoint => breakpoint.enabled)
        });
        registry.registerCommand(debug_commands_1.DebugCommands.EDIT_BREAKPOINT, {
            execute: async () => {
                const { selectedBreakpoint, selectedFunctionBreakpoint, selectedLogpoint } = this;
                if (selectedBreakpoint) {
                    await this.editors.editBreakpoint(selectedBreakpoint);
                }
                else if (selectedFunctionBreakpoint) {
                    await selectedFunctionBreakpoint.open();
                }
                else if (selectedLogpoint) {
                    await this.editors.editBreakpoint(selectedLogpoint);
                }
            },
            isEnabled: () => this.selectedBreakpoints.length === 1 && (!!this.selectedBreakpoint || !!this.selectedFunctionBreakpoint || !!this.selectedLogpoint),
            isVisible: () => this.selectedBreakpoints.length === 1 && (!!this.selectedBreakpoint || !!this.selectedFunctionBreakpoint || !!this.selectedLogpoint)
        });
        registry.registerCommand(debug_commands_1.DebugCommands.EDIT_LOGPOINT, {
            execute: async () => {
                const { selectedLogpoint } = this;
                if (selectedLogpoint) {
                    await this.editors.editBreakpoint(selectedLogpoint);
                }
            },
            isEnabled: () => this.selectedBreakpoints.length === 1 && !!this.selectedLogpoint,
            isVisible: () => this.selectedBreakpoints.length === 1 && !!this.selectedLogpoint
        });
        registry.registerCommand(debug_commands_1.DebugCommands.EDIT_BREAKPOINT_CONDITION, {
            execute: async () => {
                const { selectedExceptionBreakpoint } = this;
                if (selectedExceptionBreakpoint) {
                    await selectedExceptionBreakpoint.editCondition();
                }
            },
            isEnabled: () => this.selectedBreakpoints.length === 1 && !!this.selectedExceptionBreakpoint?.origin.raw.supportsCondition,
            isVisible: () => this.selectedBreakpoints.length === 1 && !!this.selectedExceptionBreakpoint?.origin.raw.supportsCondition
        });
        registry.registerCommand(debug_commands_1.DebugCommands.REMOVE_BREAKPOINT, {
            execute: () => {
                const selectedBreakpoint = this.selectedSettableBreakpoint;
                if (selectedBreakpoint) {
                    selectedBreakpoint.remove();
                }
            },
            isEnabled: () => this.selectedBreakpoints.length === 1 && Boolean(this.selectedSettableBreakpoint),
            isVisible: () => this.selectedBreakpoints.length === 1 && Boolean(this.selectedSettableBreakpoint),
        });
        registry.registerCommand(debug_commands_1.DebugCommands.REMOVE_LOGPOINT, {
            execute: () => {
                const { selectedLogpoint } = this;
                if (selectedLogpoint) {
                    selectedLogpoint.remove();
                }
            },
            isEnabled: () => this.selectedBreakpoints.length === 1 && !!this.selectedLogpoint,
            isVisible: () => this.selectedBreakpoints.length === 1 && !!this.selectedLogpoint
        });
        registry.registerCommand(debug_commands_1.DebugCommands.REMOVE_ALL_BREAKPOINTS, {
            execute: () => this.breakpointManager.removeBreakpoints(),
            isEnabled: () => this.breakpointManager.hasBreakpoints(),
            isVisible: widget => !(widget instanceof browser_1.Widget) || (widget instanceof debug_breakpoints_widget_1.DebugBreakpointsWidget)
        });
        registry.registerCommand(debug_commands_1.DebugCommands.REMOVE_SELECTED_BREAKPOINTS, {
            execute: () => this.selectedBreakpoints.forEach(breakpoint => breakpoint.remove()),
            isEnabled: () => this.selectedBreakpoints.length > 1,
            isVisible: widget => (!(widget instanceof browser_1.Widget) || (widget instanceof debug_breakpoints_widget_1.DebugBreakpointsWidget)) && this.selectedBreakpoints.length > 1
        });
        registry.registerCommand(debug_commands_1.DebugCommands.TOGGLE_BREAKPOINTS_ENABLED, {
            execute: () => this.breakpointManager.breakpointsEnabled = !this.breakpointManager.breakpointsEnabled,
            isVisible: arg => arg instanceof debug_breakpoints_widget_1.DebugBreakpointsWidget
        });
        registry.registerCommand(debug_commands_1.DebugCommands.SHOW_HOVER, {
            execute: () => this.editors.showHover(),
            isEnabled: () => this.editors.canShowHover()
        });
        registry.registerCommand(debug_commands_1.DebugCommands.EVALUATE_IN_DEBUG_CONSOLE, {
            execute: async () => {
                const { model } = this.editors;
                if (model) {
                    const { editor } = model;
                    const { selection, document } = editor;
                    const value = document.getText(selection) || document.getLineContent(selection.start.line + 1).trim();
                    const consoleWidget = await this.console.openView({ reveal: true, activate: false });
                    await consoleWidget.execute(value);
                }
            },
            isEnabled: () => !!this.editors.model && !!this.manager.currentFrame,
            isVisible: () => !!this.editors.model && !!this.manager.currentFrame
        });
        registry.registerCommand(debug_commands_1.DebugCommands.ADD_TO_WATCH, {
            execute: async () => {
                const { model } = this.editors;
                if (model) {
                    const { editor } = model;
                    const selection = editor.getControl().getSelection();
                    if (selection) {
                        const expression = editor.getControl().getModel()?.getValueInRange(selection) ||
                            (await this.expressionProvider.getEvaluatableExpression(editor, selection))?.matchingExpression;
                        if (expression) {
                            this.watchManager.addWatchExpression(expression);
                            const watchWidget = this.widgetManager.tryGetWidget(debug_watch_widget_1.DebugWatchWidget.FACTORY_ID);
                            if (watchWidget) {
                                await this.shell.activateWidget(watchWidget.id);
                            }
                        }
                    }
                }
            },
            isEnabled: () => !!this.editors.model && this.manager.inDebugMode,
            isVisible: () => !!this.editors.model && this.manager.inDebugMode
        });
        registry.registerCommand(debug_commands_1.DebugCommands.JUMP_TO_CURSOR, {
            execute: () => {
                const model = this.editors.model;
                if (model && this.manager.currentThread) {
                    this.manager.currentThread.jumpToCursor(model.editor.getResourceUri(), model.position);
                }
            },
            isEnabled: () => !!this.manager.currentThread && this.manager.currentThread.supportsGoto,
            isVisible: () => !!this.manager.currentThread && this.manager.currentThread.supportsGoto
        });
        registry.registerCommand(debug_commands_1.DebugCommands.RUN_TO_CURSOR, {
            execute: async () => {
                const { model } = this.editors;
                if (model) {
                    const { editor, position } = model;
                    await this.runTo(editor.getResourceUri(), position.lineNumber, position.column);
                }
            },
            isEnabled: () => !!this.editors.model && !!this.manager.currentThread?.stopped,
            isVisible: () => !!this.editors.model && !!this.manager.currentThread?.stopped
        });
        registry.registerCommand(debug_commands_1.DebugCommands.RUN_TO_LINE, {
            execute: async () => {
                const { model } = this.editors;
                if (model) {
                    const { editor, position } = model;
                    await this.runTo(editor.getResourceUri(), position.lineNumber);
                }
            },
            isEnabled: () => !!this.editors.model && !!this.manager.currentThread?.stopped,
            isVisible: () => !!this.editors.model && !!this.manager.currentThread?.stopped
        });
        registry.registerCommand(debug_commands_1.DebugCommands.RESTART_FRAME, {
            execute: () => this.selectedFrame && this.selectedFrame.restart(),
            isEnabled: () => !!this.selectedFrame
        });
        registry.registerCommand(debug_commands_1.DebugCommands.COPY_CALL_STACK, {
            execute: () => {
                const { frames } = this;
                const selection = document.getSelection();
                if (frames && selection) {
                    selection.selectAllChildren(frames.node);
                    document.execCommand('copy');
                }
            },
            isEnabled: () => document.queryCommandSupported('copy'),
            isVisible: () => document.queryCommandSupported('copy')
        });
        registry.registerCommand(debug_commands_1.DebugCommands.SET_VARIABLE_VALUE, {
            execute: () => this.selectedVariable && this.selectedVariable.open(),
            isEnabled: () => !!this.selectedVariable && this.selectedVariable.supportSetVariable && !this.selectedVariable.readOnly,
            isVisible: () => !!this.selectedVariable && this.selectedVariable.supportSetVariable
        });
        registry.registerCommand(debug_commands_1.DebugCommands.COPY_VARIABLE_VALUE, {
            execute: () => this.selectedVariable && this.selectedVariable.copyValue(),
            isEnabled: () => !!this.selectedVariable && this.selectedVariable.supportCopyValue,
            isVisible: () => !!this.selectedVariable && this.selectedVariable.supportCopyValue
        });
        registry.registerCommand(debug_commands_1.DebugCommands.COPY_VARIABLE_AS_EXPRESSION, {
            execute: () => this.selectedVariable && this.selectedVariable.copyAsExpression(),
            isEnabled: () => !!this.selectedVariable && this.selectedVariable.supportCopyAsExpression,
            isVisible: () => !!this.selectedVariable && this.selectedVariable.supportCopyAsExpression
        });
        registry.registerCommand(debug_commands_1.DebugCommands.WATCH_VARIABLE, {
            execute: () => {
                const evaluateName = this.selectedVariable?.evaluateName;
                if (evaluateName) {
                    this.watchManager.addWatchExpression(evaluateName);
                }
            },
            isEnabled: () => !!this.selectedVariable?.evaluateName,
            isVisible: () => !!this.selectedVariable?.evaluateName,
        });
        // Debug context menu commands
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.ADD_BREAKPOINT, {
            execute: position => this.isPosition(position) && this.editors.toggleBreakpoint(this.asPosition(position)),
            isEnabled: position => this.isPosition(position) && !this.editors.anyBreakpoint(this.asPosition(position)),
            isVisible: position => this.isPosition(position) && !this.editors.anyBreakpoint(this.asPosition(position))
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.ADD_CONDITIONAL_BREAKPOINT, {
            execute: position => this.isPosition(position) && this.editors.addBreakpoint('condition', this.asPosition(position)),
            isEnabled: position => this.isPosition(position) && !this.editors.anyBreakpoint(this.asPosition(position)),
            isVisible: position => this.isPosition(position) && !this.editors.anyBreakpoint(this.asPosition(position))
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.ADD_LOGPOINT, {
            execute: position => this.isPosition(position) && this.editors.addBreakpoint('logMessage', this.asPosition(position)),
            isEnabled: position => this.isPosition(position) && !this.editors.anyBreakpoint(this.asPosition(position)),
            isVisible: position => this.isPosition(position) && !this.editors.anyBreakpoint(this.asPosition(position))
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.REMOVE_BREAKPOINT, {
            execute: position => this.isPosition(position) && this.editors.toggleBreakpoint(this.asPosition(position)),
            isEnabled: position => this.isPosition(position) && !!this.editors.getBreakpoint(this.asPosition(position)),
            isVisible: position => this.isPosition(position) && !!this.editors.getBreakpoint(this.asPosition(position))
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.EDIT_BREAKPOINT, {
            execute: position => this.isPosition(position) && this.editors.editBreakpoint(this.asPosition(position)),
            isEnabled: position => this.isPosition(position) && !!this.editors.getBreakpoint(this.asPosition(position)),
            isVisible: position => this.isPosition(position) && !!this.editors.getBreakpoint(this.asPosition(position))
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.ENABLE_BREAKPOINT, {
            execute: position => this.isPosition(position) && this.editors.setBreakpointEnabled(this.asPosition(position), true),
            isEnabled: position => this.isPosition(position) && this.editors.getBreakpointEnabled(this.asPosition(position)) === false,
            isVisible: position => this.isPosition(position) && this.editors.getBreakpointEnabled(this.asPosition(position)) === false
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.DISABLE_BREAKPOINT, {
            execute: position => this.isPosition(position) && this.editors.setBreakpointEnabled(this.asPosition(position), false),
            isEnabled: position => this.isPosition(position) && !!this.editors.getBreakpointEnabled(this.asPosition(position)),
            isVisible: position => this.isPosition(position) && !!this.editors.getBreakpointEnabled(this.asPosition(position))
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.REMOVE_LOGPOINT, {
            execute: position => this.isPosition(position) && this.editors.toggleBreakpoint(this.asPosition(position)),
            isEnabled: position => this.isPosition(position) && !!this.editors.getLogpoint(this.asPosition(position)),
            isVisible: position => this.isPosition(position) && !!this.editors.getLogpoint(this.asPosition(position))
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.EDIT_LOGPOINT, {
            execute: position => this.isPosition(position) && this.editors.editBreakpoint(this.asPosition(position)),
            isEnabled: position => this.isPosition(position) && !!this.editors.getLogpoint(this.asPosition(position)),
            isVisible: position => this.isPosition(position) && !!this.editors.getLogpoint(this.asPosition(position))
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.ENABLE_LOGPOINT, {
            execute: position => this.isPosition(position) && this.editors.setBreakpointEnabled(this.asPosition(position), true),
            isEnabled: position => this.isPosition(position) && this.editors.getLogpointEnabled(this.asPosition(position)) === false,
            isVisible: position => this.isPosition(position) && this.editors.getLogpointEnabled(this.asPosition(position)) === false
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.DISABLE_LOGPOINT, {
            execute: position => this.isPosition(position) && this.editors.setBreakpointEnabled(this.asPosition(position), false),
            isEnabled: position => this.isPosition(position) && !!this.editors.getLogpointEnabled(this.asPosition(position)),
            isVisible: position => this.isPosition(position) && !!this.editors.getLogpointEnabled(this.asPosition(position))
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.JUMP_TO_CURSOR, {
            execute: position => {
                if (this.isPosition(position) && this.editors.currentUri && this.manager.currentThread) {
                    this.manager.currentThread.jumpToCursor(this.editors.currentUri, this.asPosition(position));
                }
            },
            isEnabled: () => !!this.manager.currentThread && this.manager.currentThread.supportsGoto,
            isVisible: () => !!this.manager.currentThread && this.manager.currentThread.supportsGoto
        });
        registry.registerCommand(debug_commands_1.DebugEditorContextCommands.RUN_TO_LINE, {
            execute: async (position) => {
                if (this.isPosition(position)) {
                    const { currentUri } = this.editors;
                    if (currentUri) {
                        await this.runTo(currentUri, position.lineNumber);
                    }
                }
            },
            isEnabled: position => this.isPosition(position) && !!this.editors.currentUri && !!this.manager.currentThread?.stopped,
            isVisible: position => this.isPosition(position) && !!this.editors.currentUri && !!this.manager.currentThread?.stopped
        });
        registry.registerCommand(debug_commands_1.DebugBreakpointWidgetCommands.ACCEPT, {
            execute: () => this.editors.acceptBreakpoint()
        });
        registry.registerCommand(debug_commands_1.DebugBreakpointWidgetCommands.CLOSE, {
            execute: () => this.editors.closeBreakpoint()
        });
        registry.registerCommand(debug_commands_1.DebugCommands.ADD_WATCH_EXPRESSION, {
            execute: widget => {
                if (widget instanceof browser_1.Widget) {
                    if (widget instanceof debug_watch_widget_1.DebugWatchWidget) {
                        widget.viewModel.addWatchExpression();
                    }
                }
                else if (this.watch) {
                    this.watch.viewModel.addWatchExpression();
                }
            },
            isEnabled: widget => widget instanceof browser_1.Widget ? widget instanceof debug_watch_widget_1.DebugWatchWidget : !!this.watch,
            isVisible: widget => widget instanceof browser_1.Widget ? widget instanceof debug_watch_widget_1.DebugWatchWidget : !!this.watch
        });
        registry.registerCommand(debug_commands_1.DebugCommands.EDIT_WATCH_EXPRESSION, {
            execute: () => {
                const { watchExpression } = this;
                if (watchExpression) {
                    watchExpression.open();
                }
            },
            isEnabled: () => !!this.watchExpression,
            isVisible: () => !!this.watchExpression
        });
        registry.registerCommand(debug_commands_1.DebugCommands.COPY_WATCH_EXPRESSION_VALUE, {
            execute: () => this.watchExpression && this.watchExpression.copyValue(),
            isEnabled: () => !!this.watchExpression && this.watchExpression.supportCopyValue,
            isVisible: () => !!this.watchExpression && this.watchExpression.supportCopyValue
        });
        registry.registerCommand(debug_commands_1.DebugCommands.COLLAPSE_ALL_WATCH_EXPRESSIONS, {
            execute: widget => {
                if (widget instanceof debug_watch_widget_1.DebugWatchWidget) {
                    const root = widget.model.root;
                    widget.model.collapseAll(browser_1.CompositeTreeNode.is(root) ? root : undefined);
                }
            },
            isEnabled: widget => widget instanceof debug_watch_widget_1.DebugWatchWidget,
            isVisible: widget => widget instanceof debug_watch_widget_1.DebugWatchWidget
        });
        registry.registerCommand(debug_commands_1.DebugCommands.REMOVE_WATCH_EXPRESSION, {
            execute: () => {
                const { watch, watchExpression } = this;
                if (watch && watchExpression) {
                    watch.viewModel.removeWatchExpression(watchExpression);
                }
            },
            isEnabled: () => !!this.watchExpression,
            isVisible: () => !!this.watchExpression
        });
        registry.registerCommand(debug_commands_1.DebugCommands.REMOVE_ALL_WATCH_EXPRESSIONS, {
            execute: widget => {
                if (widget instanceof browser_1.Widget) {
                    if (widget instanceof debug_watch_widget_1.DebugWatchWidget) {
                        widget.viewModel.removeWatchExpressions();
                    }
                }
                else if (this.watch) {
                    this.watch.viewModel.removeWatchExpressions();
                }
            },
            isEnabled: widget => widget instanceof browser_1.Widget ? widget instanceof debug_watch_widget_1.DebugWatchWidget : !!this.watch,
            isVisible: widget => widget instanceof browser_1.Widget ? widget instanceof debug_watch_widget_1.DebugWatchWidget : !!this.watch
        });
    }
    registerKeybindings(keybindings) {
        super.registerKeybindings(keybindings);
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugCommands.START.id,
            keybinding: 'f5',
            when: '!inDebugMode'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugCommands.START_NO_DEBUG.id,
            keybinding: 'ctrl+f5',
            when: '!inDebugMode'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugCommands.STOP.id,
            keybinding: 'shift+f5',
            when: 'inDebugMode'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugCommands.RESTART.id,
            keybinding: 'shift+ctrlcmd+f5',
            when: 'inDebugMode'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugCommands.STEP_OVER.id,
            keybinding: 'f10',
            when: 'inDebugMode'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugCommands.STEP_INTO.id,
            keybinding: 'f11',
            when: 'inDebugMode'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugCommands.STEP_OUT.id,
            keybinding: 'shift+f11',
            when: 'inDebugMode'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugCommands.CONTINUE.id,
            keybinding: 'f5',
            when: 'inDebugMode'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugCommands.PAUSE.id,
            keybinding: 'f6',
            when: 'inDebugMode'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugCommands.TOGGLE_BREAKPOINT.id,
            keybinding: 'f9',
            when: 'editorTextFocus'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugCommands.INLINE_BREAKPOINT.id,
            keybinding: 'shift+f9',
            when: 'editorTextFocus'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugBreakpointWidgetCommands.ACCEPT.id,
            keybinding: 'enter',
            when: 'breakpointWidgetFocus && !suggestWidgetVisible'
        });
        keybindings.registerKeybinding({
            command: debug_commands_1.DebugBreakpointWidgetCommands.CLOSE.id,
            keybinding: 'esc',
            when: 'isBreakpointWidgetVisible || (breakpointWidgetFocus && !suggestWidgetVisible)'
        });
    }
    registerToolbarItems(toolbar) {
        toolbar.registerItem({
            id: debug_commands_1.DebugCommands.ADD_FUNCTION_BREAKPOINT.id,
            command: debug_commands_1.DebugCommands.ADD_FUNCTION_BREAKPOINT.id,
            icon: (0, browser_1.codicon)('add'),
            tooltip: debug_commands_1.DebugCommands.ADD_FUNCTION_BREAKPOINT.label
        });
        toolbar.registerItem({
            id: debug_commands_1.DebugCommands.ADD_DATA_BREAKPOINT.id,
            command: debug_commands_1.DebugCommands.ADD_DATA_BREAKPOINT.id,
            icon: (0, browser_1.codicon)('variable-group'),
            tooltip: debug_commands_1.DebugCommands.ADD_DATA_BREAKPOINT.label,
            onDidChange: this.manager.onDidStopDebugSession
        });
        toolbar.registerItem({
            id: debug_commands_1.DebugCommands.TOGGLE_BREAKPOINTS_ENABLED.id,
            command: debug_commands_1.DebugCommands.TOGGLE_BREAKPOINTS_ENABLED.id,
            icon: (0, browser_1.codicon)('activate-breakpoints'),
            priority: 1
        });
        toolbar.registerItem({
            id: debug_commands_1.DebugCommands.REMOVE_ALL_BREAKPOINTS.id,
            command: debug_commands_1.DebugCommands.REMOVE_ALL_BREAKPOINTS.id,
            icon: (0, browser_1.codicon)('close-all'),
            priority: 2
        });
        toolbar.registerItem({
            id: debug_commands_1.DebugCommands.ADD_WATCH_EXPRESSION.id,
            command: debug_commands_1.DebugCommands.ADD_WATCH_EXPRESSION.id,
            icon: (0, browser_1.codicon)('add'),
            tooltip: debug_commands_1.DebugCommands.ADD_WATCH_EXPRESSION.label
        });
        toolbar.registerItem({
            id: debug_commands_1.DebugCommands.COLLAPSE_ALL_WATCH_EXPRESSIONS.id,
            command: debug_commands_1.DebugCommands.COLLAPSE_ALL_WATCH_EXPRESSIONS.id,
            icon: (0, browser_1.codicon)('collapse-all'),
            tooltip: debug_commands_1.DebugCommands.COLLAPSE_ALL_WATCH_EXPRESSIONS.label,
            priority: 1
        });
        toolbar.registerItem({
            id: debug_commands_1.DebugCommands.REMOVE_ALL_WATCH_EXPRESSIONS.id,
            command: debug_commands_1.DebugCommands.REMOVE_ALL_WATCH_EXPRESSIONS.id,
            icon: (0, browser_1.codicon)('close-all'),
            tooltip: debug_commands_1.DebugCommands.REMOVE_ALL_WATCH_EXPRESSIONS.label,
            priority: 2
        });
    }
    async openSession(session, options) {
        const { reveal } = {
            reveal: true,
            ...options
        };
        const debugWidget = await this.openView({ reveal });
        // Only switch to this session if it has a stopped thread
        // Don't switch to background sessions that are just starting up
        if (session.currentThread && session.currentThread.stopped) {
            debugWidget.sessionManager.currentSession = session;
        }
        return debugWidget['sessionWidget'];
    }
    revealSession(session) {
        const widget = this.tryGetWidget()?.['sessionWidget'];
        if (widget) {
            this.shell.revealWidget(widget.id);
        }
        return widget;
    }
    async start(noDebug, debugSessionOptions) {
        let current = debugSessionOptions || this.configurations.current;
        // If no configurations are currently present, create the `launch.json` and prompt users to select the config.
        if (!current) {
            await this.configurations.addConfiguration();
            return;
        }
        if (noDebug !== undefined) {
            if (current.configuration) {
                current = {
                    ...current,
                    configuration: {
                        ...current.configuration,
                        noDebug
                    }
                };
            }
            else {
                current = {
                    ...current,
                    noDebug
                };
            }
        }
        await this.manager.start(current);
    }
    async runTo(uri, line, column) {
        const thread = this.manager.currentThread;
        if (!thread) {
            return;
        }
        const checkThread = () => {
            if (thread.stopped && thread === this.manager.currentThread) {
                return true;
            }
            this.logger.warn('Cannot run to the specified location. The current thread has changed or is not stopped.');
            return false;
        };
        if (!checkThread()) {
            return;
        }
        const breakpoint = breakpoint_marker_1.SourceBreakpoint.create(uri, { line, column });
        const breakpointsBefore = this.breakpointManager.getBreakpoints(uri);
        const breakpointToRemove = this.breakpointManager.addBreakpoint(breakpoint);
        const breakpointsAfter = this.breakpointManager.getBreakpoints(uri);
        let shouldRemoveBreakpoint = breakpointsBefore.length !== breakpointsAfter.length;
        const removeBreakpoint = () => {
            breakpointToRemove.remove();
        };
        try {
            const sessionBreakpoint = await this.verifyBreakpoint(breakpointToRemove, thread.session);
            if (!checkThread()) {
                return;
            }
            if (!sessionBreakpoint || !sessionBreakpoint.installed || !sessionBreakpoint.verified) {
                this.messageService.warn(nls_1.nls.localize('theia/debug/cannotRunToThisLocation', 'Could not run the current thread to the specified location.'));
                return;
            }
            const rawBreakpoint = sessionBreakpoint.raw; // an installed breakpoint always has the underlying raw breakpoint
            if (rawBreakpoint.line !== line || (column && rawBreakpoint.column !== column)) {
                const shouldRun = await new browser_1.ConfirmDialog({
                    title: nls_1.nls.localize('theia/debug/confirmRunToShiftedPosition_title', 'Cannot run the current thread to exactly the specified location'),
                    msg: nls_1.nls.localize('theia/debug/confirmRunToShiftedPosition_msg', 'The target position will be shifted to Ln {0}, Col {1}. Run anyway?', rawBreakpoint.line, rawBreakpoint.column || 1),
                    ok: browser_1.Dialog.YES,
                    cancel: browser_1.Dialog.NO
                }).open();
                if (!shouldRun || !checkThread()) {
                    return;
                }
            }
            if (shouldRemoveBreakpoint) {
                common_1.Event.toPromise(common_1.Event.filter(common_1.Event.any(this.manager.onDidStopDebugSession, this.manager.onDidDestroyDebugSession), session => session === thread.session)).then(removeBreakpoint);
            }
            await thread.continue();
            shouldRemoveBreakpoint = false;
        }
        finally {
            if (shouldRemoveBreakpoint) {
                removeBreakpoint();
            }
        }
    }
    async verifyBreakpoint(breakpoint, session, timeout = 2000) {
        if (!breakpoint.getDebugProtocolBreakpoint(session.id)?.verified) {
            try {
                await (0, promise_util_1.waitForEvent)(common_1.Event.filter(this.breakpointManager.onDidChangeBreakpoints, () => breakpoint.getDebugProtocolBreakpoint(session.id)?.verified), timeout // wait up to `timeout` ms for the breakpoint to become installed and verified
                );
            }
            catch (e) {
                if (!(e instanceof common_1.CancellationError)) { // ignore the `CancellationError` on timeout
                    throw e;
                }
            }
        }
        return breakpoint;
    }
    get threads() {
        const { currentWidget } = this.shell;
        return currentWidget instanceof debug_threads_widget_1.DebugThreadsWidget && currentWidget || undefined;
    }
    get selectedSession() {
        const { threads } = this;
        return threads && threads.selectedElement instanceof debug_session_1.DebugSession && threads.selectedElement || undefined;
    }
    get selectedThread() {
        const { threads } = this;
        return threads && threads.selectedElement instanceof debug_thread_1.DebugThread && threads.selectedElement || undefined;
    }
    get frames() {
        const { currentWidget } = this.shell;
        return currentWidget instanceof debug_stack_frames_widget_1.DebugStackFramesWidget && currentWidget || undefined;
    }
    get selectedFrame() {
        const { frames } = this;
        return frames && frames.selectedElement instanceof debug_stack_frame_1.DebugStackFrame && frames.selectedElement || undefined;
    }
    get breakpoints() {
        const { currentWidget } = this.shell;
        return currentWidget instanceof debug_breakpoints_widget_1.DebugBreakpointsWidget && currentWidget || undefined;
    }
    get selectedAnyBreakpoint() {
        const { breakpoints } = this;
        const selectedElement = breakpoints && breakpoints.selectedElement;
        return selectedElement instanceof debug_breakpoint_1.DebugBreakpoint ? selectedElement : undefined;
    }
    get selectedBreakpoint() {
        const breakpoint = this.selectedAnyBreakpoint;
        return breakpoint && breakpoint instanceof debug_source_breakpoint_1.DebugSourceBreakpoint && !breakpoint.logMessage ? breakpoint : undefined;
    }
    get selectedBreakpoints() {
        const { breakpoints } = this;
        return breakpoints && breakpoints.model.selectedNodes
            .filter(source_tree_1.TreeElementNode.is)
            .map(node => node.element)
            .filter(element => element instanceof debug_breakpoint_1.DebugBreakpoint) || [];
    }
    get selectedLogpoint() {
        const breakpoint = this.selectedAnyBreakpoint;
        return breakpoint && breakpoint instanceof debug_source_breakpoint_1.DebugSourceBreakpoint && !!breakpoint.logMessage ? breakpoint : undefined;
    }
    get selectedFunctionBreakpoint() {
        const breakpoint = this.selectedAnyBreakpoint;
        return breakpoint && breakpoint instanceof debug_function_breakpoint_1.DebugFunctionBreakpoint ? breakpoint : undefined;
    }
    get selectedInstructionBreakpoint() {
        if (this.selectedAnyBreakpoint instanceof debug_instruction_breakpoint_1.DebugInstructionBreakpoint) {
            return this.selectedAnyBreakpoint;
        }
    }
    get selectedExceptionBreakpoint() {
        const { breakpoints } = this;
        const selectedElement = breakpoints && breakpoints.selectedElement;
        return selectedElement instanceof debug_exception_breakpoint_1.DebugExceptionBreakpoint ? selectedElement : undefined;
    }
    get selectedSettableBreakpoint() {
        const selected = this.selectedAnyBreakpoint;
        if (selected instanceof debug_function_breakpoint_1.DebugFunctionBreakpoint || selected instanceof debug_instruction_breakpoint_1.DebugInstructionBreakpoint || selected instanceof debug_source_breakpoint_1.DebugSourceBreakpoint) {
            return selected;
        }
    }
    get consoleWidget() {
        const { currentWidget } = this.shell;
        return currentWidget instanceof console_widget_1.ConsoleWidget && currentWidget.id === debug_console_contribution_1.DebugConsoleContribution.options.id && currentWidget || undefined;
    }
    get variables() {
        const { currentWidget } = this.shell;
        return currentWidget instanceof debug_variables_widget_1.DebugVariablesWidget && currentWidget || undefined;
    }
    get variablesSource() {
        const hover = this.editors.model?.hover;
        if (hover?.isVisible) {
            return hover;
        }
        return this.variables ?? this.consoleWidget?.content;
    }
    get selectedVariable() {
        const { variablesSource } = this;
        return variablesSource && variablesSource.selectedElement instanceof debug_console_items_1.DebugVariable && variablesSource.selectedElement || undefined;
    }
    get watch() {
        const { currentWidget } = this.shell;
        return currentWidget instanceof debug_watch_widget_1.DebugWatchWidget && currentWidget || undefined;
    }
    get watchExpression() {
        const { watch } = this;
        return watch && watch.selectedElement instanceof debug_watch_expression_1.DebugWatchExpression && watch.selectedElement || undefined;
    }
    isPosition(position) {
        return monaco.Position.isIPosition(position);
    }
    asPosition(position) {
        return monaco.Position.lift(position);
    }
    registerColors(colors) {
        colors.register(
        // Debug colors should be aligned with https://code.visualstudio.com/api/references/theme-color#debug-colors
        {
            id: 'editor.stackFrameHighlightBackground',
            defaults: {
                dark: '#ffff0033',
                light: '#ffff6673',
                hcDark: '#fff600',
                hcLight: '#ffff6673'
            }, description: nls_1.nls.localizeByDefault('Background color for the highlight of line at the top stack frame position.')
        }, {
            id: 'editor.focusedStackFrameHighlightBackground',
            defaults: {
                dark: '#7abd7a4d',
                light: '#cee7ce73',
                hcDark: '#cee7ce',
                hcLight: '#cee7ce73'
            }, description: nls_1.nls.localizeByDefault('Background color for the highlight of line at focused stack frame position.')
        }, 
        // Status bar colors should be aligned with debugging colors from https://code.visualstudio.com/api/references/theme-color#status-bar-colors
        {
            id: 'statusBar.debuggingBackground', defaults: {
                dark: '#CC6633',
                light: '#CC6633',
                hcDark: '#CC6633',
                hcLight: '#B5200D'
            }, description: nls_1.nls.localizeByDefault('Status bar background color when a program is being debugged. The status bar is shown in the bottom of the window')
        }, {
            id: 'statusBar.debuggingForeground', defaults: {
                dark: 'statusBar.foreground',
                light: 'statusBar.foreground',
                hcDark: 'statusBar.foreground',
                hcLight: 'statusBar.foreground'
            }, description: nls_1.nls.localizeByDefault('Status bar foreground color when a program is being debugged. The status bar is shown in the bottom of the window')
        }, {
            id: 'statusBar.debuggingBorder', defaults: {
                dark: 'statusBar.border',
                light: 'statusBar.border',
                hcDark: 'statusBar.border',
                hcLight: 'statusBar.border'
            }, description: nls_1.nls.localizeByDefault('Status bar border color separating to the sidebar and editor when a program is being debugged. The status bar is shown in the bottom of the window')
        }, 
        // Debug Exception Widget colors should be aligned with
        // https://github.com/microsoft/vscode/blob/ff5f581425da6230b6f9216ecf19abf6c9d285a6/src/vs/workbench/contrib/debug/browser/exceptionWidget.ts#L23
        {
            id: 'debugExceptionWidget.border', defaults: {
                dark: '#a31515',
                light: '#a31515',
                hcDark: '#a31515',
                hcLight: '#a31515'
            }, description: nls_1.nls.localizeByDefault('Exception widget border color.'),
        }, {
            id: 'debugExceptionWidget.background', defaults: {
                dark: '#420b0d',
                light: '#f1dfde',
                hcDark: '#420b0d',
                hcLight: '#f1dfde'
            }, description: nls_1.nls.localizeByDefault('Exception widget background color.')
        }, 
        // Debug Icon colors should be aligned with
        // https://code.visualstudio.com/api/references/theme-color#debug-icons-colors
        {
            id: 'debugIcon.breakpointForeground', defaults: {
                dark: '#E51400',
                light: '#E51400',
                hcDark: '#E51400',
                hcLight: '#E51400'
            },
            description: nls_1.nls.localizeByDefault('Icon color for breakpoints.')
        }, {
            id: 'debugIcon.breakpointDisabledForeground', defaults: {
                dark: '#848484',
                light: '#848484',
                hcDark: '#848484',
                hcLight: '#848484'
            },
            description: nls_1.nls.localizeByDefault('Icon color for disabled breakpoints.')
        }, {
            id: 'debugIcon.breakpointUnverifiedForeground', defaults: {
                dark: '#848484',
                light: '#848484',
                hcDark: '#848484',
                hcLight: '#848484'
            },
            description: nls_1.nls.localizeByDefault('Icon color for unverified breakpoints.')
        }, {
            id: 'debugIcon.breakpointCurrentStackframeForeground', defaults: {
                dark: '#FFCC00',
                light: '#BE8700',
                hcDark: '#FFCC00',
                hcLight: '#BE8700'
            },
            description: nls_1.nls.localizeByDefault('Icon color for the current breakpoint stack frame.')
        }, {
            id: 'debugIcon.breakpointStackframeForeground', defaults: {
                dark: '#89D185',
                light: '#89D185',
                hcDark: '#89D185',
                hcLight: '#89D185'
            },
            description: nls_1.nls.localizeByDefault('Icon color for all breakpoint stack frames.')
        }, {
            id: 'debugIcon.startForeground', defaults: {
                dark: '#89D185',
                light: '#388A34',
                hcDark: '#89D185',
                hcLight: '#388A34'
            }, description: nls_1.nls.localizeByDefault('Debug toolbar icon for start debugging.')
        }, {
            id: 'debugIcon.pauseForeground', defaults: {
                dark: '#75BEFF',
                light: '#007ACC',
                hcDark: '#75BEFF',
                hcLight: '#007ACC'
            }, description: nls_1.nls.localizeByDefault('Debug toolbar icon for pause.')
        }, {
            id: 'debugIcon.stopForeground', defaults: {
                dark: '#F48771',
                light: '#A1260D',
                hcDark: '#F48771',
                hcLight: '#A1260D'
            }, description: nls_1.nls.localizeByDefault('Debug toolbar icon for stop.')
        }, {
            id: 'debugIcon.disconnectForeground', defaults: {
                dark: '#F48771',
                light: '#A1260D',
                hcDark: '#F48771',
                hcLight: '#A1260D'
            }, description: nls_1.nls.localizeByDefault('Debug toolbar icon for disconnect.')
        }, {
            id: 'debugIcon.restartForeground', defaults: {
                dark: '#89D185',
                light: '#388A34',
                hcDark: '#89D185',
                hcLight: '#388A34'
            }, description: nls_1.nls.localizeByDefault('Debug toolbar icon for restart.')
        }, {
            id: 'debugIcon.stepOverForeground', defaults: {
                dark: '#75BEFF',
                light: '#007ACC',
                hcDark: '#75BEFF',
                hcLight: '#007ACC',
            }, description: nls_1.nls.localizeByDefault('Debug toolbar icon for step over.')
        }, {
            id: 'debugIcon.stepIntoForeground', defaults: {
                dark: '#75BEFF',
                light: '#007ACC',
                hcDark: '#75BEFF',
                hcLight: '#007ACC'
            }, description: nls_1.nls.localizeByDefault('Debug toolbar icon for step into.')
        }, {
            id: 'debugIcon.stepOutForeground', defaults: {
                dark: '#75BEFF',
                light: '#007ACC',
                hcDark: '#75BEFF',
                hcLight: '#007ACC',
            }, description: nls_1.nls.localizeByDefault('Debug toolbar icon for step over.')
        }, {
            id: 'debugIcon.continueForeground', defaults: {
                dark: '#75BEFF',
                light: '#007ACC',
                hcDark: '#75BEFF',
                hcLight: '#007ACC'
            }, description: nls_1.nls.localizeByDefault('Debug toolbar icon for continue.')
        }, {
            id: 'debugIcon.stepBackForeground', defaults: {
                dark: '#75BEFF',
                light: '#007ACC',
                hcDark: '#75BEFF',
                hcLight: '#007ACC'
            }, description: nls_1.nls.localizeByDefault('Debug toolbar icon for step back.')
        }, {
            id: 'debugConsole.infoForeground', defaults: {
                dark: 'editorInfo.foreground',
                light: 'editorInfo.foreground',
                hcDark: 'foreground',
                hcLight: 'foreground'
            }, description: 'Foreground color for info messages in debug REPL console.' // this description is present in VS Code, but is not currently localized there
        }, {
            id: 'debugConsole.warningForeground', defaults: {
                dark: 'editorWarning.foreground',
                light: 'editorWarning.foreground',
                hcDark: '#008000',
                hcLight: 'editorWarning.foreground'
            },
            description: 'Foreground color for warning messages in debug REPL console.' // this description is present in VS Code, but is not currently localized there
        }, {
            id: 'debugConsole.errorForeground', defaults: {
                dark: 'errorForeground',
                light: 'errorForeground',
                hcDark: 'errorForeground',
                hcLight: 'errorForeground'
            },
            description: 'Foreground color for error messages in debug REPL console.', // this description is present in VS Code, but is not currently localized there
        }, {
            id: 'debugConsole.sourceForeground', defaults: {
                dark: 'foreground',
                light: 'foreground',
                hcDark: 'foreground',
                hcLight: 'foreground'
            },
            description: 'Foreground color for source filenames in debug REPL console.', // this description is present in VS Code, but is not currently localized there
        }, {
            id: 'debugConsoleInputIcon.foreground', defaults: {
                dark: 'foreground',
                light: 'foreground',
                hcDark: 'foreground',
                hcLight: 'foreground'
            },
            description: 'Foreground color for debug console input marker icon.' // this description is present in VS Code, but is not currently localized there
        });
    }
    updateStatusBar() {
        if (this.debuggingStatusBar === document.body.classList.contains('theia-mod-debugging')) {
            return;
        }
        document.body.classList.toggle('theia-mod-debugging');
    }
    get debuggingStatusBar() {
        if (this.manager.state < debug_session_1.DebugState.Running) {
            return false;
        }
        const session = this.manager.currentSession;
        if (session) {
            if (session.configuration.noDebug) {
                return false;
            }
            if (this.getOption(session, 'suppressDebugStatusbar')) {
                return false;
            }
        }
        return true;
    }
    getOption(session, option) {
        // If session is undefined there will be no option
        if (!session) {
            return false;
        }
        // If undefined take the value of the parent
        if (option in session.configuration && session.configuration[option] !== undefined) {
            return session.configuration[option];
        }
        return this.getOption(session.parentSession, option);
    }
};
exports.DebugFrontendApplicationContribution = DebugFrontendApplicationContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_service_1.DebugService),
    tslib_1.__metadata("design:type", Object)
], DebugFrontendApplicationContribution.prototype, "debug", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_session_manager_1.DebugSessionManager),
    tslib_1.__metadata("design:type", debug_session_manager_1.DebugSessionManager)
], DebugFrontendApplicationContribution.prototype, "manager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_configuration_manager_1.DebugConfigurationManager),
    tslib_1.__metadata("design:type", debug_configuration_manager_1.DebugConfigurationManager)
], DebugFrontendApplicationContribution.prototype, "configurations", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(breakpoint_manager_1.BreakpointManager),
    tslib_1.__metadata("design:type", breakpoint_manager_1.BreakpointManager)
], DebugFrontendApplicationContribution.prototype, "breakpointManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_editor_service_1.DebugEditorService),
    tslib_1.__metadata("design:type", debug_editor_service_1.DebugEditorService)
], DebugFrontendApplicationContribution.prototype, "editors", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_console_contribution_1.DebugConsoleContribution),
    tslib_1.__metadata("design:type", debug_console_contribution_1.DebugConsoleContribution)
], DebugFrontendApplicationContribution.prototype, "console", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_schema_updater_1.DebugSchemaUpdater),
    tslib_1.__metadata("design:type", debug_schema_updater_1.DebugSchemaUpdater)
], DebugFrontendApplicationContribution.prototype, "schemaUpdater", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_preferences_1.DebugPreferences),
    tslib_1.__metadata("design:type", Object)
], DebugFrontendApplicationContribution.prototype, "preference", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_watch_manager_1.DebugWatchManager),
    tslib_1.__metadata("design:type", debug_watch_manager_1.DebugWatchManager)
], DebugFrontendApplicationContribution.prototype, "watchManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_expression_provider_1.DebugExpressionProvider),
    tslib_1.__metadata("design:type", debug_expression_provider_1.DebugExpressionProvider)
], DebugFrontendApplicationContribution.prototype, "expressionProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.LabelProvider),
    tslib_1.__metadata("design:type", browser_1.LabelProvider)
], DebugFrontendApplicationContribution.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.EditorManager),
    tslib_1.__metadata("design:type", browser_2.EditorManager)
], DebugFrontendApplicationContribution.prototype, "editorManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.MessageService),
    tslib_1.__metadata("design:type", common_1.MessageService)
], DebugFrontendApplicationContribution.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_data_breakpoint_actions_1.AddOrEditDataBreakpointAddress),
    tslib_1.__metadata("design:type", debug_data_breakpoint_actions_1.AddOrEditDataBreakpointAddress)
], DebugFrontendApplicationContribution.prototype, "AddOrEditDataBreakpointAddress", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('debug:DebugFrontendApplicationContribution'),
    tslib_1.__metadata("design:type", Object)
], DebugFrontendApplicationContribution.prototype, "logger", void 0);
exports.DebugFrontendApplicationContribution = DebugFrontendApplicationContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], DebugFrontendApplicationContribution);
//# sourceMappingURL=debug-frontend-application-contribution.js.map