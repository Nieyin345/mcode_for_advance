"use strict";
// *****************************************************************************
// Copyright (C) 2026 Robert Jandow
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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
// `ApplicationShell`, `ConfirmDialog` and `FileService` transitively import browser modules
// that touch `document` at load time.
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
// `WorkspaceService` transitively reads the frontend application config at module load time.
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
// `xterm` probes for a canvas 2d context when it is loaded, which JSDOM does not implement and
// loudly reports. Nothing under test renders, so an inert stub is enough to keep the output clean.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
window.HTMLCanvasElement.prototype.getContext = () => undefined;
const chai_1 = require("chai");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const clipboard_service_1 = require("@theia/core/lib/browser/clipboard-service");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const common_1 = require("@theia/core/lib/common");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const browser_2 = require("@theia/workspace/lib/browser");
const browser_3 = require("@theia/variable-resolver/lib/browser");
const terminal_service_1 = require("../browser/base/terminal-service");
const terminal_frontend_contribution_1 = require("../browser/terminal-frontend-contribution");
const terminal_watcher_1 = require("../common/terminal-watcher");
const shell_terminal_protocol_1 = require("../common/shell-terminal-protocol");
const terminal_preferences_1 = require("../common/terminal-preferences");
const terminal_copy_on_selection_handler_1 = require("../browser/terminal-copy-on-selection-handler");
const terminal_creation_handler_1 = require("../browser/terminal-creation-handler");
const terminal_profile_service_1 = require("../browser/terminal-profile-service");
const browser_only_terminal_frontend_contribution_1 = require("./browser-only-terminal-frontend-contribution");
disableJSDOM();
/**
 * `TerminalFrontendContribution` (and hence its browser-only subclass) has many injected
 * dependencies, most of which are never touched by the browser-only overrides under test here.
 * Only `@postConstruct() init()` reaches into a handful of them (`shell`, `widgetManager`,
 * `contextKeyService`, `terminalWatcher`) - those get working fakes, everything else gets an
 * inert placeholder just to satisfy the injector.
 */
function bindTerminalTestDependencies(container, onError = () => { }) {
    const inert = () => ({});
    container.bind(browser_1.ApplicationShell).toConstantValue({
        activeWidget: undefined,
        onDidChangeCurrentWidget: core_1.Event.None,
        onDidChangeActiveWidget: core_1.Event.None
    });
    container.bind(browser_1.WidgetManager).toConstantValue({ onDidCreateWidget: core_1.Event.None });
    container.bind(context_key_service_1.ContextKeyService).toConstantValue({ createKey: () => ({ set: () => { } }) });
    container.bind(terminal_watcher_1.TerminalWatcher).toConstantValue({
        onStoreTerminalEnvVariablesRequested: core_1.Event.None,
        onUpdateTerminalEnvVariablesRequested: core_1.Event.None
    });
    container.bind(core_1.MessageService).toConstantValue({
        error: (message) => { onError(message); return Promise.resolve(undefined); }
    });
    container.bind(core_1.ILogger).toConstantValue(new mock_logger_1.MockLogger());
    container.bind(core_1.ContributionProvider).toConstantValue({ getContributions: () => [] }).whenTargetNamed(terminal_creation_handler_1.TerminalCreationHandler);
    container.bind(shell_terminal_protocol_1.ShellTerminalServerProxy).toConstantValue(inert());
    container.bind(file_service_1.FileService).toConstantValue(inert());
    container.bind(core_1.SelectionService).toConstantValue(inert());
    container.bind(browser_1.LabelProvider).toConstantValue(inert());
    container.bind(browser_2.WorkspaceService).toConstantValue(inert());
    container.bind(terminal_profile_service_1.TerminalProfileService).toConstantValue(inert());
    container.bind(terminal_profile_service_1.UserTerminalProfileStore).toConstantValue(inert());
    container.bind(terminal_profile_service_1.ContributedTerminalProfileStore).toConstantValue(inert());
    container.bind(browser_3.VariableResolverService).toConstantValue(inert());
    container.bind(browser_1.StorageService).toConstantValue(inert());
    container.bind(common_1.PreferenceService).toConstantValue(inert());
    container.bind(terminal_preferences_1.TerminalPreferences).toConstantValue(inert());
    container.bind(terminal_copy_on_selection_handler_1.TerminalCopyOnSelectionHandler).toConstantValue(inert());
    container.bind(clipboard_service_1.ClipboardService).toConstantValue(inert());
}
describe('BrowserOnlyTerminalFrontendContribution', () => {
    /** Records every message reported through `MessageService.error`. */
    let errorMessages;
    let contribution;
    beforeEach(() => {
        errorMessages = [];
        const container = new inversify_1.Container();
        container.bind(browser_only_terminal_frontend_contribution_1.BrowserOnlyTerminalFrontendContribution).toSelf().inSingletonScope();
        container.bind(terminal_service_1.TerminalService).toService(browser_only_terminal_frontend_contribution_1.BrowserOnlyTerminalFrontendContribution);
        bindTerminalTestDependencies(container, message => errorMessages.push(message));
        contribution = container.get(browser_only_terminal_frontend_contribution_1.BrowserOnlyTerminalFrontendContribution);
    });
    it('rejects programmatic terminal creation instead of returning a dead widget', async () => {
        try {
            await contribution.newTerminal({});
            chai_1.expect.fail('newTerminal() should have rejected');
        }
        catch (error) {
            (0, chai_1.expect)(error.message).to.equal('Terminals are not supported in a browser-only application.');
        }
    });
    it('resolves the default shell to an empty string without touching the (nonexistent) backend', async () => {
        // `shellTerminalServer` is bound to an inert placeholder above: reaching for it would throw.
        const shell = await contribution.getDefaultShell();
        (0, chai_1.expect)(shell).to.equal('');
    });
    it('reports the limitation and creates no widget when opening a terminal from the UI', async () => {
        // `openTerminal` is the entry point for the "Create New Terminal" command and the
        // profile quick-pick; `widgetManager` is left as an inert placeholder above, so a
        // widget-creating code path would throw here rather than quietly succeed.
        await contribution.openTerminal();
        (0, chai_1.expect)(errorMessages).to.deep.equal(['Terminals are not supported in a browser-only application.']);
    });
    it('reports the limitation when opening a terminal for the active workspace', async () => {
        await contribution.openActiveWorkspaceTerminal();
        (0, chai_1.expect)(errorMessages).to.deep.equal(['Terminals are not supported in a browser-only application.']);
    });
    it('reports the limitation when opening a terminal from a file/folder context menu', async () => {
        await contribution.openInTerminal({ toString: () => 'file:///workspace' });
        (0, chai_1.expect)(errorMessages).to.deep.equal(['Terminals are not supported in a browser-only application.']);
    });
    it('does not attempt to create or restore a terminal at startup', async () => {
        // The base implementation calls `newTerminal` and logs an error when it fails; the
        // browser-only override must skip that attempt entirely so no such error is logged.
        await contribution.initializeLayout();
        (0, chai_1.expect)(errorMessages).to.be.empty;
    });
    it('rebinding TerminalFrontendContribution redirects every toService(TerminalFrontendContribution) binding', () => {
        // Mirrors how `terminal-frontend-module.ts` binds `TerminalService` and other contribution
        // points via `toService(TerminalFrontendContribution)`, and how `terminal-frontend-only-module.ts`
        // rebinds `TerminalFrontendContribution` itself so that every one of those lazily-resolved
        // bindings is redirected to the browser-only implementation - not just `TerminalService`.
        const module = new inversify_1.ContainerModule((bind, unbind, isBound, rebind) => {
            bind(terminal_frontend_contribution_1.TerminalFrontendContribution).toSelf().inSingletonScope();
            bind(terminal_service_1.TerminalService).toService(terminal_frontend_contribution_1.TerminalFrontendContribution);
        });
        const browserOnlyModule = new inversify_1.ContainerModule((bind, unbind, isBound, rebind) => {
            rebind(terminal_frontend_contribution_1.TerminalFrontendContribution).to(browser_only_terminal_frontend_contribution_1.BrowserOnlyTerminalFrontendContribution).inSingletonScope();
        });
        const container = new inversify_1.Container();
        container.load(module);
        bindTerminalTestDependencies(container);
        // simulates `terminal-frontend-only-module.ts` loading after `terminal-frontend-module.ts`
        container.load(browserOnlyModule);
        const resolved = container.get(terminal_service_1.TerminalService);
        (0, chai_1.expect)(resolved).to.be.instanceOf(browser_only_terminal_frontend_contribution_1.BrowserOnlyTerminalFrontendContribution);
    });
});
//# sourceMappingURL=browser-only-terminal-frontend-contribution.spec.js.map