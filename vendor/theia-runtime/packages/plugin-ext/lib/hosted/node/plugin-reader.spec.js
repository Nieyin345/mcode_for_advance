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
const chai_1 = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const plugin_reader_1 = require("./plugin-reader");
class TestHostedPluginReader extends plugin_reader_1.HostedPluginReader {
    resolve(localPath, filePath) {
        return this.resolveFile(localPath, filePath);
    }
}
describe('HostedPluginReader#resolveFile', () => {
    let pluginDir;
    let nearSiblingFile;
    let farSiblingFile;
    const reader = new TestHostedPluginReader();
    before(() => {
        // Layout:
        //   <root>/far-sibling.txt        (reachable via `../../far-sibling.txt`)
        //   <root>/wrapper/sibling.txt    (reachable via `../sibling.txt`)
        //   <root>/wrapper/plugin/        (pluginDir)
        //     ├── main.js
        //     └── media/icon.png
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theia-plugin-reader-'));
        const wrapper = path.join(root, 'wrapper');
        pluginDir = path.join(wrapper, 'plugin');
        fs.mkdirSync(pluginDir, { recursive: true });
        fs.writeFileSync(path.join(pluginDir, 'main.js'), 'console.log("ok");');
        fs.mkdirSync(path.join(pluginDir, 'media'));
        fs.writeFileSync(path.join(pluginDir, 'media', 'icon.png'), 'png');
        nearSiblingFile = path.join(wrapper, 'sibling.txt');
        fs.writeFileSync(nearSiblingFile, 'near');
        farSiblingFile = path.join(root, 'far-sibling.txt');
        fs.writeFileSync(farSiblingFile, 'far');
    });
    it('serves a file inside the plugin directory', async () => {
        (0, chai_1.expect)(await reader.resolve(pluginDir, 'main.js')).to.equal(path.join(pluginDir, 'main.js'));
        (0, chai_1.expect)(await reader.resolve(pluginDir, 'media/icon.png')).to.equal(path.join(pluginDir, 'media', 'icon.png'));
    });
    it('resolves extensionless references with the .js fallback', async () => {
        (0, chai_1.expect)(await reader.resolve(pluginDir, 'main')).to.equal(path.join(pluginDir, 'main.js'));
    });
    it('returns undefined for a relative path pointing outside the plugin directory', async () => {
        (0, chai_1.expect)(await reader.resolve(pluginDir, '../sibling.txt')).to.be.undefined;
    });
    it('returns undefined for a relative path composed of parent-directory segments', async () => {
        (0, chai_1.expect)(await reader.resolve(pluginDir, '../../far-sibling.txt')).to.be.undefined;
    });
    it('returns undefined for an absolute path outside the plugin directory', async () => {
        (0, chai_1.expect)(await reader.resolve(pluginDir, nearSiblingFile)).to.be.undefined;
    });
    it('returns undefined for a missing file inside the plugin directory', async () => {
        (0, chai_1.expect)(await reader.resolve(pluginDir, 'does-not-exist.js')).to.be.undefined;
    });
});
//# sourceMappingURL=plugin-reader.spec.js.map