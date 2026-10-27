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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HostedPluginReader = void 0;
const tslib_1 = require("tslib");
const path = require("path");
const escape_html = require("escape-html");
const promises_1 = require("fs/promises");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const plugin_protocol_1 = require("../../common/plugin-protocol");
const metadata_scanner_1 = require("./metadata-scanner");
const plugin_manifest_1 = require("@theia/plugin-utils/lib/node/plugin-manifest");
const constants_1 = require("@theia/plugin-utils/lib/common/constants");
let HostedPluginReader = class HostedPluginReader {
    constructor() {
        /**
         * Map between a plugin id and its local storage
         */
        this.pluginsIdsFiles = new Map();
    }
    configure(app) {
        app.get(`/${constants_1.PLUGINS_BASE_PATH}/:pluginId/:path(*)`, async (req, res) => {
            const pluginId = req.params.pluginId;
            const filePath = req.params.path;
            const localPath = this.pluginsIdsFiles.get(pluginId);
            if (localPath) {
                const resolvedFile = await this.resolveFile(localPath, filePath);
                if (!resolvedFile) {
                    res.status(404).send(`No such file found in '${escape_html(pluginId)}' plugin.`);
                    return;
                }
                res.sendFile(resolvedFile, e => {
                    if (!e) {
                        // the file was found and successfully transferred
                        return;
                    }
                    this.logger.error(`Could not transfer '${filePath}' file from '${pluginId}'`, e);
                    if (res.headersSent) {
                        // the request was already closed
                        return;
                    }
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    if (e['code'] === 'ENOENT') {
                        res.status(404).send(`No such file found in '${escape_html(pluginId)}' plugin.`);
                    }
                    else {
                        res.status(500).send(`Failed to transfer a file from '${escape_html(pluginId)}' plugin.`);
                    }
                });
            }
            else {
                await this.handleMissingResource(req, res);
            }
        });
    }
    /**
     * Resolves `filePath` under `localPath`, with fallback to `.js`, `.cjs` and `.mjs`
     * extensions. Returns `undefined` if the resolved path is not under `localPath`
     * or if no candidate exists on disk.
     *
     * The extension fallback handles cases where plugins reference modules without
     * extensions, which is common in Node.js/CommonJS environments.
     */
    async resolveFile(localPath, filePath) {
        const absolutePath = path.resolve(localPath, filePath);
        // `path.relative` yields a path starting with '..' (or an absolute path on
        // Windows when the drive differs) when `absolutePath` is not under `localPath`.
        const relativePath = path.relative(localPath, absolutePath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return undefined;
        }
        const candidates = [absolutePath];
        const pathExtension = path.extname(absolutePath).toLowerCase();
        if (!pathExtension) {
            candidates.push(absolutePath + '.js');
            candidates.push(absolutePath + '.cjs');
            candidates.push(absolutePath + '.mjs');
        }
        for (const candidate of candidates) {
            try {
                const stats = await (0, promises_1.stat)(candidate);
                if (stats.isFile()) {
                    return candidate;
                }
            }
            catch {
                // File doesn't exist or is inaccessible - try next candidate
                // Actual 404 errors are handled by the caller
            }
        }
        return undefined;
    }
    async handleMissingResource(req, res) {
        const pluginId = req.params.pluginId;
        res.status(404).send(`The plugin with id '${escape_html(pluginId)}' does not exist.`);
    }
    /**
     * @throws never
     */
    async getPluginMetadata(pluginPath) {
        try {
            const manifest = await this.readPackage(pluginPath);
            return manifest && this.readMetadata(manifest);
        }
        catch (e) {
            this.logger.error(`Failed to load plugin metadata from "${pluginPath}"`, e);
            return undefined;
        }
    }
    async readPackage(pluginPath) {
        if (!pluginPath) {
            return undefined;
        }
        const resolvedPluginPath = await (0, promises_1.realpath)(pluginPath);
        const manifest = await (0, plugin_manifest_1.loadManifest)(resolvedPluginPath);
        if (!manifest) {
            return undefined;
        }
        manifest.packagePath = resolvedPluginPath;
        return manifest;
    }
    async readMetadata(plugin) {
        const pluginMetadata = await this.scanner.getPluginMetadata(plugin);
        if (pluginMetadata.model.entryPoint.backend) {
            pluginMetadata.model.entryPoint.backend = path.resolve(plugin.packagePath, pluginMetadata.model.entryPoint.backend);
        }
        if (pluginMetadata.model.entryPoint.headless) {
            pluginMetadata.model.entryPoint.headless = path.resolve(plugin.packagePath, pluginMetadata.model.entryPoint.headless);
        }
        if (pluginMetadata) {
            // Add post processor
            if (this.metadataProcessors) {
                this.metadataProcessors.forEach(metadataProcessor => {
                    metadataProcessor.process(pluginMetadata);
                });
            }
            this.pluginsIdsFiles.set((0, plugin_protocol_1.getPluginId)(pluginMetadata.model), plugin.packagePath);
        }
        return pluginMetadata;
    }
    async readContribution(plugin) {
        const scanner = this.scanner.getScanner(plugin);
        return scanner.getContribution(plugin);
    }
    readDependencies(plugin) {
        const scanner = this.scanner.getScanner(plugin);
        return scanner.getDependencies(plugin);
    }
};
exports.HostedPluginReader = HostedPluginReader;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext:HostedPluginReader'),
    tslib_1.__metadata("design:type", Object)
], HostedPluginReader.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(metadata_scanner_1.MetadataScanner),
    tslib_1.__metadata("design:type", metadata_scanner_1.MetadataScanner)
], HostedPluginReader.prototype, "scanner", void 0);
tslib_1.__decorate([
    (0, inversify_1.optional)(),
    (0, inversify_1.multiInject)(plugin_protocol_1.MetadataProcessor),
    tslib_1.__metadata("design:type", Array)
], HostedPluginReader.prototype, "metadataProcessors", void 0);
exports.HostedPluginReader = HostedPluginReader = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], HostedPluginReader);
//# sourceMappingURL=plugin-reader.js.map