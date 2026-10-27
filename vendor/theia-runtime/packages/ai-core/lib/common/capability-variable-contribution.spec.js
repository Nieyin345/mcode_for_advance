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
require("reflect-metadata");
const chai_1 = require("chai");
const inversify_1 = require("inversify");
const core_1 = require("@theia/core");
const capability_variable_contribution_1 = require("./capability-variable-contribution");
const prompt_service_1 = require("./prompt-service");
const variable_service_1 = require("./variable-service");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
disableJSDOM();
describe('CapabilityVariableContribution', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    let contribution;
    let promptService;
    let container;
    beforeEach(() => {
        container = new inversify_1.Container();
        // Set up PromptService
        container.bind(prompt_service_1.PromptService).to(prompt_service_1.PromptServiceImpl).inSingletonScope();
        const mockLogger = new mock_logger_1.MockLogger();
        const variableService = new variable_service_1.DefaultAIVariableService({ getContributions: () => [] });
        variableService['logger'] = mockLogger;
        container.bind(variable_service_1.AIVariableService).toConstantValue(variableService);
        container.bind(core_1.ILogger).toConstantValue(mockLogger);
        // Bind CapabilityVariableContribution with proper DI
        container.bind(capability_variable_contribution_1.CapabilityVariableContribution).toSelf().inSingletonScope();
        // Get instances
        promptService = container.get(prompt_service_1.PromptService);
        contribution = container.get(capability_variable_contribution_1.CapabilityVariableContribution);
    });
    describe('Capability Argument Parsing', () => {
        it('resolves to prompt fragment content when default is on', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'This is the capability content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default on' }, {});
            (0, chai_1.expect)(result?.value).to.equal('This is the capability content');
        });
        it('resolves to empty string when default is off', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'This is the capability content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default off' }, {});
            (0, chai_1.expect)(result?.value).to.equal('');
        });
        it('handles case-insensitive default on/off', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'Capability content'
            });
            const resultOn = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default ON' }, {});
            (0, chai_1.expect)(resultOn?.value).to.equal('Capability content');
            const resultOff = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default OFF' }, {});
            (0, chai_1.expect)(resultOff?.value).to.equal('');
        });
        it('returns empty string for non-existent fragment', async () => {
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'non-existent-fragment default on' }, {});
            (0, chai_1.expect)(result?.value).to.equal('');
        });
        it('returns empty string for malformed arguments (no matching fragment)', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'This is the capability content'
            });
            // Incomplete default clause — parsed as fragment ID "test-capability on" which doesn't exist
            const result1 = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability on' }, {});
            (0, chai_1.expect)(result1?.value).to.equal('');
            // Incomplete default clause — parsed as fragment ID "test-capability default"
            const result2 = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default' }, {});
            (0, chai_1.expect)(result2?.value).to.equal('');
            // Invalid on/off value — parsed as fragment ID "test-capability default yes"
            const result3 = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default yes' }, {});
            (0, chai_1.expect)(result3?.value).to.equal('');
        });
        it('returns empty string for empty argument', async () => {
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: '' }, {});
            (0, chai_1.expect)(result?.value).to.equal('');
        });
        it('handles fragment IDs with hyphens', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'my-complex-capability-name',
                template: 'Complex capability content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'my-complex-capability-name default on' }, {});
            (0, chai_1.expect)(result?.value).to.equal('Complex capability content');
        });
        it('handles whitespace in arguments', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'Capability content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: '  test-capability   default   on  ' }, {});
            (0, chai_1.expect)(result?.value).to.equal('Capability content');
        });
        it('defaults to off when default on/off is omitted', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'Capability content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability' }, {});
            (0, chai_1.expect)(result?.value).to.equal('');
        });
        it('resolves content when override enables a capability without explicit default', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'Capability content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability' }, { capabilityOverrides: { 'test-capability': true } });
            (0, chai_1.expect)(result?.value).to.equal('Capability content');
        });
    });
    describe('Variable Resolution', () => {
        it('returns correct variable in result', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'Content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default on' }, {});
            (0, chai_1.expect)(result?.variable).to.deep.equal(capability_variable_contribution_1.CAPABILITY_VARIABLE);
        });
        it('returns empty allResolvedDependencies when disabled', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'Content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default off' }, {});
            (0, chai_1.expect)(result?.allResolvedDependencies).to.deep.equal([]);
        });
    });
    describe('Capability Overrides', () => {
        it('override disables a default-on capability', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'Capability content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default on' }, { capabilityOverrides: { 'test-capability': false } });
            (0, chai_1.expect)(result?.value).to.equal('');
        });
        it('override enables a default-off capability', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'Capability content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default off' }, { capabilityOverrides: { 'test-capability': true } });
            (0, chai_1.expect)(result?.value).to.equal('Capability content');
        });
        it('falls back to default when no override is present for the fragment', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'Capability content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default on' }, { capabilityOverrides: { 'other-capability': false } });
            (0, chai_1.expect)(result?.value).to.equal('Capability content');
        });
        it('falls back to default when capabilityOverrides is undefined', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-capability',
                template: 'Capability content'
            });
            const result = await contribution.resolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test-capability default on' }, { capabilityOverrides: undefined });
            (0, chai_1.expect)(result?.value).to.equal('Capability content');
        });
    });
    describe('canResolve', () => {
        it('returns 1 for capability variable', () => {
            const result = contribution.canResolve({ variable: capability_variable_contribution_1.CAPABILITY_VARIABLE, arg: 'test default on' }, {});
            (0, chai_1.expect)(result).to.equal(1);
        });
        it('returns -1 for other variables', () => {
            const result = contribution.canResolve({ variable: { id: 'other', name: 'other', description: 'other' }, arg: 'test' }, {});
            (0, chai_1.expect)(result).to.equal(-1);
        });
    });
});
//# sourceMappingURL=capability-variable-contribution.spec.js.map