"use strict";
// *****************************************************************************
// Copyright (C) 2025 STMicroelectronics and others.
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
exports.SettingServiceImpl = exports.SettingService = void 0;
const tslib_1 = require("tslib");
const fs_1 = require("fs");
const inversify_1 = require("inversify");
const common_1 = require("../common");
const env_variables_1 = require("../common/env-variables");
const promise_util_1 = require("../common/promise-util");
exports.SettingService = Symbol('SettingService');
let SettingServiceImpl = class SettingServiceImpl {
    constructor() {
        this.ready = new promise_util_1.Deferred();
        this.values = {};
    }
    init() {
        const asyncInit = async () => {
            const settingsFileUri = await this.getSettingsFileUri();
            const path = settingsFileUri.path.fsPath();
            try {
                const contents = await fs_1.promises.readFile(path, 'utf8');
                this.values = JSON.parse(contents);
            }
            catch (e) {
                if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
                    this.logger.info(`Settings file not found at '${path}'. Falling back to defaults.`);
                }
                else {
                    this.logger.warn(`Failed to read settings file at '${path}'. Falling back to defaults.`, e);
                }
            }
            finally {
                this.ready.resolve();
            }
        };
        asyncInit();
    }
    async set(key, value) {
        await this.ready.promise;
        this.values[key] = value;
        await this.writeFile();
    }
    async writeFile() {
        const settingsFileUri = await this.getSettingsFileUri();
        const path = settingsFileUri.path.fsPath();
        const values = JSON.stringify(this.values);
        await fs_1.promises.writeFile(path, values);
    }
    async get(key) {
        await this.ready.promise;
        return this.values[key];
    }
    async getConfigDirUri() {
        const uri = await this.envVarServer.getConfigDirUri();
        return new common_1.URI(uri);
    }
    async getSettingsFileUri() {
        const configDir = await this.getConfigDirUri();
        return configDir.resolve('backend-settings.json');
    }
};
exports.SettingServiceImpl = SettingServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ILogger),
    (0, inversify_1.named)('core:SettingServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], SettingServiceImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(env_variables_1.EnvVariablesServer),
    tslib_1.__metadata("design:type", Object)
], SettingServiceImpl.prototype, "envVarServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], SettingServiceImpl.prototype, "init", null);
exports.SettingServiceImpl = SettingServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], SettingServiceImpl);
//# sourceMappingURL=setting-service.js.map