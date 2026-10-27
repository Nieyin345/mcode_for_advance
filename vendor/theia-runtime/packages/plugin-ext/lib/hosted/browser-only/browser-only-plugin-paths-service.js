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
exports.BrowserOnlyPluginPathsService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const uri_1 = require("@theia/core/lib/common/uri");
const uuid_1 = require("@theia/core/lib/common/uuid");
const strings_1 = require("@theia/core/lib/common/strings");
const env_variables_1 = require("@theia/core/lib/common/env-variables");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const common_1 = require("@theia/workspace/lib/common");
const const_1 = require("../../main/common/paths/const");
/** Session folder name, e.g. `20181205T093828`, same format as the backend uses. */
const SESSION_TIMESTAMP_PATTERN = /^\d{8}T\d{6}$/;
/**
 * Resolves plugin log and storage locations for a browser-only application, under the config
 * directory, which lives on the same (browser-local) file system as the workspace.
 */
let BrowserOnlyPluginPathsService = class BrowserOnlyPluginPathsService {
    constructor() {
        /**
         * Resolving re-hashes the workspace id and hits {@link FileService.createFolder}, and the plugin
         * server asks for this on every workspace storage read/write. The roots are part of the key
         * because an untitled workspace's id is derived from them.
         */
        this.hostStoragePaths = new Map();
    }
    getHostLogPath() {
        // cached: unlike the backend, where each call creates a new session folder, here one tab
        // runs one session, and the plugin host may ask again on a later load cycle
        return this.hostLogPath ??= this.resolveHostLogPath();
    }
    async resolveHostLogPath() {
        const configDirUri = new uri_1.default(await this.envServer.getConfigDirUri());
        const logsDirUri = configDirUri.resolve(const_1.PluginPaths.PLUGINS_LOGS_DIR);
        const hostLogPath = await this.ensureDirectory(logsDirUri.resolve(this.generateTimeFolderName()).resolve('host'));
        // as on the backend, we never wait for the cleanup
        this.cleanUpOldLogs(logsDirUri).catch(error => this.logger.error('Failed to clean up old plugin log folders:', error));
        return hostLogPath;
    }
    async getHostStoragePath(workspaceUri, rootUris) {
        if (!workspaceUri) {
            // no workspace, no place to store workspace state - same as the backend
            return undefined;
        }
        // '\n' cannot appear in a URI, so it is safe as a separator between the workspace URI and its roots
        const cacheKey = `${workspaceUri}\n${[...rootUris].sort().join('\n')}`;
        let hostStoragePath = this.hostStoragePaths.get(cacheKey);
        if (!hostStoragePath) {
            hostStoragePath = this.resolveHostStoragePath(workspaceUri, rootUris);
            this.hostStoragePaths.set(cacheKey, hostStoragePath);
            // a transient failure (e.g. a flaky file system call) shouldn't poison the cache forever
            hostStoragePath.catch(() => this.hostStoragePaths.delete(cacheKey));
        }
        return hostStoragePath;
    }
    async resolveHostStoragePath(workspaceUri, rootUris) {
        const configDirUri = new uri_1.default(await this.envServer.getConfigDirUri());
        const workspaceId = await this.buildWorkspaceId(configDirUri, workspaceUri, rootUris);
        return this.ensureDirectory(configDirUri.resolve(const_1.PluginPaths.PLUGINS_WORKSPACE_STORAGE_DIR).resolve(workspaceId));
    }
    async buildWorkspaceId(configDirUri, workspaceUri, rootUris) {
        if (this.untitledWorkspaceService.isUntitledWorkspace(new uri_1.default(workspaceUri), configDirUri)) {
            // an untitled workspace is named anew in every session, so key its storage on the roots instead
            return (0, uuid_1.hashValue)([...rootUris].sort().join(','));
        }
        return (0, uuid_1.hashValue)(workspaceUri);
    }
    /**
     * Generate time folder name in format: YYYYMMDDTHHMMSS, for example: 20181205T093828
     */
    generateTimeFolderName() {
        const timeStamp = new Date().toISOString().replace(/[-:]|(\..*)/g, '');
        // Helps ensure our timestamp generation logic is "valid".
        // Changes to the timestamp structure may break old logs deletion logic.
        if (!SESSION_TIMESTAMP_PATTERN.test(timeStamp)) {
            this.logger.error(`Generated log folder name: "${timeStamp}" does not match expected pattern: ${SESSION_TIMESTAMP_PATTERN}`);
        }
        return timeStamp;
    }
    /**
     * Keeps only the most recent {@link PluginPaths.DEFAULT_PLUGIN_MAX_SESSION_LOGS_FOLDERS}
     * session folders under `logsDirUri`, so reloading doesn't fill up browser storage.
     */
    async cleanUpOldLogs(logsDirUri) {
        const logsDir = await this.fileService.resolve(logsDirUri);
        const sessionDirs = (logsDir.children ?? [])
            // we never clean a folder that is not a Theia logs session folder, even if it
            // does appear under `logsDirUri`
            .filter(child => child.isDirectory && SESSION_TIMESTAMP_PATTERN.test(child.resource.path.base))
            .map(child => child.resource)
            // newest first, so the oldest ones get cut off. Ordinal comparison, not
            // localeCompare - the format is fixed ASCII, and locale-aware sorting could order
            // it differently depending on the user's locale
            .sort((one, other) => (0, strings_1.compare)(other.path.base, one.path.base));
        const oldSessionDirs = sessionDirs.slice(const_1.PluginPaths.DEFAULT_PLUGIN_MAX_SESSION_LOGS_FOLDERS);
        await Promise.all(oldSessionDirs.map(uri => this.fileService.delete(uri, { fromUserGesture: false, recursive: true })));
    }
    /**
     * Creates `uri` as a directory (fine if it already exists) and returns its path. Plugins get
     * the path rather than the URI, e.g. as `ExtensionContext.storagePath`.
     */
    async ensureDirectory(uri) {
        await this.fileService.createFolder(uri, { fromUserGesture: false });
        return this.fileService.fsPath(uri);
    }
};
exports.BrowserOnlyPluginPathsService = BrowserOnlyPluginPathsService;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext:BrowserOnlyPluginPathsService'),
    tslib_1.__metadata("design:type", Object)
], BrowserOnlyPluginPathsService.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(env_variables_1.EnvVariablesServer),
    tslib_1.__metadata("design:type", Object)
], BrowserOnlyPluginPathsService.prototype, "envServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], BrowserOnlyPluginPathsService.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.UntitledWorkspaceService),
    tslib_1.__metadata("design:type", common_1.UntitledWorkspaceService)
], BrowserOnlyPluginPathsService.prototype, "untitledWorkspaceService", void 0);
exports.BrowserOnlyPluginPathsService = BrowserOnlyPluginPathsService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserOnlyPluginPathsService);
//# sourceMappingURL=browser-only-plugin-paths-service.js.map