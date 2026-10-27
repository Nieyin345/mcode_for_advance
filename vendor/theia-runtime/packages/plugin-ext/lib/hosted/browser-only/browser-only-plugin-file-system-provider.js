"use strict";
// *****************************************************************************
// Copyright (C) 2026 Robert Jandow
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
exports.BrowserOnlyPluginFileServiceContribution = exports.BrowserOnlyPluginFileSystemProvider = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const files_1 = require("@theia/filesystem/lib/common/files");
const constants_1 = require("@theia/plugin-utils/lib/common/constants");
const plugin_model_1 = require("@theia/plugin-utils/lib/common/plugin-model");
/**
 * Reads the plugin assets the build dropped under `PLUGINS_BASE_PATH`. With a backend those come
 * off its disk via `file:`; browser-only has to fetch them over HTTP.
 *
 * Read-only, and only for what goes through the `FileService`: color themes, icon themes, icon
 * fonts.
 */
let BrowserOnlyPluginFileSystemProvider = class BrowserOnlyPluginFileSystemProvider {
    constructor() {
        this.capabilities = 2048 /* FileSystemProviderCapabilities.Readonly */ | 2 /* FileSystemProviderCapabilities.FileReadWrite */ | 1024 /* FileSystemProviderCapabilities.PathCaseSensitive */;
        this.onDidChangeCapabilities = core_1.Event.None;
        this.onFileWatchError = core_1.Event.None;
        this.onDidChangeFileEmitter = new core_1.Emitter();
        this.onDidChangeFile = this.onDidChangeFileEmitter.event;
    }
    watch(resource, opts) {
        // baked into the build, nothing to watch
        return core_1.Disposable.NULL;
    }
    async stat(resource) {
        const response = await this.fetch(resource, 'HEAD');
        const length = Number(response.headers.get('content-length'));
        const modified = Date.parse(response.headers.get('last-modified') ?? '');
        // Build output, so created and modified are the same. Falling back to 0 rather than
        // `Date.now()` keeps it stable - callers cache on `mtime`.
        const mtime = Number.isNaN(modified) ? 0 : modified;
        return {
            type: files_1.FileType.File,
            permissions: files_1.FilePermission.Readonly,
            mtime,
            ctime: mtime,
            size: Number.isNaN(length) ? 0 : length
        };
    }
    async readFile(resource) {
        const response = await this.fetch(resource, 'GET');
        return new Uint8Array(await response.arrayBuffer());
    }
    /**
     * Maps the URI back to the path the build actually wrote, built through `Endpoint` so this
     * still works when the application is deployed under a sub-path. `URI.path` is decoded, so it
     * has to be re-encoded - otherwise a `#` or `?` in an asset name would be read as a fragment or
     * query.
     */
    toUrl(resource) {
        return new browser_1.Endpoint({ path: `${constants_1.PLUGINS_BASE_PATH}${(0, plugin_model_1.encodePluginAssetPath)(resource.path.toString())}` }).getRestUrl().toString();
    }
    async fetch(resource, method) {
        if (resource.scheme !== constants_1.PLUGINS_SCHEME) {
            throw (0, files_1.createFileSystemProviderError)(`Not a plugin asset: '${resource.toString()}'`, files_1.FileSystemProviderErrorCode.FileNotFound);
        }
        let response;
        try {
            response = await fetch(this.toUrl(resource), { method });
        }
        catch (error) {
            throw (0, files_1.createFileSystemProviderError)(`Could not read '${resource.toString()}': ${error.message}`, files_1.FileSystemProviderErrorCode.Unavailable);
        }
        if (!response.ok) {
            // A static server 404s for directories too, but nothing asks us for one.
            const code = response.status === 404 ? files_1.FileSystemProviderErrorCode.FileNotFound : files_1.FileSystemProviderErrorCode.Unknown;
            throw (0, files_1.createFileSystemProviderError)(`Could not read '${resource.toString()}': ${response.status} ${response.statusText}`, code);
        }
        return response;
    }
    readdir(resource) {
        throw (0, files_1.createFileSystemProviderError)('Plugin assets cannot be listed.', files_1.FileSystemProviderErrorCode.FileNotADirectory);
    }
    mkdir(resource) {
        throw (0, files_1.createFileSystemProviderError)('Plugin assets are read-only.', files_1.FileSystemProviderErrorCode.NoPermissions);
    }
    delete(resource, opts) {
        throw (0, files_1.createFileSystemProviderError)('Plugin assets are read-only.', files_1.FileSystemProviderErrorCode.NoPermissions);
    }
    rename(from, to, opts) {
        throw (0, files_1.createFileSystemProviderError)('Plugin assets are read-only.', files_1.FileSystemProviderErrorCode.NoPermissions);
    }
    writeFile(resource, content, opts) {
        throw (0, files_1.createFileSystemProviderError)('Plugin assets are read-only.', files_1.FileSystemProviderErrorCode.NoPermissions);
    }
};
exports.BrowserOnlyPluginFileSystemProvider = BrowserOnlyPluginFileSystemProvider;
exports.BrowserOnlyPluginFileSystemProvider = BrowserOnlyPluginFileSystemProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserOnlyPluginFileSystemProvider);
let BrowserOnlyPluginFileServiceContribution = class BrowserOnlyPluginFileServiceContribution {
    registerFileSystemProviders(service) {
        service.registerProvider(constants_1.PLUGINS_SCHEME, this.provider);
    }
};
exports.BrowserOnlyPluginFileServiceContribution = BrowserOnlyPluginFileServiceContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(BrowserOnlyPluginFileSystemProvider),
    tslib_1.__metadata("design:type", BrowserOnlyPluginFileSystemProvider)
], BrowserOnlyPluginFileServiceContribution.prototype, "provider", void 0);
exports.BrowserOnlyPluginFileServiceContribution = BrowserOnlyPluginFileServiceContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserOnlyPluginFileServiceContribution);
//# sourceMappingURL=browser-only-plugin-file-system-provider.js.map