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
exports.MonacoDiffComputer = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const vscode_languageserver_protocol_1 = require("@theia/core/shared/vscode-languageserver-protocol");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const editorWorker_1 = require("@theia/monaco-editor-core/esm/vs/editor/common/services/editorWorker");
let MonacoDiffComputer = class MonacoDiffComputer {
    async computeDiff(left, right) {
        const diff = await standaloneServices_1.StandaloneServices.get(editorWorker_1.IEditorWorkerService).computeDiff(left['codeUri'], right['codeUri'], {
            ignoreTrimWhitespace: false,
            maxComputationTimeMs: 0,
            computeMoves: false,
        }, 'advanced');
        if (!diff) {
            return undefined;
        }
        const convertLineRange = (r) => ({
            start: r.startLineNumber - 1,
            end: r.endLineNumberExclusive - 1
        });
        const convertRange = (r) => vscode_languageserver_protocol_1.Range.create(r.startLineNumber - 1, r.startColumn - 1, r.endLineNumber - 1, r.endColumn - 1);
        const changes = diff.changes.map(c => ({
            left: convertLineRange(c.original),
            right: convertLineRange(c.modified),
            innerChanges: c.innerChanges?.map(ic => ({
                left: convertRange(ic.originalRange),
                right: convertRange(ic.modifiedRange)
            }))
        }));
        return { changes };
    }
};
exports.MonacoDiffComputer = MonacoDiffComputer;
exports.MonacoDiffComputer = MonacoDiffComputer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoDiffComputer);
//# sourceMappingURL=monaco-diff-computer.js.map