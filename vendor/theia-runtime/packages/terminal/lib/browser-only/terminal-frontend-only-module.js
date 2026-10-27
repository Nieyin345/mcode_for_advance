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
const inversify_1 = require("@theia/core/shared/inversify");
const browser_only_terminal_frontend_contribution_1 = require("./browser-only-terminal-frontend-contribution");
const terminal_frontend_contribution_1 = require("../browser/terminal-frontend-contribution");
exports.default = new inversify_1.ContainerModule((bind, unbind, isBound, rebind) => {
    rebind(terminal_frontend_contribution_1.TerminalFrontendContribution).to(browser_only_terminal_frontend_contribution_1.BrowserOnlyTerminalFrontendContribution).inSingletonScope();
});
//# sourceMappingURL=terminal-frontend-only-module.js.map