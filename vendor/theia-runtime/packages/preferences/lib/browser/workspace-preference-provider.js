"use strict";
// *****************************************************************************
// Copyright (C) 2018 Ericsson and others.
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
exports.WorkspacePreferenceProvider = void 0;
const tslib_1 = require("tslib");
/* eslint-disable @typescript-eslint/no-explicit-any */
const inversify_1 = require("@theia/core/shared/inversify");
const disposable_1 = require("@theia/core/lib/common/disposable");
const workspace_service_1 = require("@theia/workspace/lib/browser/workspace-service");
const workspace_file_preference_provider_1 = require("./workspace-file-preference-provider");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const core_1 = require("@theia/core");
let WorkspacePreferenceProvider = class WorkspacePreferenceProvider {
    constructor() {
        this.onDidPreferencesChangedEmitter = new core_1.Emitter();
        this.onDidPreferencesChanged = this.onDidPreferencesChangedEmitter.event;
        this.toDisposeOnEnsureDelegateUpToDate = new disposable_1.DisposableCollection();
        this._ready = new promise_util_1.Deferred();
        this.ready = this._ready.promise;
        this.disposables = new disposable_1.DisposableCollection();
    }
    init() {
        this.workspaceService.ready.then(() => {
            // If there is no workspace after the workspace service is initialized, then no more work is needed for this provider to be ready.
            // If there is a workspace, then we wait for the new delegate to be ready before declaring this provider ready.
            if (!this.workspaceService.workspace) {
                this._ready.resolve();
            }
            else {
                // important for the case if onWorkspaceLocationChanged has fired before this init is finished
                this.ensureDelegateUpToDate();
            }
        });
    }
    dispose() {
        this.disposables.dispose();
    }
    canHandleScope(scope) {
        return true;
    }
    getConfigUri(resourceUri = this.ensureResourceUri(), sectionName) {
        return this.delegate?.getConfigUri && this.delegate?.getConfigUri(resourceUri, sectionName);
    }
    getContainingConfigUri(resourceUri = this.ensureResourceUri(), sectionName) {
        return this.delegate?.getContainingConfigUri?.(resourceUri, sectionName);
    }
    get delegate() {
        return this._delegate;
    }
    ensureDelegateUpToDate() {
        const delegate = this.createDelegate();
        if (this._delegate !== delegate) {
            this.toDisposeOnEnsureDelegateUpToDate.dispose();
            this.disposables.push(this.toDisposeOnEnsureDelegateUpToDate);
            this._delegate = delegate;
            if (delegate) {
                // If this provider has not yet declared itself ready, it should do so when the new delegate is ready.
                delegate.ready.then(() => this._ready.resolve(), () => { });
            }
            if (delegate instanceof workspace_file_preference_provider_1.WorkspaceFilePreferenceProvider) {
                this.toDisposeOnEnsureDelegateUpToDate.pushAll([
                    delegate,
                    delegate.onDidPreferencesChanged(changes => this.onDidPreferencesChangedEmitter.fire(changes))
                ]);
            }
        }
    }
    createDelegate() {
        const workspace = this.workspaceService.workspace;
        if (!workspace) {
            return undefined;
        }
        if (!this.workspaceService.isMultiRootWorkspaceOpened) {
            return this.preferenceProviderProvider(core_1.PreferenceScope.Folder);
        }
        if (this._delegate instanceof workspace_file_preference_provider_1.WorkspaceFilePreferenceProvider && this._delegate.getConfigUri().isEqual(workspace.resource)) {
            return this._delegate;
        }
        return this.workspaceFileProviderFactory({
            workspaceUri: workspace.resource
        });
    }
    get(preferenceName, resourceUri = this.ensureResourceUri()) {
        const delegate = this.delegate;
        return delegate ? delegate.get(preferenceName, resourceUri) : undefined;
    }
    resolve(preferenceName, resourceUri = this.ensureResourceUri()) {
        const delegate = this.delegate;
        return delegate ? delegate.resolve(preferenceName, resourceUri) : {};
    }
    async setPreference(preferenceName, value, resourceUri = this.ensureResourceUri()) {
        const delegate = this.delegate;
        if (delegate) {
            return delegate.setPreference(preferenceName, value, resourceUri);
        }
        return false;
    }
    getPreferences(resourceUri = this.ensureResourceUri()) {
        const delegate = this.delegate;
        return delegate ? delegate.getPreferences(resourceUri) : {};
    }
    ensureResourceUri() {
        if (this.workspaceService.workspace && !this.workspaceService.isMultiRootWorkspaceOpened) {
            return this.workspaceService.workspace.resource.toString();
        }
        return undefined;
    }
};
exports.WorkspacePreferenceProvider = WorkspacePreferenceProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_service_1.WorkspaceService),
    tslib_1.__metadata("design:type", workspace_service_1.WorkspaceService)
], WorkspacePreferenceProvider.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_file_preference_provider_1.WorkspaceFilePreferenceProviderFactory),
    tslib_1.__metadata("design:type", Function)
], WorkspacePreferenceProvider.prototype, "workspaceFileProviderFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceProviderProvider),
    tslib_1.__metadata("design:type", Function)
], WorkspacePreferenceProvider.prototype, "preferenceProviderProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], WorkspacePreferenceProvider.prototype, "init", null);
exports.WorkspacePreferenceProvider = WorkspacePreferenceProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WorkspacePreferenceProvider);
//# sourceMappingURL=workspace-preference-provider.js.map