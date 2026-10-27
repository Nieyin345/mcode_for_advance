"use strict";
// *****************************************************************************
// Copyright (C) 2026 Matthew Farrow and others.
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
const local_directory_plugin_deployer_resolver_1 = require("./local-directory-plugin-deployer-resolver");
describe('LocalDirectoryPluginDeployerResolver', () => {
    let localPath;
    let deployed;
    beforeEach(() => {
        localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theia-local-dir-'));
        deployed = new Map();
    });
    afterEach(() => {
        fs.rmSync(localPath, { recursive: true, force: true });
    });
    function createContext() {
        return {
            getOriginId: () => `${local_directory_plugin_deployer_resolver_1.LocalDirectoryPluginDeployerResolver.LOCAL_DIR}:${localPath}`,
            addPlugin: (pluginId, pluginPath) => {
                deployed.set(pluginId, pluginPath);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        };
    }
    it('should skip files that are not plugins', async () => {
        fs.mkdirSync(path.join(localPath, 'my.plugin'));
        fs.writeFileSync(path.join(localPath, 'my-other.plugin.vsix'), '');
        fs.writeFileSync(path.join(localPath, '.DS_Store'), '');
        fs.writeFileSync(path.join(localPath, '._my.plugin'), '');
        fs.writeFileSync(path.join(localPath, 'Thumbs.db'), '');
        fs.writeFileSync(path.join(localPath, 'desktop.ini'), '');
        await new local_directory_plugin_deployer_resolver_1.LocalDirectoryPluginDeployerResolver().resolve(createContext());
        (0, chai_1.expect)([...deployed.keys()].sort()).to.deep.equal(['my-other.plugin.vsix', 'my.plugin']);
        (0, chai_1.expect)(deployed.get('my.plugin')).to.equal(path.resolve(localPath, 'my.plugin'));
    });
});
//# sourceMappingURL=local-directory-plugin-deployer-resolver.spec.js.map