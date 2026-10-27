"use strict";
// *****************************************************************************
// Copyright (C) 2026 Maksim Kachurin and others.
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
exports.PluginType = exports.PLUGIN_HOST_FRONTEND = exports.PLUGIN_HOST_BACKEND = void 0;
exports.rawContributes = rawContributes;
const utils_1 = require("./utils");
exports.PLUGIN_HOST_BACKEND = 'main';
exports.PLUGIN_HOST_FRONTEND = 'frontend';
/** Whether a plugin is installed by the system or by a user. */
var PluginType;
(function (PluginType) {
    PluginType[PluginType["System"] = 0] = "System";
    PluginType[PluginType["User"] = 1] = "User";
})(PluginType || (exports.PluginType = PluginType = {}));
function rawContributes(manifest) {
    return (0, utils_1.isObject)(manifest.contributes) ? manifest.contributes : {};
}
//# sourceMappingURL=manifest-types.js.map