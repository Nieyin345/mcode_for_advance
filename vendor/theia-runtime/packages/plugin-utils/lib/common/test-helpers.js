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
exports.manifest = manifest;
exports.createNormalizeCtx = createNormalizeCtx;
const plugin_model_1 = require("./plugin-model");
function manifest(partial) {
    return {
        version: '1.0.0',
        publisher: 'acme',
        packagePath: '/tmp/plugin',
        displayName: 'Test Extension',
        ...partial
    };
}
function createNormalizeCtx(pluginOverrides, ctxOverrides) {
    const plugin = manifest({ name: 'test-ext', ...pluginOverrides });
    return {
        plugin,
        resolveUrl: relativePath => (0, plugin_model_1.toPluginUrl)(plugin, relativePath),
        resolveUri: (pck, relativePath) => (0, plugin_model_1.toPluginUrl)(pck, relativePath),
        onError: () => undefined,
        onWarn: () => undefined,
        ...ctxOverrides
    };
}
//# sourceMappingURL=test-helpers.js.map