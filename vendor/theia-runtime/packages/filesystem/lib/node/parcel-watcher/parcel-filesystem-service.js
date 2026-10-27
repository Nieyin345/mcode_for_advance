"use strict";
// *****************************************************************************
// Copyright (C) 2017-2018 TypeFox and others.
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
exports.ParcelFileSystemWatcherService = exports.ParcelWatcher = exports.WatcherDisposal = exports.ParcelFileSystemWatcherServerOptions = void 0;
const path = require("path");
const fs_1 = require("fs");
const minimatch_1 = require("minimatch");
const file_uri_1 = require("@theia/core/lib/common/file-uri");
const file_change_collection_1 = require("../file-change-collection");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const watcher_1 = require("@theia/core/shared/@parcel/watcher");
const core_1 = require("@theia/core");
exports.ParcelFileSystemWatcherServerOptions = Symbol('ParcelFileSystemWatcherServerOptions');
/**
 * This is a flag value passed around upon disposal.
 */
exports.WatcherDisposal = Symbol('WatcherDisposal');
/**
 * Because URIs can be watched by different clients, we'll track
 * how many are listening for a given URI.
 *
 * This component wraps the whole start/stop process given some
 * reference count.
 *
 * Once there are no more references the handle
 * will wait for some time before destroying its resources.
 */
class ParcelWatcher {
    static { this.debugIdSequence = 0; }
    // copied from https://github.com/microsoft/vscode/blob/e3a5acfb517a443235981655413d566533107e92/src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts#L158
    static { this.PARCEL_WATCHER_BACKEND = core_1.isWindows ? 'windows' : core_1.isOSX ? 'fs-events' : 'inotify'; }
    constructor(
    /** Initial reference to this handle. */
    initialClientId, 
    /** Filesystem path to be watched. */
    fsPath, 
    /** Watcher-specific options */
    watcherOptions, 
    /** Logging and parcel watcher options */
    parcelFileSystemWatchServerOptions, 
    /** The client to forward events to. */
    fileSystemWatcherClient, 
    /** Amount of time in ms to wait once this handle is not referenced anymore. */
    deferredDisposalTimeout = 10_000) {
        this.fsPath = fsPath;
        this.watcherOptions = watcherOptions;
        this.parcelFileSystemWatchServerOptions = parcelFileSystemWatchServerOptions;
        this.fileSystemWatcherClient = fileSystemWatcherClient;
        this.deferredDisposalTimeout = deferredDisposalTimeout;
        this.disposed = false;
        /**
         * Used for debugging to keep track of the watchers.
         */
        this.debugId = ParcelWatcher.debugIdSequence++;
        /**
         * This deferred only rejects with `WatcherDisposal` and never resolves.
         */
        this.deferredDisposalDeferred = new promise_util_1.Deferred();
        /**
         * We count each reference made to this watcher, per client.
         *
         * We do this to know where to send events via the network.
         *
         * An entry should be removed when its value hits zero.
         */
        this.refsPerClient = new Map();
        /**
         * Ensures that events are processed in the order they are emitted,
         * despite being processed async.
         */
        this.parcelEventProcessingQueue = Promise.resolve();
        /**
         * Resolves once this handle disposed itself and its resources. Never throws.
         */
        this.whenDisposed = this.deferredDisposalDeferred.promise.catch(() => undefined);
        this.refsPerClient.set(initialClientId, { value: 1 });
        this.whenStarted = this.start().then(() => true, error => {
            if (error === exports.WatcherDisposal) {
                return false;
            }
            console.error(`Watcher failed to start at "${this.fsPath}":`, error);
            this._dispose();
            this.fireError();
            throw error;
        });
        this.debug('NEW', `initialClientId=${initialClientId}`);
    }
    addRef(clientId) {
        let refs = this.refsPerClient.get(clientId);
        if (typeof refs === 'undefined') {
            this.refsPerClient.set(clientId, refs = { value: 1 });
        }
        else {
            refs.value += 1;
        }
        const totalRefs = this.getTotalReferences();
        // If it was zero before, 1 means we were revived:
        const revived = totalRefs === 1;
        if (revived) {
            this.onRefsRevive();
        }
        this.debug('REF++', `clientId=${clientId}, clientRefs=${refs.value}, totalRefs=${totalRefs}. revived=${revived}`);
    }
    removeRef(clientId) {
        const refs = this.refsPerClient.get(clientId);
        if (typeof refs === 'undefined') {
            this.info('WARN REF--', `removed one too many reference: clientId=${clientId}`);
            return;
        }
        refs.value -= 1;
        // We must remove the key from `this.clientReferences` because
        // we list active clients by reading the keys of this map.
        if (refs.value === 0) {
            this.refsPerClient.delete(clientId);
        }
        const totalRefs = this.getTotalReferences();
        const dead = totalRefs === 0;
        if (dead) {
            this.onRefsReachZero();
        }
        this.debug('REF--', `clientId=${clientId}, clientRefs=${refs.value}, totalRefs=${totalRefs}, dead=${dead}`);
    }
    /**
     * All clients with at least one active reference.
     */
    getClientIds() {
        return Array.from(this.refsPerClient.keys());
    }
    /**
     * Add the references for each client together.
     */
    getTotalReferences() {
        let total = 0;
        for (const refs of this.refsPerClient.values()) {
            total += refs.value;
        }
        return total;
    }
    /**
     * Returns true if at least one client listens to this handle.
     */
    isInUse() {
        return this.refsPerClient.size > 0;
    }
    /**
     * @throws with {@link WatcherDisposal} if this instance is disposed.
     */
    assertNotDisposed() {
        if (this.disposed) {
            throw exports.WatcherDisposal;
        }
    }
    /**
     * When starting a watcher, we'll first check and wait for the path to exists
     * before running a parcel watcher.
     */
    async start() {
        while (await fs_1.promises.stat(this.fsPath).then(() => false, () => true)) {
            await (0, promise_util_1.timeout)(500);
            this.assertNotDisposed();
        }
        this.assertNotDisposed();
        // This race is specific to Linux/inotify: parcel-watcher's inotify backend walks
        // the tree and then calls inotify_add_watch on every subdirectory. If a subdirectory
        // disappears between the walk and the add (common when watching dirs that contain
        // auto-rotated log/temp folders), the syscall returns ENOENT and parcel-watcher fails
        // the entire subscribe. Retry a few times: by the next walk the gone-but-not-forgotten
        // dir is no longer present. Windows (ReadDirectoryChangesW) and macOS (FSEvents) watch
        // the whole subtree from a single handle on the root and never register per-subdirectory
        // watches, so they cannot hit this race; the retry is simply a no-op there.
        let watcher;
        let attempt = 0;
        while (true) {
            try {
                watcher = await this.createWatcher();
                break;
            }
            catch (error) {
                const message = (error && error.message) || '';
                const isTransientEnoent = message.includes('No such file or directory')
                    && await fs_1.promises.stat(this.fsPath).then(() => true, () => false);
                if (!isTransientEnoent || attempt >= 4) {
                    throw error;
                }
                attempt++;
                this.assertNotDisposed();
                await (0, promise_util_1.timeout)(100 * attempt);
                this.assertNotDisposed();
            }
        }
        this.assertNotDisposed();
        this.debug('STARTED', `disposed=${this.disposed}`);
        // The watcher could be disposed while it was starting, make sure to check for this:
        if (this.disposed) {
            await this.stopWatcher(watcher);
            throw exports.WatcherDisposal;
        }
        this.watcher = watcher;
    }
    /**
     * Given a started parcel watcher instance, gracefully shut it down.
     */
    async stopWatcher(watcher) {
        await watcher.unsubscribe()
            .then(() => 'success=true', error => error)
            .then(status => this.debug('STOPPED', status));
    }
    async createWatcher() {
        let fsPath = await fs_1.promises.realpath(this.fsPath);
        if ((await fs_1.promises.stat(fsPath)).isFile()) {
            fsPath = path.dirname(fsPath);
        }
        return (0, watcher_1.subscribe)(fsPath, (err, events) => {
            if (err) {
                if (err.message && err.message.includes('File system must be re-scanned')) {
                    console.log(`FS Events were dropped on watcher ${fs_1.promises}`);
                }
                else {
                    console.error(`Watcher service error on "${fsPath}":`, err);
                    this._dispose();
                    this.fireError();
                    return;
                }
            }
            if (events) {
                this.handleWatcherEvents(events);
            }
        }, {
            backend: ParcelWatcher.PARCEL_WATCHER_BACKEND,
            ...this.parcelFileSystemWatchServerOptions.parcelOptions,
            // Pass the excludes to parcel's native `ignore` so excluded directories are pruned
            // from the watch tree (no OS watch is placed), not merely filtered out of the event
            // stream. Mirrors VS Code's parcel watcher (`ignore: <request excludes>`).
            ignore: [
                ...(this.parcelFileSystemWatchServerOptions.parcelOptions.ignore ?? []),
                ...this.watcherOptions.ignorePatterns
            ]
        });
    }
    handleWatcherEvents(events) {
        // Only process events if someone is listening.
        if (this.isInUse()) {
            // This callback is async, but parcel won't wait for it to finish before firing the next one.
            // We will use a lock/queue to make sure everything is processed in the order it arrives.
            this.parcelEventProcessingQueue = this.parcelEventProcessingQueue.then(async () => {
                const fileChangeCollection = new file_change_collection_1.FileChangeCollection();
                for (const event of events) {
                    const filePath = event.path;
                    if (event.type === 'create') {
                        this.pushFileChange(fileChangeCollection, 1 /* FileChangeType.ADDED */, filePath);
                    }
                    else if (event.type === 'delete') {
                        this.pushFileChange(fileChangeCollection, 2 /* FileChangeType.DELETED */, filePath);
                    }
                    else if (event.type === 'update') {
                        this.pushFileChange(fileChangeCollection, 0 /* FileChangeType.UPDATED */, filePath);
                    }
                }
                const changes = fileChangeCollection.values();
                // If all changes are part of the ignored files, the collection will be empty.
                if (changes.length > 0) {
                    this.fileSystemWatcherClient.onDidFilesChanged({
                        clients: this.getClientIds(),
                        changes,
                    });
                }
            }, console.error);
        }
    }
    async resolveEventPath(directory, file) {
        // parcel already resolves symlinks, the paths should be clean already:
        return path.resolve(directory, file);
    }
    pushFileChange(changes, type, filePath) {
        if (!this.isIgnored(filePath)) {
            const uri = file_uri_1.FileUri.create(filePath).toString();
            changes.push({ type, uri });
        }
    }
    fireError() {
        this.fileSystemWatcherClient.onError({
            clients: this.getClientIds(),
            uri: this.fsPath,
        });
    }
    /**
     * When references hit zero, we'll schedule disposal for a bit later.
     *
     * This allows new references to reuse this watcher instead of creating a new one.
     *
     * e.g. A frontend disconnects for a few milliseconds before reconnecting again.
     */
    onRefsReachZero() {
        this.deferredDisposalTimer = setTimeout(() => this._dispose(), this.deferredDisposalTimeout);
    }
    /**
     * If we get new references after hitting zero, let's unschedule our disposal and keep watching.
     */
    onRefsRevive() {
        if (this.deferredDisposalTimer) {
            clearTimeout(this.deferredDisposalTimer);
            this.deferredDisposalTimer = undefined;
        }
    }
    isIgnored(filePath) {
        return this.watcherOptions.ignored.length > 0
            && this.watcherOptions.ignored.some(m => m.match(filePath));
    }
    /**
     * Internal disposal mechanism.
     */
    async _dispose() {
        if (!this.disposed) {
            this.disposed = true;
            this.deferredDisposalDeferred.reject(exports.WatcherDisposal);
            if (this.watcher) {
                this.stopWatcher(this.watcher);
                this.watcher = undefined;
            }
            this.debug('DISPOSED');
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    info(prefix, ...params) {
        this.parcelFileSystemWatchServerOptions.info(`${prefix} ParcelWatcher(${this.debugId} at "${this.fsPath}"):`, ...params);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    debug(prefix, ...params) {
        if (this.parcelFileSystemWatchServerOptions.verbose) {
            this.info(prefix, ...params);
        }
    }
}
exports.ParcelWatcher = ParcelWatcher;
class ParcelFileSystemWatcherService {
    constructor(options) {
        this.watcherId = 0;
        this.watchers = new Map();
        this.watcherHandles = new Map();
        /**
         * `this.client` is undefined until someone sets it.
         */
        this.maybeClient = {
            onDidFilesChanged: event => this.client?.onDidFilesChanged(event),
            onError: event => this.client?.onError(event),
        };
        this.options = {
            parcelOptions: {},
            verbose: false,
            info: (message, ...args) => console.info(message, ...args),
            error: (message, ...args) => console.error(message, ...args),
            ...options
        };
    }
    setClient(client) {
        this.client = client;
    }
    /**
     * A specific client requests us to watch a given `uri` according to some `options`.
     *
     * We internally re-use all the same `(uri, options)` pairs.
     */
    async watchFileChanges(clientId, uri, options) {
        const resolvedOptions = this.resolveWatchOptions(options);
        const watcherKey = this.getWatcherKey(uri, resolvedOptions);
        let watcher = this.watchers.get(watcherKey);
        if (watcher === undefined) {
            const fsPath = file_uri_1.FileUri.fsPath(uri);
            watcher = this.createWatcher(clientId, fsPath, resolvedOptions);
            watcher.whenDisposed.then(() => this.watchers.delete(watcherKey));
            this.watchers.set(watcherKey, watcher);
        }
        else {
            watcher.addRef(clientId);
        }
        const watcherId = this.watcherId++;
        this.watcherHandles.set(watcherId, { clientId, watcher });
        watcher.whenDisposed.then(() => this.watcherHandles.delete(watcherId));
        return watcherId;
    }
    createWatcher(clientId, fsPath, options) {
        const watcherOptions = {
            ignored: options.ignored
                .map(pattern => new minimatch_1.Minimatch(pattern, { dot: true })),
            ignorePatterns: options.ignored,
        };
        return new ParcelWatcher(clientId, fsPath, watcherOptions, this.options, this.maybeClient);
    }
    async unwatchFileChanges(watcherId) {
        const handle = this.watcherHandles.get(watcherId);
        if (handle === undefined) {
            console.warn(`tried to de-allocate a disposed watcher: watcherId=${watcherId}`);
        }
        else {
            this.watcherHandles.delete(watcherId);
            handle.watcher.removeRef(handle.clientId);
        }
    }
    /**
     * Given some `URI` and some `WatchOptions`, generate a unique key.
     */
    getWatcherKey(uri, options) {
        return [
            uri,
            options.ignored.slice(0).sort().join() // use a **sorted copy** of `ignored` as part of the key
        ].join();
    }
    /**
     * Return fully qualified options.
     */
    resolveWatchOptions(options) {
        return {
            ignored: [],
            ...options,
        };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    debug(message, ...params) {
        if (this.options.verbose) {
            this.options.info(message, ...params);
        }
    }
    dispose() {
        // Singletons shouldn't be disposed...
    }
}
exports.ParcelFileSystemWatcherService = ParcelFileSystemWatcherService;
//# sourceMappingURL=parcel-filesystem-service.js.map