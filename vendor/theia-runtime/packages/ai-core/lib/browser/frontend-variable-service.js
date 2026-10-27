"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultFrontendVariableService = exports.FrontendVariableService = exports.AIVariableCompletionContext = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("../common");
const monaco = require("@theia/monaco-editor-core");
;
;
var AIVariableCompletionContext;
(function (AIVariableCompletionContext) {
    function get(variableName, model, position, matchString) {
        const lineContent = model.getLineContent(position.lineNumber);
        const indexOfVariableTrigger = lineContent.lastIndexOf(matchString ?? common_1.PromptText.VARIABLE_CHAR, position.column - 1);
        // check if there is a variable trigger and no space typed between the variable trigger and the cursor
        if (indexOfVariableTrigger === -1 || lineContent.substring(indexOfVariableTrigger).includes(' ')) {
            return undefined;
        }
        // determine whether we are providing completions before or after the variable argument separator
        const indexOfVariableArgSeparator = lineContent.lastIndexOf(common_1.PromptText.VARIABLE_SEPARATOR_CHAR, position.column - 1);
        const triggerCharIndex = Math.max(indexOfVariableTrigger, indexOfVariableArgSeparator);
        const userInput = lineContent.substring(triggerCharIndex + 1, position.column - 1);
        const range = new monaco.Range(position.lineNumber, triggerCharIndex + 2, position.lineNumber, position.column);
        const matchVariableChar = lineContent[triggerCharIndex] === (matchString ? matchString : common_1.PromptText.VARIABLE_CHAR);
        const prefix = matchVariableChar ? variableName + common_1.PromptText.VARIABLE_SEPARATOR_CHAR : '';
        return { range, userInput, prefix };
    }
    AIVariableCompletionContext.get = get;
})(AIVariableCompletionContext || (exports.AIVariableCompletionContext = AIVariableCompletionContext = {}));
exports.FrontendVariableService = Symbol('FrontendVariableService');
let DefaultFrontendVariableService = class DefaultFrontendVariableService extends common_1.DefaultAIVariableService {
    constructor() {
        super(...arguments);
        this.dropHandlers = new Set();
        this.pasteHandlers = new Set();
    }
    onStart() {
        this.initContributions();
    }
    registerDropHandler(handler) {
        this.dropHandlers.add(handler);
        return core_1.Disposable.create(() => this.unregisterDropHandler(handler));
    }
    unregisterDropHandler(handler) {
        this.dropHandlers.delete(handler);
    }
    async getDropResult(event, context) {
        let text = undefined;
        const variables = [];
        for (const handler of this.dropHandlers) {
            const result = await handler(event, context);
            if (result) {
                variables.push(...result.variables);
                if (text === undefined) {
                    text = result.text;
                }
            }
        }
        return { variables, text };
    }
    registerPasteHandler(handler) {
        this.pasteHandlers.add(handler);
        return core_1.Disposable.create(() => this.unregisterPasteHandler(handler));
    }
    unregisterPasteHandler(handler) {
        this.pasteHandlers.delete(handler);
    }
    async getPasteResult(event, context) {
        let text = undefined;
        const variables = [];
        for (const handler of this.pasteHandlers) {
            const result = await handler(event, context);
            if (result) {
                variables.push(...result.variables);
                if (text === undefined) {
                    text = result.text;
                }
            }
        }
        return { variables, text };
    }
    registerOpener(variable, opener) {
        const key = this.getKey(variable.name);
        if (!this.variables.get(key)) {
            this.variables.set(key, variable);
            this.onDidChangeVariablesEmitter.fire();
        }
        const openers = this.openers.get(key) ?? [];
        openers.push(opener);
        this.openers.set(key, openers);
        return core_1.Disposable.create(() => this.unregisterOpener(variable, opener));
    }
    unregisterOpener(variable, opener) {
        const key = this.getKey(variable.name);
        const registeredOpeners = this.openers.get(key);
        registeredOpeners?.splice(registeredOpeners.indexOf(opener), 1);
    }
    async getOpener(name, arg, context = {}) {
        const variable = this.getVariable(name);
        return variable && core_1.Prioritizeable.prioritizeAll(this.openers.get(this.getKey(name)) ?? [], opener => (async () => opener.canOpen({ variable, arg }, context))().catch(() => 0))
            .then(prioritized => prioritized.at(0)?.value);
    }
    async open(request, context) {
        const { variableName, arg } = this.parseRequest(request);
        const variable = this.getVariable(variableName);
        if (!variable) {
            this.messageService.warn(core_1.nls.localize('theia/ai/core/noVariableFoundForOpenRequest', 'No variable found for open request.'));
            return;
        }
        const opener = await this.getOpener(variableName, arg, context);
        try {
            return opener ? opener.open({ variable, arg }, context ?? {}) : this.openReadonly({ variable, arg }, context);
        }
        catch (err) {
            this.logger.error('Unable to open variable:', err);
            this.messageService.error(core_1.nls.localize('theia/ai/core/unableToDisplayVariableValue', 'Unable to display variable value.'));
        }
    }
    async openReadonly(request, context = {}) {
        const resolved = await this.resolveVariable(request, context);
        if (resolved === undefined) {
            this.messageService.warn(core_1.nls.localize('theia/ai/core/unableToResolveVariable', 'Unable to resolve variable.'));
            return;
        }
        const resource = this.aiResourceResolver.getOrCreate(request, context, resolved.value);
        await (0, browser_1.open)(this.openerService, resource.uri);
        resource.dispose();
    }
};
exports.DefaultFrontendVariableService = DefaultFrontendVariableService;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], DefaultFrontendVariableService.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.AIVariableResourceResolver),
    tslib_1.__metadata("design:type", common_1.AIVariableResourceResolver)
], DefaultFrontendVariableService.prototype, "aiResourceResolver", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], DefaultFrontendVariableService.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:DefaultFrontendVariableService'),
    tslib_1.__metadata("design:type", Object)
], DefaultFrontendVariableService.prototype, "logger", void 0);
exports.DefaultFrontendVariableService = DefaultFrontendVariableService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DefaultFrontendVariableService);
//# sourceMappingURL=frontend-variable-service.js.map