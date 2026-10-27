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
const model_discovery_status_service_1 = require("./model-discovery-status-service");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
/** The service logs a failed run, so a bare instance would have no logger to do it with. */
function createService() {
    return Object.assign(new model_discovery_status_service_1.ModelDiscoveryStatusService(), { logger: new mock_logger_1.MockLogger() });
}
describe('ModelDiscoveryStatusService', () => {
    it('registers a provider with an initial idle status', () => {
        const service = createService();
        service.registerProvider({ providerId: 'anthropic', label: 'Anthropic', refresh: async () => { } });
        const status = service.getStatus('anthropic');
        (0, chai_1.expect)(status?.state).to.equal('idle');
        (0, chai_1.expect)(status?.label).to.equal('Anthropic');
    });
    it('merges partial updates and fires onDidChange', () => {
        const service = createService();
        service.registerProvider({ providerId: 'anthropic', label: 'Anthropic', refresh: async () => { } });
        const events = [];
        service.onDidChange(e => events.push(e));
        service.updateStatus('anthropic', { state: 'fetching' });
        service.updateStatus('anthropic', { state: 'ready', lastFetch: 123, fromCache: false });
        const status = service.getStatus('anthropic');
        (0, chai_1.expect)(status?.state).to.equal('ready');
        (0, chai_1.expect)(status?.lastFetch).to.equal(123);
        // label is carried over from registration.
        (0, chai_1.expect)(status?.label).to.equal('Anthropic');
        (0, chai_1.expect)(events.map(e => e.state)).to.deep.equal(['fetching', 'ready']);
    });
    it('does not reset an existing status when the provider is re-registered', () => {
        const service = createService();
        service.registerProvider({ providerId: 'anthropic', label: 'Anthropic', refresh: async () => { } });
        service.updateStatus('anthropic', { state: 'ready' });
        service.registerProvider({ providerId: 'anthropic', label: 'Anthropic', refresh: async () => { } });
        (0, chai_1.expect)(service.getStatus('anthropic')?.state).to.equal('ready');
    });
    it('reports a failure and clears what the previous state offered', () => {
        const service = createService();
        service.registerProvider({ providerId: 'copilot', label: 'GitHub Copilot', refresh: async () => { } });
        service.updateStatus('copilot', {
            state: 'no-credentials',
            stateLabel: 'Not signed in',
            action: { label: 'Sign in', commandId: 'copilot.signIn' }
        });
        service.reportError('copilot', new Error('the CLI is not talking'));
        const status = service.getStatus('copilot');
        (0, chai_1.expect)(status?.state).to.equal('error');
        (0, chai_1.expect)(status?.message).to.equal('the CLI is not talking');
        // A failure must not keep reading like the state before it.
        (0, chai_1.expect)(status?.stateLabel).to.equal(undefined);
        (0, chai_1.expect)(status?.action).to.equal(undefined);
    });
    it('reports a rejection that is not an error', () => {
        const service = createService();
        service.registerProvider({ providerId: 'anthropic', label: 'Anthropic', refresh: async () => { } });
        service.reportError('anthropic', 'nope');
        (0, chai_1.expect)(service.getStatus('anthropic')?.message).to.equal('nope');
    });
    it('delegates refresh to the registered provider', async () => {
        const service = createService();
        let refreshed = false;
        service.registerProvider({ providerId: 'anthropic', label: 'Anthropic', refresh: async () => { refreshed = true; } });
        await service.refresh('anthropic');
        (0, chai_1.expect)(refreshed).to.be.true;
        // Refreshing an unknown provider is a no-op and does not throw.
        await service.refresh('unknown');
    });
});
//# sourceMappingURL=model-discovery-status-service.spec.js.map