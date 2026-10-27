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
exports.WorkspaceTrustPreferences = exports.WorkspaceTrustPreferenceContribution = exports.workspaceTrustPreferenceSchema = exports.WorkspaceTrustPrompt = exports.WORKSPACE_TRUST_TRUSTED_FOLDERS = exports.WORKSPACE_TRUST_EMPTY_WINDOW = exports.WORKSPACE_TRUST_STARTUP_PROMPT = exports.WORKSPACE_TRUST_ENABLED = void 0;
exports.createWorkspaceTrustPreferences = createWorkspaceTrustPreferences;
exports.bindWorkspaceTrustPreferences = bindWorkspaceTrustPreferences;
const preferences_1 = require("@theia/core/lib/common/preferences");
const nls_1 = require("@theia/core/lib/common/nls");
exports.WORKSPACE_TRUST_ENABLED = 'security.workspace.trust.enabled';
exports.WORKSPACE_TRUST_STARTUP_PROMPT = 'security.workspace.trust.startupPrompt';
exports.WORKSPACE_TRUST_EMPTY_WINDOW = 'security.workspace.trust.emptyWindow';
exports.WORKSPACE_TRUST_TRUSTED_FOLDERS = 'security.workspace.trust.trustedFolders';
var WorkspaceTrustPrompt;
(function (WorkspaceTrustPrompt) {
    WorkspaceTrustPrompt["ALWAYS"] = "always";
    WorkspaceTrustPrompt["ONCE"] = "once";
    WorkspaceTrustPrompt["NEVER"] = "never";
})(WorkspaceTrustPrompt || (exports.WorkspaceTrustPrompt = WorkspaceTrustPrompt = {}));
exports.workspaceTrustPreferenceSchema = {
    scope: preferences_1.PreferenceScope.User,
    properties: {
        [exports.WORKSPACE_TRUST_ENABLED]: {
            description: nls_1.nls.localize('theia/workspace/trustEnabled', 'Controls whether or not workspace trust is enabled. If disabled, all workspaces are trusted.'),
            type: 'boolean',
            default: true
        },
        [exports.WORKSPACE_TRUST_STARTUP_PROMPT]: {
            description: nls_1.nls.localizeByDefault('Controls when the startup prompt to trust a workspace is shown.'),
            enum: Object.values(WorkspaceTrustPrompt),
            default: WorkspaceTrustPrompt.ALWAYS
        },
        [exports.WORKSPACE_TRUST_EMPTY_WINDOW]: {
            description: nls_1.nls.localize('theia/workspace/trustEmptyWindow', 'Controls whether or not the empty workspace is trusted by default.'),
            type: 'boolean',
            default: true
        },
        [exports.WORKSPACE_TRUST_TRUSTED_FOLDERS]: {
            description: nls_1.nls.localize('theia/workspace/trustTrustedFolders', 'List of folder URIs that are trusted without prompting.'),
            type: 'array',
            items: {
                type: 'string'
            },
            default: [],
            scope: preferences_1.PreferenceScope.User
        }
    }
};
exports.WorkspaceTrustPreferenceContribution = Symbol('WorkspaceTrustPreferenceContribution');
exports.WorkspaceTrustPreferences = Symbol('WorkspaceTrustPreferences');
function createWorkspaceTrustPreferences(preferences, schema = exports.workspaceTrustPreferenceSchema) {
    return (0, preferences_1.createPreferenceProxy)(preferences, schema);
}
function bindWorkspaceTrustPreferences(bind) {
    bind(exports.WorkspaceTrustPreferences).toDynamicValue(ctx => {
        const preferences = ctx.container.get(preferences_1.PreferenceService);
        const contribution = ctx.container.get(exports.WorkspaceTrustPreferenceContribution);
        return createWorkspaceTrustPreferences(preferences, contribution.schema);
    }).inSingletonScope();
    bind(exports.WorkspaceTrustPreferenceContribution).toConstantValue({ schema: exports.workspaceTrustPreferenceSchema });
    bind(preferences_1.PreferenceContribution).toService(exports.WorkspaceTrustPreferenceContribution);
}
//# sourceMappingURL=workspace-trust-preferences.js.map