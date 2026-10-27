"use strict";
// *****************************************************************************
// Copyright (C) 2025 STMicroelectronics and others.
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
exports.BackendPreferenceStorage = void 0;
const core_1 = require("@theia/core");
const buffer_1 = require("@theia/core/lib/common/buffer");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const debounce = require("@theia/core/shared/lodash.debounce");
const encodings_1 = require("@theia/core/lib/common/encodings");
class BackendPreferenceStorage {
    constructor(fileSystem, uri, encodingService, jsonEditor) {
        this.fileSystem = fileSystem;
        this.uri = uri;
        this.encodingService = encodingService;
        this.jsonEditor = jsonEditor;
        this.pendingWrites = [];
        this.writeDeferred = new promise_util_1.Deferred();
        this.writeFile = debounce(() => {
            this.doWrite();
        }, 10);
        this.currentContent = undefined;
        this.encoding = encodings_1.UTF8;
        this.onDidChangeFileContentListeners = new core_1.ListenerList();
        this.onDidChangeFileContent = this.onDidChangeFileContentListeners.registration;
        this.fileSystem.watch(uri, { excludes: [], recursive: false });
        this.fileSystem.onDidChangeFile(events => {
            for (const e of events) {
                if (e.resource.isEqual(uri)) {
                    this.read().then(content => this.onDidChangeFileContentListeners.invoke({ content, fileOK: true }, () => { }))
                        .catch(() => this.onDidChangeFileContentListeners.invoke({ content: '', fileOK: false }, () => { }));
                }
            }
        });
    }
    writeValue(key, path, value) {
        this.pendingWrites.push({
            key, path, value
        });
        return this.waitForWrite();
    }
    waitForWrite() {
        const result = this.writeDeferred.promise;
        this.writeFile();
        return result;
    }
    async doWrite() {
        try {
            if (this.currentContent === undefined) {
                await this.read();
            }
            let newContent = this.currentContent || '';
            for (const op of this.pendingWrites) {
                newContent = this.jsonEditor.setValue(newContent, op.path, op.value);
            }
            await this.fileSystem.writeFile(this.uri, this.encodingService.encode(newContent, {
                encoding: this.encoding,
                hasBOM: false
            }).buffer, {
                create: true,
                overwrite: true
            });
            this.currentContent = newContent;
            this.pendingWrites = [];
            await core_1.Listener.awaitAll({ content: newContent, fileOK: true }, this.onDidChangeFileContentListeners);
            this.writeDeferred.resolve(true);
        }
        catch (e) {
            this.currentContent = undefined;
            console.error(e);
            this.writeDeferred.resolve(false);
        }
        finally {
            this.writeDeferred = new promise_util_1.Deferred();
        }
    }
    async read() {
        const contents = buffer_1.BinaryBuffer.wrap(await this.fileSystem.readFile(this.uri));
        this.encoding = (await this.encodingService.detectEncoding(contents)).encoding || this.encoding;
        this.currentContent = this.encodingService.decode(contents, this.encoding);
        return this.currentContent;
    }
    dispose() {
        // Safe to dispose because the provider is bound transient and created solely for this storage.
        this.fileSystem.dispose();
    }
}
exports.BackendPreferenceStorage = BackendPreferenceStorage;
//# sourceMappingURL=backend-preference-storage.js.map