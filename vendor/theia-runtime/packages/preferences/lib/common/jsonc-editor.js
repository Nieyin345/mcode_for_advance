"use strict";
// *****************************************************************************
// Copyright (C) 2021 Ericsson and others.
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
exports.JSONCEditor = void 0;
const tslib_1 = require("tslib");
const jsoncparser = require("jsonc-parser");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
let JSONCEditor = class JSONCEditor {
    setValue(model, path, value) {
        const edits = this.getEditOperations(model, path, value);
        return jsoncparser.applyEdits(model, edits);
    }
    getEditOperations(content, path, value) {
        // Everything is already undefined - no need for changes.
        if (!content && value === undefined) {
            return [];
        }
        // Delete the entire document.
        if (!path.length && value === undefined) {
            return [{
                    offset: 0,
                    length: content.length,
                    content: ''
                }];
        }
        const tabSize = this.preferenceService.get('[json].editor.tabSize', 4);
        const insertSpaces = this.preferenceService.get('[json].editor.insertSpaces', true);
        const jsonCOptions = {
            formattingOptions: {
                insertSpaces,
                tabSize,
                eol: this.getEOL()
            }
        };
        return jsoncparser.modify(content, path, value, jsonCOptions);
    }
    getEOL() {
        const eol = this.preferenceService.get('[json].files.eol');
        if (eol && typeof eol === 'string' && eol !== 'auto') {
            return eol;
        }
        return core_1.isWindows ? '\r\n' : '\n';
    }
};
exports.JSONCEditor = JSONCEditor;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], JSONCEditor.prototype, "preferenceService", void 0);
exports.JSONCEditor = JSONCEditor = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], JSONCEditor);
//# sourceMappingURL=jsonc-editor.js.map