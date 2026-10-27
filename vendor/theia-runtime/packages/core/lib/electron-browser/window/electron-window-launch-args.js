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
exports.ElectronWindowLaunchArgs = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
/**
 * Electron implementation of {@link WindowLaunchArgs}. Reads the options the main process attached
 * to this window's metadata, which the preload script fetches synchronously before any frontend code
 * runs, and which main keys by the IPC sender rather than by any value from the URL (see
 * `LaunchArgsStore`).
 *
 * @experimental
 */
let ElectronWindowLaunchArgs = class ElectronWindowLaunchArgs {
    getLaunchArgs() {
        // `undefined` for a cold-start window, letting callers fall back to the shared backend, and
        // the stored options for a forwarded window (kept for as long as the window shows the
        // frontend the launch opened, so a plain reload still sees them).
        return window.electronTheiaCore.WindowMetadata.launchArgs;
    }
};
exports.ElectronWindowLaunchArgs = ElectronWindowLaunchArgs;
exports.ElectronWindowLaunchArgs = ElectronWindowLaunchArgs = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ElectronWindowLaunchArgs);
//# sourceMappingURL=electron-window-launch-args.js.map