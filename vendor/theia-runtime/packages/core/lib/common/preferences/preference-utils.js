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
exports.LINUX_ENV_HINT = void 0;
const nls_1 = require("../nls");
const os_1 = require("../os");
/**
 * Hint appended to API key preference descriptions on Linux, where environment variables
 * set in `~/.bashrc` are not available to desktop-launched applications.
 */
exports.LINUX_ENV_HINT = !os_1.isWindows && !os_1.isOSX
    ? ' ' + nls_1.nls.localize('theia/ai-core/preferences/linuxEnvHint', 'On Linux, make sure the variable is defined in `~/.profile` (not just `~/.bashrc`) if you launch the application from a desktop shortcut.' +
        ' See the [documentation](https://theia-ide.org/docs/user_ai/#setting-api-keys) for details.')
    : '';
//# sourceMappingURL=preference-utils.js.map