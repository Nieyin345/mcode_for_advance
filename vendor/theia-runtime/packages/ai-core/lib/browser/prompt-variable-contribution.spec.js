"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource and others.
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
const sinon = require("sinon");
const inversify_1 = require("inversify");
const core_1 = require("@theia/core");
const prompt_variable_contribution_1 = require("./prompt-variable-contribution");
const prompt_service_1 = require("../common/prompt-service");
const variable_service_1 = require("../common/variable-service");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
disableJSDOM();
describe('PromptVariableContribution', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    let contribution;
    let promptService;
    let container;
    beforeEach(() => {
        container = new inversify_1.Container();
        // Set up PromptService
        container.bind(prompt_service_1.PromptService).to(prompt_service_1.PromptServiceImpl).inSingletonScope();
        const logger = sinon.createStubInstance(core_1.Logger);
        const variableService = new variable_service_1.DefaultAIVariableService({ getContributions: () => [] });
        variableService['logger'] = logger;
        container.bind(variable_service_1.AIVariableService).toConstantValue(variableService);
        container.bind(core_1.ILogger).toConstantValue(new mock_logger_1.MockLogger);
        // Set up CommandService stub (needed for PromptVariableContribution but not used in these tests)
        const commandService = sinon.createStubInstance(core_1.Logger); // Using Logger as a simple mock
        container.bind(core_1.CommandService).toConstantValue(commandService);
        // Bind PromptVariableContribution with proper DI
        container.bind(prompt_variable_contribution_1.PromptVariableContribution).toSelf().inSingletonScope();
        // Get instances
        promptService = container.get(prompt_service_1.PromptService);
        contribution = container.get(prompt_variable_contribution_1.PromptVariableContribution);
    });
    describe('Command Argument Substitution', () => {
        it('substitutes $ARGUMENTS with full argument string', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-cmd',
                template: 'Process: $ARGUMENTS',
                isCommand: true,
                commandName: 'test'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'test-cmd|arg1 arg2 arg3' }, {});
            (0, chai_1.expect)(result?.value).to.equal('Process: arg1 arg2 arg3');
        });
        it('substitutes $0 with command name', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-cmd',
                template: 'Command $0 was called',
                isCommand: true,
                commandName: 'test'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'test-cmd|args' }, {});
            (0, chai_1.expect)(result?.value).to.equal('Command test-cmd was called');
        });
        it('substitutes $1, $2, ... with individual arguments', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'compare-cmd',
                template: 'Compare $1 with $2',
                isCommand: true,
                commandName: 'compare'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'compare-cmd|item1 item2' }, {});
            (0, chai_1.expect)(result?.value).to.equal('Compare item1 with item2');
        });
        it('handles quoted arguments in $1, $2', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-cmd',
                template: 'First: $1, Second: $2',
                isCommand: true,
                commandName: 'test'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'test-cmd|"arg with spaces" other' }, {});
            (0, chai_1.expect)(result?.value).to.equal('First: arg with spaces, Second: other');
        });
        it('handles escaped quotes in arguments', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-cmd',
                template: 'Arg: $1',
                isCommand: true,
                commandName: 'test'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'test-cmd|"value with \\"quote\\""' }, {});
            (0, chai_1.expect)(result?.value).to.equal('Arg: value with "quote"');
        });
        it('handles 10+ arguments correctly', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-cmd',
                template: 'Args: $1 $10 $11',
                isCommand: true,
                commandName: 'test'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'test-cmd|a b c d e f g h i j k' }, {});
            (0, chai_1.expect)(result?.value).to.equal('Args: a j k');
        });
        it('handles command without arguments', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'hello-cmd',
                template: 'Hello, world!',
                isCommand: true,
                commandName: 'hello'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'hello-cmd' }, {});
            (0, chai_1.expect)(result?.value).to.equal('Hello, world!');
        });
        it('handles non-command prompts without substitution', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'normal-prompt',
                template: 'This has $1 and $ARGUMENTS but is not a command'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'normal-prompt' }, {});
            // No substitution should occur for non-commands
            (0, chai_1.expect)(result?.value).to.equal('This has $1 and $ARGUMENTS but is not a command');
        });
        it('handles missing argument placeholders gracefully', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-cmd',
                template: 'Args: $1 $2 $3',
                isCommand: true,
                commandName: 'test'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'test-cmd|only-one' }, {});
            // Missing arguments should remain as placeholders
            (0, chai_1.expect)(result?.value).to.equal('Args: only-one $2 $3');
        });
    });
    describe('Command Resolution', () => {
        it('resolves command fragments correctly', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'test-cmd',
                template: 'Do something with $ARGUMENTS',
                isCommand: true,
                commandName: 'test'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'test-cmd|input' }, {});
            (0, chai_1.expect)(result?.value).to.equal('Do something with input');
            (0, chai_1.expect)(result?.variable).to.deep.equal(prompt_variable_contribution_1.PROMPT_VARIABLE);
        });
        describe('customized (file-based) commands, whose fragment id differs from the command name', () => {
            const customized = {
                id: 'my-file',
                customizationId: 'customization-1',
                priority: 1,
                template: 'Deploy $ARGUMENTS now.',
                isCommand: true,
                commandName: 'deploy'
            };
            beforeEach(() => {
                promptService['customizationService'] = {
                    isPromptFragmentCustomized: (id) => id === customized.id,
                    getActivePromptFragmentCustomization: (id) => (id === customized.id ? customized : undefined),
                    getCustomizedPromptFragmentIds: () => [customized.id]
                };
            });
            it('resolves the command with arguments', async () => {
                const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'deploy|prod' }, {});
                (0, chai_1.expect)(result?.value).to.equal('Deploy prod now.');
            });
            it('resolves the command without arguments', async () => {
                const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'deploy' }, {});
                (0, chai_1.expect)(result?.value).to.equal('Deploy $ARGUMENTS now.');
            });
            it('is accepted by isKnownCommand for both invocations', () => {
                (0, chai_1.expect)(promptService.isKnownCommand('deploy')).to.be.true;
            });
            it('still resolves the command by its fragment id', async () => {
                const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'my-file' }, {});
                (0, chai_1.expect)(result?.value).to.equal('Deploy $ARGUMENTS now.');
            });
        });
        // Resolving to `undefined` instead of an empty string makes callers keep the original text
        // (the literal `#prompt:...` / `{{prompt:...}}` placeholder) rather than silently dropping it.
        it('returns undefined for a non-existent prompt with arguments', async () => {
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'non-existent|args' }, {});
            (0, chai_1.expect)(result).to.be.undefined;
        });
        it('returns undefined for a non-existent prompt without arguments', async () => {
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'non-existent' }, {});
            (0, chai_1.expect)(result).to.be.undefined;
        });
        it('returns undefined for a path-like argument', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'hello-cmd',
                template: 'Hello, world!',
                isCommand: true,
                commandName: 'hello'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'home|/user/notes.txt and fix the bug' }, {});
            (0, chai_1.expect)(result).to.be.undefined;
        });
        it('returns undefined when no argument is given', async () => {
            (0, chai_1.expect)(await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: undefined }, {})).to.be.undefined;
            (0, chai_1.expect)(await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: '   ' }, {})).to.be.undefined;
        });
        it('resolves a command referenced by its fragment id without arguments', async () => {
            promptService.addBuiltInPromptFragment({
                id: 'hello-cmd',
                template: 'Hello, world!',
                isCommand: true,
                commandName: 'hello'
            });
            const result = await contribution.resolve({ variable: prompt_variable_contribution_1.PROMPT_VARIABLE, arg: 'hello' }, {});
            (0, chai_1.expect)(result?.value).to.equal('Hello, world!');
        });
    });
});
//# sourceMappingURL=prompt-variable-contribution.spec.js.map