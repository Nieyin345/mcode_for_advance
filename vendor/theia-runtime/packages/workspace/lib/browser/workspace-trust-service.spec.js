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
const sinon = require("sinon");
const preferences_1 = require("@theia/core/lib/common/preferences");
const workspace_trust_service_1 = require("./workspace-trust-service");
const workspace_trust_preferences_1 = require("../common/workspace-trust-preferences");
const uri_1 = require("@theia/core/lib/common/uri");
class TestableWorkspaceTrustService extends workspace_trust_service_1.WorkspaceTrustService {
    async testHandlePreferenceChange(change) {
        return this.handlePreferenceChange(change);
    }
    async testHandleWorkspaceChanged() {
        return this.handleWorkspaceChanged();
    }
    setCurrentTrust(trust) {
        this.currentTrust = trust;
    }
    getCurrentTrust() {
        return this.currentTrust;
    }
    isWorkspaceTrustResolved() {
        return super.isWorkspaceTrustResolved();
    }
    async testCalculateWorkspaceTrust() {
        return this.calculateWorkspaceTrust();
    }
    testShouldReloadForTrustChange(newTrust) {
        return this.shouldReloadForTrustChange(newTrust);
    }
    setLastKnownTrustEnabled(value) {
        this.lastKnownTrustEnabled = value;
    }
}
describe('WorkspaceTrustService', () => {
    let service;
    beforeEach(() => {
        service = new TestableWorkspaceTrustService();
    });
    afterEach(() => {
        sinon.restore();
    });
    describe('calculateWorkspaceTrust', () => {
        let workspaceTrustPrefStub;
        let workspaceServiceStub;
        let untitledWorkspaceServiceStub;
        let envVariablesServerStub;
        beforeEach(() => {
            workspaceTrustPrefStub = {
                [workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED]: true,
                [workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW]: false,
                [workspace_trust_preferences_1.WORKSPACE_TRUST_STARTUP_PROMPT]: workspace_trust_preferences_1.WorkspaceTrustPrompt.NEVER,
                [workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS]: []
            };
            workspaceServiceStub = {
                tryGetRoots: () => [],
                workspace: undefined,
                saved: false
            };
            untitledWorkspaceServiceStub = {
                isUntitledWorkspace: () => false
            };
            envVariablesServerStub = {
                getConfigDirUri: async () => 'file:///home/user/.theia'
            };
            service.workspaceTrustPref = workspaceTrustPrefStub;
            service.workspaceService = workspaceServiceStub;
            service.untitledWorkspaceService = untitledWorkspaceServiceStub;
            service.envVariablesServer = envVariablesServerStub;
        });
        it('should return true when trust is disabled', async () => {
            workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED] = false;
            (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.true;
        });
        describe('empty workspace', () => {
            it('should return emptyWindow setting when no workspace is open', async () => {
                workspaceServiceStub.workspace = undefined;
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW] = true;
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.true;
            });
            it('should return false when emptyWindow is false and no workspace', async () => {
                workspaceServiceStub.workspace = undefined;
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW] = false;
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.false;
            });
            it('should return emptyWindow setting for untitled workspace with no folders', async () => {
                workspaceServiceStub.workspace = { resource: new uri_1.default('file:///home/user/.theia/workspaces/Untitled-123.theia-workspace') };
                workspaceServiceStub.tryGetRoots = () => [];
                untitledWorkspaceServiceStub.isUntitledWorkspace = () => true;
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW] = true;
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.true;
            });
            it('should not treat saved workspace with no folders as empty', async () => {
                workspaceServiceStub.workspace = { resource: new uri_1.default('file:///home/user/my.theia-workspace') };
                workspaceServiceStub.tryGetRoots = () => [];
                workspaceServiceStub.saved = true;
                untitledWorkspaceServiceStub.isUntitledWorkspace = () => false;
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW] = true;
                // Should return false because saved workspace with 0 folders is not "empty"
                // and the workspace file is not trusted
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.false;
            });
        });
        describe('single-root workspace', () => {
            it('should return true when folder is in trusted folders', async () => {
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] = ['file:///home/user/project'];
                workspaceServiceStub.workspace = { resource: new uri_1.default('file:///home/user/project') };
                workspaceServiceStub.tryGetRoots = () => [
                    { resource: new uri_1.default('file:///home/user/project') }
                ];
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.true;
            });
            it('should return true when parent folder is trusted', async () => {
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] = ['file:///home/user'];
                workspaceServiceStub.workspace = { resource: new uri_1.default('file:///home/user/project') };
                workspaceServiceStub.tryGetRoots = () => [
                    { resource: new uri_1.default('file:///home/user/project') }
                ];
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.true;
            });
            it('should return false when folder is not trusted', async () => {
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] = ['file:///home/other'];
                workspaceServiceStub.workspace = { resource: new uri_1.default('file:///home/user/project') };
                workspaceServiceStub.tryGetRoots = () => [
                    { resource: new uri_1.default('file:///home/user/project') }
                ];
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.false;
            });
        });
        describe('multi-root workspace', () => {
            it('should return true when all folders are trusted', async () => {
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] = [
                    'file:///home/user/project1',
                    'file:///home/user/project2'
                ];
                workspaceServiceStub.workspace = { resource: new uri_1.default('file:///home/user/my.theia-workspace') };
                workspaceServiceStub.tryGetRoots = () => [
                    { resource: new uri_1.default('file:///home/user/project1') },
                    { resource: new uri_1.default('file:///home/user/project2') }
                ];
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.true;
            });
            it('should return false when one folder is not trusted', async () => {
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] = ['file:///home/user/project1'];
                workspaceServiceStub.workspace = { resource: new uri_1.default('file:///home/user/my.theia-workspace') };
                workspaceServiceStub.tryGetRoots = () => [
                    { resource: new uri_1.default('file:///home/user/project1') },
                    { resource: new uri_1.default('file:///home/user/project2') }
                ];
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.false;
            });
            it('should return true when parent folder covers all roots', async () => {
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] = ['file:///home/user'];
                workspaceServiceStub.workspace = { resource: new uri_1.default('file:///home/user/my.theia-workspace') };
                workspaceServiceStub.tryGetRoots = () => [
                    { resource: new uri_1.default('file:///home/user/project1') },
                    { resource: new uri_1.default('file:///home/user/project2') }
                ];
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.true;
            });
        });
        describe('saved workspace file trust', () => {
            it('should require workspace file to be trusted for saved workspaces', async () => {
                // Folder is trusted but workspace file location is not
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] = ['file:///home/user/project'];
                workspaceServiceStub.workspace = { resource: new uri_1.default('file:///other/location/my.theia-workspace') };
                workspaceServiceStub.saved = true;
                workspaceServiceStub.tryGetRoots = () => [
                    { resource: new uri_1.default('file:///home/user/project') }
                ];
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.false;
            });
            it('should return true when both folder and workspace file are trusted', async () => {
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] = ['file:///home/user'];
                workspaceServiceStub.workspace = { resource: new uri_1.default('file:///home/user/my.theia-workspace') };
                workspaceServiceStub.saved = true;
                workspaceServiceStub.tryGetRoots = () => [
                    { resource: new uri_1.default('file:///home/user/project') }
                ];
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.true;
            });
            it('should not require workspace file trust for unsaved workspaces', async () => {
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] = ['file:///home/user/project'];
                workspaceServiceStub.workspace = { resource: new uri_1.default('file:///tmp/untitled.theia-workspace') };
                workspaceServiceStub.saved = false;
                workspaceServiceStub.tryGetRoots = () => [
                    { resource: new uri_1.default('file:///home/user/project') }
                ];
                (0, chai_1.expect)(await service.testCalculateWorkspaceTrust()).to.be.true;
            });
        });
    });
    describe('handleWorkspaceChanged', () => {
        let resolveWorkspaceTrustStub;
        let getWorkspaceTrustStub;
        let updateRestrictedModeIndicatorStub;
        beforeEach(() => {
            resolveWorkspaceTrustStub = sinon.stub(service, 'resolveWorkspaceTrust').resolves();
            getWorkspaceTrustStub = sinon.stub(service, 'getWorkspaceTrust').resolves(true);
            updateRestrictedModeIndicatorStub = sinon.stub(service, 'updateRestrictedModeIndicator');
        });
        it('should reset trust state when workspace changes', async () => {
            service.setCurrentTrust(true);
            await service.testHandleWorkspaceChanged();
            (0, chai_1.expect)(service.getCurrentTrust()).to.be.undefined;
        });
        it('should re-evaluate trust when workspace changes', async () => {
            service.setCurrentTrust(true);
            await service.testHandleWorkspaceChanged();
            (0, chai_1.expect)(resolveWorkspaceTrustStub.calledOnce).to.be.true;
        });
        it('should update restricted mode indicator after workspace change if not trusted', async () => {
            getWorkspaceTrustStub.resolves(false);
            await service.testHandleWorkspaceChanged();
            (0, chai_1.expect)(updateRestrictedModeIndicatorStub.calledOnceWith(false)).to.be.true;
        });
        it('should reset workspaceTrust deferred to unresolved state', async () => {
            // First resolve the trust
            service.setCurrentTrust(true);
            await service.testHandleWorkspaceChanged();
            // After workspace change, it should be reset and resolved again via resolveWorkspaceTrust
            (0, chai_1.expect)(resolveWorkspaceTrustStub.calledOnce).to.be.true;
        });
    });
    describe('handlePreferenceChange', () => {
        let areAllWorkspaceUrisTrustedStub;
        let setWorkspaceTrustStub;
        let isEmptyWorkspaceStub;
        let workspaceTrustPrefStub;
        beforeEach(() => {
            areAllWorkspaceUrisTrustedStub = sinon.stub(service, 'areAllWorkspaceUrisTrusted');
            setWorkspaceTrustStub = sinon.stub(service, 'setWorkspaceTrust').resolves();
            isEmptyWorkspaceStub = sinon.stub(service, 'isEmptyWorkspace');
            // Mock workspaceTrustPref - default emptyWindow to false so trusted folders logic runs;
            // trust is enabled by default so the trustedFolders branch is exercised
            workspaceTrustPrefStub = { [workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW]: false, [workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED]: true };
            service.workspaceTrustPref = workspaceTrustPrefStub;
            // Default to non-empty workspace
            isEmptyWorkspaceStub.resolves(false);
        });
        it('should update trust to true when all workspace URIs become trusted', async () => {
            service.setCurrentTrust(false);
            areAllWorkspaceUrisTrustedStub.resolves(true);
            const change = {
                preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS,
                scope: preferences_1.PreferenceScope.User,
                domain: [],
                affects: () => true
            };
            await service.testHandlePreferenceChange(change);
            (0, chai_1.expect)(setWorkspaceTrustStub.calledOnceWith(true)).to.be.true;
        });
        it('should update trust to false when not all workspace URIs are trusted', async () => {
            service.setCurrentTrust(true);
            areAllWorkspaceUrisTrustedStub.resolves(false);
            const change = {
                preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS,
                scope: preferences_1.PreferenceScope.User,
                domain: [],
                affects: () => true
            };
            await service.testHandlePreferenceChange(change);
            (0, chai_1.expect)(setWorkspaceTrustStub.calledOnceWith(false)).to.be.true;
        });
        it('should not update trust when trustedFolders change does not affect trust status', async () => {
            service.setCurrentTrust(false);
            areAllWorkspaceUrisTrustedStub.resolves(false);
            const change = {
                preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS,
                scope: preferences_1.PreferenceScope.User,
                domain: [],
                affects: () => true
            };
            await service.testHandlePreferenceChange(change);
            (0, chai_1.expect)(setWorkspaceTrustStub.called).to.be.false;
        });
        describe('emptyWindow setting changes', () => {
            beforeEach(() => {
                // Reset to empty workspace for empty window tests
                isEmptyWorkspaceStub.resolves(true);
            });
            it('should update trust to true when emptyWindow setting changes to true for empty window', async () => {
                service.setCurrentTrust(false);
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW] = true;
                const change = {
                    preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW,
                    scope: preferences_1.PreferenceScope.User,
                    domain: [],
                    affects: () => true
                };
                await service.testHandlePreferenceChange(change);
                (0, chai_1.expect)(setWorkspaceTrustStub.calledOnceWith(true, false)).to.be.true;
            });
            it('should update trust to false when emptyWindow setting changes to false for empty window', async () => {
                service.setCurrentTrust(true);
                const change = {
                    preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW,
                    scope: preferences_1.PreferenceScope.User,
                    domain: [],
                    affects: () => true
                };
                await service.testHandlePreferenceChange(change);
                (0, chai_1.expect)(setWorkspaceTrustStub.calledOnceWith(false, false)).to.be.true;
            });
            it('should not update trust when emptyWindow setting changes but workspace has roots', async () => {
                service.setCurrentTrust(false);
                isEmptyWorkspaceStub.resolves(false);
                const change = {
                    preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW,
                    scope: preferences_1.PreferenceScope.User,
                    domain: [],
                    affects: () => true
                };
                await service.testHandlePreferenceChange(change);
                (0, chai_1.expect)(setWorkspaceTrustStub.called).to.be.false;
            });
            it('should not update trust when emptyWindow setting changes but trust already matches', async () => {
                service.setCurrentTrust(true);
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW] = true;
                const change = {
                    preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW,
                    scope: preferences_1.PreferenceScope.User,
                    domain: [],
                    affects: () => true
                };
                await service.testHandlePreferenceChange(change);
                (0, chai_1.expect)(setWorkspaceTrustStub.called).to.be.false;
            });
        });
        describe('workspaceTrustEnabled setting changes', () => {
            let windowServiceStub;
            let confirmRestartStub;
            beforeEach(() => {
                windowServiceStub = { reload: sinon.stub(), setSafeToShutDown: sinon.stub() };
                service.windowService = windowServiceStub;
                confirmRestartStub = sinon.stub(service, 'confirmRestart');
                sinon.stub(service, 'resolveWorkspaceTrust').resolves();
                // Stub isWorkspaceTrustResolved to return true (simulates resolved state)
                sinon.stub(service, 'isWorkspaceTrustResolved').returns(true);
                service.setCurrentTrust(true);
                // Simulate a real user change: effective value just flipped from true to false.
                service.setLastKnownTrustEnabled(true);
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED] = false;
            });
            it('should reload without setSafeToShutDown when user confirms restart', async () => {
                confirmRestartStub.resolves(true);
                const change = {
                    preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED,
                    scope: preferences_1.PreferenceScope.User,
                    domain: [],
                    affects: () => true
                };
                await service.testHandlePreferenceChange(change);
                (0, chai_1.expect)(windowServiceStub.reload.calledOnce).to.be.true;
                (0, chai_1.expect)(windowServiceStub.setSafeToShutDown.called).to.be.false;
            });
            it('should not reload when user cancels restart', async () => {
                confirmRestartStub.resolves(false);
                const change = {
                    preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED,
                    scope: preferences_1.PreferenceScope.User,
                    domain: [],
                    affects: () => true
                };
                await service.testHandlePreferenceChange(change);
                (0, chai_1.expect)(windowServiceStub.reload.called).to.be.false;
                (0, chai_1.expect)(windowServiceStub.setSafeToShutDown.called).to.be.false;
            });
            it('should not show restart dialog when effective value is unchanged (initial-load event)', async () => {
                // Simulate the User provider's initial-load event: value already matches what was
                // observed at trust resolution time.
                service.setLastKnownTrustEnabled(false);
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED] = false;
                const change = {
                    preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED,
                    scope: preferences_1.PreferenceScope.User,
                    domain: [],
                    affects: () => true
                };
                await service.testHandlePreferenceChange(change);
                (0, chai_1.expect)(confirmRestartStub.called).to.be.false;
                (0, chai_1.expect)(windowServiceStub.reload.called).to.be.false;
            });
        });
        describe('trustedFolders change while trust is disabled', () => {
            it('should not flip currentTrust when `enabled` is false', async () => {
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED] = false;
                service.setCurrentTrust(true);
                areAllWorkspaceUrisTrustedStub.resolves(false);
                const change = {
                    preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS,
                    scope: preferences_1.PreferenceScope.User,
                    domain: [],
                    affects: () => true
                };
                await service.testHandlePreferenceChange(change);
                (0, chai_1.expect)(setWorkspaceTrustStub.called).to.be.false;
                (0, chai_1.expect)(areAllWorkspaceUrisTrustedStub.called).to.be.false;
            });
        });
        describe('trustedFolders change for empty window with emptyWindow enabled', () => {
            beforeEach(() => {
                isEmptyWorkspaceStub.resolves(true);
                workspaceTrustPrefStub[workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW] = true;
            });
            it('should not change trust when trustedFolders change for empty window with emptyWindow enabled', async () => {
                service.setCurrentTrust(true);
                const change = {
                    preferenceName: workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS,
                    scope: preferences_1.PreferenceScope.User,
                    domain: [],
                    affects: () => true
                };
                await service.testHandlePreferenceChange(change);
                (0, chai_1.expect)(setWorkspaceTrustStub.called).to.be.false;
            });
        });
    });
    describe('setWorkspaceTrust and trust change handling', () => {
        let storeWorkspaceTrustStub;
        let addToTrustedFoldersStub;
        let removeFromTrustedFoldersStub;
        let shouldReloadStub;
        let windowServiceStub;
        let contextKeyServiceStub;
        let onDidChangeEmitterStub;
        let confirmRestartStub;
        beforeEach(() => {
            storeWorkspaceTrustStub = sinon.stub(service, 'storeWorkspaceTrust').resolves();
            addToTrustedFoldersStub = sinon.stub(service, 'addToTrustedFolders').resolves();
            removeFromTrustedFoldersStub = sinon.stub(service, 'removeFromTrustedFolders').resolves();
            shouldReloadStub = sinon.stub(service, 'shouldReloadForTrustChange');
            confirmRestartStub = sinon.stub(service, 'confirmRestart').resolves(true);
            windowServiceStub = { reload: sinon.stub(), setSafeToShutDown: sinon.stub() };
            service.windowService = windowServiceStub;
            contextKeyServiceStub = { setContext: sinon.stub() };
            service.contextKeyService = contextKeyServiceStub;
            onDidChangeEmitterStub = { fire: sinon.stub() };
            service.onDidChangeWorkspaceTrustEmitter = onDidChangeEmitterStub;
        });
        it('should update currentTrust and fire event', async () => {
            service.setCurrentTrust(false);
            shouldReloadStub.returns(false);
            await service.setWorkspaceTrust(true);
            (0, chai_1.expect)(service.getCurrentTrust()).to.equal(true);
            (0, chai_1.expect)(contextKeyServiceStub.setContext.calledWith('isWorkspaceTrusted', true)).to.be.true;
            (0, chai_1.expect)(onDidChangeEmitterStub.fire.calledWith(true)).to.be.true;
        });
        it('should be a no-op when trust value does not change', async () => {
            service.setCurrentTrust(true);
            await service.setWorkspaceTrust(true);
            (0, chai_1.expect)(contextKeyServiceStub.setContext.called).to.be.false;
            (0, chai_1.expect)(onDidChangeEmitterStub.fire.called).to.be.false;
            (0, chai_1.expect)(storeWorkspaceTrustStub.called).to.be.false;
        });
        it('should confirm restart before storing or firing events when reload is required', async () => {
            const callOrder = [];
            confirmRestartStub.callsFake(async () => {
                callOrder.push('confirm');
                return true;
            });
            storeWorkspaceTrustStub.callsFake(() => {
                callOrder.push('store');
                return Promise.resolve();
            });
            onDidChangeEmitterStub.fire.callsFake(() => {
                callOrder.push('fire');
            });
            shouldReloadStub.returns(true);
            service.setCurrentTrust(false);
            await service.setWorkspaceTrust(true);
            (0, chai_1.expect)(callOrder[0]).to.equal('confirm');
            (0, chai_1.expect)(callOrder).to.include('store');
            (0, chai_1.expect)(callOrder).to.include('fire');
        });
        it('should call windowService.reload() when shouldReloadForTrustChange returns true', async () => {
            shouldReloadStub.returns(true);
            service.setCurrentTrust(false);
            await service.setWorkspaceTrust(true);
            (0, chai_1.expect)(windowServiceStub.reload.calledOnce).to.be.true;
        });
        it('should NOT call windowService.reload() when shouldReloadForTrustChange returns false', async () => {
            shouldReloadStub.returns(false);
            service.setCurrentTrust(false);
            await service.setWorkspaceTrust(true);
            (0, chai_1.expect)(windowServiceStub.reload.called).to.be.false;
        });
        it('should NOT call setSafeToShutDown (unsaved-changes protection preserved)', async () => {
            shouldReloadStub.returns(true);
            service.setCurrentTrust(false);
            await service.setWorkspaceTrust(true);
            (0, chai_1.expect)(windowServiceStub.setSafeToShutDown.called).to.be.false;
        });
        it('should NOT call windowService.reload() when user cancels confirm dialog', async () => {
            shouldReloadStub.returns(true);
            confirmRestartStub.resolves(false);
            service.setCurrentTrust(false);
            await service.setWorkspaceTrust(true);
            (0, chai_1.expect)(windowServiceStub.reload.called).to.be.false;
        });
        it('should leave trust state unchanged and not fire events when user cancels the restart dialog', async () => {
            shouldReloadStub.returns(true);
            confirmRestartStub.resolves(false);
            service.setCurrentTrust(false);
            await service.setWorkspaceTrust(true);
            (0, chai_1.expect)(service.getCurrentTrust()).to.equal(false);
            (0, chai_1.expect)(contextKeyServiceStub.setContext.called).to.be.false;
            (0, chai_1.expect)(onDidChangeEmitterStub.fire.called).to.be.false;
            (0, chai_1.expect)(storeWorkspaceTrustStub.called).to.be.false;
            (0, chai_1.expect)(addToTrustedFoldersStub.called).to.be.false;
            (0, chai_1.expect)(removeFromTrustedFoldersStub.called).to.be.false;
        });
        it('should call addToTrustedFolders when setting trusted=true', async () => {
            shouldReloadStub.returns(false);
            service.setCurrentTrust(false);
            await service.setWorkspaceTrust(true);
            (0, chai_1.expect)(addToTrustedFoldersStub.calledOnce).to.be.true;
            (0, chai_1.expect)(removeFromTrustedFoldersStub.called).to.be.false;
        });
        it('should call removeFromTrustedFolders when setting trusted=false', async () => {
            shouldReloadStub.returns(false);
            service.setCurrentTrust(true);
            await service.setWorkspaceTrust(false);
            (0, chai_1.expect)(removeFromTrustedFoldersStub.calledOnce).to.be.true;
            (0, chai_1.expect)(addToTrustedFoldersStub.called).to.be.false;
        });
        it('should NOT reload when reload=false even if shouldReloadForTrustChange returns true', async () => {
            shouldReloadStub.returns(true);
            service.setCurrentTrust(false);
            await service.setWorkspaceTrust(true, false);
            (0, chai_1.expect)(windowServiceStub.reload.called).to.be.false;
        });
        it('should still update state and fire event when reload=false', async () => {
            service.setCurrentTrust(false);
            shouldReloadStub.returns(true);
            await service.setWorkspaceTrust(true, false);
            (0, chai_1.expect)(service.getCurrentTrust()).to.equal(true);
            (0, chai_1.expect)(contextKeyServiceStub.setContext.calledWith('isWorkspaceTrusted', true)).to.be.true;
            (0, chai_1.expect)(onDidChangeEmitterStub.fire.calledWith(true)).to.be.true;
        });
    });
    describe('shouldReloadForTrustChange', () => {
        let freshService;
        beforeEach(() => {
            freshService = new TestableWorkspaceTrustService();
        });
        it('should return false when no restriction contributions are registered', () => {
            freshService
                .restrictionContributions = { getContributions: () => [] };
            (0, chai_1.expect)(freshService.testShouldReloadForTrustChange(true)).to.be.false;
        });
        it('should return false when contribution does not implement requiresReloadOnTrustChange', () => {
            freshService
                .restrictionContributions = { getContributions: () => [{ getRestrictions: () => [] }] };
            (0, chai_1.expect)(freshService.testShouldReloadForTrustChange(true)).to.be.false;
        });
        it('should return true when a contribution requires reload for the given trust value', () => {
            freshService
                .restrictionContributions = {
                getContributions: () => [{
                        getRestrictions: () => [],
                        requiresReloadOnTrustChange: (_newTrust) => true
                    }]
            };
            (0, chai_1.expect)(freshService.testShouldReloadForTrustChange(true)).to.be.true;
        });
        it('should return false when contribution returns false for requiresReloadOnTrustChange', () => {
            freshService
                .restrictionContributions = {
                getContributions: () => [{
                        getRestrictions: () => [],
                        requiresReloadOnTrustChange: (_newTrust) => false
                    }]
            };
            (0, chai_1.expect)(freshService.testShouldReloadForTrustChange(true)).to.be.false;
        });
        it('should pass newTrust value to requiresReloadOnTrustChange', () => {
            const calls = [];
            freshService
                .restrictionContributions = {
                getContributions: () => [{
                        getRestrictions: () => [],
                        requiresReloadOnTrustChange: (newTrust) => { calls.push(newTrust); return false; }
                    }]
            };
            freshService.testShouldReloadForTrustChange(false);
            (0, chai_1.expect)(calls).to.deep.equal([false]);
            freshService.testShouldReloadForTrustChange(true);
            (0, chai_1.expect)(calls).to.deep.equal([false, true]);
        });
    });
});
//# sourceMappingURL=workspace-trust-service.spec.js.map