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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
// Another spec in this package may have already set the configuration; mocha loads all
// specs into one process and `set` throws if called twice, so guard it.
try {
    frontend_application_config_provider_1.FrontendApplicationConfigProvider.get();
}
catch {
    frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
}
require("reflect-metadata");
const chai_1 = require("chai");
const sinon = require("sinon");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const mcp_frontend_application_contribution_1 = require("./mcp-frontend-application-contribution");
const common_1 = require("../common");
const workspace_trust_service_1 = require("@theia/workspace/lib/browser/workspace-trust-service");
const workspace_service_1 = require("@theia/workspace/lib/browser/workspace-service");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
disableJSDOM();
describe('McpFrontendApplicationContribution', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    let contribution;
    let mockFrontendMCPService;
    let mockManager;
    beforeEach(() => {
        const container = new inversify_1.Container();
        mockFrontendMCPService = {
            startServer: sinon.stub().resolves(),
            stopServer: sinon.stub().resolves(),
            hasServer: sinon.stub().resolves(false),
            isServerStarted: sinon.stub().resolves(false),
            registerToolsForAllStartedServers: sinon.stub().resolves(),
            addOrUpdateServer: sinon.stub().resolves(),
            getStartedServers: sinon.stub().resolves([]),
            getServerNames: sinon.stub().resolves([]),
            getServerDescription: sinon.stub().resolves(undefined),
            getTools: sinon.stub().resolves(undefined),
            getPromptTemplateId: sinon.stub().returns(''),
        };
        mockManager = {
            callTool: sinon.stub().resolves({ content: [] }),
            removeServer: sinon.stub().resolves(),
            addOrUpdateServer: sinon.stub().resolves(),
            getTools: sinon.stub().resolves({ tools: [] }),
            getServerNames: sinon.stub().resolves([]),
            getServerDescription: sinon.stub().resolves(undefined),
            startServer: sinon.stub().resolves(),
            stopServer: sinon.stub().resolves(),
            getRunningServers: sinon.stub().resolves([]),
            setClient: sinon.stub(),
            disconnectClient: sinon.stub(),
            readResource: sinon.stub().resolves({ contents: [] }),
            getResources: sinon.stub().resolves({ resources: [] }),
            setWorkspaceRoots: sinon.stub(),
        };
        const mockPreferenceService = {
            ready: Promise.resolve(),
            get: sinon.stub().returns({}),
            onPreferenceChanged: sinon.stub().returns({ dispose: () => { } }),
        };
        const mockWorkspaceTrustService = {
            getWorkspaceTrust: sinon.stub().resolves(true),
            onDidChangeWorkspaceTrust: sinon.stub().returns({ dispose: () => { } }),
            refreshRestrictedModeIndicator: sinon.stub(),
        };
        const mockWorkspaceService = {
            tryGetRoots: sinon.stub().returns([]),
            onWorkspaceChanged: sinon.stub().returns({ dispose: () => { } }),
        };
        const mockMessageService = {
            warn: sinon.stub().resolves(undefined),
            error: sinon.stub().resolves(undefined),
            info: sinon.stub().resolves(undefined),
        };
        container.bind(mcp_frontend_application_contribution_1.McpFrontendApplicationContribution).toSelf().inSingletonScope();
        container.bind(core_1.PreferenceService).toConstantValue(mockPreferenceService);
        container.bind(common_1.MCPServerManager).toConstantValue(mockManager);
        container.bind(common_1.MCPFrontendService).toConstantValue(mockFrontendMCPService);
        container.bind(workspace_trust_service_1.WorkspaceTrustService).toConstantValue(mockWorkspaceTrustService);
        container.bind(workspace_service_1.WorkspaceService).toConstantValue(mockWorkspaceService);
        container.bind(core_1.ILogger).to(mock_logger_1.MockLogger).inSingletonScope();
        container.bind(core_1.MessageService).toConstantValue(mockMessageService);
        container.bind(common_1.MCPOAuthFrontendDelegate).toConstantValue({
            getCallbackUrl: () => Promise.resolve('')
        });
        container.bind(common_1.MCPFrontendNotificationService).toConstantValue({
            onDidUpdateMCPServers: () => ({ dispose: () => { } }),
            didUpdateMCPServers: () => { }
        });
        contribution = container.get(mcp_frontend_application_contribution_1.McpFrontendApplicationContribution);
    });
    afterEach(() => {
        sinon.restore();
    });
    describe('handleServerChanges', () => {
        it('removes a server via the manager when it is no longer configured', async () => {
            // The OAuth work made `MCPServerManager.removeServer` perform the full lifecycle teardown
            // (stop + credential cleanup), so the contribution no longer calls `stopServer` separately.
            contribution.prevServers = new Map([
                ['test-server', { name: 'test-server', command: 'node', args: ['server.js'], autostart: true }]
            ]);
            await contribution.handleServerChanges({});
            (0, chai_1.expect)(mockManager.removeServer.calledOnce).to.be.true;
            (0, chai_1.expect)(mockManager.removeServer.calledWith('test-server')).to.be.true;
        });
        it('removes each server that is no longer configured via the manager', async () => {
            contribution.prevServers = new Map([
                ['server-a', { name: 'server-a', command: 'node', args: ['a.js'], autostart: false }],
                ['server-b', { name: 'server-b', serverUrl: 'http://example.com', autostart: false }],
                ['server-c', { name: 'server-c', command: 'node', args: ['c.js'], autostart: false }]
            ]);
            // Only server-b remains
            await contribution.handleServerChanges({
                'server-b': { serverUrl: 'http://example.com' }
            });
            (0, chai_1.expect)(mockManager.removeServer.calledWith('server-a')).to.be.true;
            (0, chai_1.expect)(mockManager.removeServer.calledWith('server-c')).to.be.true;
            (0, chai_1.expect)(mockManager.removeServer.calledWith('server-b')).to.be.false;
        });
        it('does not call stopServer or removeServer when no servers are removed', async () => {
            contribution.prevServers = new Map([
                ['existing-server', { name: 'existing-server', command: 'node', autostart: true }]
            ]);
            await contribution.handleServerChanges({
                'existing-server': { command: 'node' }
            });
            (0, chai_1.expect)(mockFrontendMCPService.stopServer.called).to.be.false;
            (0, chai_1.expect)(mockManager.removeServer.called).to.be.false;
        });
        it('calls addOrUpdateServer for new servers', async () => {
            contribution.prevServers = new Map();
            await contribution.handleServerChanges({
                'new-server': { command: 'node', args: ['server.js'] }
            });
            (0, chai_1.expect)(mockManager.addOrUpdateServer.calledOnce).to.be.true;
            const addedServer = mockManager.addOrUpdateServer.firstCall.args[0];
            (0, chai_1.expect)(addedServer.name).to.equal('new-server');
        });
        it('calls addOrUpdateServer for updated servers', async () => {
            contribution.prevServers = new Map([
                ['my-server', { name: 'my-server', command: 'node', args: ['old.js'], autostart: true }]
            ]);
            await contribution.handleServerChanges({
                'my-server': { command: 'node', args: ['new.js'] }
            });
            (0, chai_1.expect)(mockFrontendMCPService.stopServer.called).to.be.false;
            (0, chai_1.expect)(mockManager.removeServer.called).to.be.false;
            (0, chai_1.expect)(mockManager.addOrUpdateServer.calledOnce).to.be.true;
        });
        it('clears blockedUntrustedServers entry when a server is removed', async () => {
            contribution.prevServers = new Map([
                ['blocked-server', { name: 'blocked-server', command: 'node', autostart: true }]
            ]);
            // Simulate the server having been blocked
            contribution.blockedUntrustedServers.add('blocked-server');
            await contribution.handleServerChanges({});
            (0, chai_1.expect)(contribution.blockedUntrustedServers.has('blocked-server')).to.be.false;
        });
        it('updates prevServers after handling changes', async () => {
            contribution.prevServers = new Map([
                ['old-server', { name: 'old-server', command: 'node', autostart: true }]
            ]);
            await contribution.handleServerChanges({
                'new-server': { command: 'python', args: ['serve.py'] }
            });
            (0, chai_1.expect)(contribution.prevServers.has('old-server')).to.be.false;
            (0, chai_1.expect)(contribution.prevServers.has('new-server')).to.be.true;
        });
    });
});
describe('McpFrontendApplicationContribution workspace-trust handlers', () => {
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        disableJSDOM();
    });
    function createContribution(options) {
        const contribution = new TestMcpFrontendApplicationContribution();
        contribution.logger = new mock_logger_1.MockLogger();
        const runningServers = [...(options.runningServers ?? [])];
        // Default active set = running set. Tests that exercise in-flight (Starting/Connecting/
        // AuthenticationRequired) behavior pass `activeServers` explicitly.
        const activeServers = [...(options.activeServers ?? options.runningServers ?? [])];
        const prev = new Map();
        for (const desc of options.prevServers ?? []) {
            prev.set(desc.name, desc);
        }
        contribution.frontendMCPService = {
            getStartedServers: async () => [...runningServers],
            getActiveServers: async () => [...activeServers],
            stopServer: async (name) => {
                options.onStop?.(name);
                const runningIndex = runningServers.indexOf(name);
                if (runningIndex >= 0) {
                    runningServers.splice(runningIndex, 1);
                }
                const activeIndex = activeServers.indexOf(name);
                if (activeIndex >= 0) {
                    activeServers.splice(activeIndex, 1);
                }
            },
            startServer: async (name) => {
                options.onStart?.(name);
                runningServers.push(name);
                if (!activeServers.includes(name)) {
                    activeServers.push(name);
                }
            },
            startServerInteractive: async () => true,
            hasStoredOAuthCredentials: async (name) => options.hasStoredOAuthCredentials?.(name) ?? false,
            // Returns the prev description merged with the test-configured post-start status so the
            // contribution's AuthenticationRequired check can fire when configured.
            getServerDescription: async (name) => {
                const baseDescription = prev.get(name);
                if (!baseDescription) {
                    return undefined;
                }
                return { ...baseDescription, status: options.postStartStatus?.[name] };
            }
        };
        contribution.workspaceTrustService = {
            refreshRestrictedModeIndicator: () => { }
        };
        contribution.messageService = {
            warn: () => Promise.resolve(undefined),
            // Sign-in prompts are shown via `showProgress` so the contribution can dismiss them once the
            // start attempt concludes. The fake result only settles when the simulated user picks an
            // action, mirroring the real toast which stays open until clicked or cancelled.
            showProgress: async (message) => {
                const action = options.onSignInPrompt?.(message);
                return {
                    id: 'test-progress',
                    report: () => { },
                    cancel: () => options.onSignInPromptCancel?.(message),
                    result: action !== undefined ? Promise.resolve(action) : new Promise(() => { })
                };
            }
        };
        contribution.setPrevServers(prev);
        contribution.setBlockedServers(options.blockedServers ?? []);
        return contribution;
    }
    describe('stopAllServers', () => {
        it('stops only currently running servers and tracks autostart servers as blocked', async () => {
            const stopped = [];
            const contribution = createContribution({
                runningServers: ['running-autostart', 'running-manual'],
                prevServers: [
                    { name: 'running-autostart', command: 'node', autostart: true },
                    { name: 'running-manual', command: 'node', autostart: false },
                    // A manually-started, non-running, non-autostart server stays stopped on re-trust by design.
                    { name: 'idle', command: 'node', autostart: false }
                ],
                onStop: name => stopped.push(name)
            });
            await contribution.testStopAllServers();
            (0, chai_1.expect)(stopped).to.have.members(['running-autostart', 'running-manual']);
            // Only the running autostart server is queued for restart on re-trust.
            (0, chai_1.expect)(contribution.getBlockedServers()).to.deep.equal(['running-autostart']);
            (0, chai_1.expect)(contribution.refreshCalls).to.equal(1);
        });
        it('does nothing when no servers are running', async () => {
            const stopped = [];
            const contribution = createContribution({
                runningServers: [],
                prevServers: [
                    { name: 'idle-autostart', command: 'node', autostart: true }
                ],
                onStop: name => stopped.push(name)
            });
            await contribution.testStopAllServers();
            (0, chai_1.expect)(stopped).to.deep.equal([]);
            (0, chai_1.expect)(contribution.getBlockedServers()).to.deep.equal([]);
        });
        it('interrupts in-flight (Starting / Connecting / AuthenticationRequired) servers when trust is lost', async () => {
            // A server whose lifecycle is between Starting and Connected at the moment trust is lost must
            // be stopped: otherwise the SDK can finish authorization in the now-untrusted workspace and
            // transition the server into Connected, contradicting the upfront trust gate in
            // `startServerInteractive`. `MCPServerManagerImpl.stopServer` cancels OAuth state before
            // awaiting `server.stop()`, so this also rejects a pending `waitForCallback`.
            const stopped = [];
            const contribution = createContribution({
                runningServers: ['running-autostart'],
                activeServers: ['running-autostart', 'oauth-in-flight', 'local-starting'],
                prevServers: [
                    { name: 'running-autostart', command: 'node', autostart: true },
                    { name: 'oauth-in-flight', serverUrl: 'https://mcp.example.com/mcp', autostart: true, oauth: {} },
                    { name: 'local-starting', command: 'node', autostart: false }
                ],
                onStop: name => stopped.push(name)
            });
            await contribution.testStopAllServers();
            // All three active servers are stopped, regardless of whether they had reached Running.
            (0, chai_1.expect)(stopped).to.have.members(['running-autostart', 'oauth-in-flight', 'local-starting']);
            // Only autostart servers are queued for restart on re-trust; the in-flight OAuth server is included
            // because its description has autostart=true. local-starting is a manual start and stays stopped.
            (0, chai_1.expect)(contribution.getBlockedServers()).to.have.members(['running-autostart', 'oauth-in-flight']);
        });
    });
    describe('enqueueServerChanges', () => {
        it('surfaces preference-change failures via the message service and keeps the queue healthy', async () => {
            // Without messageService.warn, a failed preference apply only writes to the log and the
            // user has no UI signal that their edit did not land. The queue must also stay healthy so a
            // subsequent successful edit applies; pinning both invariants here.
            const contribution = new TestMcpFrontendApplicationContribution();
            contribution.logger = new mock_logger_1.MockLogger();
            const warnings = [];
            contribution.messageService = {
                warn: async (message) => { warnings.push(message); return undefined; }
            };
            let addCallCount = 0;
            contribution.manager = {
                addOrUpdateServer: async () => {
                    addCallCount++;
                    if (addCallCount === 1) {
                        throw new Error('first apply fails');
                    }
                },
                removeServer: async () => { }
            };
            contribution.frontendMCPService = {
                getStartedServers: async () => []
            };
            contribution.workspaceTrustService = {
                getWorkspaceTrust: async () => true,
                refreshRestrictedModeIndicator: () => { }
            };
            await contribution.testEnqueueServerChanges({ asana: { command: 'node' } });
            (0, chai_1.expect)(warnings).to.have.length(1);
            (0, chai_1.expect)(warnings[0]).to.contain('first apply fails');
            // Queue still healthy: a second enqueue applies (addCallCount increments to 2 without throwing).
            await contribution.testEnqueueServerChanges({ asana: { command: 'node' } });
            (0, chai_1.expect)(addCallCount).to.equal(2);
        });
    });
    describe('startPreviouslyBlockedServers', () => {
        it('is a no-op when nothing is blocked', async () => {
            const started = [];
            const contribution = createContribution({ onStart: name => started.push(name) });
            await contribution.testStartPreviouslyBlockedServers();
            (0, chai_1.expect)(started).to.deep.equal([]);
            // Status bar refresh is skipped on the early-return path because nothing changed.
            (0, chai_1.expect)(contribution.refreshCalls).to.equal(0);
        });
        it('restarts blocked autostart servers and clears the blocked set', async () => {
            const started = [];
            const contribution = createContribution({
                prevServers: [
                    { name: 'autostart-server', command: 'node', autostart: true }
                ],
                blockedServers: ['autostart-server'],
                onStart: name => started.push(name)
            });
            await contribution.testStartPreviouslyBlockedServers();
            (0, chai_1.expect)(started).to.deep.equal(['autostart-server']);
            (0, chai_1.expect)(contribution.getBlockedServers()).to.deep.equal([]);
            (0, chai_1.expect)(contribution.refreshCalls).to.equal(1);
        });
        it('does not restart blocked servers whose autostart was disabled in the meantime', async () => {
            const started = [];
            const contribution = createContribution({
                prevServers: [
                    { name: 'changed-autostart', command: 'node', autostart: false }
                ],
                blockedServers: ['changed-autostart'],
                onStart: name => started.push(name)
            });
            await contribution.testStartPreviouslyBlockedServers();
            (0, chai_1.expect)(started).to.deep.equal([]);
            // The blocked set is still cleared so the indicator refreshes correctly.
            (0, chai_1.expect)(contribution.getBlockedServers()).to.deep.equal([]);
        });
        it('skips the silent start AND prompts the user to sign in when an OAuth-enabled server has no stored credentials', async () => {
            // Without stored credentials the silent start would just hit `redirectToAuthorization` and be
            // rejected by the non-interactive provider. The contribution skips the round-trip and prompts
            // the user directly via a dismissable notification with a Sign In action.
            const started = [];
            const prompts = [];
            const contribution = createContribution({
                prevServers: [
                    { name: 'oauth-server', serverUrl: 'https://mcp.example.com/mcp', autostart: true, oauth: {} }
                ],
                blockedServers: ['oauth-server'],
                hasStoredOAuthCredentials: () => false,
                onStart: name => started.push(name),
                onSignInPrompt: message => {
                    prompts.push(message);
                    return undefined;
                }
            });
            await contribution.testStartPreviouslyBlockedServers();
            (0, chai_1.expect)(started).to.deep.equal([]);
            (0, chai_1.expect)(contribution.getBlockedServers()).to.deep.equal([]);
            (0, chai_1.expect)(prompts).to.have.length(1);
            (0, chai_1.expect)(prompts[0].text).to.contain('oauth-server');
            (0, chai_1.expect)(prompts[0].actions).to.have.length(1);
            (0, chai_1.expect)(prompts[0].actions?.[0]?.toLowerCase()).to.contain('sign in');
            // The user must be able to dismiss the prompt manually; progress notifications have no close button.
            (0, chai_1.expect)(prompts[0].options?.cancelable).to.be.true;
        });
        it('dismisses the sign-in prompt once the server start attempt has concluded', async () => {
            // The prompt is moot once the user signed in through another affordance (e.g. the Connect
            // button in the MCP configuration view) or the start failed; a server update must clear it.
            const prompts = [];
            const cancelled = [];
            const contribution = createContribution({
                prevServers: [
                    { name: 'oauth-server', serverUrl: 'https://mcp.example.com/mcp', autostart: true, oauth: {} }
                ],
                blockedServers: ['oauth-server'],
                hasStoredOAuthCredentials: () => false,
                postStartStatus: { 'oauth-server': common_1.MCPServerStatus.Connected },
                onSignInPrompt: message => {
                    prompts.push(message);
                    return undefined;
                },
                onSignInPromptCancel: message => cancelled.push(message)
            });
            await contribution.testStartPreviouslyBlockedServers();
            // Let the fire-and-forget prompt chain register the progress handle.
            await Promise.resolve();
            await Promise.resolve();
            (0, chai_1.expect)(prompts).to.have.length(1);
            (0, chai_1.expect)(cancelled).to.deep.equal([]);
            // Simulates the server-update notification arriving once the server reached Connected.
            await contribution.testDismissSettledSignInPrompts();
            (0, chai_1.expect)(cancelled).to.have.length(1);
            (0, chai_1.expect)(cancelled[0].text).to.contain('oauth-server');
        });
        it('keeps the sign-in prompt while the server still requires authentication', async () => {
            const cancelled = [];
            const contribution = createContribution({
                prevServers: [
                    { name: 'oauth-server', serverUrl: 'https://mcp.example.com/mcp', autostart: true, oauth: {} }
                ],
                blockedServers: ['oauth-server'],
                hasStoredOAuthCredentials: () => false,
                postStartStatus: { 'oauth-server': common_1.MCPServerStatus.AuthenticationRequired },
                onSignInPrompt: () => undefined,
                onSignInPromptCancel: message => cancelled.push(message)
            });
            await contribution.testStartPreviouslyBlockedServers();
            await Promise.resolve();
            await Promise.resolve();
            await contribution.testDismissSettledSignInPrompts();
            (0, chai_1.expect)(cancelled).to.deep.equal([]);
        });
        it('attempts the silent start when an OAuth-enabled server has stored credentials', async () => {
            const started = [];
            const contribution = createContribution({
                prevServers: [
                    { name: 'oauth-server', serverUrl: 'https://mcp.example.com/mcp', autostart: true, oauth: {} }
                ],
                blockedServers: ['oauth-server'],
                hasStoredOAuthCredentials: name => name === 'oauth-server',
                // Post-start status reaches Connected (refresh succeeded). No notification.
                postStartStatus: { 'oauth-server': common_1.MCPServerStatus.Connected },
                onStart: name => started.push(name)
            });
            await contribution.testStartPreviouslyBlockedServers();
            (0, chai_1.expect)(started).to.deep.equal(['oauth-server']);
        });
        it('prompts the user to sign in when the silent start lands in AuthenticationRequired (refresh failed)', async () => {
            // Stored credentials existed but refresh failed; the silent attempt routes through the
            // non-interactive provider which rejects authorization, leaving the server in
            // AuthenticationRequired. The contribution detects this and prompts the user.
            const started = [];
            const prompts = [];
            const contribution = createContribution({
                prevServers: [
                    { name: 'oauth-server', serverUrl: 'https://mcp.example.com/mcp', autostart: true, oauth: {} }
                ],
                blockedServers: ['oauth-server'],
                hasStoredOAuthCredentials: name => name === 'oauth-server',
                postStartStatus: { 'oauth-server': common_1.MCPServerStatus.AuthenticationRequired },
                onStart: name => started.push(name),
                onSignInPrompt: message => { prompts.push(message); return undefined; }
            });
            await contribution.testStartPreviouslyBlockedServers();
            // Silent start was attempted (credentials present), then prompted because it failed.
            (0, chai_1.expect)(started).to.deep.equal(['oauth-server']);
            (0, chai_1.expect)(prompts).to.have.length(1);
            (0, chai_1.expect)(prompts[0].text).to.contain('oauth-server');
        });
    });
});
describe('McpFrontendApplicationContribution convertToMap', () => {
    // `convertToMap` is a pure projection of the preference value, so no injected collaborators are needed.
    let contribution;
    beforeEach(() => {
        contribution = new TestMcpFrontendApplicationContribution();
    });
    it('carries cwd, pluginRoot and pluginData through to the local server description', () => {
        const result = contribution.testConvertToMap({
            validator: {
                command: './bin/validator',
                args: ['--data', '/home/alex/.agents/plugins/data/devtools/validator'],
                cwd: '/home/alex/.agents/plugins/devtools',
                pluginRoot: '/home/alex/.agents/plugins/devtools',
                pluginData: '/home/alex/.agents/plugins/data/devtools'
            }
        });
        (0, chai_1.expect)(result.get('validator')).to.deep.equal({
            name: 'validator',
            command: './bin/validator',
            args: ['--data', '/home/alex/.agents/plugins/data/devtools/validator'],
            cwd: '/home/alex/.agents/plugins/devtools',
            pluginRoot: '/home/alex/.agents/plugins/devtools',
            pluginData: '/home/alex/.agents/plugins/data/devtools',
            autostart: true
        });
    });
    it('omits cwd, pluginRoot and pluginData when the preference entry does not set them', () => {
        const result = contribution.testConvertToMap({ plain: { command: 'npx' } });
        (0, chai_1.expect)(result.get('plain')).to.deep.equal({ name: 'plain', command: 'npx', autostart: true });
    });
    it('carries a registryMetadata block that identifies an Agent Plugin instead of a registry server', () => {
        const result = contribution.testConvertToMap({
            'plugin-server': {
                command: 'npx',
                registryMetadata: { pluginId: 'io.github.acme/devtools', version: '1.0.0' }
            }
        });
        (0, chai_1.expect)(result.get('plugin-server')?.registryMetadata).to.deep.equal({ pluginId: 'io.github.acme/devtools', version: '1.0.0' });
    });
});
class TestMcpFrontendApplicationContribution extends mcp_frontend_application_contribution_1.McpFrontendApplicationContribution {
    constructor() {
        super(...arguments);
        this.refreshCalls = 0;
    }
    setPrevServers(servers) {
        this.prevServers = servers;
    }
    setBlockedServers(names) {
        this.blockedUntrustedServers = new Set(names);
    }
    getBlockedServers() {
        return Array.from(this.blockedUntrustedServers);
    }
    testStopAllServers() {
        return this.stopAllServers();
    }
    testStartPreviouslyBlockedServers() {
        return this.startPreviouslyBlockedServers();
    }
    testDismissSettledSignInPrompts() {
        return this.dismissSettledSignInPrompts();
    }
    testEnqueueServerChanges(newServers) {
        this.enqueueServerChanges(newServers);
        return this.serverChangeQueue;
    }
    testConvertToMap(servers) {
        return this.convertToMap(servers);
    }
    updateBlockedServersStatusBar() {
        this.refreshCalls++;
    }
}
//# sourceMappingURL=mcp-frontend-application-contribution.spec.js.map