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
exports.FrontendPreferenceStorage = void 0;
const core_1 = require("@theia/core");
class FrontendPreferenceStorage {
    constructor(transactionFactory, fileService, uri, scope) {
        this.transactionFactory = transactionFactory;
        this.fileService = fileService;
        this.uri = uri;
        this.scope = scope;
        this.onDidChangeFileContentListeners = new core_1.ListenerList();
        this.toDispose = new core_1.DisposableCollection();
        this.onDidChangeFileContent = this.onDidChangeFileContentListeners.registration;
        this.fileService.watch(uri);
        this.fileService.onDidFilesChange(e => {
            if (e.contains(uri)) {
                this.read().then(content => this.onDidChangeFileContentListeners.invoke({ content, fileOK: true }, () => { }))
                    .catch(() => this.onDidChangeFileContentListeners.invoke({ content: '', fileOK: false }, () => { }));
            }
        });
    }
    dispose() {
        this.toDispose.dispose();
    }
    writeValue(key, path, value) {
        if (!this.transaction?.open) {
            const current = this.transaction;
            this.transaction = this.transactionFactory({
                getScope: () => this.scope,
                getConfigUri: () => this.uri
            }, current?.result);
            this.transaction.onWillConclude(async (status) => {
                if (status) {
                    const content = await this.read();
                    await core_1.Listener.awaitAll({ content, fileOK: true }, this.onDidChangeFileContentListeners);
                }
            });
            this.toDispose.push(this.transaction);
        }
        return this.transaction.enqueueAction(key, path, value);
    }
    async read() {
        return (await this.fileService.read(this.uri)).value;
    }
}
exports.FrontendPreferenceStorage = FrontendPreferenceStorage;
//# sourceMappingURL=frontend-preference-storage.js.map