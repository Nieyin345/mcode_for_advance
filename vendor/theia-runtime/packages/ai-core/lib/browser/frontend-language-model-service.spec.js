"use strict";
// *****************************************************************************
// Copyright (C) 2026 Safi Seid-Ahmad, K2view and others.
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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const chai_1 = require("chai");
const ai_core_preferences_1 = require("../common/ai-core-preferences");
const frontend_language_model_service_1 = require("./frontend-language-model-service");
disableJSDOM();
const O_SERIES = { supportedLevels: ['off', 'low', 'medium', 'high', 'auto'], defaultLevel: 'auto' };
const GPT5 = { supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'auto'], defaultLevel: 'auto' };
/** Service with the trust check and the reasoning preference entries stubbed; nothing else in `sendRequest` needs a container. */
function createService(reasoningEntries = []) {
    const service = new frontend_language_model_service_1.FrontendLanguageModelServiceImpl();
    Object.assign(service, {
        workspaceTrustService: { getWorkspaceTrust: async () => true },
        aiConfiguration: { get: (key, defaultValue) => key === ai_core_preferences_1.PREFERENCE_NAME_REASONING ? reasoningEntries : defaultValue }
    });
    return service;
}
function createModel(id, reasoningSupport, captured) {
    return {
        id,
        reasoningSupport,
        status: { status: 'ready' },
        request: async (request) => {
            captured.push(request);
            return { text: '' };
        }
    };
}
function createRequest(reasoning) {
    return { messages: [{ actor: 'user', type: 'text', text: 'hello' }], agentId: 'agent', sessionId: 'session', requestId: 'request', reasoning };
}
describe('FrontendLanguageModelServiceImpl reasoning level', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    it('clamps a session-selected level the model does not support to the nearest supported one', async () => {
        const captured = [];
        await createService().sendRequest(createModel('openai/o3', O_SERIES, captured), createRequest({ level: 'minimal' }));
        (0, chai_1.expect)(captured[0].reasoning).to.deep.equal({ level: 'low' });
    });
    it('clamps a preference-entry level the model does not support', async () => {
        const captured = [];
        const service = createService([{ scope: { providerId: 'openai' }, reasoning: { level: 'minimal' } }]);
        await service.sendRequest(createModel('openai/o3', O_SERIES, captured), createRequest());
        (0, chai_1.expect)(captured[0].reasoning).to.deep.equal({ level: 'low' });
    });
    it('keeps a level the model supports', async () => {
        const captured = [];
        await createService().sendRequest(createModel('openai/gpt-5', GPT5, captured), createRequest({ level: 'minimal' }));
        (0, chai_1.expect)(captured[0].reasoning).to.deep.equal({ level: 'minimal' });
    });
    it('leaves the level untouched for models without reasoning support', async () => {
        const captured = [];
        await createService().sendRequest(createModel('openai/gpt-4o', undefined, captured), createRequest({ level: 'high' }));
        (0, chai_1.expect)(captured[0].reasoning).to.deep.equal({ level: 'high' });
    });
});
//# sourceMappingURL=frontend-language-model-service.spec.js.map