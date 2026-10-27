"use strict";
/********************************************************************************
 * Copyright (C) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
 ********************************************************************************/
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceMetadataStorageServiceImpl = exports.WorkspaceMetadataStorageService = exports.WorkspaceMetadataStoreFactory = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const env_variables_1 = require("@theia/core/lib/common/env-variables");
const logger_1 = require("@theia/core/lib/common/logger");
const uri_1 = require("@theia/core/lib/common/uri");
const uuid_1 = require("@theia/core/lib/common/uuid");
const buffer_1 = require("@theia/core/lib/common/buffer");
const workspace_service_1 = require("../workspace-service");
exports.WorkspaceMetadataStoreFactory = Symbol('WorkspaceMetadataStoreFactory');
/**
 * Service for managing workspace-specific metadata storage.
 * Provides isolated storage directories for different features within a workspace.
 *
 * This is different to the `WorkspaceStorageService` in that it is an unlimited free-form
 * storage area _in the filesystem_ and not in the browser's local storage.
 */
exports.WorkspaceMetadataStorageService = Symbol('WorkspaceMetadataStorageService');
let WorkspaceMetadataStorageServiceImpl = class WorkspaceMetadataStorageServiceImpl {
    constructor() {
        /**
         * Registry of created stores by their mangled keys
         */
        this.stores = new Map();
    }
    async getOrCreateStore(key) {
        const mangledKey = this.mangleKey(key);
        const existingStore = this.stores.get(mangledKey);
        if (existingStore) {
            this.logger.debug(`Returning existing metadata store for key '${key}'`, {
                mangledKey,
                location: existingStore.location.toString()
            });
            return existingStore;
        }
        return this.doCreateStore(key, mangledKey);
    }
    async doCreateStore(key, mangledKey) {
        const workspaceRoot = this.getFirstWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('Cannot create metadata store: no workspace is currently open');
        }
        const workspaceUuid = await this.getOrCreateWorkspaceUUID(workspaceRoot);
        const storeLocation = await this.getStoreLocation(workspaceUuid, mangledKey);
        const store = this.storeFactory();
        store.initialize(mangledKey, storeLocation, async () => this.resolveStoreLocation(mangledKey), () => this.stores.delete(mangledKey));
        this.stores.set(mangledKey, store);
        this.logger.debug(`Created metadata store for key '${key}'`, {
            mangledKey,
            location: storeLocation.toString()
        });
        return store;
    }
    /**
     * Mangles a key to make it safe for use as a directory name.
     * Replaces all characters except alphanumerics, hyphens, and underscores with hyphens.
     */
    mangleKey(key) {
        return key.replace(/[^a-zA-Z0-9-_]/g, '-');
    }
    getFirstWorkspaceRoot() {
        const roots = this.workspaceService.tryGetRoots();
        return roots.length > 0 ? roots[0].resource : undefined;
    }
    /**
     * Gets or creates a UUID for the given workspace root.
     * UUIDs are stored in an index file and reused if the same workspace is opened again.
     */
    async getOrCreateWorkspaceUUID(workspaceRoot) {
        const index = await this.loadIndex();
        const workspacePath = workspaceRoot.path.toString();
        if (index[workspacePath]) {
            return index[workspacePath];
        }
        const newUuid = (0, uuid_1.generateUuid)();
        index[workspacePath] = newUuid;
        await this.saveIndex(index);
        this.logger.debug('Generated new UUID for workspace', {
            workspacePath,
            uuid: newUuid
        });
        return newUuid;
    }
    async loadIndex() {
        const indexFileUri = await this.getIndexFile();
        try {
            const exists = await this.fileService.exists(indexFileUri);
            if (!exists) {
                return {};
            }
            const content = await this.fileService.readFile(indexFileUri);
            return JSON.parse(content.value.toString());
        }
        catch (error) {
            this.logger.warn('Failed to load workspace metadata index, using empty index', error);
            return {};
        }
    }
    async saveIndex(index) {
        const indexFileUri = await this.getIndexFile();
        try {
            // Ensure metadata root exists
            const metadataRootUri = await this.getMetadataRoot();
            await this.fileService.createFolder(metadataRootUri);
            // Write index file
            const content = JSON.stringify(index, undefined, 2);
            await this.fileService.writeFile(indexFileUri, buffer_1.BinaryBuffer.fromString(content));
        }
        catch (error) {
            this.logger.error('Failed to save workspace metadata index', error);
            throw error;
        }
    }
    async getMetadataRoot() {
        if (!this.metadataRoot) {
            const configDirUri = await this.envVariableServer.getConfigDirUri();
            this.metadataRoot = new uri_1.URI(configDirUri).resolve('workspace-metadata');
        }
        return this.metadataRoot;
    }
    async getIndexFile() {
        if (!this.indexFile) {
            const metadataRoot = await this.getMetadataRoot();
            this.indexFile = metadataRoot.resolve('index.json');
        }
        return this.indexFile;
    }
    /**
     * Gets the location for a store given a workspace UUID and mangled key.
     */
    async getStoreLocation(workspaceUuid, mangledKey) {
        const metadataRoot = await this.getMetadataRoot();
        return metadataRoot.resolve(workspaceUuid).resolve(mangledKey);
    }
    /**
     * Resolves the current store location for a given mangled key.
     * Used when workspace changes to get the new location.
     */
    async resolveStoreLocation(mangledKey) {
        const workspaceRoot = this.getFirstWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace is currently open');
        }
        const workspaceUuid = await this.getOrCreateWorkspaceUUID(workspaceRoot);
        return this.getStoreLocation(workspaceUuid, mangledKey);
    }
};
exports.WorkspaceMetadataStorageServiceImpl = WorkspaceMetadataStorageServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], WorkspaceMetadataStorageServiceImpl.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_service_1.WorkspaceService),
    tslib_1.__metadata("design:type", workspace_service_1.WorkspaceService)
], WorkspaceMetadataStorageServiceImpl.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(env_variables_1.EnvVariablesServer),
    tslib_1.__metadata("design:type", Object)
], WorkspaceMetadataStorageServiceImpl.prototype, "envVariableServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_1.ILogger),
    (0, inversify_1.named)('workspace:WorkspaceMetadataStorageServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], WorkspaceMetadataStorageServiceImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.WorkspaceMetadataStoreFactory),
    tslib_1.__metadata("design:type", Function)
], WorkspaceMetadataStorageServiceImpl.prototype, "storeFactory", void 0);
exports.WorkspaceMetadataStorageServiceImpl = WorkspaceMetadataStorageServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WorkspaceMetadataStorageServiceImpl);
//# sourceMappingURL=workspace-metadata-storage-service.js.map