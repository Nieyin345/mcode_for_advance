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
/* eslint-disable @typescript-eslint/no-explicit-any */
const chai_1 = require("chai");
const path = require("path");
const plugin_vscode_init_1 = require("./plugin-vscode-init");
const PLUGIN_A_FOLDER = path.join(path.sep, 'p', 'sample-namespace.plugin-esm');
const PLUGIN_B_FOLDER = path.join(path.sep, 'p', 'sample-namespace.plugin-esm-mjs');
const pluginA = { pluginFolder: PLUGIN_A_FOLDER };
const pluginB = { pluginFolder: PLUGIN_B_FOLDER };
const plugins = [pluginA, pluginB];
describe('findPlugin', () => {
    it('matches the plugin whose folder directly contains the file', () => {
        const file = path.join(PLUGIN_A_FOLDER, 'extension.js');
        (0, chai_1.expect)((0, plugin_vscode_init_1.findPlugin)(plugins, file)).to.equal(pluginA);
    });
    it('matches a nested file inside the plugin folder', () => {
        const file = path.join(PLUGIN_B_FOLDER, 'node_modules', 'dep', 'index.js');
        (0, chai_1.expect)((0, plugin_vscode_init_1.findPlugin)(plugins, file)).to.equal(pluginB);
    });
    it('does not mismatch when one plugin folder name is a prefix of another', () => {
        const file = path.join(PLUGIN_B_FOLDER, 'extension.mjs');
        (0, chai_1.expect)((0, plugin_vscode_init_1.findPlugin)(plugins, file)).to.equal(pluginB);
    });
    it('returns undefined for a path outside any plugin folder', () => {
        (0, chai_1.expect)((0, plugin_vscode_init_1.findPlugin)(plugins, path.join(path.sep, 'p', 'some-other', 'file.js'))).to.be.undefined;
    });
    it('returns undefined for an empty plugin list', () => {
        (0, chai_1.expect)((0, plugin_vscode_init_1.findPlugin)([], path.join(PLUGIN_A_FOLDER, 'extension.js'))).to.be.undefined;
    });
});
//# sourceMappingURL=plugin-vscode-init.spec.js.map