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
exports.SessionPreferenceRemoteCliContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const launch_arguments_1 = require("@theia/core/lib/common/launch-arguments");
const window_launch_args_1 = require("@theia/core/lib/browser/window/window-launch-args");
const cli_preferences_1 = require("../common/cli-preferences");
/**
 * Re-applies `--session-preference` values on a remote backend that is started for a *forwarded*
 * (second-instance) window.
 *
 * The shared local backend only knows the preferences of the original cold-start launch, so its
 * `RemoteCliContribution#enhanceArgs` cannot supply the right values for a window opened by a
 * later launch. This frontend contribution reads the session preferences forwarded to the current
 * window (provided by the trusted main process) and formats them as CLI arguments for the remote
 * backend.
 */
let SessionPreferenceRemoteCliContribution = class SessionPreferenceRemoteCliContribution {
    async getRemoteCliArgs() {
        const forwarded = this.launchArgs.getLaunchArgs();
        if (forwarded === undefined) {
            // Cold-start window: the shared backend already forwards its session preferences.
            return [];
        }
        return cli_preferences_1.CliPreferenceEntry
            .parseAll(launch_arguments_1.LaunchArguments.values(forwarded, 'session-preference'))
            .map(entry => cli_preferences_1.CliPreferenceEntry.toArg('session-preference', entry));
    }
};
exports.SessionPreferenceRemoteCliContribution = SessionPreferenceRemoteCliContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(window_launch_args_1.WindowLaunchArgs),
    tslib_1.__metadata("design:type", Object)
], SessionPreferenceRemoteCliContribution.prototype, "launchArgs", void 0);
exports.SessionPreferenceRemoteCliContribution = SessionPreferenceRemoteCliContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], SessionPreferenceRemoteCliContribution);
//# sourceMappingURL=session-preference-remote-cli-contribution.js.map