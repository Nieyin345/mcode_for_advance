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
exports.WorkspaceMetadataStoreImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const common_1 = require("@theia/core/lib/common");
const workspace_service_1 = require("../workspace-service");
/**
 * Implementation of WorkspaceMetadataStore.
 * @internal
 */
let WorkspaceMetadataStoreImpl = class WorkspaceMetadataStoreImpl {
    constructor() {
        this.toDispose = new common_1.DisposableCollection();
        this.onDidChangeLocationEmitter = new common_1.Emitter();
        this.onDidChangeLocation = this.onDidChangeLocationEmitter.event;
    }
    get location() {
        return this._location;
    }
    get key() {
        return this._key;
    }
    /**
     * Initializes the WorkspaceMetadataStore.
     * @param key The key identifying this store
     * @param initialLocation The initial location URI
     * @param locationProvider Function to resolve the current location based on workspace changes
     * @param onDispose Callback invoked when the store is disposed
     */
    initialize(key, initialLocation, locationProvider, onDispose) {
        this._key = key;
        this._location = initialLocation;
        this.locationProvider = locationProvider;
        this.onDisposeCallback = onDispose;
        this.currentWorkspaceRoot = this.getFirstWorkspaceRoot();
    }
    init() {
        this.toDispose.push(this.onDidChangeLocationEmitter);
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => this.handleWorkspaceChange()));
    }
    async handleWorkspaceChange() {
        const newWorkspaceRoot = this.getFirstWorkspaceRoot();
        // Check if the first workspace root actually changed
        if (this.currentWorkspaceRoot?.toString() !== newWorkspaceRoot?.toString()) {
            this.currentWorkspaceRoot = newWorkspaceRoot;
            try {
                const newLocation = await this.locationProvider();
                if (this._location.toString() !== newLocation.toString()) {
                    this._location = newLocation;
                    this.onDidChangeLocationEmitter.fire(newLocation);
                    this.logger.debug(`Metadata store location changed for key '${this._key}'`, {
                        newLocation: newLocation.toString()
                    });
                }
            }
            catch (error) {
                this.logger.error(`Failed to update location for metadata store '${this._key}'`, error);
            }
        }
    }
    getFirstWorkspaceRoot() {
        const roots = this.workspaceService.tryGetRoots();
        return roots.length > 0 ? roots[0].resource : undefined;
    }
    async ensureExists() {
        try {
            await this.fileService.createFolder(this._location);
            this.logger.debug(`Ensured metadata store exists for key '${this._key}'`, {
                location: this._location.toString()
            });
        }
        catch (error) {
            this.logger.error(`Failed to create metadata store directory for key '${this._key}'`, error);
            throw error;
        }
    }
    async delete() {
        try {
            const exists = await this.fileService.exists(this._location);
            if (exists) {
                await this.fileService.delete(this._location, { recursive: true, useTrash: false });
                this.logger.debug(`Deleted metadata store for key '${this._key}'`, {
                    location: this._location.toString()
                });
            }
        }
        catch (error) {
            this.logger.error(`Failed to delete metadata store directory for key '${this._key}'`, error);
            throw error;
        }
    }
    dispose() {
        this.toDispose.dispose();
        this.onDisposeCallback?.();
    }
};
exports.WorkspaceMetadataStoreImpl = WorkspaceMetadataStoreImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], WorkspaceMetadataStoreImpl.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_service_1.WorkspaceService),
    tslib_1.__metadata("design:type", workspace_service_1.WorkspaceService)
], WorkspaceMetadataStoreImpl.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ILogger),
    (0, inversify_1.named)('workspace:WorkspaceMetadataStoreImpl'),
    tslib_1.__metadata("design:type", Object)
], WorkspaceMetadataStoreImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], WorkspaceMetadataStoreImpl.prototype, "init", null);
exports.WorkspaceMetadataStoreImpl = WorkspaceMetadataStoreImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WorkspaceMetadataStoreImpl);
//# sourceMappingURL=workspace-metadata-store.js.map