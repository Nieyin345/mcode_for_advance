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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
// `FileService` transitively imports browser modules that touch `document` at load time.
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const core_1 = require("@theia/core");
const uri_1 = require("@theia/core/lib/common/uri");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
const inversify_1 = require("@theia/core/shared/inversify");
const env_variables_1 = require("@theia/core/lib/common/env-variables");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const common_1 = require("@theia/workspace/lib/common");
const browser_only_plugin_paths_service_1 = require("./browser-only-plugin-paths-service");
disableJSDOM();
/* eslint-disable @typescript-eslint/no-explicit-any */
/** The directories of the browser local file system, enough of it for the path service. */
class FakeFileService {
    constructor() {
        this.directories = new Set();
        /** Lets tests assert that a cached path didn't go through {@link createFolder} again. */
        this.createFolderCallCount = 0;
    }
    async createFolder(uri) {
        this.createFolderCallCount++;
        for (let current = uri; !current.path.isRoot; current = current.parent) {
            this.directories.add(current.path.toString());
        }
    }
    async fsPath(uri) {
        return uri.path.toString();
    }
    async resolve(uri) {
        const parent = uri.path.toString();
        const children = [...this.directories]
            .filter(directory => new uri_1.default(directory).parent.path.toString() === parent)
            .map(directory => ({ isDirectory: true, resource: new uri_1.default(directory) }));
        return { isDirectory: true, resource: uri, children };
    }
    async delete(uri) {
        const prefix = `${uri.path.toString()}/`;
        for (const directory of [...this.directories]) {
            if (directory === uri.path.toString() || directory.startsWith(prefix)) {
                this.directories.delete(directory);
            }
        }
    }
}
describe('BrowserOnlyPluginPathsService', () => {
    let fileService;
    let service;
    function createService() {
        const container = new inversify_1.Container();
        container.bind(browser_only_plugin_paths_service_1.BrowserOnlyPluginPathsService).toSelf().inSingletonScope();
        container.bind(core_1.ILogger).to(mock_logger_1.MockLogger);
        container.bind(file_service_1.FileService).toConstantValue(fileService);
        container.bind(common_1.WorkspaceFileService).toSelf().inSingletonScope();
        container.bind(common_1.UntitledWorkspaceService).toSelf().inSingletonScope();
        container.bind(env_variables_1.EnvVariablesServer).toConstantValue({
            getConfigDirUri: async () => 'file:///.theia'
        });
        return container.get(browser_only_plugin_paths_service_1.BrowserOnlyPluginPathsService);
    }
    /** A fake session folder name for the `session`th day of December 2025, e.g. `20251203T000000`. */
    function sessionFolderName(session) {
        const day = String(session).padStart(2, '0');
        return `202512${day}T000000`;
    }
    function sessionFolderUri(session) {
        return new uri_1.default(`file:///.theia/logs/${sessionFolderName(session)}/host`);
    }
    beforeEach(() => {
        fileService = new FakeFileService();
        service = createService();
    });
    describe('host log path', () => {
        it('creates a session log folder', async () => {
            const logPath = await service.getHostLogPath();
            (0, chai_1.expect)(logPath).to.match(/^\/\.theia\/logs\/\d{8}T\d{6}\/host$/);
            (0, chai_1.expect)(fileService.directories).to.include(logPath);
        });
        it('resolves the log path only once', async () => {
            (0, chai_1.expect)(await service.getHostLogPath()).to.equal(await service.getHostLogPath());
        });
        it('keeps the ten most recent session folders, the one of this session among them', async () => {
            for (let session = 1; session <= 12; session++) {
                await fileService.createFolder(sessionFolderUri(session));
            }
            const logPath = await service.getHostLogPath();
            const sessions = sessionFolders();
            (0, chai_1.expect)(sessions).to.have.lengthOf(10);
            (0, chai_1.expect)(logPath).to.contain(sessions.find(session => !session.startsWith('/.theia/logs/202512')));
            // the three oldest gave way to the folder of this session
            (0, chai_1.expect)(sessions).to.not.include(`/.theia/logs/${sessionFolderName(1)}`);
            (0, chai_1.expect)(sessions).to.not.include(`/.theia/logs/${sessionFolderName(3)}`);
            (0, chai_1.expect)(sessions).to.include(`/.theia/logs/${sessionFolderName(4)}`);
            (0, chai_1.expect)(sessions).to.include(`/.theia/logs/${sessionFolderName(12)}`);
        });
        it('never cleans up a folder that is not a session folder', async () => {
            for (let session = 1; session <= 12; session++) {
                await fileService.createFolder(sessionFolderUri(session));
            }
            await fileService.createFolder(new uri_1.default('file:///.theia/logs/not-a-session'));
            await service.getHostLogPath();
            // getHostLogPath() doesn't wait for the cleanup, so give it a tick to finish
            await new Promise(resolve => setImmediate(resolve));
            (0, chai_1.expect)(fileService.directories).to.include('/.theia/logs/not-a-session');
        });
        function sessionFolders() {
            return [...fileService.directories].filter(directory => /^\/\.theia\/logs\/[^/]+$/.test(directory)).sort();
        }
    });
    describe('host storage path', () => {
        it('has nowhere to store while no workspace is open', async () => {
            (0, chai_1.expect)(await service.getHostStoragePath(undefined, [])).to.be.undefined;
        });
        it('gives every workspace a storage folder of its own', async () => {
            const one = await service.getHostStoragePath('file:///one', []);
            const other = await service.getHostStoragePath('file:///other', []);
            (0, chai_1.expect)(one).to.match(/^\/\.theia\/workspace-storage\/.+$/);
            (0, chai_1.expect)(one).to.not.equal(other);
            (0, chai_1.expect)(fileService.directories).to.include(one);
        });
        it('gives a workspace the same storage folder in every session', async () => {
            (0, chai_1.expect)(await service.getHostStoragePath('file:///one', [])).to.equal(await service.getHostStoragePath('file:///one', []));
        });
        it('keys the storage of an untitled workspace on its roots, which outlive its name', async () => {
            const roots = ['file:///a', 'file:///b'];
            const one = await service.getHostStoragePath('file:///.theia/workspaces/Untitled-1.theia-workspace', roots);
            // the same roots under the name the next session gives the untitled workspace
            const next = await service.getHostStoragePath('file:///.theia/workspaces/Untitled-2.theia-workspace', [...roots].reverse());
            (0, chai_1.expect)(one).to.equal(next);
        });
        it('resolves the storage path only once per workspace', async () => {
            await service.getHostStoragePath('file:///one', []);
            const callsAfterFirst = fileService.createFolderCallCount;
            await service.getHostStoragePath('file:///one', []);
            (0, chai_1.expect)(fileService.createFolderCallCount).to.equal(callsAfterFirst);
        });
        it('resolves a new storage path when the roots of an untitled workspace change', async () => {
            const workspaceUri = 'file:///.theia/workspaces/Untitled-1.theia-workspace';
            const first = await service.getHostStoragePath(workspaceUri, ['file:///a']);
            const callsAfterFirst = fileService.createFolderCallCount;
            const second = await service.getHostStoragePath(workspaceUri, ['file:///a', 'file:///b']);
            (0, chai_1.expect)(second).to.not.equal(first);
            (0, chai_1.expect)(fileService.createFolderCallCount).to.be.greaterThan(callsAfterFirst);
        });
    });
});
//# sourceMappingURL=browser-only-plugin-paths-service.spec.js.map