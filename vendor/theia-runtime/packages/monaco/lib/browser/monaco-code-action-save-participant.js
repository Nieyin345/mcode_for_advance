"use strict";
// *****************************************************************************
// Copyright (C) 2025 STMicroelectronics and others.
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
exports.MonacoCodeActionSaveParticipant = void 0;
const tslib_1 = require("tslib");
const browser_1 = require("@theia/core/lib/browser");
const monaco_editor_provider_1 = require("./monaco-editor-provider");
const inversify_1 = require("@theia/core/shared/inversify");
const monaco_code_action_service_1 = require("./monaco-code-action-service");
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Partially copied from https://github.com/microsoft/vscode/blob/f66e839a38dfe39ee66a86619a790f9c2336d698/src/vs/workbench/contrib/codeEditor/browser/saveParticipants.ts#L272
let MonacoCodeActionSaveParticipant = class MonacoCodeActionSaveParticipant {
    constructor() {
        this.order = monaco_editor_provider_1.SAVE_PARTICIPANT_DEFAULT_ORDER;
    }
    async applyChangesOnSave(editor, cancellationToken, options) {
        if (options?.saveReason !== browser_1.SaveReason.Manual) {
            return undefined;
        }
        await this.codeActionService.applyOnSaveCodeActions(editor.document.textEditorModel, editor.document.textEditorModel.getLanguageId(), editor.document.textEditorModel.uri.toString(), cancellationToken);
    }
};
exports.MonacoCodeActionSaveParticipant = MonacoCodeActionSaveParticipant;
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_code_action_service_1.MonacoCodeActionService),
    tslib_1.__metadata("design:type", Object)
], MonacoCodeActionSaveParticipant.prototype, "codeActionService", void 0);
exports.MonacoCodeActionSaveParticipant = MonacoCodeActionSaveParticipant = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoCodeActionSaveParticipant);
//# sourceMappingURL=monaco-code-action-save-participant.js.map