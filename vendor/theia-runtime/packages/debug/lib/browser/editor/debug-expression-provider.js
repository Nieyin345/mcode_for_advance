"use strict";
// *****************************************************************************
// Copyright (C) 2018 TypeFox and others.
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
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and others. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/Microsoft/vscode/blob/master/LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugExpressionProvider = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const monaco = require("@theia/monaco-editor-core");
const cancellation_1 = require("@theia/monaco-editor-core/esm/vs/base/common/cancellation");
const languageFeatures_1 = require("@theia/monaco-editor-core/esm/vs/editor/common/services/languageFeatures");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
/**
 * TODO: introduce a new request to LSP to look up an expression range: https://github.com/Microsoft/language-server-protocol/issues/462
 */
let DebugExpressionProvider = class DebugExpressionProvider {
    async getEvaluatableExpression(editor, selection) {
        const pluginExpressionProvider = standaloneServices_1.StandaloneServices.get(languageFeatures_1.ILanguageFeaturesService).evaluatableExpressionProvider;
        const textEditorModel = editor.document.textEditorModel;
        if (pluginExpressionProvider && pluginExpressionProvider.has(textEditorModel)) {
            const registeredProviders = pluginExpressionProvider.ordered(textEditorModel);
            const position = new monaco.Position(selection.startLineNumber, selection.startColumn);
            const promises = registeredProviders.map(support => Promise.resolve(support.provideEvaluatableExpression(textEditorModel, position, cancellation_1.CancellationToken.None)));
            const results = await Promise.all(promises).then(core_1.ArrayUtils.coalesce);
            if (results.length > 0) {
                const range = results[0].range;
                const matchingExpression = results[0].expression || textEditorModel.getValueInRange(range);
                return { matchingExpression, range };
            }
        }
        else { // use fallback if no provider was registered
            const model = editor.getControl().getModel();
            if (model) {
                const lineContent = model.getLineContent(selection.startLineNumber);
                const { start, end } = this.getExactExpressionStartAndEnd(lineContent, selection.startColumn, selection.endColumn);
                const matchingExpression = lineContent.substring(start - 1, end - 1);
                const range = new monaco.Range(selection.startLineNumber, start, selection.startLineNumber, end);
                return { matchingExpression, range };
            }
        }
    }
    get(model, selection) {
        const lineContent = model.getLineContent(selection.startLineNumber);
        const { start, end } = this.getExactExpressionStartAndEnd(lineContent, selection.startColumn, selection.endColumn);
        return lineContent.substring(start - 1, end - 1);
    }
    getExactExpressionStartAndEnd(lineContent, looseStart, looseEnd) {
        let matchingExpression = undefined;
        let startOffset = 1;
        // Some example supported expressions: myVar.prop, a.b.c.d, myVar?.prop, myVar->prop, MyClass::StaticProp, *myVar
        // Match any character except a set of characters which often break interesting sub-expressions
        const expression = /([^()\[\]{}<>\s+\-/%~#^;=|,`!]|\->)+/g;
        // eslint-disable-next-line no-null/no-null
        let result = null;
        // First find the full expression under the cursor
        while (result = expression.exec(lineContent)) {
            const start = result.index + 1;
            const end = start + result[0].length;
            if (start <= looseStart && end >= looseEnd) {
                matchingExpression = result[0];
                startOffset = start;
                break;
            }
        }
        // If there are non-word characters after the cursor, we want to truncate the expression then.
        // For example in expression 'a.b.c.d', if the focus was under 'b', 'a.b' would be evaluated.
        if (matchingExpression) {
            const subExpression = /\w+/g;
            // eslint-disable-next-line no-null/no-null
            let subExpressionResult = null;
            while (subExpressionResult = subExpression.exec(matchingExpression)) {
                const subEnd = subExpressionResult.index + 1 + startOffset + subExpressionResult[0].length;
                if (subEnd >= looseEnd) {
                    break;
                }
            }
            if (subExpressionResult) {
                matchingExpression = matchingExpression.substring(0, subExpression.lastIndex);
            }
        }
        return matchingExpression ?
            { start: startOffset, end: startOffset + matchingExpression.length } :
            { start: 1, end: 1 };
    }
};
exports.DebugExpressionProvider = DebugExpressionProvider;
exports.DebugExpressionProvider = DebugExpressionProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DebugExpressionProvider);
//# sourceMappingURL=debug-expression-provider.js.map