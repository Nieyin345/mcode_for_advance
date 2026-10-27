"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
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
exports.DefaultWindowLaunchArgs = exports.WindowLaunchArgs = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
exports.WindowLaunchArgs = Symbol('WindowLaunchArgs');
/**
 * Default (browser) implementation: there is no trusted per-window launch channel in a plain
 * browser deployment, and the window URL must never be treated as one, so this always reports "no
 * launch options". Electron rebinds {@link WindowLaunchArgs} to an implementation backed by the
 * per-window metadata the preload script provides.
 *
 * @experimental
 */
let DefaultWindowLaunchArgs = class DefaultWindowLaunchArgs {
    getLaunchArgs() {
        return undefined;
    }
};
exports.DefaultWindowLaunchArgs = DefaultWindowLaunchArgs;
exports.DefaultWindowLaunchArgs = DefaultWindowLaunchArgs = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DefaultWindowLaunchArgs);
//# sourceMappingURL=window-launch-args.js.map