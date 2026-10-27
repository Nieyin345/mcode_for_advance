"use strict";
// *****************************************************************************
// Copyright (C) 2015-2018 Red Hat, Inc.
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
exports.GrammarsReader = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const read_grammars_1 = require("@theia/plugin-utils/lib/node/read-grammars");
let GrammarsReader = class GrammarsReader {
    async readGrammars(rawGrammars, pluginPath, log) {
        const result = new Array();
        for (const rawGrammar of rawGrammars) {
            const grammar = await this.readGrammar(rawGrammar, pluginPath, log);
            if (grammar) {
                result.push(grammar);
            }
        }
        return result;
    }
    async readGrammar(rawGrammar, pluginPath, log) {
        return (0, read_grammars_1.readGrammarFromDisk)(rawGrammar, pluginPath, log);
    }
};
exports.GrammarsReader = GrammarsReader;
exports.GrammarsReader = GrammarsReader = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], GrammarsReader);
//# sourceMappingURL=grammars-reader.js.map