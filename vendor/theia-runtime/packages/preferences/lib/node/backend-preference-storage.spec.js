"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
const chai_1 = require("chai");
const core_1 = require("@theia/core");
const disposable_1 = require("@theia/core/lib/common/disposable");
const event_1 = require("@theia/core/lib/common/event");
const backend_preference_storage_1 = require("./backend-preference-storage");
class MockDiskFileSystemProvider {
    constructor() {
        this.disposed = false;
        this.onDidChangeFile = event_1.Event.None;
    }
    watch() {
        return disposable_1.Disposable.NULL;
    }
    dispose() {
        this.disposed = true;
    }
}
describe('BackendPreferenceStorage', () => {
    it('disposes its file system provider when disposed', () => {
        const provider = new MockDiskFileSystemProvider();
        const storage = new backend_preference_storage_1.BackendPreferenceStorage(provider, new core_1.URI('file:///settings.json'), undefined, undefined);
        (0, chai_1.expect)(provider.disposed).to.be.false;
        storage.dispose();
        (0, chai_1.expect)(provider.disposed).to.be.true;
    });
});
//# sourceMappingURL=backend-preference-storage.spec.js.map