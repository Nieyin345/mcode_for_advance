"use strict";
// *****************************************************************************
// Copyright (C) 2025 Maksim Kachurin
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
var FileUploadServiceImpl_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileUploadServiceImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const uri_1 = require("@theia/core/lib/common/uri");
const cancellation_1 = require("@theia/core/lib/common/cancellation");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const message_service_1 = require("@theia/core/lib/common/message-service");
const throttle = require("@theia/core/shared/lodash.throttle");
const async_mutex_1 = require("async-mutex");
const file_service_1 = require("../../browser/file-service");
const browser_1 = require("@theia/core/lib/browser");
const nls_1 = require("@theia/core/lib/common/nls");
const event_1 = require("@theia/core/lib/common/event");
const filesystem_preferences_1 = require("../../common/filesystem-preferences");
const stream_1 = require("@theia/core/lib/common/stream");
const minimatch_1 = require("minimatch");
let FileUploadServiceImpl = class FileUploadServiceImpl {
    constructor() {
        this.onDidUploadEmitter = new event_1.Emitter();
        this.ignorePatterns = [];
    }
    static { FileUploadServiceImpl_1 = this; }
    static { this.TARGET = 'target'; }
    static { this.UPLOAD = 'upload'; }
    get onDidUpload() {
        return this.onDidUploadEmitter.event;
    }
    get maxConcurrentUploads() {
        const maxConcurrentUploads = this.fileSystemPreferences['files.maxConcurrentUploads'];
        return maxConcurrentUploads > 0 ? maxConcurrentUploads : Infinity;
    }
    init() {
        this.uploadForm = this.createUploadForm();
    }
    createUploadForm() {
        const targetInput = document.createElement('input');
        targetInput.type = 'text';
        targetInput.spellcheck = false;
        targetInput.name = FileUploadServiceImpl_1.TARGET;
        targetInput.classList.add('theia-input');
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.classList.add('theia-input');
        fileInput.name = FileUploadServiceImpl_1.UPLOAD;
        fileInput.multiple = true;
        const form = document.createElement('form');
        form.style.display = 'none';
        form.enctype = 'multipart/form-data';
        form.append(targetInput);
        form.append(fileInput);
        document.body.appendChild(form);
        fileInput.addEventListener('change', () => {
            if (this.deferredUpload && fileInput.value) {
                const source = new FormData(form);
                // clean up for reuse
                fileInput.value = '';
                const targetUri = new uri_1.default(source.get(FileUploadServiceImpl_1.TARGET));
                const { resolve, reject } = this.deferredUpload;
                this.deferredUpload = undefined;
                const { onDidUpload } = this.uploadForm;
                this.withProgress((progress, token) => this.uploadFiles(targetUri, { source, progress, token, onDidUpload })).then(resolve, reject);
            }
        });
        return { targetInput, fileInput };
    }
    async upload(targetUri, params) {
        const { source, onDidUpload } = params || {};
        if (source) {
            return this.withProgress((progress, token) => this.uploadFiles(typeof targetUri === 'string' ? new uri_1.default(targetUri) : targetUri, { source, progress, token, onDidUpload }));
        }
        this.deferredUpload = new promise_util_1.Deferred();
        this.uploadForm.targetInput.value = String(targetUri);
        this.uploadForm.fileInput.click();
        this.uploadForm.onDidUpload = onDidUpload;
        return this.deferredUpload.promise;
    }
    async withProgress(cb) {
        const cancellationSource = new cancellation_1.CancellationTokenSource();
        const { token } = cancellationSource;
        const text = nls_1.nls.localize('theia/filesystem/uploadFiles', 'Saving Files');
        const progress = await this.messageService.showProgress({ text, options: { cancelable: true } }, () => cancellationSource.cancel());
        try {
            return await cb(progress, token);
        }
        finally {
            progress.cancel();
        }
    }
    async confirmOverwrite(fileUri) {
        const dialog = new browser_1.ConfirmDialog({
            title: nls_1.nls.localizeByDefault('Replace'),
            msg: nls_1.nls.localizeByDefault("A file or folder with the name '{0}' already exists in the destination folder. Do you want to replace it?", fileUri.path.base),
            ok: nls_1.nls.localizeByDefault('Replace'),
            cancel: browser_1.Dialog.CANCEL
        });
        return !!await dialog.open();
    }
    /**
     * Upload all files to the filesystem
     */
    async uploadFiles(targetUri, params) {
        const status = new Map();
        const report = throttle(() => {
            const list = Array.from(status.values());
            const total = list.length;
            const done = list.filter(item => item.uploaded).length;
            params.progress.report({
                message: nls_1.nls.localize('theia/filesystem/processedOutOf', 'Processed {0} out of {1}', done, total),
                work: { total, done }
            });
        }, 100);
        const uploads = [];
        const uploadSemaphore = new async_mutex_1.Semaphore(this.maxConcurrentUploads);
        try {
            const files = await this.enumerateFiles(targetUri, params.source, params.token);
            for (const { file, uri } of files) {
                (0, cancellation_1.checkCancelled)(params.token);
                // Check exists and confirm overwrite before adding to queue
                if (await this.fileService.exists(uri) && !await this.confirmOverwrite(uri)) {
                    continue;
                }
                status.set(uri, {
                    uploaded: false
                });
                report();
                uploads.push(uploadSemaphore.runExclusive(async () => {
                    const entry = status.get(uri);
                    try {
                        (0, cancellation_1.checkCancelled)(params.token);
                        await this.uploadFile(file, uri);
                        if (entry) {
                            entry.uploaded = true;
                            report();
                        }
                        if (params.onDidUpload) {
                            params.onDidUpload(uri.toString(true));
                        }
                    }
                    catch (error) {
                        if (entry) {
                            entry.failed = true;
                            report();
                        }
                        throw error;
                    }
                }));
            }
            (0, cancellation_1.checkCancelled)(params.token);
            await Promise.all(uploads);
        }
        catch (error) {
            uploadSemaphore.cancel();
            if (!(0, cancellation_1.isCancelled)(error)) {
                this.messageService.error(nls_1.nls.localize('theia/filesystem/uploadFailed', 'An error occurred while saving a file. {0}', error.message));
                throw error;
            }
        }
        const uploaded = Array.from(status.keys()).map(uri => uri.toString(true));
        this.onDidUploadEmitter.fire(uploaded);
        return { uploaded };
    }
    /**
     * Upload (write) a file directly to the filesystem
     */
    async uploadFile(file, targetUri) {
        await this.fileService.writeFile(targetUri, (0, stream_1.fileToStream)(file));
    }
    /**
     * Normalize sources into an array of { file, uri } objects
     */
    async enumerateFiles(targetUri, source, token) {
        (0, cancellation_1.checkCancelled)(token);
        if (source instanceof FormData) {
            // Handle FormData declaratively
            const files = source.getAll(FileUploadServiceImpl_1.UPLOAD)
                .filter((entry) => entry instanceof File)
                .filter(entry => this.shouldIncludeFile(entry.name))
                .map(entry => ({
                file: entry,
                uri: targetUri.resolve(entry.name)
            }));
            return files;
        }
        else if (source instanceof DataTransfer) {
            // Use WebKit Entries for folder traversal
            if (source.items && this.supportsWebKitEntries()) {
                // Collect all files first
                const allFiles = [];
                const items = Array.from(source.items);
                const entries = items.map(item => item.webkitGetAsEntry()).filter((entry) => !!entry);
                for (let i = 0; i < entries.length; i++) {
                    const entry = entries[i];
                    const filesFromEntry = await this.traverseEntry(targetUri, entry, token);
                    allFiles.push(...filesFromEntry);
                }
                return allFiles;
            }
            else {
                // Fall back to flat file list
                return Array.from(source.files)
                    .filter((file) => !!file)
                    .filter(file => this.shouldIncludeFile(file.name))
                    .map(file => ({
                    file,
                    uri: targetUri.resolve(file.name)
                }));
            }
        }
        else {
            // Handle CustomDataTransfer declaratively
            const files = await Promise.all(Array.from(source)
                .map(async ([, item]) => {
                const fileData = item.asFile();
                if (fileData && this.shouldIncludeFile(fileData.name)) {
                    const data = await fileData.data();
                    return {
                        file: new File([data], fileData.name, { type: 'application/octet-stream' }),
                        uri: targetUri.resolve(fileData.name)
                    };
                }
                return undefined;
            }));
            return files.filter(Boolean);
        }
    }
    /**
     * Traverse WebKit Entries (files and folders)
     */
    async traverseEntry(base, entry, token) {
        if (!entry) {
            return [];
        }
        // Skip system entries
        if (!this.shouldIncludeFile(entry.name)) {
            return [];
        }
        // directory
        if (entry.isDirectory) {
            const dir = entry;
            const newBase = base.resolve(dir.name);
            const entries = await this.readAllEntries(dir, token);
            (0, cancellation_1.checkCancelled)(token);
            const chunks = await Promise.all(entries.map(sub => this.traverseEntry(newBase, sub, token)));
            return chunks.flat();
        }
        // file
        const fileEntry = entry;
        const file = await this.readFileEntry(fileEntry, token);
        (0, cancellation_1.checkCancelled)(token);
        return [{ file, uri: base.resolve(entry.name) }];
    }
    /**
     * Read all entries from a WebKit directory entry
     */
    async readAllEntries(dir, token) {
        const reader = dir.createReader();
        const out = [];
        while (true) {
            (0, cancellation_1.checkCancelled)(token);
            const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
            if (!batch.length) {
                break;
            }
            out.push(...batch);
            // yield to the event loop to keep UI responsive
            await Promise.resolve();
        }
        return out;
    }
    /**
     * Read a file from a WebKit file entry
     */
    async readFileEntry(fileEntry, token) {
        (0, cancellation_1.checkCancelled)(token);
        try {
            return await new Promise((resolve, reject) => fileEntry.file(resolve, reject));
        }
        catch (err) {
            throw err;
        }
    }
    supportsWebKitEntries() {
        return typeof DataTransferItem.prototype.webkitGetAsEntry === 'function';
    }
    shouldIncludeFile(path) {
        return !this.ignorePatterns.some((pattern) => (0, minimatch_1.minimatch)(path, pattern));
    }
};
exports.FileUploadServiceImpl = FileUploadServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(filesystem_preferences_1.FileSystemPreferences),
    tslib_1.__metadata("design:type", Object)
], FileUploadServiceImpl.prototype, "fileSystemPreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], FileUploadServiceImpl.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(message_service_1.MessageService),
    tslib_1.__metadata("design:type", message_service_1.MessageService)
], FileUploadServiceImpl.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], FileUploadServiceImpl.prototype, "init", null);
exports.FileUploadServiceImpl = FileUploadServiceImpl = FileUploadServiceImpl_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FileUploadServiceImpl);
//# sourceMappingURL=file-upload-service-impl.js.map