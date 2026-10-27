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
exports.loadManifest = loadManifest;
const path = require("path");
const fs = require("fs-extra");
const plugin_manifest_1 = require("../common/plugin-manifest");
async function loadManifest(pluginPath, options) {
    const manifest = await fs.readJson(path.join(pluginPath, 'package.json'));
    return (0, plugin_manifest_1.prepareLoadedManifest)(manifest, options);
}
//# sourceMappingURL=plugin-manifest.js.map