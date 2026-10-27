"use strict";
// *****************************************************************************
// Copyright (C) 2025 and others.
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
const fs_1 = require("fs");
const inversify_1 = require("inversify");
const sinon = require("sinon");
const env_variables_1 = require("../common/env-variables");
const logger_1 = require("../common/logger");
const mock_logger_1 = require("../common/test/mock-logger");
const uri_1 = require("../common/uri");
const setting_service_1 = require("./setting-service");
describe('SettingServiceImpl', () => {
    const mockConfigDirUri = new uri_1.URI('mock');
    const setup = () => {
        const container = new inversify_1.Container({ defaultScope: 'Singleton' });
        container.bind(setting_service_1.SettingServiceImpl).toSelf();
        container.bind(mock_logger_1.MockLogger).toSelf();
        container.bind(logger_1.ILogger).toService(mock_logger_1.MockLogger);
        container.bind(env_variables_1.EnvVariablesServer).toConstantValue({
            getConfigDirUri: () => Promise.resolve(mockConfigDirUri.toString()),
        });
        return container;
    };
    afterEach(() => {
        sinon.restore();
    });
    it('should initialize and read settings file', async () => {
        const container = setup();
        const settingService = container.get(setting_service_1.SettingServiceImpl);
        const mockLogger = container.get(mock_logger_1.MockLogger);
        const readFileStub = sinon.stub(fs_1.promises, 'readFile').resolves(JSON.stringify({ key: 'value' }));
        const infoSpy = sinon.spy(mockLogger, 'info');
        const warnSpy = sinon.spy(mockLogger, 'warn');
        const actual = await settingService.get('key');
        (0, chai_1.expect)(actual).to.be.equal('value');
        (0, chai_1.expect)(readFileStub.calledWith(mockConfigDirUri.resolve('backend-settings.json').path.fsPath())).to.be.true;
        (0, chai_1.expect)(infoSpy.callCount).to.be.equal(0);
        (0, chai_1.expect)(warnSpy.callCount).to.be.equal(0);
    });
    it('should fallback to default and log info when errors with ENOENT', async () => {
        const container = setup();
        const settingService = container.get(setting_service_1.SettingServiceImpl);
        const mockLogger = container.get(mock_logger_1.MockLogger);
        const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        sinon.stub(fs_1.promises, 'readFile').rejects(enoent);
        const infoSpy = sinon.spy(mockLogger, 'info');
        const warnSpy = sinon.spy(mockLogger, 'warn');
        const actual = await settingService.get('key');
        (0, chai_1.expect)(actual).to.be.undefined;
        (0, chai_1.expect)(infoSpy.callCount).to.be.equal(1);
        (0, chai_1.expect)(infoSpy.firstCall.args[0]).to.include('Falling back to defaults');
        (0, chai_1.expect)(warnSpy.callCount).to.be.equal(0);
    });
    it('should fallback to default and log warn when errors', async () => {
        const container = setup();
        const settingService = container.get(setting_service_1.SettingServiceImpl);
        const mockLogger = container.get(mock_logger_1.MockLogger);
        const enoent = Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
        sinon.stub(fs_1.promises, 'readFile').rejects(enoent);
        const infoSpy = sinon.spy(mockLogger, 'info');
        const warnSpy = sinon.spy(mockLogger, 'warn');
        const actual = await settingService.get('key');
        (0, chai_1.expect)(actual).to.be.undefined;
        (0, chai_1.expect)(infoSpy.callCount).to.be.equal(0);
        (0, chai_1.expect)(warnSpy.callCount).to.be.equal(1);
        (0, chai_1.expect)(warnSpy.firstCall.args[0]).to.include('Falling back to defaults');
    });
});
//# sourceMappingURL=setting-service.spec.js.map