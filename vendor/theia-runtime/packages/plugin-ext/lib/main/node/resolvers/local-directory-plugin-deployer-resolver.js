"use strict";
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
var LocalDirectoryPluginDeployerResolver_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalDirectoryPluginDeployerResolver = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const fs = require("@theia/core/shared/fs-extra");
const path = require("path");
const local_plugin_deployer_resolver_1 = require("./local-plugin-deployer-resolver");
/**
 * Lower-case names of files a file manager leaves behind, which are never plugins.
 */
const IGNORED_FILE_NAMES = new Set(['thumbs.db', 'desktop.ini']);
let LocalDirectoryPluginDeployerResolver = class LocalDirectoryPluginDeployerResolver extends local_plugin_deployer_resolver_1.LocalPluginDeployerResolver {
    static { LocalDirectoryPluginDeployerResolver_1 = this; }
    static { this.LOCAL_DIR = 'local-dir'; }
    get supportedScheme() {
        return LocalDirectoryPluginDeployerResolver_1.LOCAL_DIR;
    }
    async resolveFromLocalPath(pluginResolverContext, localPath) {
        const files = await fs.readdir(localPath);
        files.filter(file => !this.isIgnored(file)).forEach(file => pluginResolverContext.addPlugin(file, path.resolve(localPath, file)));
    }
    /**
     * Whether a directory entry should be skipped instead of being deployed as a plugin.
     * Covers dotfiles such as the macOS `.DS_Store` and the Windows `Thumbs.db` and `desktop.ini`.
     */
    isIgnored(file) {
        return file.startsWith('.') || IGNORED_FILE_NAMES.has(file.toLowerCase());
    }
};
exports.LocalDirectoryPluginDeployerResolver = LocalDirectoryPluginDeployerResolver;
exports.LocalDirectoryPluginDeployerResolver = LocalDirectoryPluginDeployerResolver = LocalDirectoryPluginDeployerResolver_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], LocalDirectoryPluginDeployerResolver);
//# sourceMappingURL=local-directory-plugin-deployer-resolver.js.map