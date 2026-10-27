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
exports.BrowserOnlyTerminalFrontendContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const message_service_1 = require("@theia/core/lib/common/message-service");
const nls_1 = require("@theia/core/lib/common/nls");
const terminal_frontend_contribution_1 = require("../browser/terminal-frontend-contribution");
/**
 * A browser-only application has no backend to run a shell in, so it can't open terminals.
 *
 * `TerminalService`, `FrontendApplicationContribution`, `CommandContribution` and the other
 * contribution points in `terminal-frontend-module.ts` are all bound with
 * `toService(TerminalFrontendContribution)`, which resolves the token lazily on every lookup.
 * Rebinding `TerminalFrontendContribution` itself - instead of only `TerminalService` - therefore
 * redirects every one of those paths (UI commands, terminal profiles, and the `TerminalService`
 * token used by plugins/tasks/debug) through this subclass, rather than just the minority of
 * callers that happen to inject `TerminalService` directly.
 */
let BrowserOnlyTerminalFrontendContribution = class BrowserOnlyTerminalFrontendContribution extends terminal_frontend_contribution_1.TerminalFrontendContribution {
    // There is no backend to restore or create a terminal for at startup, so skip it silently
    // instead of letting the base implementation fail and log an error on every launch.
    async initializeLayout() {
        // no terminal to restore in a browser-only application
    }
    // Callers that inject the `TerminalService` token programmatically (the VS Code
    // `window.createTerminal` API, tasks, debug sessions, AI terminal functions, ...) need a
    // rejected promise so they can handle the failure themselves. This message is not localized
    // since it is meant for those programmatic callers, not shown to the user directly.
    async newTerminal(options) {
        throw new Error('Terminals are not supported in a browser-only application.');
    }
    // The plugin host queries the default shell on startup; report none available instead of
    // rejecting so that query doesn't fail plugin activation.
    async getDefaultShell() {
        return '';
    }
    async openInTerminal(uri) {
        this.showNotSupportedMessage();
    }
    async openTerminal(options, terminalProfile) {
        this.showNotSupportedMessage();
    }
    async openActiveWorkspaceTerminal(options) {
        this.showNotSupportedMessage();
    }
    showNotSupportedMessage() {
        this.messageService.error(nls_1.nls.localize('theia/terminal/notSupportedInBrowserOnly', 'Terminals are not supported in a browser-only application.'));
    }
};
exports.BrowserOnlyTerminalFrontendContribution = BrowserOnlyTerminalFrontendContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(message_service_1.MessageService),
    tslib_1.__metadata("design:type", message_service_1.MessageService)
], BrowserOnlyTerminalFrontendContribution.prototype, "messageService", void 0);
exports.BrowserOnlyTerminalFrontendContribution = BrowserOnlyTerminalFrontendContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserOnlyTerminalFrontendContribution);
//# sourceMappingURL=browser-only-terminal-frontend-contribution.js.map