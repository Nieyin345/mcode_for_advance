"use strict";
// *****************************************************************************
// Copyright (C) 2021 Ericsson and others.
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
/* eslint-disable @typescript-eslint/no-explicit-any */
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const chai_1 = require("chai");
const inversify_1 = require("@theia/core/shared/inversify");
const abstract_resource_preference_provider_1 = require("./abstract-resource-preference-provider");
const frontend_application_bindings_1 = require("@theia/core/lib/browser/frontend-application-bindings");
const test_1 = require("@theia/core/lib/browser/preferences/test");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const common_1 = require("@theia/core/lib/common");
const monaco_workspace_1 = require("@theia/monaco/lib/browser/monaco-workspace");
const browser_1 = require("@theia/editor/lib/browser");
const preference_transaction_manager_1 = require("../browser/preference-transaction-manager");
const core_1 = require("@theia/core");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
disableJSDOM();
class MockPreferenceStorage {
    constructor() {
        this.onDidChangeFileContent = common_1.Listener.None;
        this.disposed = false;
        this.releaseContent = new promise_util_1.Deferred();
    }
    writeValue(key, path, value) {
        throw new Error('Method not implemented.');
    }
    dispose() {
        this.disposed = true;
    }
    async read() {
        await this.releaseContent.promise;
        return JSON.stringify({ 'editor.fontSize': 20 });
    }
}
const mockSchemaProvider = { getSchemaProperty: () => undefined };
class LessAbstractPreferenceProvider extends abstract_resource_preference_provider_1.AbstractResourcePreferenceProvider {
    getUri() { }
    getScope() { }
}
describe('AbstractResourcePreferenceProvider', () => {
    let provider;
    let preferenceStorage;
    beforeEach(() => {
        preferenceStorage = new MockPreferenceStorage();
        const testContainer = new inversify_1.Container();
        testContainer.bind(core_1.ILogger).to(mock_logger_1.MockLogger).inSingletonScope();
        (0, frontend_application_bindings_1.bindPreferenceService)(testContainer.bind.bind(testContainer));
        (0, test_1.bindMockPreferenceProviders)(testContainer.bind.bind(testContainer), testContainer.unbind.bind(testContainer));
        testContainer.rebind(common_1.PreferenceSchemaService).toConstantValue(mockSchemaProvider);
        testContainer.bind(abstract_resource_preference_provider_1.PreferenceStorageFactory).toFactory(() => () => preferenceStorage);
        testContainer.bind(common_1.MessageService).toConstantValue(undefined);
        testContainer.bind(monaco_workspace_1.MonacoWorkspace).toConstantValue(undefined);
        testContainer.bind(browser_1.EditorManager).toConstantValue(undefined);
        testContainer.bind(preference_transaction_manager_1.PreferenceTransactionFactory).toConstantValue(undefined);
        provider = testContainer.resolve(LessAbstractPreferenceProvider);
    });
    it('should not store any preferences before it is ready.', async () => {
        const resolveWhenFinished = new promise_util_1.Deferred();
        const errorIfReadyFirst = provider.ready.then(() => Promise.reject());
        (0, chai_1.expect)(provider.get('editor.fontSize')).to.be.undefined;
        resolveWhenFinished.resolve();
        preferenceStorage.releaseContent.resolve(); // Allow the initialization to run
        // This promise would reject if the provider had declared itself ready before we resolve `resolveWhenFinished`
        await Promise.race([resolveWhenFinished.promise, errorIfReadyFirst]);
    });
    it('should report values in file when `ready` resolves.', async () => {
        preferenceStorage.releaseContent.resolve();
        await provider.ready;
        (0, chai_1.expect)(provider.get('editor.fontSize')).to.equal(20); // The value provided by the mock FileService implementation.
    });
    it('disposes its preference storage when the provider is disposed', () => {
        (0, chai_1.expect)(preferenceStorage.disposed).to.be.false;
        provider.dispose();
        (0, chai_1.expect)(preferenceStorage.disposed).to.be.true;
    });
});
//# sourceMappingURL=abstract-resource-preference-provider.spec.js.map