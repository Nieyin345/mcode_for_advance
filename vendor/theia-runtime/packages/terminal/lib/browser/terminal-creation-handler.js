"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
exports.TerminalCreationHandler = void 0;
/**
 * Contribution point that allows extensions to intercept terminal placement
 * and take ownership of how/where terminals are displayed.
 *
 * When a terminal is opened via {@link TerminalService.open}, registered
 * handlers are consulted in priority order. A handler can:
 * - Return `true` to claim the terminal (the default shell placement is skipped)
 * - Return `false` / `undefined` to decline (the next handler or default behavior applies)
 *
 * This is the canonical way for alternative terminal UIs (e.g. the terminal
 * manager's tree view) to take ownership of terminal placement without relying
 * on post-hoc event interception or timing-sensitive side-channel flags.
 */
exports.TerminalCreationHandler = Symbol('TerminalCreationHandler');
//# sourceMappingURL=terminal-creation-handler.js.map