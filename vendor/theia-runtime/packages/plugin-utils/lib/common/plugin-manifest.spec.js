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
const chai_1 = require("chai");
const constants_1 = require("./constants");
const plugin_manifest_1 = require("./plugin-manifest");
const plugin_manifest_2 = require("../node/plugin-manifest");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
describe('plugin-manifest', () => {
    describe('stripVscodeBuiltinNamePrefix', () => {
        it('removes the vscode builtin prefix from package names', () => {
            const manifest = {
                name: `${constants_1.VSCODE_BUILTIN_NAME_PREFIX}json`
            };
            (0, plugin_manifest_1.stripVscodeBuiltinNamePrefix)(manifest);
            (0, chai_1.expect)(manifest.name).to.equal('json');
        });
    });
    describe('prepareLoadedManifest', () => {
        it('defaults publisher and derives activation events', () => {
            const manifest = (0, plugin_manifest_1.prepareLoadedManifest)({
                name: 'sample',
                version: '1.0.0',
                packagePath: '/tmp/sample',
                contributes: {
                    commands: [{ command: 'sample.run', title: 'Run' }]
                }
            });
            (0, chai_1.expect)(manifest.publisher).to.equal(constants_1.UNPUBLISHED);
            (0, chai_1.expect)(manifest.activationEvents).to.include('onCommand:sample.run');
        });
        it('can skip activation event derivation', () => {
            const manifest = (0, plugin_manifest_1.prepareLoadedManifest)({
                name: 'sample',
                version: '1.0.0',
                packagePath: '/tmp/sample',
                contributes: {
                    commands: [{ command: 'sample.run', title: 'Run' }]
                }
            }, { updateActivationEvents: false });
            (0, chai_1.expect)(manifest.activationEvents).to.equal(undefined);
        });
    });
    describe('loadManifest', () => {
        let pluginRoot;
        beforeEach(async () => {
            pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-manifest-'));
        });
        afterEach(async () => {
            await fs.remove(pluginRoot);
        });
        it('reads and prepares package.json from disk', async () => {
            await fs.writeJson(path.join(pluginRoot, 'package.json'), {
                name: `${constants_1.VSCODE_BUILTIN_NAME_PREFIX}json`,
                version: '1.0.0',
                contributes: {
                    commands: [{ command: 'json.format', title: 'Format JSON' }]
                }
            });
            const manifest = await (0, plugin_manifest_2.loadManifest)(pluginRoot);
            (0, chai_1.expect)(manifest.name).to.equal('json');
            (0, chai_1.expect)(manifest.publisher).to.equal(constants_1.UNPUBLISHED);
            (0, chai_1.expect)(manifest.activationEvents).to.include('onCommand:json.format');
        });
    });
});
//# sourceMappingURL=plugin-manifest.spec.js.map