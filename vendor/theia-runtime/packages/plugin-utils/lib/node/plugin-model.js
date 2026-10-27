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
exports.getPluginRootFileUrl = getPluginRootFileUrl;
const fs_1 = require("fs");
const plugin_model_1 = require("../common/plugin-model");
function getPluginRootFileUrl(manifest, names) {
    const nameSet = new Set(names.map(n => n.toLowerCase()));
    try {
        const dir = (0, fs_1.readdirSync)(manifest.packagePath, { withFileTypes: true });
        for (const dirent of dir) {
            if (dirent.isFile() && nameSet.has(dirent.name.toLowerCase())) {
                return (0, plugin_model_1.toPluginUrl)(manifest, dirent.name);
            }
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
//# sourceMappingURL=plugin-model.js.map