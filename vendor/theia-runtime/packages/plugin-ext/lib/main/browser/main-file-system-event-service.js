"use strict";
// *****************************************************************************
// Copyright (C) 2020 TypeFox and others.
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
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// based on https://github.com/microsoft/vscode/blob/04c36be045a94fee58e5f8992d3e3fd980294a84/src/vs/workbench/api/browser/mainThreadFileSystemEventService.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.MainFileSystemEventService = void 0;
const plugin_api_rpc_1 = require("../../common/plugin-api-rpc");
const core_1 = require("@theia/core");
const disposable_1 = require("@theia/core/lib/common/disposable");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const browser_1 = require("@theia/workspace/lib/browser");
class MainFileSystemEventService {
    constructor(rpc, container, fileService = container.get(file_service_1.FileService), workspaceService = container.get(browser_1.WorkspaceService)) {
        this.fileService = fileService;
        this.workspaceService = workspaceService;
        this.toDispose = new disposable_1.DisposableCollection();
        this.watches = new Map();
        /** Ancestor-of-workspace roots already skipped, to avoid logging on every re-registration. */
        this.skippedWatchRoots = new Set();
        const proxy = rpc.getProxy(plugin_api_rpc_1.MAIN_RPC_CONTEXT.ExtHostFileSystemEventService);
        this.toDispose.push(fileService.onDidFilesChange(event => {
            // file system events - (changes the editor and others make)
            const events = {
                created: [],
                changed: [],
                deleted: []
            };
            for (const change of event.changes) {
                switch (change.type) {
                    case 1 /* FileChangeType.ADDED */:
                        events.created.push(change.resource['codeUri']);
                        break;
                    case 0 /* FileChangeType.UPDATED */:
                        events.changed.push(change.resource['codeUri']);
                        break;
                    case 2 /* FileChangeType.DELETED */:
                        events.deleted.push(change.resource['codeUri']);
                        break;
                }
            }
            proxy.$onFileEvent(events);
        }));
        // BEFORE file operation
        fileService.addFileOperationParticipant({
            participate: (target, source, operation, timeout, token) => proxy.$onWillRunFileOperation(operation, target['codeUri'], source?.['codeUri'], timeout, token)
        });
        // AFTER file operation
        this.toDispose.push(fileService.onDidRunUserOperation(e => proxy.$onDidRunFileOperation(e.operation, e.target['codeUri'], e.source?.['codeUri'])));
    }
    dispose() {
        this.toDispose.dispose();
    }
    $watch(session, resource, options) {
        if (this.watches.has(session)) {
            throw new Error(`There is already a watch request for the key ${session}`);
        }
        const uri = core_1.URI.fromComponents(resource);
        if (this.shouldSkipWatch(uri, options)) {
            // Register a no-op disposable so the session is tracked and `$unwatch` still works.
            this.watches.set(session, disposable_1.Disposable.NULL);
            return;
        }
        // Plugin/language-server watchers (`vscode.workspace.createFileSystemWatcher`) arrive here
        // with an empty `excludes` list; `FileService.watch` applies `files.watcherExclude` centrally
        // for all watchers, so they stay bounded without merging the excludes here.
        const watch = this.fileService.watch(uri, options);
        this.toDispose.push(watch);
        this.watches.set(session, watch);
    }
    /**
     * Whether a plugin-requested watch should not be registered at all.
     *
     * Theia's backend ignores the `recursive` flag and always watches recursively. A NON-recursive
     * watch rooted at a strict ancestor of a workspace root - e.g. a language server (such as
     * `redhat.java` / JDT-LS) watching the PARENT of the workspace folder via
     * `RelativePattern(parentDir, folderName)` purely to detect deletion of the folder itself -
     * would therefore be turned into a recursive crawl of every sibling subtree under that parent,
     * i.e. thousands of inodes the workspace does not own, which can exhaust the OS file-watch
     * budget. `files.watcherExclude` cannot bound it because the root is outside the workspace, so
     * the only effective mitigation is to not register the watch.
     *
     * Explicit recursive requests are honored as-is, and watches on or inside a workspace root are
     * left untouched.
     */
    shouldSkipWatch(uri, options) {
        if (options.recursive) {
            return false;
        }
        const roots = this.workspaceService.tryGetRoots();
        // A folder that is itself a workspace root must always be watched, even if it also happens to
        // be a (strict) ancestor of another root in a multi-root workspace where one root is nested
        // inside another. Only watches rooted strictly above every root are dropped.
        const isWorkspaceRoot = roots.some(root => uri.isEqual(root.resource));
        const isAncestorOfWorkspace = !isWorkspaceRoot && roots.some(root => uri.isEqualOrParent(root.resource));
        if (isAncestorOfWorkspace) {
            const key = uri.toString();
            if (!this.skippedWatchRoots.has(key)) {
                this.skippedWatchRoots.add(key);
                console.warn('[MainFileSystemEventService] skipping non-recursive watch rooted at an ancestor of the '
                    + `workspace (the backend would recursively crawl sibling trees): ${key}`);
            }
            return true;
        }
        return false;
    }
    $unwatch(session) {
        const watch = this.watches.get(session);
        if (watch) {
            watch.dispose();
            this.watches.delete(session);
        }
    }
}
exports.MainFileSystemEventService = MainFileSystemEventService;
//# sourceMappingURL=main-file-system-event-service.js.map