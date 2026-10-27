"use strict";
// *****************************************************************************
// Copyright (C) 2021 EclipseSource and others.
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
exports.WorkspaceTrustService = exports.WorkspaceRestrictionContribution = exports.WORKSPACE_TRUST_STATUS_BAR_ID = void 0;
const tslib_1 = require("tslib");
const browser_1 = require("@theia/core/lib/browser");
const markdown_string_1 = require("@theia/core/lib/common/markdown-rendering/markdown-string");
const status_bar_1 = require("@theia/core/lib/browser/status-bar/status-bar");
const core_1 = require("@theia/core");
const common_1 = require("@theia/core/lib/common");
const uri_1 = require("@theia/core/lib/common/uri");
const preferences_1 = require("@theia/core/lib/common/preferences");
const message_service_1 = require("@theia/core/lib/common/message-service");
const nls_1 = require("@theia/core/lib/common/nls");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const inversify_1 = require("@theia/core/shared/inversify");
const window_service_1 = require("@theia/core/lib/browser/window/window-service");
const workspace_trust_preferences_1 = require("../common/workspace-trust-preferences");
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
const workspace_service_1 = require("./workspace-service");
const workspace_commands_1 = require("./workspace-commands");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const workspace_trust_dialog_1 = require("./workspace-trust-dialog");
const untitled_workspace_service_1 = require("../common/untitled-workspace-service");
const env_variables_1 = require("@theia/core/lib/common/env-variables");
const STORAGE_TRUSTED = 'trusted';
exports.WORKSPACE_TRUST_STATUS_BAR_ID = 'workspace-trust-status';
/**
 * Contribution interface for features that are restricted in untrusted workspaces.
 * Implementations can provide information about what is being restricted.
 */
exports.WorkspaceRestrictionContribution = Symbol('WorkspaceRestrictionContribution');
let WorkspaceTrustService = class WorkspaceTrustService {
    constructor() {
        this.workspaceTrust = new promise_util_1.Deferred();
        this.onDidChangeWorkspaceTrustEmitter = new common_1.Emitter();
        this.onDidChangeWorkspaceTrust = this.onDidChangeWorkspaceTrustEmitter.event;
        this.toDispose = new core_1.DisposableCollection(this.onDidChangeWorkspaceTrustEmitter);
    }
    init() {
        this.doInit();
    }
    async doInit() {
        await this.workspaceService.ready;
        await this.workspaceTrustPref.ready;
        await this.preferenceSchemaService.ready;
        await this.resolveWorkspaceTrust();
        this.toDispose.push(this.preferences.onPreferenceChanged(change => this.handlePreferenceChange(change)));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => this.handleWorkspaceChanged()));
        // Show status bar item if starting in restricted mode
        const initialTrust = await this.getWorkspaceTrust();
        this.updateRestrictedModeIndicator(initialTrust);
        // React to trust changes
        this.toDispose.push(this.onDidChangeWorkspaceTrust(trust => {
            this.updateRestrictedModeIndicator(trust);
        }));
    }
    onStop() {
        this.toDispose.dispose();
    }
    getWorkspaceTrust() {
        // Return current trust if already resolved, otherwise wait for initial resolution
        if (this.currentTrust !== undefined) {
            return Promise.resolve(this.currentTrust);
        }
        return this.workspaceTrust.promise;
    }
    async resolveWorkspaceTrust(givenTrust) {
        if (!this.isWorkspaceTrustResolved()) {
            this.lastKnownTrustEnabled = !!this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED];
            const trust = givenTrust ?? await this.calculateWorkspaceTrust();
            if (trust !== undefined) {
                await this.storeWorkspaceTrust(trust);
                this.contextKeyService.setContext('isWorkspaceTrusted', trust);
                this.currentTrust = trust;
                this.workspaceTrust.resolve(trust);
                this.onDidChangeWorkspaceTrustEmitter.fire(trust);
                if (trust && this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED]) {
                    await this.addToTrustedFolders();
                }
            }
        }
    }
    async setWorkspaceTrust(trusted, reload = true) {
        if (this.currentTrust === trusted) {
            return;
        }
        const needsReload = reload && this.shouldReloadForTrustChange(trusted);
        if (needsReload && !await this.confirmRestart()) {
            return;
        }
        // Must be set before add/removeFromTrustedFolders to prevent handlePreferenceChange from recursing.
        this.currentTrust = trusted;
        this.contextKeyService.setContext('isWorkspaceTrusted', trusted);
        this.onDidChangeWorkspaceTrustEmitter.fire(trusted);
        await this.storeWorkspaceTrust(trusted);
        await (trusted ? this.addToTrustedFolders() : this.removeFromTrustedFolders());
        if (needsReload) {
            this.windowService.reload();
        }
    }
    shouldReloadForTrustChange(newTrust) {
        return this.restrictionContributions.getContributions()
            .some(c => c.requiresReloadOnTrustChange?.(newTrust) ?? false);
    }
    isWorkspaceTrustResolved() {
        return this.workspaceTrust.state !== 'unresolved';
    }
    async calculateWorkspaceTrust() {
        const trustEnabled = this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED];
        if (!trustEnabled) {
            return true;
        }
        // Empty workspace - no folders open
        if (await this.isEmptyWorkspace()) {
            return !!this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW];
        }
        if (await this.areAllWorkspaceUrisTrusted()) {
            return true;
        }
        if (this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_STARTUP_PROMPT] === workspace_trust_preferences_1.WorkspaceTrustPrompt.NEVER) {
            return false;
        }
        // For ONCE mode, check stored trust first
        if (this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_STARTUP_PROMPT] === workspace_trust_preferences_1.WorkspaceTrustPrompt.ONCE) {
            const storedTrust = await this.loadWorkspaceTrust();
            if (storedTrust !== undefined) {
                return storedTrust;
            }
        }
        // For ALWAYS mode or ONCE mode with no stored decision, show dialog
        return this.showTrustPromptDialog();
    }
    /**
     * Check if the workspace is empty (no workspace or folder opened, or
     * an untitled workspace with no folders).
     * A saved workspace file with 0 folders is NOT empty - it still needs trust
     * evaluation because it could have tasks defined.
     */
    async isEmptyWorkspace() {
        const workspace = this.workspaceService.workspace;
        if (!workspace) {
            return true;
        }
        const roots = this.workspaceService.tryGetRoots();
        // Only consider it empty if it's an untitled workspace with no folders
        // Use secure check with configDirUri for trust-related decisions
        if (roots.length === 0) {
            const configDirUri = new uri_1.default(await this.envVariablesServer.getConfigDirUri());
            if (this.untitledWorkspaceService.isUntitledWorkspace(workspace.resource, configDirUri)) {
                return true;
            }
        }
        return false;
    }
    /**
     * Get the URIs that need to be trusted for the current workspace.
     * This includes all workspace folder URIs, plus the workspace file URI
     * for saved workspaces (since workspace files can contain tasks/settings).
     */
    getWorkspaceUris() {
        const uris = this.workspaceService.tryGetRoots().map(root => root.resource);
        const workspace = this.workspaceService.workspace;
        // For saved workspaces, include the workspace file itself
        if (workspace && this.workspaceService.saved) {
            uris.push(workspace.resource);
        }
        return uris;
    }
    /**
     * Check if all workspace URIs are trusted.
     * A workspace is trusted only if ALL of its folders (and the workspace
     * file for saved workspaces) are trusted.
     */
    async areAllWorkspaceUrisTrusted() {
        const uris = this.getWorkspaceUris();
        if (uris.length === 0) {
            return false;
        }
        return uris.every(uri => this.isUriTrusted(uri));
    }
    /**
     * Check if a URI is trusted. A URI is trusted if it or any of its
     * parent folders is in the trusted folders list.
     */
    isUriTrusted(uri) {
        const trustedFolders = this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] || [];
        const caseSensitive = !core_1.OS.backend.isWindows;
        const normalizedUri = uri.normalizePath();
        return trustedFolders.some(folder => {
            try {
                const folderUri = new uri_1.default(folder).normalizePath();
                // Check if the trusted folder is equal to or a parent of the URI
                return folderUri.isEqualOrParent(normalizedUri, caseSensitive);
            }
            catch {
                return false; // Invalid URI in preferences
            }
        });
    }
    async showTrustPromptDialog() {
        // If dialog is already open, wait for its result
        if (this.pendingTrustDialog) {
            return this.pendingTrustDialog.promise;
        }
        this.pendingTrustDialog = new promise_util_1.Deferred();
        try {
            // Show the workspace folders in the dialog
            const folderUris = this.workspaceService.tryGetRoots().map(root => root.resource);
            const dialog = new workspace_trust_dialog_1.WorkspaceTrustDialog(folderUris);
            const result = await dialog.open();
            const trusted = result === true;
            this.pendingTrustDialog.resolve(trusted);
            return trusted;
        }
        catch (e) {
            this.pendingTrustDialog.resolve(false);
            throw e;
        }
        finally {
            this.pendingTrustDialog = undefined;
        }
    }
    async addToTrustedFolders() {
        const uris = this.getWorkspaceUris();
        if (uris.length === 0) {
            return;
        }
        const currentFolders = this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] || [];
        const newFolders = [...currentFolders];
        let changed = false;
        for (const uri of uris) {
            if (!this.isUriTrusted(uri)) {
                newFolders.push(uri.toString());
                changed = true;
            }
        }
        if (changed) {
            await this.preferences.set(workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS, newFolders, preferences_1.PreferenceScope.User);
        }
    }
    async removeFromTrustedFolders() {
        const uris = this.getWorkspaceUris();
        if (uris.length === 0) {
            return;
        }
        const currentFolders = this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS] || [];
        const caseSensitive = !core_1.OS.backend.isWindows;
        const normalizedUris = uris.map(uri => uri.normalizePath());
        const updatedFolders = currentFolders.filter(folder => {
            try {
                const folderUri = new uri_1.default(folder).normalizePath();
                // Remove folder if it exactly matches any workspace URI
                return !normalizedUris.some(wsUri => wsUri.isEqual(folderUri, caseSensitive));
            }
            catch {
                return true; // Keep invalid URIs
            }
        });
        if (updatedFolders.length !== currentFolders.length) {
            await this.preferences.set(workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS, updatedFolders, preferences_1.PreferenceScope.User);
        }
    }
    async loadWorkspaceTrust() {
        if (this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_STARTUP_PROMPT] === workspace_trust_preferences_1.WorkspaceTrustPrompt.ONCE) {
            return this.storage.getData(STORAGE_TRUSTED);
        }
    }
    async storeWorkspaceTrust(trust) {
        if (this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_STARTUP_PROMPT] === workspace_trust_preferences_1.WorkspaceTrustPrompt.ONCE) {
            return this.storage.setData(STORAGE_TRUSTED, trust);
        }
    }
    async handlePreferenceChange(change) {
        // Handle trustedFolders changes regardless of scope
        if (change.preferenceName === workspace_trust_preferences_1.WORKSPACE_TRUST_TRUSTED_FOLDERS) {
            // When trust is disabled, trust is unconditionally granted: trustedFolders
            // changes must not flip `currentTrust` (which would trigger a restart dialog
            // via `setWorkspaceTrust` → `shouldReloadForTrustChange`).
            if (!this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED]) {
                return;
            }
            // For empty windows with emptyWindow setting enabled, trust should remain true
            if (await this.isEmptyWorkspace() && this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW]) {
                return;
            }
            const areAllUrisTrusted = await this.areAllWorkspaceUrisTrusted();
            if (areAllUrisTrusted !== this.currentTrust) {
                await this.setWorkspaceTrust(areAllUrisTrusted);
            }
            return;
        }
        if (change.scope === preferences_1.PreferenceScope.User) {
            if (change.preferenceName === workspace_trust_preferences_1.WORKSPACE_TRUST_STARTUP_PROMPT && this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_STARTUP_PROMPT] !== workspace_trust_preferences_1.WorkspaceTrustPrompt.ONCE) {
                this.storage.setData(STORAGE_TRUSTED, undefined);
            }
            if (change.preferenceName === workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED) {
                const currentEnabled = !!this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_ENABLED];
                // The preference framework emits a User-scope change event when the user
                // settings file is first loaded (oldValue undefined → current value). Only
                // prompt for restart when the effective value has actually changed since
                // trust was last resolved.
                if (currentEnabled !== this.lastKnownTrustEnabled) {
                    this.lastKnownTrustEnabled = currentEnabled;
                    if (!await this.isEmptyWorkspace() && this.isWorkspaceTrustResolved() && await this.confirmRestart()) {
                        this.windowService.reload();
                    }
                }
                this.resolveWorkspaceTrust();
            }
            // Handle emptyWindow setting change for empty windows
            if (change.preferenceName === workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW && await this.isEmptyWorkspace()) {
                // For empty windows, directly update trust based on the new setting value
                const shouldTrust = !!this.workspaceTrustPref[workspace_trust_preferences_1.WORKSPACE_TRUST_EMPTY_WINDOW];
                if (this.currentTrust !== shouldTrust) {
                    // No reload needed: in an empty window there are no workspace folders,
                    // so no extensions are blocked by trust and no extension host restart is required.
                    await this.setWorkspaceTrust(shouldTrust, false);
                }
            }
        }
    }
    async handleWorkspaceChanged() {
        // Reset trust state for the new workspace
        this.workspaceTrust = new promise_util_1.Deferred();
        this.currentTrust = undefined;
        // Re-evaluate trust for the new workspace
        await this.resolveWorkspaceTrust();
        // Update status bar indicator
        const trust = await this.getWorkspaceTrust();
        this.updateRestrictedModeIndicator(trust);
    }
    async confirmRestart() {
        const shouldRestart = await new browser_1.ConfirmDialog({
            title: nls_1.nls.localizeByDefault('A setting has changed that requires a restart to take effect.'),
            msg: nls_1.nls.localizeByDefault('Press the restart button to restart {0} and enable the setting.', frontend_application_config_provider_1.FrontendApplicationConfigProvider.get().applicationName),
            ok: nls_1.nls.localizeByDefault('Restart'),
            cancel: browser_1.Dialog.CANCEL,
        }).open();
        return shouldRestart === true;
    }
    updateRestrictedModeIndicator(trusted) {
        if (trusted) {
            this.hideRestrictedModeStatusBarItem();
        }
        else {
            this.showRestrictedModeStatusBarItem();
        }
    }
    showRestrictedModeStatusBarItem() {
        this.statusBar.setElement(exports.WORKSPACE_TRUST_STATUS_BAR_ID, {
            text: '$(shield) ' + nls_1.nls.localizeByDefault('Restricted Mode'),
            alignment: status_bar_1.StatusBarAlignment.LEFT,
            backgroundColor: 'var(--theia-statusBarItem-prominentBackground)',
            color: 'var(--theia-statusBarItem-prominentForeground)',
            priority: 5000,
            tooltip: this.createRestrictedModeTooltip(),
            command: workspace_commands_1.WorkspaceCommands.MANAGE_WORKSPACE_TRUST.id
        });
    }
    createRestrictedModeTooltip() {
        const manageTrustLink = `[${workspace_commands_1.WorkspaceCommands.MANAGE_WORKSPACE_TRUST.label}](command:${workspace_commands_1.WorkspaceCommands.MANAGE_WORKSPACE_TRUST.id})`;
        const docsLink = `[${nls_1.nls.localize('theia/workspace/trustLearnMore', "Learn more about Theia's Workspace Trust")}](https://theia-ide.org/docs/workspace_trust/)`;
        const md = new markdown_string_1.MarkdownStringImpl('', {
            supportThemeIcons: true,
            isTrusted: { enabledCommands: [workspace_commands_1.WorkspaceCommands.MANAGE_WORKSPACE_TRUST.id] }
        });
        md.appendMarkdown(`**${nls_1.nls.localizeByDefault('Restricted Mode')}**\n\n`);
        md.appendMarkdown(nls_1.nls.localize('theia/workspace/restrictedModeDescription', 'Some features are disabled because this workspace is not trusted.'));
        md.appendMarkdown('\n\n');
        md.appendMarkdown(nls_1.nls.localize('theia/workspace/restrictedModeFeatures', 'Features like task execution, debugging, extensions, and AI are disabled to protect against potentially harmful code.'));
        md.appendMarkdown('\n\n');
        md.appendMarkdown(manageTrustLink);
        const restrictions = this.collectRestrictions();
        if (restrictions.length > 0) {
            md.appendMarkdown('\n\n---\n\n');
            for (const restriction of restrictions) {
                md.appendMarkdown(`**${restriction.label}**\n\n`);
                if (restriction.details && restriction.details.length > 0) {
                    for (const detail of restriction.details) {
                        md.appendMarkdown(`- ${detail}\n`);
                    }
                    md.appendMarkdown('\n');
                }
            }
        }
        md.appendMarkdown('\n\n---\n\n');
        md.appendMarkdown(docsLink);
        return md;
    }
    collectRestrictions() {
        const restrictions = [];
        for (const contribution of this.restrictionContributions.getContributions()) {
            restrictions.push(...contribution.getRestrictions());
        }
        return restrictions;
    }
    hideRestrictedModeStatusBarItem() {
        this.statusBar.removeElement(exports.WORKSPACE_TRUST_STATUS_BAR_ID);
    }
    /**
     * Refreshes the restricted mode status bar item.
     * Call this when restriction contributions change.
     */
    refreshRestrictedModeIndicator() {
        if (this.currentTrust === false) {
            this.showRestrictedModeStatusBarItem();
        }
    }
    /**
     * Request workspace trust from the user. This method follows VS Code's pattern:
     * - If already trusted, returns true immediately
     * - If there's already a pending trust request, returns the same promise (avoiding duplicate dialogs)
     * - Otherwise, shows a dialog and waits for the user's response
     *
     * Unlike the initial trust resolution, this can be called multiple times and will
     * prompt the user each time (unless a dialog is already open).
     */
    async requestWorkspaceTrust() {
        // If already trusted, return true immediately
        if (this.currentTrust === true) {
            return true;
        }
        // If there's already a pending request, return the same promise to avoid duplicate dialogs
        if (this.pendingTrustRequest) {
            return this.pendingTrustRequest.promise;
        }
        // Create a new pending request
        this.pendingTrustRequest = new promise_util_1.Deferred();
        try {
            const grantedTrust = await this.showTrustPromptDialog();
            if (grantedTrust) {
                await this.setWorkspaceTrust(true);
            }
            this.pendingTrustRequest.resolve(grantedTrust);
            return grantedTrust;
        }
        catch (e) {
            this.pendingTrustRequest.resolve(undefined);
            throw e;
        }
        finally {
            this.pendingTrustRequest = undefined;
        }
    }
};
exports.WorkspaceTrustService = WorkspaceTrustService;
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_service_1.WorkspaceService),
    tslib_1.__metadata("design:type", workspace_service_1.WorkspaceService)
], WorkspaceTrustService.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preferences_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], WorkspaceTrustService.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.StorageService),
    tslib_1.__metadata("design:type", Object)
], WorkspaceTrustService.prototype, "storage", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(message_service_1.MessageService),
    tslib_1.__metadata("design:type", message_service_1.MessageService)
], WorkspaceTrustService.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_trust_preferences_1.WorkspaceTrustPreferences),
    tslib_1.__metadata("design:type", Object)
], WorkspaceTrustService.prototype, "workspaceTrustPref", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preferences_1.PreferenceSchemaService),
    tslib_1.__metadata("design:type", Object)
], WorkspaceTrustService.prototype, "preferenceSchemaService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(window_service_1.WindowService),
    tslib_1.__metadata("design:type", Object)
], WorkspaceTrustService.prototype, "windowService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], WorkspaceTrustService.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(status_bar_1.StatusBar),
    tslib_1.__metadata("design:type", Object)
], WorkspaceTrustService.prototype, "statusBar", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(exports.WorkspaceRestrictionContribution),
    tslib_1.__metadata("design:type", Object)
], WorkspaceTrustService.prototype, "restrictionContributions", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(untitled_workspace_service_1.UntitledWorkspaceService),
    tslib_1.__metadata("design:type", untitled_workspace_service_1.UntitledWorkspaceService)
], WorkspaceTrustService.prototype, "untitledWorkspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(env_variables_1.EnvVariablesServer),
    tslib_1.__metadata("design:type", Object)
], WorkspaceTrustService.prototype, "envVariablesServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], WorkspaceTrustService.prototype, "init", null);
tslib_1.__decorate([
    (0, inversify_1.preDestroy)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], WorkspaceTrustService.prototype, "onStop", null);
exports.WorkspaceTrustService = WorkspaceTrustService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WorkspaceTrustService);
//# sourceMappingURL=workspace-trust-service.js.map