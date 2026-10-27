"use strict";
// *****************************************************************************
// Copyright (C) 2020 Red Hat, Inc. and others.
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
exports.MonacoFormattingConflictsContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/editor/lib/browser");
const monaco_quick_input_service_1 = require("./monaco-quick-input-service");
const format_1 = require("@theia/monaco-editor-core/esm/vs/editor/contrib/format/browser/format");
const core_1 = require("@theia/core");
const monaco_formatter_service_1 = require("./monaco-formatter-service");
let MonacoFormattingConflictsContribution = class MonacoFormattingConflictsContribution {
    async initialize() {
        format_1.FormattingConflicts.setFormatterSelector((formatters, document, mode) => this.selectFormatter(formatters, document, mode));
    }
    async selectFormatter(formatters, document, mode) {
        if (formatters.length === 0) {
            return undefined;
        }
        if (formatters.length === 1) {
            return formatters[0];
        }
        const currentEditor = this.editorManager.currentEditor;
        if (!currentEditor) {
            return undefined;
        }
        const languageId = currentEditor.editor.document.languageId;
        const defaultFormatterId = this.formatterService.getDefaultFormatter(languageId, document.uri.toString());
        if (defaultFormatterId) {
            const formatter = formatters.find(f => f.extensionId && f.extensionId.value === defaultFormatterId);
            if (formatter) {
                return formatter;
            }
        }
        return new Promise(async (resolve, reject) => {
            const items = formatters
                .filter(formatter => formatter.displayName)
                .map(formatter => ({
                label: formatter.displayName,
                detail: formatter.extensionId ? formatter.extensionId.value : undefined,
                value: formatter,
            }))
                .sort((a, b) => a.label.localeCompare(b.label));
            const selectedFormatter = await this.monacoQuickInputService.showQuickPick(items, { placeholder: core_1.nls.localizeByDefault('Format Document With...') });
            if (selectedFormatter) {
                this.formatterService.setDefaultFormatter(languageId, selectedFormatter.detail, core_1.PreferenceScope.Workspace);
                resolve(selectedFormatter.value);
            }
            else {
                resolve(undefined);
            }
        });
    }
};
exports.MonacoFormattingConflictsContribution = MonacoFormattingConflictsContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_quick_input_service_1.MonacoQuickInputService),
    tslib_1.__metadata("design:type", monaco_quick_input_service_1.MonacoQuickInputService)
], MonacoFormattingConflictsContribution.prototype, "monacoQuickInputService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.EditorManager),
    tslib_1.__metadata("design:type", browser_1.EditorManager)
], MonacoFormattingConflictsContribution.prototype, "editorManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_formatter_service_1.MonacoFormatterService),
    tslib_1.__metadata("design:type", monaco_formatter_service_1.MonacoFormatterService)
], MonacoFormattingConflictsContribution.prototype, "formatterService", void 0);
exports.MonacoFormattingConflictsContribution = MonacoFormattingConflictsContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoFormattingConflictsContribution);
//# sourceMappingURL=monaco-formatting-conflicts.js.map