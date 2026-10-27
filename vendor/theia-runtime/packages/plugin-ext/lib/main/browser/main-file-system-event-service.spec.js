"use strict";
// *****************************************************************************
// Copyright (C) 2026 Safi Seid-Ahmad, K2view and others.
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
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const assert = require("assert");
const core_1 = require("@theia/core");
const disposable_1 = require("@theia/core/lib/common/disposable");
const main_file_system_event_service_1 = require("./main-file-system-event-service");
disableJSDOM();
/* eslint-disable @typescript-eslint/no-explicit-any */
// A language server (e.g. `redhat.java` / JDT-LS) registers a watcher rooted at the PARENT of the
// workspace folder - `RelativePattern(parentDir, folderName)` - purely to detect deletion of the
// workspace folder itself. The pattern has no globstar, so `ensureWatching` sends it as a
// NON-recursive `$watch` on `parentDir`. Theia's backend ignores the `recursive` flag and always
// watches recursively, so this turns into a recursive crawl of every sibling subtree under the
// parent - thousands of inodes the workspace does not own - which can exhaust the OS file-watch
// budget. `files.watcherExclude` cannot bound it because the root is outside the workspace.
//
// These tests pin the fix: a non-recursive watch rooted at a strict ancestor of a workspace root is
// not registered, while watches on/inside the workspace and explicit recursive requests are
// untouched.
describe('MainFileSystemEventService ancestor-of-workspace watch handling', () => {
    function componentsFor(path) {
        return { scheme: 'file', authority: '', path, query: '', fragment: '' };
    }
    function createService(rootUris, watchCalls) {
        const fileService = {
            onDidFilesChange: () => disposable_1.Disposable.NULL,
            onDidRunUserOperation: () => disposable_1.Disposable.NULL,
            addFileOperationParticipant: () => disposable_1.Disposable.NULL,
            watch: (resource) => {
                watchCalls.push(resource);
                return disposable_1.Disposable.NULL;
            }
        };
        const workspaceService = { tryGetRoots: () => rootUris.map(uri => ({ resource: new core_1.URI(uri) })) };
        const rpc = { getProxy: () => ({}) };
        return new main_file_system_event_service_1.MainFileSystemEventService(rpc, {}, fileService, workspaceService);
    }
    it('skips a non-recursive watch rooted at a strict ancestor of a workspace root', () => {
        const watchCalls = [];
        const service = createService(['file:///projects/my-app'], watchCalls);
        service.$watch(1, componentsFor('/projects'), { recursive: false, excludes: [] });
        assert.strictEqual(watchCalls.length, 0, 'ancestor-of-workspace watch must not be registered');
    });
    it('still registers a non-recursive watch on the workspace root itself', () => {
        const watchCalls = [];
        const service = createService(['file:///projects/my-app'], watchCalls);
        service.$watch(1, componentsFor('/projects/my-app'), { recursive: false, excludes: [] });
        assert.strictEqual(watchCalls.length, 1);
    });
    it('still registers a non-recursive watch on an outer root that is itself the parent of another root', () => {
        const watchCalls = [];
        // Multi-root workspace where `/projects` is a root AND the parent of the `/projects/my-app` root.
        // The outer root is explicitly opened by the user, so its watch must not be dropped as an
        // "ancestor of the workspace".
        const service = createService(['file:///projects', 'file:///projects/my-app'], watchCalls);
        service.$watch(1, componentsFor('/projects'), { recursive: false, excludes: [] });
        assert.strictEqual(watchCalls.length, 1, 'a folder that is itself a workspace root must be watched, even if it is an ancestor of another root');
    });
    it('still registers a non-recursive watch inside the workspace', () => {
        const watchCalls = [];
        const service = createService(['file:///projects/my-app'], watchCalls);
        service.$watch(1, componentsFor('/projects/my-app/src'), { recursive: false, excludes: [] });
        assert.strictEqual(watchCalls.length, 1);
    });
    it('does not skip an explicit recursive watch on an ancestor (honored as requested)', () => {
        const watchCalls = [];
        const service = createService(['file:///projects/my-app'], watchCalls);
        service.$watch(1, componentsFor('/projects'), { recursive: true, excludes: [] });
        assert.strictEqual(watchCalls.length, 1);
    });
    it('frees the session for a skipped watch so $unwatch and re-watch do not throw', () => {
        const watchCalls = [];
        const service = createService(['file:///projects/my-app'], watchCalls);
        service.$watch(1, componentsFor('/projects'), { recursive: false, excludes: [] });
        service.$unwatch(1);
        // Re-using the same session id must not throw "already a watch request".
        service.$watch(1, componentsFor('/projects'), { recursive: false, excludes: [] });
        assert.strictEqual(watchCalls.length, 0);
    });
});
//# sourceMappingURL=main-file-system-event-service.spec.js.map