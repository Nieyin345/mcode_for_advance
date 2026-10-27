"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
exports.ModelSnapshotStoreImpl = exports.MODEL_SNAPSHOT_DIRECTORY = exports.ModelSnapshotStore = void 0;
const tslib_1 = require("tslib");
const fs_1 = require("fs");
const path = require("path");
const core_1 = require("@theia/core");
const env_variables_1 = require("@theia/core/lib/common/env-variables");
const uri_1 = require("@theia/core/lib/common/uri");
const inversify_1 = require("@theia/core/shared/inversify");
exports.ModelSnapshotStore = Symbol('ModelSnapshotStore');
/** Directory below the configuration directory that holds the snapshots, one file per provider. */
exports.MODEL_SNAPSHOT_DIRECTORY = 'model-snapshots';
/** Stores one JSON file per provider in {@link MODEL_SNAPSHOT_DIRECTORY} below the configuration directory. */
let ModelSnapshotStoreImpl = class ModelSnapshotStoreImpl {
    async read(fileName) {
        try {
            const content = await fs_1.promises.readFile(await this.snapshotPath(fileName), 'utf8');
            const models = JSON.parse(content).models;
            return Array.isArray(models) ? models.filter(model => this.isDiscoveredModel(model)) : undefined;
        }
        catch {
            // A missing or unreadable snapshot is an expected state, not an error: discovery falls back to a live fetch.
            return undefined;
        }
    }
    async write(fileName, models) {
        try {
            const file = await this.snapshotPath(fileName);
            await fs_1.promises.mkdir(path.dirname(file), { recursive: true });
            await fs_1.promises.writeFile(file, JSON.stringify({ models }, undefined, 2));
        }
        catch (error) {
            this.logger.warn(`Failed to persist the model snapshot '${fileName}':`, error instanceof Error ? error.message : error);
        }
    }
    isDiscoveredModel(candidate) {
        return (0, core_1.isObject)(candidate) && typeof candidate.id === 'string';
    }
    async snapshotPath(fileName) {
        const configDirUri = await this.envVariablesServer.getConfigDirUri();
        return new uri_1.default(configDirUri).resolve(exports.MODEL_SNAPSHOT_DIRECTORY).resolve(fileName).path.fsPath();
    }
};
exports.ModelSnapshotStoreImpl = ModelSnapshotStoreImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(env_variables_1.EnvVariablesServer),
    tslib_1.__metadata("design:type", Object)
], ModelSnapshotStoreImpl.prototype, "envVariablesServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:ModelSnapshotStoreImpl'),
    tslib_1.__metadata("design:type", Object)
], ModelSnapshotStoreImpl.prototype, "logger", void 0);
exports.ModelSnapshotStoreImpl = ModelSnapshotStoreImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ModelSnapshotStoreImpl);
//# sourceMappingURL=model-snapshot-store.js.map