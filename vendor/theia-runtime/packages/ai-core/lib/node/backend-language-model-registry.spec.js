"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
const backend_language_model_registry_1 = require("./backend-language-model-registry");
describe('BackendLanguageModelRegistryImpl.mapToMetaData', () => {
    it('includes serverTools in the metadata DTO sent to the frontend', () => {
        const registry = new backend_language_model_registry_1.BackendLanguageModelRegistryImpl();
        const serverTools = [
            { id: 'web_fetch', name: 'Web Fetch' },
            { id: 'web_search', name: 'Web Search' }
        ];
        const model = {
            id: 'm1',
            vendor: 'anthropic',
            status: { status: 'ready' },
            serverTools,
            async request() { return { text: '' }; }
        };
        const meta = registry.mapToMetaData(model);
        (0, chai_1.expect)(meta.serverTools).to.deep.equal(serverTools);
        (0, chai_1.expect)(meta.vendor).to.equal('anthropic');
    });
    it('leaves serverTools undefined when the model declares none', () => {
        const registry = new backend_language_model_registry_1.BackendLanguageModelRegistryImpl();
        const model = {
            id: 'm2',
            status: { status: 'ready' },
            async request() { return { text: '' }; }
        };
        (0, chai_1.expect)(registry.mapToMetaData(model).serverTools).to.equal(undefined);
    });
});
//# sourceMappingURL=backend-language-model-registry.spec.js.map