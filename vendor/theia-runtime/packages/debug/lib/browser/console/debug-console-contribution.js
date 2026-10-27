"use strict";
var DebugConsoleContribution_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugConsoleContribution = exports.DebugConsoleCommands = exports.InDebugReplContextKey = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
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
require("../../../src/browser/style/debug.css");
const console_session_manager_1 = require("@theia/console/lib/browser/console-session-manager");
const console_widget_1 = require("@theia/console/lib/browser/console-widget");
const browser_1 = require("@theia/core/lib/browser");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const nls_1 = require("@theia/core/lib/common/nls");
const tab_bar_toolbar_1 = require("@theia/core/lib/browser/shell/tab-bar-toolbar");
const command_1 = require("@theia/core/lib/common/command");
const severity_1 = require("@theia/core/lib/common/severity");
const inversify_1 = require("@theia/core/shared/inversify");
const select_component_1 = require("@theia/core/lib/browser/widgets/select-component");
const debug_session_manager_1 = require("../debug-session-manager");
const debug_console_session_1 = require("./debug-console-session");
const core_1 = require("@theia/core");
const markdown_rendering_1 = require("@theia/core/lib/common/markdown-rendering");
const debounce = require("@theia/core/shared/lodash.debounce");
exports.InDebugReplContextKey = Symbol('inDebugReplContextKey');
var DebugConsoleCommands;
(function (DebugConsoleCommands) {
    DebugConsoleCommands.DEBUG_CATEGORY = 'Debug';
    DebugConsoleCommands.CLEAR = command_1.Command.toDefaultLocalizedCommand({
        id: 'debug.console.clear',
        category: DebugConsoleCommands.DEBUG_CATEGORY,
        label: 'Clear Console',
        iconClass: (0, browser_1.codicon)('clear-all')
    });
})(DebugConsoleCommands || (exports.DebugConsoleCommands = DebugConsoleCommands = {}));
let DebugConsoleContribution = class DebugConsoleContribution extends browser_1.AbstractViewContribution {
    static { DebugConsoleContribution_1 = this; }
    constructor() {
        super({
            widgetId: DebugConsoleContribution_1.options.id,
            widgetName: DebugConsoleContribution_1.options.title.label,
            defaultWidgetOptions: {
                area: 'bottom'
            },
            toggleCommandId: 'debug:console:toggle',
            toggleKeybinding: 'ctrlcmd+shift+y'
        });
        this.DEBUG_CONSOLE_SEVERITY_ID = 'debugConsoleSeverity';
        this.currentFilterValue = '';
        this.filterChangedEmitter = new core_1.Emitter();
        this.toDispose = new core_1.DisposableCollection();
        this.handleSeverityMouseEnter = (e) => {
            const tooltipContent = new markdown_rendering_1.MarkdownStringImpl();
            tooltipContent.appendMarkdown(nls_1.nls.localize('theia/debug/consoleSeverityTooltip', 'Filter console output by severity level. Only messages with the selected severity will be shown.'));
            this.hoverService.requestHover({
                content: tooltipContent,
                target: e.currentTarget,
                position: 'bottom'
            });
        };
        this.handleSessionSelectorMouseEnter = (e) => {
            const tooltipContent = new markdown_rendering_1.MarkdownStringImpl();
            tooltipContent.appendMarkdown(nls_1.nls.localize('theia/debug/consoleSessionSelectorTooltip', 'Switch between debug sessions. Each debug session has its own console output.'));
            this.hoverService.requestHover({
                content: tooltipContent,
                target: e.currentTarget,
                position: 'bottom'
            });
        };
        this.handleFilterInputChange = (e) => {
            const value = e.target.value;
            this.currentFilterValue = value;
            this.filterChangedEmitter.fire();
            this.applyFilterDebounced(value);
        };
        this.applyFilterDebounced = debounce((value) => {
            const session = this.consoleSessionManager.selectedSession;
            if (session) {
                session.filterText = value;
            }
        }, 150);
        this.handleFilterClear = () => {
            if (this.filterInputRef) {
                this.filterInputRef.value = '';
            }
            this.currentFilterValue = '';
            const session = this.consoleSessionManager.selectedSession;
            if (session) {
                session.filterText = '';
            }
            this.filterChangedEmitter.fire();
        };
        this.handleFilterMouseEnter = (e) => {
            const tooltipContent = new markdown_rendering_1.MarkdownStringImpl();
            tooltipContent.appendMarkdown(nls_1.nls.localize('theia/debug/consoleFilterTooltip', 'Filter console output by text. Separate multiple terms with commas. Prefix with `!` to exclude a term.\n\n' +
                'Examples:\n\n' +
                '- `text` - show lines containing "text"\n' +
                '- `text, other` - show lines containing "text" or "other"\n' +
                '- `!text` - hide lines containing "text"\n' +
                '- `text, !other` - show "text" but hide "other"'));
            this.hoverService.requestHover({
                content: tooltipContent,
                target: e.currentTarget,
                position: 'bottom'
            });
        };
        this.changeDebugConsole = (option) => {
            const id = option.value;
            const session = this.consoleSessionManager.get(id);
            this.consoleSessionManager.selectedSession = session;
        };
        this.changeSeverity = (option) => {
            this.consoleSessionManager.severity = severity_1.Severity.fromValue(option.value);
        };
    }
    init() {
        this.resources.add(debug_console_session_1.DebugConsoleSession.uri, '');
        this.toDispose.pushAll([
            this.debugSessionManager.onDidCreateDebugSession(session => {
                const consoleParent = session.findConsoleParent();
                if (consoleParent) {
                    const parentConsoleSession = this.consoleSessionManager.get(consoleParent.id);
                    if (parentConsoleSession instanceof debug_console_session_1.DebugConsoleSession) {
                        session.on('output', event => parentConsoleSession.logOutput(parentConsoleSession.debugSession, event));
                    }
                }
                else {
                    const consoleSession = this.debugConsoleSessionFactory(session);
                    this.consoleSessionManager.add(consoleSession);
                    session.on('output', event => consoleSession.logOutput(session, event));
                }
            }),
            this.debugSessionManager.onDidChangeActiveDebugSession(event => this.handleActiveDebugSessionChanged(event)),
            this.debugSessionManager.onDidDestroyDebugSession(session => {
                const consoleSession = this.consoleSessionManager.get(session.id);
                if (consoleSession instanceof debug_console_session_1.DebugConsoleSession) {
                    consoleSession.markTerminated();
                }
            }),
            this.consoleSessionManager.onDidChangeSelectedSession(() => {
                const session = this.consoleSessionManager.selectedSession;
                if (session && this.filterInputRef) {
                    const filterValue = session.filterText || '';
                    this.filterInputRef.value = filterValue;
                    this.currentFilterValue = filterValue;
                    this.filterChangedEmitter.fire();
                }
            })
        ]);
    }
    handleActiveDebugSessionChanged(event) {
        if (!event.current) {
            return;
        }
        else {
            const topSession = event.current.findConsoleParent() || event.current;
            const consoleSession = topSession ? this.consoleSessionManager.get(topSession.id) : undefined;
            this.consoleSessionManager.selectedSession = consoleSession;
            const consoleSelector = document.getElementById('debugConsoleSelector');
            if (consoleSession && consoleSelector instanceof HTMLSelectElement) {
                consoleSelector.value = consoleSession.id;
            }
        }
    }
    registerCommands(commands) {
        super.registerCommands(commands);
        commands.registerCommand(DebugConsoleCommands.CLEAR, {
            isEnabled: widget => this.withWidget(widget, () => true),
            isVisible: widget => this.withWidget(widget, () => true),
            execute: widget => this.withWidget(widget, () => {
                this.clearConsole();
            }),
        });
    }
    async registerToolbarItems(toolbarRegistry) {
        toolbarRegistry.registerItem({
            id: 'debug-console-severity',
            render: widget => this.renderSeveritySelector(widget),
            isVisible: widget => this.withWidget(widget, () => true),
            onDidChange: this.consoleSessionManager.onDidChangeSeverity,
            priority: -3,
        });
        toolbarRegistry.registerItem({
            id: 'debug-console-filter',
            render: () => this.renderFilterInput(),
            isVisible: widget => this.withWidget(widget, () => true),
            onDidChange: this.filterChangedEmitter.event,
            priority: -2,
        });
        toolbarRegistry.registerItem({
            id: 'debug-console-session-selector',
            render: widget => this.renderDebugConsoleSelector(widget),
            isVisible: widget => this.withWidget(widget, () => this.consoleSessionManager.all.length >= 1),
            onDidChange: core_1.Event.any(this.consoleSessionManager.onDidAddSession, this.consoleSessionManager.onDidDeleteSession, this.consoleSessionManager.onDidChangeSelectedSession),
            priority: -1,
        });
        toolbarRegistry.registerItem({
            id: DebugConsoleCommands.CLEAR.id,
            command: DebugConsoleCommands.CLEAR.id,
            tooltip: DebugConsoleCommands.CLEAR.label,
            priority: 0,
        });
    }
    static { this.options = {
        id: 'debug-console',
        title: {
            label: nls_1.nls.localizeByDefault('Debug Console'),
            iconClass: (0, browser_1.codicon)('debug-console')
        },
        input: {
            uri: debug_console_session_1.DebugConsoleSession.uri,
            options: {
                autoSizing: true,
                minHeight: 1,
                maxHeight: 10
            }
        }
    }; }
    static async create(parent) {
        const inputFocusContextKey = parent.get(exports.InDebugReplContextKey);
        const child = console_widget_1.ConsoleWidget.createContainer(parent, {
            ...DebugConsoleContribution_1.options,
            inputFocusContextKey
        });
        const widget = child.get(console_widget_1.ConsoleWidget);
        await widget.ready;
        return widget;
    }
    static bindContribution(bind) {
        bind(exports.InDebugReplContextKey).toDynamicValue(({ container }) => container.get(context_key_service_1.ContextKeyService).createKey('inDebugRepl', false)).inSingletonScope();
        bind(debug_console_session_1.DebugConsoleSession).toSelf().inRequestScope();
        bind(debug_console_session_1.DebugConsoleSessionFactory).toFactory(context => (session) => {
            const consoleSession = context.container.get(debug_console_session_1.DebugConsoleSession);
            consoleSession.debugSession = session;
            return consoleSession;
        });
        bind(console_session_manager_1.ConsoleSessionManager).toSelf().inSingletonScope();
        (0, browser_1.bindViewContribution)(bind, DebugConsoleContribution_1);
        bind(tab_bar_toolbar_1.TabBarToolbarContribution).toService(DebugConsoleContribution_1);
        bind(browser_1.WidgetFactory).toDynamicValue(({ container }) => ({
            id: DebugConsoleContribution_1.options.id,
            createWidget: () => DebugConsoleContribution_1.create(container)
        }));
    }
    renderSeveritySelector(widget) {
        const severityElements = severity_1.Severity.toArray().map(e => ({
            value: e,
            label: severity_1.Severity.toLocaleString(e)
        }));
        return (0, jsx_runtime_1.jsx)("div", { onMouseEnter: this.handleSeverityMouseEnter, children: (0, jsx_runtime_1.jsx)(select_component_1.SelectComponent, { id: this.DEBUG_CONSOLE_SEVERITY_ID, options: severityElements, defaultValue: this.consoleSessionManager.severity || severity_1.Severity.Ignore, onChange: this.changeSeverity }, "debugConsoleSeverity") });
    }
    renderDebugConsoleSelector(widget) {
        const availableConsoles = [];
        const sortedSessions = this.consoleSessionManager.all
            .filter((e) => e instanceof debug_console_session_1.DebugConsoleSession)
            .sort((a, b) => {
            if (a.terminated !== b.terminated) {
                return a.terminated ? 1 : -1;
            }
            return 0;
        });
        sortedSessions.forEach(session => {
            let label = session.debugSession.label;
            if (session.terminated) {
                label = `${label} (${nls_1.nls.localizeByDefault('Stopped')})`;
            }
            availableConsoles.push({
                value: session.id,
                label
            });
        });
        const selectedId = this.consoleSessionManager.selectedSession?.id;
        return (0, jsx_runtime_1.jsx)("div", { onMouseEnter: this.handleSessionSelectorMouseEnter, children: (0, jsx_runtime_1.jsx)(select_component_1.SelectComponent, { options: availableConsoles, defaultValue: selectedId, onChange: this.changeDebugConsole }, "debugConsoleSelector") });
    }
    renderFilterInput() {
        return ((0, jsx_runtime_1.jsxs)("div", { className: "item enabled debug-console-filter-container", children: [(0, jsx_runtime_1.jsx)("input", { type: "text", className: "theia-input", placeholder: nls_1.nls.localize('theia/debug/consoleFilterPlaceholder', 'Filter (e.g. text, !exclude)'), "aria-label": nls_1.nls.localize('theia/debug/consoleFilterAriaLabel', 'Filter debug console output'), ref: ref => { this.filterInputRef = ref ?? undefined; }, onChange: this.handleFilterInputChange, onMouseEnter: this.handleFilterMouseEnter, spellCheck: false }), this.currentFilterValue && (0, jsx_runtime_1.jsx)("span", { className: "debug-console-filter-btn codicon codicon-close action-label", role: "button", "aria-label": nls_1.nls.localizeByDefault('Clear'), onClick: this.handleFilterClear, title: nls_1.nls.localizeByDefault('Clear') })] }));
    }
    withWidget(widget = this.tryGetWidget(), fn) {
        if (widget instanceof console_widget_1.ConsoleWidget && widget.id === DebugConsoleContribution_1.options.id) {
            return fn(widget);
        }
        return false;
    }
    /**
     * Clear the console widget.
     */
    async clearConsole() {
        const widget = await this.widget;
        widget.clear();
        const selectedSession = this.consoleSessionManager.selectedSession;
        if (selectedSession instanceof debug_console_session_1.DebugConsoleSession && selectedSession.terminated) {
            this.consoleSessionManager.delete(selectedSession.id);
        }
    }
    dispose() {
        this.toDispose.dispose();
    }
};
exports.DebugConsoleContribution = DebugConsoleContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(console_session_manager_1.ConsoleSessionManager),
    tslib_1.__metadata("design:type", console_session_manager_1.ConsoleSessionManager)
], DebugConsoleContribution.prototype, "consoleSessionManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_console_session_1.DebugConsoleSessionFactory),
    tslib_1.__metadata("design:type", Function)
], DebugConsoleContribution.prototype, "debugConsoleSessionFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_session_manager_1.DebugSessionManager),
    tslib_1.__metadata("design:type", debug_session_manager_1.DebugSessionManager)
], DebugConsoleContribution.prototype, "debugSessionManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.InMemoryResources),
    tslib_1.__metadata("design:type", core_1.InMemoryResources)
], DebugConsoleContribution.prototype, "resources", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.HoverService),
    tslib_1.__metadata("design:type", browser_1.HoverService)
], DebugConsoleContribution.prototype, "hoverService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DebugConsoleContribution.prototype, "init", null);
exports.DebugConsoleContribution = DebugConsoleContribution = DebugConsoleContribution_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], DebugConsoleContribution);
//# sourceMappingURL=debug-console-contribution.js.map