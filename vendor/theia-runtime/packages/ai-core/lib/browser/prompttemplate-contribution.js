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
exports.PromptTemplateContribution = exports.DISCARD_PROMPT_TEMPLATE_CUSTOMIZATIONS = exports.PROMPT_TEMPLATE_EXTENSION = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const monaco = require("@theia/monaco-editor-core");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const browser_2 = require("@theia/editor/lib/browser");
const common_1 = require("../common");
const variable_service_1 = require("../common/variable-service");
const PROMPT_TEMPLATE_LANGUAGE_ID = 'theia-ai-prompt-template';
const PROMPT_TEMPLATE_TEXTMATE_SCOPE = 'source.prompttemplate';
exports.PROMPT_TEMPLATE_EXTENSION = '.prompttemplate';
exports.DISCARD_PROMPT_TEMPLATE_CUSTOMIZATIONS = core_1.Command.toLocalizedCommand({
    id: 'theia-ai-prompt-template:discard',
    label: 'Discard AI Prompt Template',
    iconClass: (0, browser_1.codicon)('discard'),
    category: 'AI Prompt Templates'
}, 'theia/ai/core/discard/label', 'theia/ai/core/prompts/category');
let PromptTemplateContribution = class PromptTemplateContribution {
    constructor() {
        this.config = {
            'brackets': [
                ['${', '}'],
                ['~{', '}'],
                ['{{', '}}'],
                ['{{{', '}}}']
            ],
            'autoClosingPairs': [
                { 'open': '${', 'close': '}' },
                { 'open': '~{', 'close': '}' },
                { 'open': '{{', 'close': '}}' },
                { 'open': '{{{', 'close': '}}}' }
            ],
            'surroundingPairs': [
                { 'open': '${', 'close': '}' },
                { 'open': '~{', 'close': '}' },
                { 'open': '{{', 'close': '}}' },
                { 'open': '{{{', 'close': '}}}' }
            ]
        };
    }
    registerTextmateLanguage(registry) {
        monaco.languages.register({
            id: PROMPT_TEMPLATE_LANGUAGE_ID,
            'aliases': [
                'AI Prompt Template'
            ],
            'extensions': [
                exports.PROMPT_TEMPLATE_EXTENSION,
            ],
            'filenames': []
        });
        monaco.languages.setLanguageConfiguration(PROMPT_TEMPLATE_LANGUAGE_ID, this.config);
        monaco.languages.registerCompletionItemProvider(PROMPT_TEMPLATE_LANGUAGE_ID, {
            // Monaco only supports single character trigger characters
            triggerCharacters: ['{'],
            provideCompletionItems: (model, position, _context, _token) => this.provideFunctionCompletions(model, position),
        });
        monaco.languages.registerCompletionItemProvider(PROMPT_TEMPLATE_LANGUAGE_ID, {
            // Monaco only supports single character trigger characters
            triggerCharacters: ['{'],
            provideCompletionItems: (model, position, _context, _token) => this.provideVariableCompletions(model, position),
        });
        monaco.languages.registerCompletionItemProvider(PROMPT_TEMPLATE_LANGUAGE_ID, {
            // Monaco only supports single character trigger characters
            triggerCharacters: ['{', ':'],
            provideCompletionItems: (model, position, _context, _token) => this.provideVariableWithArgCompletions(model, position),
        });
        const textmateGrammar = require('../../data/prompttemplate.tmLanguage.json');
        const grammarDefinitionProvider = {
            getGrammarDefinition: function () {
                return Promise.resolve({
                    format: 'json',
                    content: textmateGrammar
                });
            }
        };
        registry.registerTextmateGrammarScope(PROMPT_TEMPLATE_TEXTMATE_SCOPE, grammarDefinitionProvider);
        registry.mapLanguageIdToTextmateGrammar(PROMPT_TEMPLATE_LANGUAGE_ID, PROMPT_TEMPLATE_TEXTMATE_SCOPE);
    }
    provideFunctionCompletions(model, position) {
        return this.getSuggestions(model, position, '~{', this.toolInvocationRegistry.getAllFunctions(), monaco.languages.CompletionItemKind.Function, tool => tool.id, tool => tool.name, tool => tool.description ?? '');
    }
    provideVariableCompletions(model, position) {
        return this.getSuggestions(model, position, '{{', this.variableService.getVariables(), monaco.languages.CompletionItemKind.Variable, variable => variable.args?.some(arg => !arg.isOptional) ? variable.name + common_1.PromptText.VARIABLE_SEPARATOR_CHAR : variable.name, variable => variable.name, variable => variable.description ?? '');
    }
    async provideVariableWithArgCompletions(model, position) {
        // Get the text of the current line up to the cursor position
        const textUntilPosition = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
        });
        // Regex that captures the variable name in contexts like {{, {{{, {{varname, {{{varname, {{varname:, or {{{varname:
        const variableRegex = /(?:\{\{\{|\{\{)([\w-]+)?(?::)?/;
        const match = textUntilPosition.match(variableRegex);
        if (!match) {
            return { suggestions: [] };
        }
        const currentVariableName = match[1];
        const hasColonSeparator = textUntilPosition.includes(`${currentVariableName}:`);
        const variables = this.variableService.getVariables();
        const suggestions = [];
        for (const variable of variables) {
            // If we have a variable:arg pattern, only process the matching variable
            if (hasColonSeparator && variable.name !== currentVariableName) {
                continue;
            }
            const provider = await this.variableService.getArgumentCompletionProvider(variable.name);
            if (provider) {
                const items = await provider(model, position, '{');
                if (items) {
                    suggestions.push(...items.map(item => ({
                        ...item
                    })));
                }
            }
        }
        return { suggestions };
    }
    getCompletionRange(model, position, triggerCharacters) {
        // Check if the characters before the current position are the trigger characters
        const lineContent = model.getLineContent(position.lineNumber);
        const triggerLength = triggerCharacters.length;
        const charactersBefore = lineContent.substring(position.column - triggerLength - 1, position.column - 1);
        if (charactersBefore !== triggerCharacters) {
            // Do not return agent suggestions if the user didn't just type the trigger characters
            return undefined;
        }
        // Calculate the range from the position of the trigger characters
        const wordInfo = model.getWordUntilPosition(position);
        return new monaco.Range(position.lineNumber, wordInfo.startColumn, position.lineNumber, position.column);
    }
    getSuggestions(model, position, triggerChars, items, kind, getId, getName, getDescription) {
        const completionRange = this.getCompletionRange(model, position, triggerChars);
        if (completionRange === undefined) {
            return { suggestions: [] };
        }
        const suggestions = items.map(item => ({
            insertText: getId(item),
            kind: kind,
            label: getName(item),
            range: completionRange,
            detail: getDescription(item),
        }));
        return { suggestions };
    }
    registerCommands(commands) {
        commands.registerCommand(exports.DISCARD_PROMPT_TEMPLATE_CUSTOMIZATIONS, {
            isVisible: (widget) => this.isPromptTemplateWidget(widget),
            isEnabled: (widget) => this.canDiscard(widget),
            execute: (widget) => this.discard(widget)
        });
    }
    isPromptTemplateWidget(widget) {
        if (widget instanceof browser_2.EditorWidget) {
            return PROMPT_TEMPLATE_LANGUAGE_ID === widget.editor.document.languageId;
        }
        return false;
    }
    canDiscard(widget) {
        if (!(widget instanceof browser_2.EditorWidget)) {
            return false;
        }
        const resourceUri = widget.editor.uri;
        const id = this.promptService.getTemplateIDFromResource(resourceUri);
        if (id === undefined) {
            return false;
        }
        const rawPrompt = this.promptService.getRawPromptFragment(id);
        const defaultPrompt = this.promptService.getBuiltInRawPrompt(id);
        return rawPrompt?.template !== defaultPrompt?.template;
    }
    async discard(widget) {
        const resourceUri = widget.editor.uri;
        const id = this.promptService.getTemplateIDFromResource(resourceUri);
        if (id === undefined) {
            return;
        }
        const defaultPrompt = this.promptService.getBuiltInRawPrompt(id);
        if (defaultPrompt === undefined) {
            return;
        }
        const source = widget.editor.document.getText();
        const lastLine = widget.editor.document.getLineContent(widget.editor.document.lineCount);
        const replaceOperation = {
            range: {
                start: {
                    line: 0,
                    character: 0
                },
                end: {
                    line: widget.editor.document.lineCount,
                    character: lastLine.length
                }
            },
            text: defaultPrompt.template
        };
        await widget.editor.replaceText({
            source,
            replaceOperations: [replaceOperation]
        });
    }
    registerToolbarItems(registry) {
        registry.registerItem({
            id: exports.DISCARD_PROMPT_TEMPLATE_CUSTOMIZATIONS.id,
            command: exports.DISCARD_PROMPT_TEMPLATE_CUSTOMIZATIONS.id,
            tooltip: core_1.nls.localize('theia/ai/core/discardCustomPrompt/tooltip', 'Discard Customizations')
        });
    }
};
exports.PromptTemplateContribution = PromptTemplateContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.PromptService),
    tslib_1.__metadata("design:type", Object)
], PromptTemplateContribution.prototype, "promptService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ToolInvocationRegistry),
    tslib_1.__metadata("design:type", Object)
], PromptTemplateContribution.prototype, "toolInvocationRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(variable_service_1.AIVariableService),
    tslib_1.__metadata("design:type", Object)
], PromptTemplateContribution.prototype, "variableService", void 0);
exports.PromptTemplateContribution = PromptTemplateContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PromptTemplateContribution);
//# sourceMappingURL=prompttemplate-contribution.js.map