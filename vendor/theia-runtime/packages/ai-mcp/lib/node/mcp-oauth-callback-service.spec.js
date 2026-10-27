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
const mcp_oauth_callback_service_1 = require("./mcp-oauth-callback-service");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
/**
 * Exposes the protected `reserveCallback` so the timeout test can install a short-lived timer without
 * waiting `MCP_OAUTH_CALLBACK_TIMEOUT` (the default used by production callers via `createState`). The
 * public `waitForCallback` no longer accepts a timeout parameter — timeout ownership lives with the
 * reservation, not the wait.
 */
class TestableMCPOAuthCallbackService extends mcp_oauth_callback_service_1.MCPOAuthCallbackService {
    reserveForTest(state, timeout) {
        this.reserveCallback(state, timeout);
    }
}
describe('MCPOAuthCallbackService', () => {
    let service;
    beforeEach(() => {
        service = new TestableMCPOAuthCallbackService();
        service.logger = new mock_logger_1.MockLogger();
    });
    it('resolves a waiting callback', async () => {
        const promise = service.waitForCallback('state');
        (0, chai_1.expect)(service.acceptCallback({ state: 'state', code: 'code' })).to.be.true;
        (0, chai_1.expect)(await promise).to.deep.equal({ state: 'state', code: 'code' });
    });
    it('queues callbacks that arrive between createState and waitForCallback', async () => {
        const state = service.createState();
        // Callback arrives before waitForCallback subscribes. The reserved deferred from createState
        // accepts the callback so waitForCallback can observe the result instead of failing as
        // 'unknown state' in the callback route.
        (0, chai_1.expect)(service.acceptCallback({ state, code: 'code' })).to.be.true;
        (0, chai_1.expect)(await service.waitForCallback(state)).to.deep.equal({ state, code: 'code' });
    });
    it('propagates a cancellation that occurred between createState and waitForCallback', async () => {
        const state = service.createState();
        service.cancel(state);
        try {
            await service.waitForCallback(state);
            throw new Error('Expected cancellation');
        }
        catch (error) {
            (0, chai_1.expect)(error.message).to.equal(mcp_oauth_callback_service_1.MCP_OAUTH_AUTHORIZATION_CANCELLED);
        }
    });
    it('ignores unknown callback states', () => {
        (0, chai_1.expect)(service.acceptCallback({ state: 'missing', code: 'code' })).to.be.false;
    });
    it('remembers cancelled callback states for late browser callbacks', async () => {
        const promise = service.waitForCallback('state');
        service.cancel('state');
        try {
            await promise;
            throw new Error('Expected cancellation');
        }
        catch (error) {
            (0, chai_1.expect)(error.message).to.equal(mcp_oauth_callback_service_1.MCP_OAUTH_AUTHORIZATION_CANCELLED);
        }
        (0, chai_1.expect)(service.consumeRejectedCallbackMessage('state')).to.equal('OAuth authorization was cancelled. You can close this tab.');
        (0, chai_1.expect)(service.consumeRejectedCallbackMessage('state')).to.be.undefined;
    });
    it('evicts old active callback states when the limit is reached', async () => {
        const promises = [];
        for (let index = 0; index <= mcp_oauth_callback_service_1.MCP_OAUTH_ACTIVE_CALLBACK_LIMIT; index++) {
            promises.push(service.waitForCallback(`state-${index}`).catch(error => error));
        }
        const firstResult = await promises[0];
        (0, chai_1.expect)(firstResult.message).to.equal(mcp_oauth_callback_service_1.MCP_OAUTH_AUTHORIZATION_CANCELLED);
        (0, chai_1.expect)(service.acceptCallback({ state: 'state-0', code: 'code' })).to.be.false;
        (0, chai_1.expect)(service.consumeRejectedCallbackMessage('state-0'))
            .to.equal('OAuth authorization was cancelled because too many authorization attempts are in progress.');
        (0, chai_1.expect)(service.acceptCallback({ state: `state-${mcp_oauth_callback_service_1.MCP_OAUTH_ACTIVE_CALLBACK_LIMIT}`, code: 'code' })).to.be.true;
    });
    it('rejects when a wait times out', async () => {
        service.reserveForTest('state', 1);
        try {
            await service.waitForCallback('state');
            throw new Error('Expected timeout');
        }
        catch (error) {
            (0, chai_1.expect)(error.message).to.equal('Timed out waiting for MCP OAuth authorization callback.');
        }
    });
    it('evicts old rejected callback states when the limit is reached', async () => {
        for (let index = 0; index <= mcp_oauth_callback_service_1.MCP_OAUTH_REJECTED_CALLBACK_LIMIT; index++) {
            const promise = service.waitForCallback(`state-${index}`);
            service.cancel(`state-${index}`);
            await promise.catch(() => undefined);
        }
        (0, chai_1.expect)(service.consumeRejectedCallbackMessage('state-0')).to.be.undefined;
        (0, chai_1.expect)(service.consumeRejectedCallbackMessage(`state-${mcp_oauth_callback_service_1.MCP_OAUTH_REJECTED_CALLBACK_LIMIT}`))
            .to.equal('OAuth authorization was cancelled. You can close this tab.');
    });
});
//# sourceMappingURL=mcp-oauth-callback-service.spec.js.map