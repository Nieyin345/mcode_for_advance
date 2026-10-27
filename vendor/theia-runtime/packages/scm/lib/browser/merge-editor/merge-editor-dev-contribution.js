"use strict";
// *****************************************************************************
// Copyright (C) 2025 1C-Soft LLC and others.
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
exports.MergeEditorDevContribution = exports.MergeEditorDevCommands = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const clipboard_service_1 = require("@theia/core/lib/browser/clipboard-service");
const language_service_1 = require("@theia/core/lib/browser/language-service");
const merge_editor_1 = require("./merge-editor");
var MergeEditorDevCommands;
(function (MergeEditorDevCommands) {
    MergeEditorDevCommands.MERGE_EDITOR_DEV_CATEGORY = 'Merge Editor (Dev)';
    MergeEditorDevCommands.COPY_CONTENTS_TO_JSON = core_1.Command.toDefaultLocalizedCommand({
        id: 'mergeEditor.dev.copyContentsToJSON',
        label: 'Copy Merge Editor State as JSON',
        category: MergeEditorDevCommands.MERGE_EDITOR_DEV_CATEGORY
    });
    MergeEditorDevCommands.OPEN_CONTENTS_FROM_JSON = core_1.Command.toDefaultLocalizedCommand({
        id: 'mergeEditor.dev.openContentsFromJSON',
        label: 'Open Merge Editor State from JSON',
        category: MergeEditorDevCommands.MERGE_EDITOR_DEV_CATEGORY
    });
})(MergeEditorDevCommands || (exports.MergeEditorDevCommands = MergeEditorDevCommands = {}));
let MergeEditorDevContribution = class MergeEditorDevContribution {
    getMergeEditor(widget = this.shell.currentWidget) {
        return widget instanceof merge_editor_1.MergeEditor ? widget : (widget?.parent ? this.getMergeEditor(widget.parent) : undefined);
    }
    registerCommands(commands) {
        commands.registerCommand(MergeEditorDevCommands.COPY_CONTENTS_TO_JSON, {
            execute: widget => {
                const editor = this.getMergeEditor(widget);
                if (editor) {
                    this.copyContentsToJSON(editor);
                }
            },
            isEnabled: widget => !!this.getMergeEditor(widget),
            isVisible: widget => !!this.getMergeEditor(widget)
        });
        commands.registerCommand(MergeEditorDevCommands.OPEN_CONTENTS_FROM_JSON, {
            execute: () => this.openContentsFromJSON().catch(error => this.messageService.error(error.message))
        });
    }
    copyContentsToJSON(editor) {
        const { model } = editor;
        const editorContents = {
            base: model.baseDocument.getText(),
            input1: model.side1Document.getText(),
            input2: model.side2Document.getText(),
            result: model.resultDocument.getText(),
            languageId: model.resultDocument.getLanguageId()
        };
        this.clipboardService.writeText(JSON.stringify(editorContents, undefined, 2));
        this.messageService.info(core_1.nls.localizeByDefault('Successfully copied merge editor state'));
    }
    async openContentsFromJSON() {
        const inputText = await this.quickInputService.input({
            prompt: core_1.nls.localizeByDefault('Enter JSON'),
            value: await this.clipboardService.readText()
        });
        if (!inputText) {
            return;
        }
        const { base, input1, input2, result, languageId } = Object.assign({
            base: '',
            input1: '',
            input2: '',
            result: '',
            languageId: 'plaintext'
        }, JSON.parse(inputText));
        const extension = Array.from(this.languageService.getLanguage(languageId)?.extensions ?? [''])[0];
        const parentUri = new core_1.URI('merge-editor-dev://' + (0, core_1.generateUuid)());
        const baseUri = parentUri.resolve('base' + extension);
        const side1Uri = parentUri.resolve('side1' + extension);
        const side2Uri = parentUri.resolve('side2' + extension);
        const resultUri = parentUri.resolve('result' + extension);
        const toDispose = new core_1.DisposableCollection();
        try {
            toDispose.push(this.inMemoryResources.add(baseUri, base));
            toDispose.push(this.inMemoryResources.add(side1Uri, input1));
            toDispose.push(this.inMemoryResources.add(side2Uri, input2));
            toDispose.push(this.inMemoryResources.add(resultUri, result));
            const uri = merge_editor_1.MergeEditorUri.encode({ baseUri, side1Uri, side2Uri, resultUri });
            const options = {
                widgetState: {
                    side1State: {
                        title: 'Left',
                        description: '(from JSON)'
                    },
                    side2State: {
                        title: 'Right',
                        description: '(from JSON)'
                    }
                }
            };
            await (0, browser_1.open)(this.openerService, uri, options);
        }
        finally {
            toDispose.dispose();
        }
    }
};
exports.MergeEditorDevContribution = MergeEditorDevContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ApplicationShell),
    tslib_1.__metadata("design:type", browser_1.ApplicationShell)
], MergeEditorDevContribution.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(clipboard_service_1.ClipboardService),
    tslib_1.__metadata("design:type", Object)
], MergeEditorDevContribution.prototype, "clipboardService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], MergeEditorDevContribution.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.QuickInputService),
    tslib_1.__metadata("design:type", Object)
], MergeEditorDevContribution.prototype, "quickInputService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(language_service_1.LanguageService),
    tslib_1.__metadata("design:type", language_service_1.LanguageService)
], MergeEditorDevContribution.prototype, "languageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.InMemoryResources),
    tslib_1.__metadata("design:type", core_1.InMemoryResources)
], MergeEditorDevContribution.prototype, "inMemoryResources", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], MergeEditorDevContribution.prototype, "openerService", void 0);
exports.MergeEditorDevContribution = MergeEditorDevContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MergeEditorDevContribution);
//# sourceMappingURL=merge-editor-dev-contribution.js.map