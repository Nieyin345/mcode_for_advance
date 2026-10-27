"use strict";
// *****************************************************************************
// Copyright (C) 2024 EclipseSource and others.
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
exports.OPFSFileSystemProvider = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const files_1 = require("../common/files");
const core_1 = require("@theia/core");
const encoding_service_1 = require("@theia/core/lib/common/encoding-service");
const buffer_1 = require("@theia/core/lib/common/buffer");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const opfs_worker_1 = require("opfs-worker");
const opfs_filesystem_initialization_1 = require("./opfs-filesystem-initialization");
const stream_1 = require("@theia/core/lib/common/stream");
const io_1 = require("../common/io");
const path_1 = require("@theia/core/lib/common/path");
let OPFSFileSystemProvider = class OPFSFileSystemProvider {
    constructor() {
        this.BUFFER_SIZE = 64 * 1024;
        this.capabilities = 2 /* FileSystemProviderCapabilities.FileReadWrite */ |
            4 /* FileSystemProviderCapabilities.FileOpenReadWriteClose */ |
            8 /* FileSystemProviderCapabilities.FileFolderCopy */ |
            33554432 /* FileSystemProviderCapabilities.Update */;
        this.onDidChangeCapabilities = core_1.Event.None;
        this.onDidChangeFileEmitter = new core_1.Emitter();
        this.onDidChangeFile = this.onDidChangeFileEmitter.event;
        this.onFileWatchError = core_1.Event.None;
        this.toDispose = new core_1.DisposableCollection(this.onDidChangeFileEmitter);
    }
    /**
     * Initializes the OPFS file system provider
     */
    init() {
        const setup = async () => {
            const root = await this.initialization.getRootDirectory();
            const broadcastChannel = this.initialization.getBroadcastChannel();
            // Set up file change listening via BroadcastChannel
            broadcastChannel.onmessage = this.handleFileSystemChange.bind(this);
            // Initialize the file system
            this.fs = new opfs_worker_1.OPFSFileSystem({
                root,
                broadcastChannel,
                hashAlgorithm: false,
            });
            await this.initialization.initializeFS(new Proxy(this, {
                get(target, prop, receiver) {
                    if (prop === 'initialized') {
                        return Promise.resolve(true);
                    }
                    return Reflect.get(target, prop, receiver);
                }
            }));
            return true;
        };
        this.initialized = setup();
    }
    /**
     * Watches a resource for file system changes
     */
    watch(resource, opts) {
        if (!resource || !resource.path) {
            return core_1.Disposable.NULL;
        }
        const unwatch = this.fs.watch(formatPath(resource), {
            recursive: opts.recursive,
            exclude: opts.excludes,
        });
        return core_1.Disposable.create(unwatch);
    }
    /**
     * Creates an index from the map of entries
     */
    async createIndex(entries) {
        const arrayEntries = [];
        for (const [uri, content] of entries) {
            arrayEntries.push([formatPath(uri), content]);
        }
        await this.fs.createIndex(arrayEntries);
    }
    /**
     * Retrieves the current file system index
     */
    async index() {
        const opfsIndex = await this.fs.index();
        const index = new Map();
        for (const [path, stats] of opfsIndex.entries()) {
            const uri = new core_1.URI(path);
            index.set(uri, formatStat(stats));
        }
        return index;
    }
    /**
     * Clears the file system
     */
    async clear() {
        try {
            await this.fs.clear();
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Checks if a resource exists
     */
    async exists(resource) {
        if (!resource || !resource.path) {
            return false;
        }
        await this.initialized;
        try {
            return await this.fs.exists(formatPath(resource));
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Gets file system statistics for a resource
     */
    async stat(resource) {
        if (!resource || !resource.path) {
            throw (0, files_1.createFileSystemProviderError)('Invalid resource URI', files_1.FileSystemProviderErrorCode.FileNotFound);
        }
        await this.initialized;
        try {
            const path = formatPath(resource);
            const stats = await this.fs.stat(path);
            return formatStat(stats);
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Creates a directory
     */
    async mkdir(resource) {
        if (!resource || !resource.path) {
            throw (0, files_1.createFileSystemProviderError)('Invalid resource URI', files_1.FileSystemProviderErrorCode.FileNotFound);
        }
        await this.initialized;
        try {
            const path = formatPath(resource);
            await this.fs.mkdir(path, { recursive: true });
            this.onDidChangeFileEmitter.fire([{ resource, type: 1 /* FileChangeType.ADDED */ }]);
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Reads directory contents
     */
    async readdir(resource) {
        if (!resource || !resource.path) {
            throw (0, files_1.createFileSystemProviderError)('Invalid resource URI', files_1.FileSystemProviderErrorCode.FileNotFound);
        }
        await this.initialized;
        try {
            const path = formatPath(resource);
            const entries = await this.fs.readDir(path);
            return entries.map(entry => [
                entry.name,
                entry.isFile ? files_1.FileType.File : files_1.FileType.Directory
            ]);
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Deletes a resource
     */
    async delete(resource, opts) {
        if (!resource || !resource.path) {
            throw (0, files_1.createFileSystemProviderError)('Invalid resource URI', files_1.FileSystemProviderErrorCode.FileNotFound);
        }
        await this.initialized;
        try {
            const path = formatPath(resource);
            await this.fs.remove(path, { recursive: opts.recursive });
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Renames a resource from one location to another
     */
    async rename(from, to, opts) {
        if (!from || !from.path || !to || !to.path) {
            throw (0, files_1.createFileSystemProviderError)('Invalid source or destination URI', files_1.FileSystemProviderErrorCode.FileNotFound);
        }
        await this.initialized;
        try {
            const fromPath = formatPath(from);
            const toPath = formatPath(to);
            await this.fs.rename(fromPath, toPath, {
                overwrite: opts.overwrite,
            });
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Copies a resource from one location to another
     */
    async copy(from, to, opts) {
        if (!from || !from.path || !to || !to.path) {
            throw (0, files_1.createFileSystemProviderError)('Invalid source or destination URI', files_1.FileSystemProviderErrorCode.FileNotFound);
        }
        await this.initialized;
        try {
            const fromPath = formatPath(from);
            const toPath = formatPath(to);
            await this.fs.copy(fromPath, toPath, {
                overwrite: opts.overwrite,
                recursive: true,
            });
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Reads file content as binary data
     */
    async readFile(resource) {
        if (!resource || !resource.path) {
            throw (0, files_1.createFileSystemProviderError)('Invalid resource URI', files_1.FileSystemProviderErrorCode.FileNotFound);
        }
        await this.initialized;
        try {
            return await this.fs.readFile(formatPath(resource), 'binary');
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Reads file content as a stream
     */
    readFileStream(resource, opts, token) {
        const stream = (0, stream_1.newWriteableStream)(chunks => buffer_1.BinaryBuffer.concat(chunks.map(chunk => buffer_1.BinaryBuffer.wrap(chunk))).buffer);
        (0, io_1.readFileIntoStream)(this, resource, stream, data => data.buffer, {
            ...opts,
            bufferSize: this.BUFFER_SIZE
        }, token);
        return stream;
    }
    /**
     * Writes binary content to a file
     */
    async writeFile(resource, content, opts) {
        await this.initialized;
        let handle = undefined;
        if (!resource || !resource.path) {
            throw (0, files_1.createFileSystemProviderError)('Invalid resource URI', files_1.FileSystemProviderErrorCode.FileNotFound);
        }
        if (!content || !(content instanceof Uint8Array)) {
            throw (0, files_1.createFileSystemProviderError)('Invalid content: must be Uint8Array', files_1.FileSystemProviderErrorCode.Unknown);
        }
        try {
            const path = formatPath(resource);
            if (!opts.create || !opts.overwrite) {
                const fileExists = await this.fs.exists(path);
                if (fileExists) {
                    if (!opts.overwrite) {
                        throw (0, files_1.createFileSystemProviderError)('File already exists', files_1.FileSystemProviderErrorCode.FileExists);
                    }
                }
                else if (!opts.create) {
                    throw (0, files_1.createFileSystemProviderError)('File does not exist', files_1.FileSystemProviderErrorCode.FileNotFound);
                }
            }
            // Open
            handle = await this.open(resource, { create: true });
            // Write content at once
            await this.write(handle, 0, content, 0, content.byteLength);
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
        finally {
            if (typeof handle === 'number') {
                await this.close(handle);
            }
        }
    }
    // #region Open/Read/Write/Close Operations
    /**
     * Opens a file and returns a file descriptor
     */
    async open(resource, opts) {
        await this.initialized;
        if (!resource || !resource.path) {
            throw (0, files_1.createFileSystemProviderError)('Invalid resource URI', files_1.FileSystemProviderErrorCode.FileNotFound);
        }
        try {
            const path = formatPath(resource);
            const fileExists = await this.fs.exists(path);
            if (!opts.create && !fileExists) {
                throw (0, files_1.createFileSystemProviderError)('File does not exist', files_1.FileSystemProviderErrorCode.FileNotFound);
            }
            const fd = await this.fs.open(path, {
                create: opts.create,
                truncate: opts.create
            });
            return fd;
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Closes a file descriptor
     */
    async close(fd) {
        try {
            await this.fs.close(fd);
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Reads data from a file descriptor
     */
    async read(fd, pos, data, offset, length) {
        try {
            const result = await this.fs.read(fd, data, offset, length, pos);
            return result.bytesRead;
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    /**
     * Writes data to a file descriptor
     */
    async write(fd, pos, data, offset, length) {
        try {
            return await this.fs.write(fd, data, offset, length, pos, true);
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    // #endregion
    // #region Text File Updates
    /**
     * Updates a text file with content changes
     */
    async updateFile(resource, changes, opts) {
        try {
            const content = await this.readFile(resource);
            const decoded = this.encodingService.decode(buffer_1.BinaryBuffer.wrap(content), opts.readEncoding);
            const newContent = vscode_languageserver_textdocument_1.TextDocument.update(vscode_languageserver_textdocument_1.TextDocument.create('', '', 1, decoded), changes, 2).getText();
            const encoding = await this.encodingService.toResourceEncoding(opts.writeEncoding, {
                overwriteEncoding: opts.overwriteEncoding,
                read: async (length) => {
                    const fd = await this.open(resource, { create: false });
                    try {
                        const data = new Uint8Array(length);
                        await this.read(fd, 0, data, 0, length);
                        return data;
                    }
                    finally {
                        await this.close(fd);
                    }
                }
            });
            const encoded = this.encodingService.encode(newContent, encoding);
            await this.writeFile(resource, encoded.buffer, { create: false, overwrite: true });
            const stat = await this.stat(resource);
            return Object.assign(stat, { encoding: encoding.encoding });
        }
        catch (error) {
            throw toFileSystemProviderError(error);
        }
    }
    // #endregion
    /**
     * Handles file system change events from BroadcastChannel
     */
    async handleFileSystemChange(event) {
        if (!event.data?.path) {
            return;
        }
        const resource = new core_1.URI('file://' + event.data.path);
        let changeType;
        if (event.data.type === opfs_worker_1.WatchEventType.Added) {
            changeType = 1 /* FileChangeType.ADDED */;
        }
        else if (event.data.type === opfs_worker_1.WatchEventType.Removed) {
            changeType = 2 /* FileChangeType.DELETED */;
        }
        else {
            changeType = 0 /* FileChangeType.UPDATED */;
        }
        this.onDidChangeFileEmitter.fire([{ resource, type: changeType }]);
    }
    /**
     * Disposes the file system provider
     */
    dispose() {
        this.toDispose.dispose();
    }
};
exports.OPFSFileSystemProvider = OPFSFileSystemProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(opfs_filesystem_initialization_1.OPFSInitialization),
    tslib_1.__metadata("design:type", Object)
], OPFSFileSystemProvider.prototype, "initialization", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(encoding_service_1.EncodingService),
    tslib_1.__metadata("design:type", encoding_service_1.EncodingService)
], OPFSFileSystemProvider.prototype, "encodingService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], OPFSFileSystemProvider.prototype, "init", null);
exports.OPFSFileSystemProvider = OPFSFileSystemProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], OPFSFileSystemProvider);
/**
 * Formats a URI or string resource to a file system path.
 *
 * For browser-only mode with OPFS we always want POSIX-style paths,
 * regardless of the underlying platform.
 */
function formatPath(resource) {
    const uri = typeof resource === 'string' ? new core_1.URI(resource) : resource;
    return uri.path.fsPath(path_1.Path.Format.Posix);
}
/**
 * Creates a Stat object from OPFS stats
 */
function formatStat(stats) {
    return {
        type: stats.isDirectory ? files_1.FileType.Directory : files_1.FileType.File,
        ctime: new Date(stats.ctime).getTime(),
        mtime: new Date(stats.mtime).getTime(),
        size: stats.size
    };
}
/**
 * Converts OPFS errors to file system provider errors
 */
function toFileSystemProviderError(error) {
    if (error instanceof files_1.FileSystemProviderError) {
        return error;
    }
    let code;
    if (error.name === 'NotFoundError' || error.name === 'ENOENT') {
        code = files_1.FileSystemProviderErrorCode.FileNotFound;
    }
    else if (error.name === 'NotAllowedError' || error.name === 'SecurityError' || error.name === 'EACCES') {
        code = files_1.FileSystemProviderErrorCode.NoPermissions;
    }
    else if (error.name === 'QuotaExceededError' || error.name === 'ENOSPC') {
        code = files_1.FileSystemProviderErrorCode.FileTooLarge;
    }
    else if (error.name === 'PathError' || error.name === 'INVALID_PATH') {
        code = files_1.FileSystemProviderErrorCode.FileNotADirectory;
    }
    else {
        code = files_1.FileSystemProviderErrorCode.Unknown;
    }
    return (0, files_1.createFileSystemProviderError)(error, code);
}
//# sourceMappingURL=opfs-filesystem-provider.js.map