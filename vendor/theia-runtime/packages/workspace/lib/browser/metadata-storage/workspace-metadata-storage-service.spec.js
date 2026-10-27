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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const inversify_1 = require("@theia/core/shared/inversify");
const chai_1 = require("chai");
const sinon = require("sinon");
const env_variables_1 = require("@theia/core/lib/common/env-variables");
const logger_1 = require("@theia/core/lib/common/logger");
const uri_1 = require("@theia/core/lib/common/uri");
const buffer_1 = require("@theia/core/lib/common/buffer");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const workspace_service_1 = require("../workspace-service");
const workspace_metadata_storage_service_1 = require("./workspace-metadata-storage-service");
const workspace_metadata_store_1 = require("./workspace-metadata-store");
const uuid = require("@theia/core/lib/common/uuid");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
disableJSDOM();
before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
after(() => disableJSDOM());
describe('WorkspaceMetadataStorageService', () => {
    let service;
    let fileService;
    let workspaceService;
    let envVariableServer;
    let logger;
    let container;
    let generateUuidStub;
    const configDir = '/home/user/.theia';
    const workspaceRootPath = '/home/user/my-workspace';
    const workspaceRootUri = new uri_1.URI(`file://${workspaceRootPath}`);
    beforeEach(() => {
        // Create container for DI
        container = new inversify_1.Container();
        // Create mocks
        fileService = {
            exists: sinon.stub(),
            readFile: sinon.stub(),
            writeFile: sinon.stub(),
            createFolder: sinon.stub(),
            delete: sinon.stub(),
        };
        // Create workspace service with stubs
        workspaceService = new workspace_service_1.WorkspaceService();
        sinon.stub(workspaceService, 'tryGetRoots').returns([{
                resource: workspaceRootUri,
                isDirectory: true
            }]);
        envVariableServer = {
            getConfigDirUri: sinon.stub().resolves(`file://${configDir}`)
        };
        logger = new mock_logger_1.MockLogger();
        // Bind to container
        container.bind(file_service_1.FileService).toConstantValue(fileService);
        container.bind(workspace_service_1.WorkspaceService).toConstantValue(workspaceService);
        container.bind(env_variables_1.EnvVariablesServer).toConstantValue(envVariableServer);
        container.bind(logger_1.ILogger).toConstantValue(logger);
        container.bind(workspace_metadata_store_1.WorkspaceMetadataStoreImpl).toSelf();
        container.bind(workspace_metadata_storage_service_1.WorkspaceMetadataStoreFactory).toFactory(ctx => () => ctx.container.get(workspace_metadata_store_1.WorkspaceMetadataStoreImpl));
        container.bind(workspace_metadata_storage_service_1.WorkspaceMetadataStorageServiceImpl).toSelf();
        service = container.get(workspace_metadata_storage_service_1.WorkspaceMetadataStorageServiceImpl);
        // Stub UUID generation
        generateUuidStub = sinon.stub(uuid, 'generateUuid');
        // Default file service behavior
        fileService.exists.resolves(false);
        fileService.createFolder.resolves({
            resource: new uri_1.URI('file:///dummy'),
            isFile: false,
            isDirectory: true,
            isSymbolicLink: false,
            mtime: Date.now(),
            ctime: Date.now(),
            etag: 'dummy',
            size: 0
        });
        fileService.writeFile.resolves({
            resource: new uri_1.URI('file:///dummy'),
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
            mtime: Date.now(),
            ctime: Date.now(),
            etag: 'dummy',
            size: 0
        });
    });
    afterEach(() => {
        sinon.restore();
    });
    describe('getOrCreateStore', () => {
        it('should create a new store with a unique key', async () => {
            const testUuid = 'test-uuid-1234';
            generateUuidStub.returns(testUuid);
            const store = await service.getOrCreateStore('my-feature');
            (0, chai_1.expect)(store).to.exist;
            (0, chai_1.expect)(store.key).to.equal('my-feature');
            (0, chai_1.expect)(store.location.toString()).to.equal(`file://${configDir}/workspace-metadata/${testUuid}/my-feature`);
        });
        it('should return existing store if key already exists', async () => {
            const testUuid = 'test-uuid-1234';
            generateUuidStub.returns(testUuid);
            const store1 = await service.getOrCreateStore('my-feature');
            const store2 = await service.getOrCreateStore('my-feature');
            (0, chai_1.expect)(store1).to.equal(store2);
        });
        it('should throw error if no workspace is open', async () => {
            workspaceService.tryGetRoots.returns([]);
            try {
                await service.getOrCreateStore('my-feature');
                chai_1.expect.fail('Should have thrown error for no workspace');
            }
            catch (error) {
                (0, chai_1.expect)(error.message).to.contain('no workspace is currently open');
            }
        });
        it('should mangle keys with special characters', async () => {
            const testUuid = 'test-uuid-1234';
            generateUuidStub.returns(testUuid);
            const store = await service.getOrCreateStore('my/feature.name');
            (0, chai_1.expect)(store.key).to.equal('my-feature-name');
            (0, chai_1.expect)(store.location.toString()).to.equal(`file://${configDir}/workspace-metadata/${testUuid}/my-feature-name`);
        });
        it('should generate and store UUID for new workspace', async () => {
            const testUuid = 'test-uuid-1234';
            generateUuidStub.returns(testUuid);
            await service.getOrCreateStore('my-feature');
            // Check that writeFile was called to save the index
            (0, chai_1.expect)(fileService.writeFile.calledOnce).to.be.true;
            const writeCall = fileService.writeFile.getCall(0);
            const indexUri = writeCall.args[0];
            const content = writeCall.args[1].toString();
            (0, chai_1.expect)(indexUri.toString()).to.equal(`file://${configDir}/workspace-metadata/index.json`);
            const index = JSON.parse(content);
            (0, chai_1.expect)(index[workspaceRootPath]).to.equal(testUuid);
        });
        it('should reuse existing UUID for known workspace', async () => {
            const existingUuid = 'existing-uuid-5678';
            const indexContent = JSON.stringify({
                [workspaceRootPath]: existingUuid
            });
            fileService.exists.resolves(true);
            fileService.readFile.resolves({
                resource: new uri_1.URI(`file://${configDir}/workspace-metadata/index.json`),
                value: buffer_1.BinaryBuffer.fromString(indexContent)
            });
            const store = await service.getOrCreateStore('my-feature');
            (0, chai_1.expect)(store.location.toString()).to.equal(`file://${configDir}/workspace-metadata/${existingUuid}/my-feature`);
            // Should not write index again since UUID already existed
            (0, chai_1.expect)(fileService.writeFile.called).to.be.false;
        });
        it('should handle multiple stores with different keys', async () => {
            generateUuidStub.returns('test-uuid-1234');
            const store1 = await service.getOrCreateStore('feature-1');
            const store2 = await service.getOrCreateStore('feature-2');
            (0, chai_1.expect)(store1.key).to.equal('feature-1');
            (0, chai_1.expect)(store2.key).to.equal('feature-2');
            (0, chai_1.expect)(store1.location.toString()).to.not.equal(store2.location.toString());
        });
        it('should allow recreating store with same key after disposal', async () => {
            generateUuidStub.returns('test-uuid-1234');
            const store1 = await service.getOrCreateStore('my-feature');
            (0, chai_1.expect)(store1.key).to.equal('my-feature');
            store1.dispose();
            // Should not throw - the key should be available again
            const store2 = await service.getOrCreateStore('my-feature');
            (0, chai_1.expect)(store2.key).to.equal('my-feature');
            (0, chai_1.expect)(store2).to.not.equal(store1);
        });
    });
    describe('key mangling', () => {
        beforeEach(() => {
            generateUuidStub.returns('test-uuid');
        });
        it('should replace forward slashes with hyphens', async () => {
            const store = await service.getOrCreateStore('path/to/feature');
            (0, chai_1.expect)(store.key).to.equal('path-to-feature');
        });
        it('should replace dots with hyphens', async () => {
            const store = await service.getOrCreateStore('my.feature.name');
            (0, chai_1.expect)(store.key).to.equal('my-feature-name');
        });
        it('should replace spaces with hyphens', async () => {
            const store = await service.getOrCreateStore('my feature name');
            (0, chai_1.expect)(store.key).to.equal('my-feature-name');
        });
        it('should preserve alphanumeric characters, hyphens, and underscores', async () => {
            const store = await service.getOrCreateStore('My_Feature-123');
            (0, chai_1.expect)(store.key).to.equal('My_Feature-123');
        });
        it('should replace multiple special characters', async () => {
            const store = await service.getOrCreateStore('!@#$%^&*()');
            (0, chai_1.expect)(store.key).to.equal('----------');
        });
    });
    describe('index management', () => {
        it('should handle missing index file', async () => {
            generateUuidStub.returns('new-uuid');
            fileService.exists.resolves(false);
            const store = await service.getOrCreateStore('feature');
            (0, chai_1.expect)(store).to.exist;
            (0, chai_1.expect)(fileService.writeFile.calledOnce).to.be.true;
        });
        it('should handle corrupted index file', async () => {
            const warnSpy = sinon.spy(logger, 'warn');
            generateUuidStub.returns('new-uuid');
            fileService.exists.resolves(true);
            fileService.readFile.resolves({
                resource: new uri_1.URI(`file://${configDir}/workspace-metadata/index.json`),
                value: buffer_1.BinaryBuffer.fromString('{ invalid json')
            });
            const store = await service.getOrCreateStore('feature');
            (0, chai_1.expect)(store).to.exist;
            (0, chai_1.expect)(warnSpy.calledOnce).to.be.true;
        });
        it('should create metadata root directory when saving index', async () => {
            generateUuidStub.returns('test-uuid');
            await service.getOrCreateStore('feature');
            (0, chai_1.expect)(fileService.createFolder.calledOnce).to.be.true;
            const createCall = fileService.createFolder.getCall(0);
            const createdUri = createCall.args[0];
            (0, chai_1.expect)(createdUri.toString()).to.equal(`file://${configDir}/workspace-metadata`);
        });
    });
    describe('workspace changes', () => {
        it('should update store location when workspace root changes', async () => {
            const uuid1 = 'workspace-1-uuid';
            const uuid2 = 'workspace-2-uuid';
            let uuidCallCount = 0;
            generateUuidStub.callsFake(() => {
                uuidCallCount++;
                return uuidCallCount === 1 ? uuid1 : uuid2;
            });
            const store = await service.getOrCreateStore('feature');
            const initialLocation = store.location.toString();
            // Simulate workspace change
            const newWorkspaceRoot = new uri_1.URI('file:///home/user/other-workspace');
            workspaceService.tryGetRoots.returns([{
                    resource: newWorkspaceRoot,
                    isDirectory: true
                }]);
            // Track location changes
            let locationChanged = false;
            let newLocation;
            store.onDidChangeLocation(uri => {
                locationChanged = true;
                newLocation = uri;
            });
            // Trigger workspace change via the protected emitter
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            workspaceService['onWorkspaceChangeEmitter'].fire([]);
            // Wait for async updates
            await new Promise(resolve => setTimeout(resolve, 10));
            (0, chai_1.expect)(locationChanged).to.be.true;
            (0, chai_1.expect)(newLocation?.toString()).to.not.equal(initialLocation);
            (0, chai_1.expect)(newLocation?.toString()).to.contain(uuid2);
        });
    });
});
//# sourceMappingURL=workspace-metadata-storage-service.spec.js.map