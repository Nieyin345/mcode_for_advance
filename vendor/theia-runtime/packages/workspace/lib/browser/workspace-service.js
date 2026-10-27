"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
exports.WorkspaceData = exports.WorkspaceService = exports.WorkspaceHandlingContribution = exports.WorkspaceOpenHandlerContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const uri_1 = require("@theia/core/lib/common/uri");
const common_1 = require("../common");
const window_service_1 = require("@theia/core/lib/browser/window/window-service");
const window_1 = require("@theia/core/lib/common/window");
const browser_1 = require("@theia/core/lib/browser");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const env_variables_1 = require("@theia/core/lib/common/env-variables");
const core_1 = require("@theia/core");
const workspace_preferences_1 = require("../common/workspace-preferences");
const jsoncparser = require("jsonc-parser");
const Ajv = require("@theia/core/shared/ajv");
const files_1 = require("@theia/filesystem/lib/common/files");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const window_title_service_1 = require("@theia/core/lib/browser/window/window-title-service");
const common_2 = require("@theia/filesystem/lib/common");
const workspace_schema_updater_1 = require("./workspace-schema-updater");
const frontend_application_state_1 = require("@theia/core/lib/common/frontend-application-state");
const preferences_1 = require("@theia/core/lib/common/preferences");
exports.WorkspaceOpenHandlerContribution = Symbol('WorkspaceOpenHandlerContribution');
exports.WorkspaceHandlingContribution = Symbol('WorkspaceHandlingContribution');
/**
 * The workspace service.
 */
let WorkspaceService = class WorkspaceService {
    constructor() {
        this._roots = [];
        this.deferredRoots = new promise_util_1.Deferred();
        this._ready = new promise_util_1.Deferred();
        this.onWorkspaceChangeEmitter = new core_1.Emitter();
        this.onWorkspaceLocationChangedEmitter = new core_1.Emitter();
        this.toDisposeOnWorkspace = new core_1.DisposableCollection();
        this.rootWatchers = new Map();
    }
    get ready() {
        return this._ready.promise;
    }
    init() {
        this.doInit();
    }
    async doInit() {
        let wsUriString = await this.getDefaultWorkspaceUri();
        if (wsUriString) {
            const wsUri = new uri_1.default(wsUriString);
            if (wsUri.scheme !== 'file') {
                let handled = false;
                for (const handler of this.openHandlerContribution.getContributions()) {
                    if (await handler.canHandle(wsUri)) {
                        try {
                            // openWorkspace reloads the window on success, so if we
                            // reach the timeout the connection attempt is hanging.
                            await Promise.race([
                                handler.openWorkspace(wsUri),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 120000))
                            ]);
                            handled = true;
                        }
                        catch {
                            // Failed or timed out — fall through to local workspace
                        }
                        break;
                    }
                }
                if (handled) {
                    this._ready.resolve();
                    return;
                }
                // No handler could open this non-file URI, or it failed/timed out.
                // Fall back to the most recent local workspace.
                const recents = await this.server.getRecentWorkspaces();
                wsUriString = recents.find(r => new uri_1.default(r).scheme === 'file');
            }
        }
        let wsStat = await this.toFileStat(wsUriString);
        if (!wsStat && wsUriString) {
            // The URI (e.g. from the URL hash after a remote disconnect) points
            // to a path that doesn't exist locally. Fall back to the most recent
            // local workspace.
            const recents = await this.server.getRecentWorkspaces();
            const fallback = recents.find(r => new uri_1.default(r).scheme === 'file');
            if (fallback) {
                wsStat = await this.toFileStat(fallback);
            }
        }
        await this.setWorkspace(wsStat);
        this.fileService.onDidFilesChange(event => {
            if (this._workspace && this._workspace.isFile && event.contains(this._workspace.resource)) {
                this.updateWorkspace();
            }
        });
        this.fsPreferences.onPreferenceChanged(event => {
            if (event.preferenceName === 'files.watcherExclude') {
                this.refreshRootWatchers();
            }
        });
        this._ready.resolve();
    }
    /**
     * Resolves to the default workspace URI as string.
     *
     * The default implementation tries to extract the default workspace location
     * from the `window.location.hash`, then falls-back to the most recently
     * used workspace root from the server.
     *
     * It is not ensured that the resolved workspace URI is valid, it can point
     * to a non-existing location.
     */
    getDefaultWorkspaceUri() {
        return this.doGetDefaultWorkspaceUri();
    }
    async doGetDefaultWorkspaceUri() {
        // If an empty window is explicitly requested do not restore a previous workspace.
        // Note: `window.location.hash` includes leading "#" if non-empty.
        if (window.location.hash === `#${window_1.DEFAULT_WINDOW_HASH}`) {
            window.location.hash = '';
            return undefined;
        }
        // Prefer the workspace path specified as the URL fragment, if present.
        if (window.location.hash.length > 1) {
            // Remove the leading # and decode the URI.
            const wpPath = decodeURI(window.location.hash.substring(1));
            let workspaceUri;
            if (wpPath.startsWith('//')) {
                const unc = wpPath.slice(2);
                const firstSlash = unc.indexOf('/');
                const authority = firstSlash >= 0 ? unc.slice(0, firstSlash) : unc;
                const path = firstSlash >= 0 ? unc.slice(firstSlash) : '/';
                workspaceUri = new uri_1.default().withPath(path).withAuthority(authority).withScheme('file');
            }
            else {
                workspaceUri = new uri_1.default().withPath(wpPath).withScheme('file');
            }
            let workspaceStat;
            try {
                workspaceStat = await this.fileService.resolve(workspaceUri);
            }
            catch { }
            if (workspaceStat && !workspaceStat.isDirectory && !this.isWorkspaceFile(workspaceStat)) {
                this.messageService.error(core_1.nls.localize('theia/workspace/notWorkspaceFile', 'Not a valid workspace file: {0}', this.labelProvider.getLongName(workspaceUri)));
                return undefined;
            }
            return workspaceUri.toString();
        }
        else {
            // Else, ask the server for its suggested workspace (usually the one
            // specified on the CLI, or the most recent).
            return this.server.getMostRecentlyUsedWorkspace();
        }
    }
    /**
     * Set the URL fragment to the given workspace path.
     */
    setURLFragment(workspacePath) {
        window.location.hash = encodeURI(workspacePath);
    }
    getWorkspacePath(resource) {
        return resource.authority
            ? `//${resource.authority}${resource.path.toString()}`
            : resource.path.toString();
    }
    get roots() {
        return this.deferredRoots.promise;
    }
    tryGetRoots() {
        return this._roots;
    }
    get workspace() {
        return this._workspace;
    }
    get onWorkspaceChanged() {
        return this.onWorkspaceChangeEmitter.event;
    }
    get onWorkspaceLocationChanged() {
        return this.onWorkspaceLocationChangedEmitter.event;
    }
    async setWorkspace(workspaceStat) {
        if (this._workspace && workspaceStat &&
            this._workspace.resource === workspaceStat.resource &&
            this._workspace.mtime === workspaceStat.mtime &&
            this._workspace.etag === workspaceStat.etag &&
            this._workspace.size === workspaceStat.size) {
            return;
        }
        this.toDisposeOnWorkspace.dispose();
        this._workspace = workspaceStat;
        if (this._workspace) {
            const uri = this._workspace.resource;
            if (this._workspace.isFile) {
                this.toDisposeOnWorkspace.push(this.fileService.watch(uri));
                this.onWorkspaceLocationChangedEmitter.fire(this._workspace);
            }
            this.setURLFragment(this.getWorkspacePath(uri));
        }
        else {
            this.setURLFragment('');
        }
        this.updateTitle();
        if (!this.isRemoteSession()) {
            await this.server.setMostRecentlyUsedWorkspace(this._workspace ? this._workspace.resource.toString() : '');
        }
        await this.updateWorkspace();
    }
    async updateWorkspace() {
        await this.updateRoots();
        this.watchRoots();
    }
    async updateRoots() {
        const newRoots = await this.computeRoots();
        let rootsChanged = false;
        if (newRoots.length !== this._roots.length || newRoots.length === 0) {
            rootsChanged = true;
        }
        else {
            for (const newRoot of newRoots) {
                if (!this._roots.some(r => r.resource.toString() === newRoot.resource.toString())) {
                    rootsChanged = true;
                    break;
                }
            }
        }
        if (rootsChanged) {
            this._roots = newRoots;
            this.deferredRoots.resolve(this._roots); // in order to resolve first
            this.deferredRoots = new promise_util_1.Deferred();
            this.deferredRoots.resolve(this._roots);
            this.onWorkspaceChangeEmitter.fire(this._roots);
        }
    }
    async computeRoots() {
        const roots = [];
        if (this._workspace) {
            if (this._workspace.isDirectory) {
                return [this._workspace];
            }
            const workspaceData = await this.getWorkspaceDataFromFile();
            if (workspaceData) {
                for (const { path } of workspaceData.folders) {
                    const valid = await this.toValidRoot(path);
                    if (valid) {
                        roots.push(valid);
                    }
                    else {
                        roots.push(files_1.FileStat.dir(path));
                    }
                }
            }
        }
        return roots;
    }
    async getWorkspaceDataFromFile() {
        if (this._workspace && await this.fileService.exists(this._workspace.resource)) {
            if (this._workspace.isDirectory) {
                return {
                    folders: [{ path: this._workspace.resource.toString() }]
                };
            }
            else if (this.isWorkspaceFile(this._workspace)) {
                const stat = await this.fileService.read(this._workspace.resource);
                const strippedContent = jsoncparser.stripComments(stat.value);
                const data = jsoncparser.parse(strippedContent);
                if (data && WorkspaceData.is(data)) {
                    return WorkspaceData.transformToAbsolute(data, stat);
                }
                this.logger.error(`Unable to retrieve workspace data from the file: '${this.labelProvider.getLongName(this._workspace)}'. Please check if the file is corrupted.`);
            }
            else {
                this.logger.warn(`Not a valid workspace file: ${this.labelProvider.getLongName(this._workspace)}`);
            }
        }
    }
    updateTitle() {
        let rootName;
        let rootPath;
        if (this._workspace) {
            const displayName = this._workspace.name;
            const fullName = this._workspace.resource.path.toString();
            if (this.isWorkspaceFile(this._workspace)) {
                if (this.isUntitledWorkspace(this._workspace.resource)) {
                    const untitled = core_1.nls.localizeByDefault('Untitled (Workspace)');
                    rootName = untitled;
                    rootPath = untitled;
                }
                else {
                    rootName = displayName.slice(0, displayName.lastIndexOf('.'));
                    rootPath = fullName.slice(0, fullName.lastIndexOf('.'));
                }
            }
            else {
                rootName = displayName;
                rootPath = fullName;
            }
        }
        this.windowTitleService.update({
            rootName,
            rootPath
        });
    }
    /**
     * On unload, we set our workspace root as the last recently used on the backend.
     *
     * In the browser, we use `onStop` (fire-and-forget) because `onWillStop` actions
     * are never executed during browser tab close and returning an `OnWillStopAction`
     * would trigger an unwanted "Leave site?" confirmation dialog.
     *
     * In Electron, we use `onWillStop` so the workspace is persisted before the window closes.
     */
    onStop() {
        if (!core_1.environment.electron.is()) {
            this.setMostRecentlyUsedWorkspace();
        }
    }
    onWillStop() {
        if (core_1.environment.electron.is() && this.workspace) {
            return {
                reason: 'Set workspace root as most recently used',
                action: async () => {
                    await this.setMostRecentlyUsedWorkspace();
                    return true;
                }
            };
        }
    }
    setMostRecentlyUsedWorkspace() {
        if (!this.isRemoteSession()) {
            this.server.setMostRecentlyUsedWorkspace(this._workspace ? this._workspace.resource.toString() : '');
        }
    }
    /**
     * Returns true if the current window is connected to a remote backend.
     * In remote sessions, we must not overwrite the local MRU with the remote
     * workspace's file URI, as the local MRU should retain the remote connection
     * URI (e.g. `devcontainer://...`) so the session can be restored on restart.
     *
     * Detection: the backend port is always in `?port=`. When connected to a
     * remote, the URL also has `?localPort=` (the original backend port).
     */
    isRemoteSession() {
        return new URLSearchParams(window.location.search).has('localPort');
    }
    async recentWorkspaces() {
        let recentWorkspaces = await this.server.getRecentWorkspaces();
        for (const handler of this.workspaceHandlingContribution.getContributions()) {
            if (handler.modifyRecentWorkspaces) {
                recentWorkspaces = await handler.modifyRecentWorkspaces(recentWorkspaces);
            }
        }
        return recentWorkspaces;
    }
    async removeRecentWorkspace(uri) {
        return this.server.removeRecentWorkspace(uri);
    }
    /**
     * Returns `true` if theia has an opened workspace or folder
     * @returns {boolean}
     */
    get opened() {
        return !!this._workspace;
    }
    /**
     * Returns `true` if a multiple-root workspace is currently open.
     * @returns {boolean}
     */
    get isMultiRootWorkspaceOpened() {
        return !!this.workspace && !this.workspace.isDirectory;
    }
    /**
     * Opens directory, or recreates a workspace from the file that `uri` points to.
     */
    open(uri, options) {
        this.doOpen(uri, options);
    }
    async doOpen(uri, options) {
        for (const handler of [...this.openHandlerContribution.getContributions(), this]) {
            if (await handler.canHandle(uri)) {
                handler.openWorkspace(uri, options);
                return;
            }
        }
        throw new Error(`Could not find a handler to open the workspace with uri ${uri.toString()}.`);
    }
    canHandle(uri) {
        return uri.scheme === 'file';
    }
    async openWorkspace(uri, options) {
        const stat = await this.toFileStat(uri);
        if (stat) {
            if (!stat.isDirectory && !this.isWorkspaceFile(stat)) {
                const message = core_1.nls.localize('theia/workspace/notWorkspaceFile', 'Not a valid workspace file: {0}', this.labelProvider.getLongName(uri));
                this.messageService.error(message);
                throw new Error(message);
            }
            // The same window has to be preserved too (instead of opening a new one), if the workspace root is not yet available and we are setting it for the first time.
            // Option passed as parameter has the highest priority (for api developers), then the preference, then the default.
            await this.roots;
            const { preserveWindow } = {
                preserveWindow: this.preferences['workspace.preserveWindow'] || !this.opened,
                ...options
            };
            this.openWindow(stat, Object.assign(options ?? {}, { preserveWindow }));
            return;
        }
        throw new Error('Invalid workspace root URI. Expected an existing directory or workspace file.');
    }
    /**
     * Adds root folder(s) to the workspace
     * @param uris URI or URIs of the root folder(s) to add
     */
    async addRoot(uris) {
        const toAdd = Array.isArray(uris) ? uris : [uris];
        await this.spliceRoots(this._roots.length, 0, ...toAdd);
    }
    /**
     * Removes root folder(s) from workspace.
     */
    async removeRoots(uris) {
        if (!this.opened) {
            throw new Error('Folder cannot be removed as there is no active folder in the current workspace.');
        }
        if (this._workspace) {
            const workspaceData = await this.getWorkspaceDataFromFile();
            this._workspace = await this.writeWorkspaceFile(this._workspace, WorkspaceData.buildWorkspaceData(this._roots.filter(root => uris.findIndex(u => u.toString() === root.resource.toString()) < 0), workspaceData));
            await this.updateWorkspace();
        }
    }
    async spliceRoots(start, deleteCount, ...rootsToAdd) {
        if (!this._workspace || this._workspace.isDirectory) {
            const untitledWorkspace = await this.getUntitledWorkspace();
            await this.save(untitledWorkspace);
            if (!this._workspace) {
                throw new Error('Could not create new untitled workspace');
            }
        }
        const dedup = new Set();
        const roots = this._roots.map(root => (dedup.add(root.resource.toString()), root.resource.toString()));
        const toAdd = [];
        for (const root of rootsToAdd) {
            const uri = root.toString();
            if (!dedup.has(uri)) {
                dedup.add(uri);
                toAdd.push(uri);
            }
        }
        const toRemove = roots.splice(start, deleteCount || 0, ...toAdd);
        if (!toRemove.length && !toAdd.length) {
            return [];
        }
        const currentData = await this.getWorkspaceDataFromFile();
        const newData = WorkspaceData.buildWorkspaceData(roots, currentData);
        await this.writeWorkspaceFile(this._workspace, newData);
        await this.updateWorkspace();
        return toRemove.map(root => new uri_1.default(root));
    }
    async getUntitledWorkspace() {
        const configDirURI = new uri_1.default(await this.envVariableServer.getConfigDirUri());
        return this.untitledWorkspaceService.getUntitledWorkspaceUri(configDirURI, uri => this.fileService.exists(uri).then(exists => !exists), () => this.messageService.warn(core_1.nls.localize('theia/workspace/untitled-cleanup', 'There appear to be many untitled workspace files. Please check {0} and remove any unused files.', configDirURI.resolve('workspaces').path.fsPath())));
    }
    async writeWorkspaceFile(workspaceFile, workspaceData) {
        if (workspaceFile) {
            const data = JSON.stringify(WorkspaceData.transformToRelative(workspaceData, workspaceFile));
            const edits = jsoncparser.format(data, undefined, { tabSize: 2, insertSpaces: true, eol: '' });
            const result = jsoncparser.applyEdits(data, edits);
            await this.fileService.write(workspaceFile.resource, result);
            return this.fileService.resolve(workspaceFile.resource);
        }
    }
    /**
     * Clears current workspace root.
     */
    async close() {
        if (await this.windowService.isSafeToShutDown(frontend_application_state_1.StopReason.Reload)) {
            this.windowService.setSafeToShutDown();
            this._workspace = undefined;
            this._roots.length = 0;
            if (!this.isRemoteSession()) {
                await this.server.setMostRecentlyUsedWorkspace('');
            }
            this.reloadWindow('');
        }
    }
    /**
     * returns a FileStat if the argument URI points to an existing directory. Otherwise, `undefined`.
     */
    async toValidRoot(uri) {
        const fileStat = await this.toFileStat(uri);
        if (fileStat && fileStat.isDirectory) {
            return fileStat;
        }
        return undefined;
    }
    /**
     * returns a FileStat if the argument URI points to a file or directory. Otherwise, `undefined`.
     */
    async toFileStat(uri) {
        if (!uri) {
            return undefined;
        }
        let uriStr = uri.toString();
        try {
            if (uriStr.endsWith('/')) {
                uriStr = uriStr.slice(0, -1);
            }
            const normalizedUri = new uri_1.default(uriStr).normalizePath();
            return await this.fileService.resolve(normalizedUri);
        }
        catch (error) {
            return undefined;
        }
    }
    openWindow(uri, options) {
        const workspacePath = this.getWorkspacePath(uri.resource);
        if (this.shouldPreserveWindow(options)) {
            this.reloadWindow(workspacePath, options);
        }
        else {
            try {
                this.openNewWindow(workspacePath, options);
            }
            catch (error) {
                // Fall back to reloading the current window in case the browser has blocked the new window
                this.logger.error(error.toString()).then(() => this.reloadWindow(workspacePath));
            }
        }
    }
    reloadWindow(workspacePath, options) {
        // Set the new workspace path as the URL fragment.
        this.setURLFragment(workspacePath);
        this.windowService.reload();
    }
    openNewWindow(workspacePath, options) {
        const url = new URL(window.location.href);
        url.hash = encodeURI(workspacePath);
        this.windowService.openNewWindow(url.toString());
    }
    shouldPreserveWindow(options) {
        return options !== undefined && !!options.preserveWindow;
    }
    /**
     * Return true if one of the paths in paths array is present in the workspace
     * NOTE: You should always explicitly use `/` as the separator between the path segments.
     */
    async containsSome(paths) {
        await this.roots;
        if (this.opened) {
            for (const root of this._roots) {
                const uri = root.resource;
                for (const path of paths) {
                    const fileUri = uri.resolve(path);
                    const exists = await this.fileService.exists(fileUri);
                    if (exists) {
                        return exists;
                    }
                }
            }
        }
        return false;
    }
    /**
     * `true` if the current workspace is configured using a configuration file.
     *
     * `false` if there is no workspace or the workspace is simply a folder.
     */
    get saved() {
        return !!this._workspace && !this._workspace.isDirectory;
    }
    /**
     * Save workspace data into a file
     * @param uri URI or FileStat of the workspace file
     */
    async save(uri) {
        const resource = uri instanceof uri_1.default ? uri : uri.resource;
        if (!await this.fileService.exists(resource)) {
            await this.fileService.create(resource);
        }
        const workspaceData = { folders: [], settings: {} };
        if (!this.saved) {
            for (const p of Object.keys(this.schemaService.getJSONSchema(preferences_1.PreferenceScope.Workspace).properties)) {
                // The goal is to ensure that workspace-scoped preferences are preserved in the new workspace.
                // Preferences valid in folder scope will take effect in their folders without being copied.
                if (this.schemaService.isValidInScope(p, preferences_1.PreferenceScope.Folder)) {
                    continue;
                }
                const preferences = this.preferenceImpl.inspect(p);
                if (preferences && preferences.workspaceValue) {
                    workspaceData.settings[p] = preferences.workspaceValue;
                }
            }
        }
        let stat = await this.toFileStat(resource);
        Object.assign(workspaceData, await this.getWorkspaceDataFromFile());
        stat = await this.writeWorkspaceFile(stat, WorkspaceData.buildWorkspaceData(this._roots, workspaceData));
        if (!this.isRemoteSession()) {
            await this.server.setMostRecentlyUsedWorkspace(resource.toString());
        }
        // If saving a workspace based on an untitled workspace, delete the old file.
        const toDelete = this.isUntitledWorkspace(this.workspace?.resource) && this.workspace.resource;
        await this.setWorkspace(stat);
        if (toDelete && stat && !toDelete.isEqual(stat.resource)) {
            await this.fileService.delete(toDelete).catch(() => { });
        }
        this.onWorkspaceLocationChangedEmitter.fire(stat);
    }
    async watchRoots() {
        const rootUris = new Set(this._roots.map(r => r.resource.toString()));
        for (const [uri, watcher] of this.rootWatchers.entries()) {
            if (!rootUris.has(uri)) {
                watcher.dispose();
            }
        }
        for (const root of this._roots) {
            this.watchRoot(root);
        }
    }
    async refreshRootWatchers() {
        for (const watcher of this.rootWatchers.values()) {
            watcher.dispose();
        }
        await this.watchRoots();
    }
    async watchRoot(root) {
        const uriStr = root.resource.toString();
        if (this.rootWatchers.has(uriStr)) {
            return;
        }
        const excludes = this.getExcludes(uriStr);
        const watcher = this.fileService.watch(new uri_1.default(uriStr), {
            recursive: true,
            excludes
        });
        this.rootWatchers.set(uriStr, new core_1.DisposableCollection(watcher, core_1.Disposable.create(() => this.rootWatchers.delete(uriStr))));
    }
    getExcludes(uri) {
        const patterns = this.fsPreferences.get('files.watcherExclude', undefined, uri);
        return Object.keys(patterns).filter(pattern => patterns[pattern]);
    }
    /**
     * Returns the workspace root uri that the given file belongs to.
     * In case that the file is found in more than one workspace roots, returns the root that is closest to the file.
     * If the file is not from the current workspace, returns `undefined`.
     * @param uri URI of the file
     */
    getWorkspaceRootUri(uri) {
        if (!uri) {
            const root = this.tryGetRoots()[0];
            if (root) {
                return root.resource;
            }
            return undefined;
        }
        const rootUris = [];
        for (const root of this.tryGetRoots()) {
            const rootUri = root.resource;
            if (rootUri && rootUri.scheme === uri.scheme && rootUri.isEqualOrParent(uri)) {
                rootUris.push(rootUri);
            }
        }
        return rootUris.sort((r1, r2) => r2.toString().length - r1.toString().length)[0];
    }
    /**
     * Returns the relative path of the given file to the workspace root.
     * @param uri URI of the file
     * @see getWorkspaceRootUri(uri)
     */
    async getWorkspaceRelativePath(uri) {
        const wsUri = this.getWorkspaceRootUri(uri);
        if (wsUri) {
            const wsRelative = wsUri.relative(uri);
            if (wsRelative) {
                return wsRelative.toString();
            }
        }
        return uri.path.fsPath();
    }
    /**
     * Returns a workspace-relative path prefixed with the containing root's
     * directory name, e.g. `backend/src/index.ts`.
     *
     * In a single-root workspace the root name is still included so that the
     * format is consistent regardless of how many roots are open.
     *
     * Falls back to the absolute filesystem path if the URI is not contained
     * in any workspace root.
     *
     * @param uri URI of the file
     */
    getRootPrefixedPath(uri) {
        const rootUri = this.getWorkspaceRootUri(uri);
        if (!rootUri) {
            return uri.path.fsPath();
        }
        const rootName = rootUri.path.base;
        const relative = rootUri.relative(uri);
        if (!relative || relative.toString() === '') {
            return rootName;
        }
        return `${rootName}/${relative.toString()}`;
    }
    areWorkspaceRoots(uris) {
        if (!uris.length) {
            return false;
        }
        const rootUris = new Set(this.tryGetRoots().map(root => root.resource.toString()));
        return uris.every(uri => rootUris.has(uri.toString()));
    }
    /**
     * Check if the file should be considered as a workspace file.
     *
     * Example: We should not try to read the contents of an .exe file.
     */
    isWorkspaceFile(candidate) {
        return this.workspaceFileService.isWorkspaceFile(candidate);
    }
    isUntitledWorkspace(candidate) {
        return this.untitledWorkspaceService.isUntitledWorkspace(candidate);
    }
    async isSafeToReload(withURI) {
        return !withURI || !this.untitledWorkspaceService.isUntitledWorkspace(withURI) || new uri_1.default(await this.getDefaultWorkspaceUri()).isEqual(withURI);
    }
    /**
     *
     * @param key the property key under which to store the schema (e.g. tasks, launch)
     * @param schema the schema for the property. If none is supplied, the update is treated as a deletion.
     */
    async updateSchema(key, schema) {
        return this.schemaUpdater.updateSchema({ key, schema });
    }
};
exports.WorkspaceService = WorkspaceService;
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], WorkspaceService.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.WorkspaceServer),
    tslib_1.__metadata("design:type", Object)
], WorkspaceService.prototype, "server", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(window_service_1.WindowService),
    tslib_1.__metadata("design:type", Object)
], WorkspaceService.prototype, "windowService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('workspace:WorkspaceService'),
    tslib_1.__metadata("design:type", Object)
], WorkspaceService.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_preferences_1.WorkspacePreferences),
    tslib_1.__metadata("design:type", Object)
], WorkspaceService.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preferences_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], WorkspaceService.prototype, "preferenceImpl", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preferences_1.PreferenceSchemaService),
    tslib_1.__metadata("design:type", Object)
], WorkspaceService.prototype, "schemaService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(env_variables_1.EnvVariablesServer),
    tslib_1.__metadata("design:type", Object)
], WorkspaceService.prototype, "envVariableServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], WorkspaceService.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.LabelProvider),
    tslib_1.__metadata("design:type", browser_1.LabelProvider)
], WorkspaceService.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_2.FileSystemPreferences),
    tslib_1.__metadata("design:type", Object)
], WorkspaceService.prototype, "fsPreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_schema_updater_1.WorkspaceSchemaUpdater),
    tslib_1.__metadata("design:type", workspace_schema_updater_1.WorkspaceSchemaUpdater)
], WorkspaceService.prototype, "schemaUpdater", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.UntitledWorkspaceService),
    tslib_1.__metadata("design:type", common_1.UntitledWorkspaceService)
], WorkspaceService.prototype, "untitledWorkspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.WorkspaceFileService),
    tslib_1.__metadata("design:type", common_1.WorkspaceFileService)
], WorkspaceService.prototype, "workspaceFileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(window_title_service_1.WindowTitleService),
    tslib_1.__metadata("design:type", window_title_service_1.WindowTitleService)
], WorkspaceService.prototype, "windowTitleService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(exports.WorkspaceOpenHandlerContribution),
    tslib_1.__metadata("design:type", Object)
], WorkspaceService.prototype, "openHandlerContribution", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(exports.WorkspaceHandlingContribution),
    tslib_1.__metadata("design:type", Object)
], WorkspaceService.prototype, "workspaceHandlingContribution", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], WorkspaceService.prototype, "init", null);
exports.WorkspaceService = WorkspaceService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WorkspaceService);
var WorkspaceData;
(function (WorkspaceData) {
    const validateSchema = new Ajv().compile(workspace_schema_updater_1.workspaceSchema);
    function is(data) {
        return !!validateSchema(data);
    }
    WorkspaceData.is = is;
    function buildWorkspaceData(folders, additionalFields) {
        const roots = new Set();
        if (folders.length > 0) {
            if (typeof folders[0] !== 'string') {
                folders.forEach(folder => roots.add(folder.resource.toString()));
            }
            else {
                folders.forEach(folder => roots.add(folder));
            }
        }
        const data = {
            folders: Array.from(roots, folder => ({ path: folder }))
        };
        if (additionalFields) {
            delete additionalFields.folders;
            Object.assign(data, additionalFields);
        }
        return data;
    }
    WorkspaceData.buildWorkspaceData = buildWorkspaceData;
    function transformToRelative(data, workspaceFile) {
        const folderUris = [];
        const workspaceFileUri = new uri_1.default(workspaceFile ? workspaceFile.resource.toString() : '').withScheme('file');
        for (const { path } of data.folders) {
            const folderUri = new uri_1.default(path).withScheme('file');
            const rel = workspaceFileUri.parent.relative(folderUri);
            if (rel) {
                folderUris.push(rel.toString());
            }
            else {
                folderUris.push(folderUri.toString());
            }
        }
        return buildWorkspaceData(folderUris, data);
    }
    WorkspaceData.transformToRelative = transformToRelative;
    function transformToAbsolute(data, workspaceFile) {
        if (workspaceFile) {
            const folders = [];
            for (const folder of data.folders) {
                const path = folder.path;
                if (path.startsWith('file:///')) {
                    folders.push(path);
                }
                else {
                    const absolutePath = workspaceFile.resource.withScheme('file').parent.resolveToAbsolute(path)?.toString();
                    if (absolutePath) {
                        folders.push(absolutePath.toString());
                    }
                }
            }
            return Object.assign(data, buildWorkspaceData(folders, data));
        }
        return data;
    }
    WorkspaceData.transformToAbsolute = transformToAbsolute;
})(WorkspaceData || (exports.WorkspaceData = WorkspaceData = {}));
//# sourceMappingURL=workspace-service.js.map