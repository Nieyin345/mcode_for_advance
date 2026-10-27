"use strict";
var TheiaVariableContribution_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TheiaVariableContribution = void 0;
const tslib_1 = require("tslib");
// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH.
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
const frontend_application_state_1 = require("@theia/core/lib/browser/frontend-application-state");
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
const nls_1 = require("@theia/core/lib/common/nls");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/variable-resolver/lib/browser");
/**
 * Integrates the Theia VariableRegistry with the Theia AI VariableService
 */
let TheiaVariableContribution = class TheiaVariableContribution {
    constructor() {
        // Map original variable name to one or more mappings with new name and description.
        // Only variables present in this map are registered.
        this.variableRenameMap = new Map([
            ['file', [
                    {
                        name: 'currentAbsoluteFilePath',
                        description: nls_1.nls.localize('theia/ai/core/variable-contribution/currentAbsoluteFilePath', 'The absolute path of the currently opened file.')
                    }
                ]],
            ['selectedText', [
                    {
                        description: nls_1.nls.localize('theia/ai/core/variable-contribution/currentSelectedText', 'The plain text that is currently selected in the opened file. This excludes the information where the content is coming from.')
                    }
                ]],
            ['currentText', [
                    {
                        name: 'currentFileContent',
                        description: nls_1.nls.localize('theia/ai/core/variable-contribution/currentFileContent', 'The plain content of the currently opened file. This excludes the information where the content is coming from.')
                    }
                ]],
            ['relativeFile', [
                    {
                        name: 'currentRelativeFilePath',
                        description: nls_1.nls.localize('theia/ai/core/variable-contribution/currentRelativeFilePath', 'The workspace-relative path of the currently opened file (e.g., my-project/src/index.ts).')
                    },
                    {
                        name: '_f',
                        description: nls_1.nls.localize('theia/ai/core/variable-contribution/dotRelativePath', 'Short reference to the workspace-relative path of the currently opened file (\'currentRelativeFilePath\').')
                    }
                ]],
            ['relativeFileDirname', [
                    {
                        name: 'currentRelativeDirPath',
                        description: nls_1.nls.localize('theia/ai/core/variable-contribution/currentRelativeDirPath', 'The workspace-relative path of the directory containing the currently opened file (e.g., my-project/src).')
                    }
                ]],
            ['lineNumber', [{}]],
            ['workspaceFolder', [{}]]
        ]);
    }
    static { TheiaVariableContribution_1 = this; }
    static { this.THEIA_PREFIX = 'theia-'; }
    registerVariables(service) {
        this.stateService.reachedState('initialized_layout').then(() => {
            // some variable contributions in Theia are done as part of the onStart, same as our AI variable contributions
            // we therefore wait for all of them to be registered before we register we map them to our own
            this.variableRegistry.getVariables().forEach(variable => {
                if (!this.variableRenameMap.has(variable.name)) {
                    return; // Do not register variables not part of the map
                }
                const mappings = this.variableRenameMap.get(variable.name);
                // Register each mapping for this variable
                mappings.forEach((mapping, index) => {
                    const newName = (mapping.name && mapping.name.trim() !== '') ? mapping.name : variable.name;
                    const newDescription = (mapping.description && mapping.description.trim() !== '') ? mapping.description
                        : (variable.description && variable.description.trim() !== '' ? variable.description
                            : nls_1.nls.localize('theia/ai/core/variable-contribution/builtInVariable', '{0} Built-in Variable', frontend_application_config_provider_1.FrontendApplicationConfigProvider.get().applicationName));
                    // For multiple mappings of the same variable, add a suffix to the ID to make it unique
                    const idSuffix = mappings.length > 1 ? `-${index}` : '';
                    const id = `${TheiaVariableContribution_1.THEIA_PREFIX}${variable.name}${idSuffix}`;
                    service.registerResolver({
                        id,
                        name: newName,
                        description: newDescription
                    }, this);
                });
            });
        });
    }
    toTheiaVariable(request) {
        // Extract the base variable name by removing the THEIA_PREFIX and any potential index suffix
        let variableId = request.variable.id;
        if (variableId.startsWith(TheiaVariableContribution_1.THEIA_PREFIX)) {
            variableId = variableId.slice(TheiaVariableContribution_1.THEIA_PREFIX.length);
            // Remove any potential index suffix (e.g., -0, -1)
            variableId = variableId.replace(/-\d+$/, '');
        }
        return `\${${variableId}${request.arg ? ':' + request.arg : ''}}`;
    }
    async canResolve(request, context) {
        if (!request.variable.id.startsWith(TheiaVariableContribution_1.THEIA_PREFIX)) {
            return 0;
        }
        // some variables are not resolvable without providing a specific context
        // this may be expensive but was not a problem for Theia's built-in variables
        const resolved = await this.variableResolverService.resolve(this.toTheiaVariable(request), context);
        return !resolved ? 0 : 1;
    }
    async resolve(request, context) {
        const resolved = await this.variableResolverService.resolve(this.toTheiaVariable(request), context);
        return resolved ? { value: resolved, variable: request.variable } : undefined;
    }
};
exports.TheiaVariableContribution = TheiaVariableContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.VariableResolverService),
    tslib_1.__metadata("design:type", browser_1.VariableResolverService)
], TheiaVariableContribution.prototype, "variableResolverService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.VariableRegistry),
    tslib_1.__metadata("design:type", browser_1.VariableRegistry)
], TheiaVariableContribution.prototype, "variableRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(frontend_application_state_1.FrontendApplicationStateService),
    tslib_1.__metadata("design:type", frontend_application_state_1.FrontendApplicationStateService)
], TheiaVariableContribution.prototype, "stateService", void 0);
exports.TheiaVariableContribution = TheiaVariableContribution = TheiaVariableContribution_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TheiaVariableContribution);
//# sourceMappingURL=theia-variable-contribution.js.map