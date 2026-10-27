"use strict";
// *****************************************************************************
// Copyright (C) 2025 Maksim Kachurin and others.
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
exports.FileDownloadServiceImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const logger_1 = require("@theia/core/lib/common/logger");
const message_service_1 = require("@theia/core/lib/common/message-service");
const filesystem_preferences_1 = require("../../common/filesystem-preferences");
const core_1 = require("@theia/core");
const stream_1 = require("@theia/core/lib/common/stream");
const file_service_1 = require("../../browser/file-service");
const tarStream = require("tar-stream");
const minimatch_1 = require("minimatch");
let FileDownloadServiceImpl = class FileDownloadServiceImpl {
    constructor() {
        this.ignorePatterns = [];
    }
    getFileSizeThreshold() {
        return this.preferences['files.maxFileSizeMB'] * 1024 * 1024;
    }
    /**
     * Check if streaming download is supported (File System Access API)
     */
    isStreamingSupported() {
        if (!globalThis.isSecureContext) {
            return false;
        }
        if (!('showSaveFilePicker' in globalThis)) {
            return false;
        }
        try {
            return typeof globalThis.ReadableStream?.prototype?.pipeTo === 'function';
        }
        catch {
            return false;
        }
    }
    async download(uris, options) {
        if (uris.length === 0) {
            return;
        }
        const abortController = new AbortController();
        try {
            const progress = await this.messageService.showProgress({
                text: core_1.nls.localize('theia/filesystem/prepareDownload', 'Preparing download...'),
                options: { cancelable: true },
            }, () => {
                abortController.abort();
            });
            try {
                await this.doDownload(uris, abortController.signal);
            }
            finally {
                progress.cancel();
            }
        }
        catch (e) {
            if (!abortController.signal.aborted) {
                this.logger.error(`Error occurred when downloading: ${uris.map(u => u.toString(true))}.`, e);
                this.messageService.error(core_1.nls.localize('theia/filesystem/downloadError', 'Failed to download files. See console for details.'));
            }
        }
    }
    async doDownload(uris, abortSignal) {
        try {
            const { files, directories, totalSize, stats } = await this.collectFiles(uris, abortSignal);
            if (abortSignal.aborted) {
                return;
            }
            if (totalSize > this.getFileSizeThreshold() &&
                this.isStreamingSupported()) {
                await this.streamDownloadToFile(uris, files, directories, stats, abortSignal);
            }
            else {
                let data;
                let filename = 'theia-download.tar';
                if (uris.length === 1) {
                    const stat = stats[0];
                    if (stat.isDirectory) {
                        filename = `${stat.name}.tar`;
                        data = await this.createArchiveBlob(async (tarPack) => {
                            await this.addFilesToArchive(tarPack, files, directories, abortSignal);
                        }, abortSignal);
                    }
                    else {
                        filename = stat.name;
                        const content = await this.fileService.readFile(uris[0]);
                        data = new Blob([content.value.buffer], {
                            type: 'application/octet-stream',
                        });
                    }
                }
                else {
                    data = await this.createArchiveBlob(async (tarPack) => {
                        await this.addFilesToArchive(tarPack, files, directories, abortSignal);
                    }, abortSignal);
                }
                if (!abortSignal.aborted) {
                    this.blobDownload(data, filename);
                }
            }
        }
        catch (error) {
            if (!abortSignal.aborted) {
                this.logger.error('Failed to download files', error);
                throw error;
            }
        }
    }
    async createArchiveBlob(populateArchive, abortSignal) {
        const stream = this.createArchiveStream(abortSignal, populateArchive);
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                if (abortSignal.aborted) {
                    throw new Error('Operation aborted');
                }
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                chunks.push(value);
                total += value.byteLength;
            }
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
                out.set(c, off);
                off += c.byteLength;
            }
            return new Blob([out], { type: 'application/x-tar' });
        }
        finally {
            try {
                reader.releaseLock();
            }
            catch { }
        }
    }
    /**
     * Create ReadableStream from a single file using FileService streaming
     */
    async createFileStream(uri, abortSignal) {
        if (abortSignal.aborted) {
            throw new Error('Operation aborted');
        }
        const fileStreamContent = await this.fileService.readFileStream(uri);
        return (0, stream_1.binaryStreamToWebStream)(fileStreamContent.value, abortSignal);
    }
    async addFileToArchive(tarPack, file, abortSignal) {
        if (abortSignal.aborted) {
            return;
        }
        try {
            const name = this.sanitizeFilename(file.path);
            const size = file.size;
            const entry = tarPack.entry({ name, size });
            const fileStreamContent = await this.fileService.readFileStream(file.uri);
            const src = fileStreamContent.value;
            return new Promise((resolve, reject) => {
                const cleanup = () => {
                    src.removeListener?.('data', onData);
                    src.removeListener?.('end', onEnd);
                    src.removeListener?.('error', onError);
                    entry.removeListener?.('error', onEntryError);
                    abortSignal.removeEventListener('abort', onAbort);
                };
                const onAbort = () => {
                    cleanup();
                    entry.destroy?.();
                    reject(new Error('Operation aborted'));
                };
                let ended = false;
                let pendingWrite = undefined;
                const onData = async (chunk) => {
                    if (abortSignal.aborted || ended) {
                        return;
                    }
                    src.pause?.();
                    const u8 = new Uint8Array(chunk.buffer);
                    const canWrite = entry.write(u8);
                    if (!canWrite) {
                        pendingWrite = new Promise(resolveDrain => {
                            entry.once('drain', resolveDrain);
                        });
                        await pendingWrite;
                        pendingWrite = undefined;
                    }
                    if (!ended) {
                        src.resume?.();
                    }
                };
                const onEnd = async () => {
                    ended = true;
                    if (pendingWrite) {
                        await pendingWrite;
                    }
                    cleanup();
                    // `tar-stream` types `end` via `streamx`, which declares the data argument as required.
                    // Passing `undefined` is equivalent to a bare `end()` call.
                    entry.end(undefined);
                    resolve();
                };
                const onError = (err) => {
                    cleanup();
                    try {
                        entry.destroy?.(err);
                    }
                    catch { }
                    reject(err);
                };
                const onEntryError = (err) => {
                    cleanup();
                    reject(new Error(`Entry error for ${name}: ${err.message}`));
                };
                if (abortSignal.aborted) {
                    return onAbort();
                }
                abortSignal.addEventListener('abort', onAbort, { once: true });
                entry.on?.('error', onEntryError);
                src.on?.('data', onData);
                src.on?.('end', onEnd);
                src.on?.('error', onError);
            });
        }
        catch (error) {
            this.logger.error(`Failed to read file ${file.uri.toString()}:`, error);
            throw error;
        }
    }
    async addFilesToArchive(tarPack, files, directories, abortSignal) {
        const uniqueDirs = new Set();
        for (const dir of directories) {
            const normalizedPath = this.sanitizeFilename(dir.path) + '/';
            uniqueDirs.add(normalizedPath);
        }
        for (const dirPath of uniqueDirs) {
            try {
                const entry = tarPack.entry({
                    name: dirPath,
                    type: 'directory',
                });
                entry.end(undefined);
            }
            catch (error) {
                this.logger.error(`Failed to add directory ${dirPath}:`, error);
            }
        }
        for (const file of files) {
            if (abortSignal.aborted) {
                break;
            }
            try {
                await this.addFileToArchive(tarPack, file, abortSignal);
            }
            catch (error) {
                this.logger.error(`Failed to read file ${file.uri.toString()}:`, error);
            }
        }
    }
    createArchiveStream(abortSignal, populateArchive) {
        const tarPack = tarStream.pack();
        return new ReadableStream({
            start(controller) {
                const cleanup = () => {
                    try {
                        tarPack.removeAllListeners();
                    }
                    catch { }
                    try {
                        tarPack.destroy?.();
                    }
                    catch { }
                    abortSignal.removeEventListener('abort', onAbort);
                };
                const onAbort = () => {
                    cleanup();
                    controller.error(new Error('Operation aborted'));
                };
                if (abortSignal.aborted) {
                    onAbort();
                    return;
                }
                abortSignal.addEventListener('abort', onAbort, { once: true });
                tarPack.on('data', (chunk) => {
                    if (abortSignal.aborted) {
                        return;
                    }
                    try {
                        controller.enqueue(chunk);
                    }
                    catch (error) {
                        cleanup();
                        controller.error(error);
                    }
                });
                tarPack.once('end', () => {
                    cleanup();
                    controller.close();
                });
                tarPack.once('error', error => {
                    cleanup();
                    controller.error(error);
                });
                populateArchive(tarPack)
                    .then(() => {
                    if (!abortSignal.aborted) {
                        tarPack.finalize();
                    }
                })
                    .catch(error => {
                    cleanup();
                    controller.error(error);
                });
            },
            cancel: () => {
                try {
                    tarPack.finalize?.();
                    tarPack.destroy?.();
                }
                catch { }
            },
        });
    }
    async streamDownloadToFile(uris, files, directories, stats, abortSignal) {
        let filename = 'theia-download.tar';
        if (uris.length === 1) {
            const stat = stats[0];
            filename = stat.isDirectory ? `${stat.name}.tar` : stat.name;
        }
        const isArchive = filename.endsWith('.tar');
        let fileHandle;
        try {
            // @ts-expect-error non-standard
            fileHandle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: isArchive
                    ? [
                        {
                            description: 'Archive files',
                            accept: { 'application/x-tar': ['.tar'] },
                        },
                    ]
                    : undefined,
            });
        }
        catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return;
            }
            throw error;
        }
        let stream;
        if (uris.length === 1) {
            const stat = await this.fileService.resolve(uris[0]);
            stream = stat.isDirectory
                ? this.createArchiveStream(abortSignal, async (tarPack) => {
                    await this.addFilesToArchive(tarPack, files, directories, abortSignal);
                })
                : await this.createFileStream(uris[0], abortSignal);
        }
        else {
            stream = this.createArchiveStream(abortSignal, async (tarPack) => {
                await this.addFilesToArchive(tarPack, files, directories, abortSignal);
            });
        }
        const writable = await fileHandle.createWritable();
        try {
            await stream.pipeTo(writable, { signal: abortSignal });
        }
        catch (error) {
            try {
                await writable.abort?.();
            }
            catch { }
            throw error;
        }
    }
    blobDownload(data, filename) {
        const url = URL.createObjectURL(data);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 0);
    }
    sanitizeFilename(filename) {
        return filename
            .replace(/[\\:*?"<>|]/g, '_') // Replace Windows-problematic chars
            .replace(/\.\./g, '__') // Replace .. to prevent directory traversal
            .replace(/^\/+/g, '') // Remove leading slashes
            .replace(/\/+$/, '') // Remove trailing slashes for files
            .replace(/[\u0000-\u001f\u007f]/g, '_') // Replace control characters
            .replace(/\/+/g, '/')
            .replace(/^\.$/, '_')
            .replace(/^$/, '_');
    }
    shouldIncludeFile(path) {
        return !this.ignorePatterns.some((pattern) => (0, minimatch_1.minimatch)(path, pattern));
    }
    /**
     * Collect all files and calculate total size
     */
    async collectFiles(uris, abortSignal) {
        const files = [];
        const directories = [];
        let totalSize = 0;
        const stats = [];
        for (const uri of uris) {
            if (abortSignal?.aborted) {
                break;
            }
            try {
                const stat = await this.fileService.resolve(uri, {
                    resolveMetadata: true,
                });
                stats.push({
                    name: stat.name,
                    isDirectory: stat.isDirectory,
                    size: stat.size,
                });
                if (abortSignal?.aborted) {
                    break;
                }
                if (!stat.isDirectory) {
                    const size = stat.size || 0;
                    files.push({ uri, path: stat.name, size });
                    totalSize += size;
                    continue;
                }
                if (!stat.children?.length) {
                    directories.push({ path: stat.name });
                    continue;
                }
                directories.push({ path: stat.name });
                const dirResult = await this.collectFilesFromDirectory(uri, stat.name, abortSignal);
                files.push(...dirResult.files);
                directories.push(...dirResult.directories);
                totalSize += dirResult.files.reduce((sum, file) => sum + file.size, 0);
            }
            catch (error) {
                this.logger.warn(`Failed to collect files from ${uri.toString()}:`, error);
                stats.push({
                    name: uri.path.name || 'unknown',
                    isDirectory: false,
                    size: 0,
                });
            }
        }
        return { files, directories, totalSize, stats };
    }
    /**
     * Recursively collect files from a directory
     */
    async collectFilesFromDirectory(dirUri, basePath, abortSignal) {
        const files = [];
        const directories = [];
        try {
            const dirStat = await this.fileService.resolve(dirUri);
            if (abortSignal?.aborted) {
                return { files, directories };
            }
            // Empty directory - add it to preserve structure
            if (!dirStat.children?.length) {
                directories.push({ path: basePath });
                return { files, directories };
            }
            for (const child of dirStat.children) {
                if (abortSignal?.aborted) {
                    break;
                }
                const childPath = basePath
                    ? `${basePath}/${child.name}`
                    : child.name;
                if (!this.shouldIncludeFile(childPath)) {
                    continue;
                }
                if (child.isDirectory) {
                    directories.push({ path: childPath });
                    const subResult = await this.collectFilesFromDirectory(child.resource, childPath, abortSignal);
                    files.push(...subResult.files);
                    directories.push(...subResult.directories);
                }
                else {
                    const childStat = await this.fileService.resolve(child.resource);
                    files.push({
                        uri: child.resource,
                        path: childPath,
                        size: childStat.size || 0,
                    });
                }
            }
        }
        catch (error) {
            this.logger.warn(`Failed to collect files from directory ${dirUri.toString()}:`, error);
        }
        return { files, directories };
    }
};
exports.FileDownloadServiceImpl = FileDownloadServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], FileDownloadServiceImpl.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_1.ILogger),
    (0, inversify_1.named)('filesystem:FileDownloadServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], FileDownloadServiceImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(message_service_1.MessageService),
    tslib_1.__metadata("design:type", message_service_1.MessageService)
], FileDownloadServiceImpl.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(filesystem_preferences_1.FileSystemPreferences),
    tslib_1.__metadata("design:type", Object)
], FileDownloadServiceImpl.prototype, "preferences", void 0);
exports.FileDownloadServiceImpl = FileDownloadServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FileDownloadServiceImpl);
//# sourceMappingURL=file-download-service.js.map