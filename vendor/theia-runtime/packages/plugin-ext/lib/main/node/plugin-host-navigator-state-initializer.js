"use strict";
// *****************************************************************************
// Copyright (C) 2026 STMicroelectronics and others.
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
exports.PluginHostNavigatorStateInitializer = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const preferences_1 = require("@theia/core/lib/common/preferences");
const plugin_host_environment_preferences_1 = require("../common/plugin-host-environment-preferences");
/**
 * Keeps {@link PluginHostNavigatorState} in sync with the navigator preference.
 *
 * `PreferenceService` has async dependencies and cannot be injected in
 * connection-scoped containers. This contribution runs in the root container
 * and mutates the shared state object by reference so that
 * `HostedPluginProcess` (connection-scoped) always sees the latest value.
 */
let PluginHostNavigatorStateInitializer = class PluginHostNavigatorStateInitializer {
    onStart() {
        this.state.supportNodeGlobalNavigator = this.preferences.get(plugin_host_environment_preferences_1.SUPPORT_NODE_GLOBAL_NAVIGATOR_PREF, false);
        this.preferences.onPreferenceChanged(e => {
            if (e.preferenceName === plugin_host_environment_preferences_1.SUPPORT_NODE_GLOBAL_NAVIGATOR_PREF) {
                this.state.supportNodeGlobalNavigator = this.preferences.get(plugin_host_environment_preferences_1.SUPPORT_NODE_GLOBAL_NAVIGATOR_PREF, false);
            }
        });
    }
};
exports.PluginHostNavigatorStateInitializer = PluginHostNavigatorStateInitializer;
tslib_1.__decorate([
    (0, inversify_1.inject)(preferences_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], PluginHostNavigatorStateInitializer.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_host_environment_preferences_1.PluginHostNavigatorState),
    tslib_1.__metadata("design:type", Object)
], PluginHostNavigatorStateInitializer.prototype, "state", void 0);
exports.PluginHostNavigatorStateInitializer = PluginHostNavigatorStateInitializer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PluginHostNavigatorStateInitializer);
//# sourceMappingURL=plugin-host-navigator-state-initializer.js.map