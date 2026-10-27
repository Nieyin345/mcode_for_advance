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
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/workbench/contrib/mergeEditor/test/browser/mapping.test.ts
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const vscode_languageserver_protocol_1 = require("@theia/core/shared/vscode-languageserver-protocol");
const range_mapping_1 = require("./range-mapping");
describe('document-range-map', () => {
    it('project', () => {
        const documentRangeMap = new range_mapping_1.DocumentRangeMap([
            new range_mapping_1.RangeMapping(vscode_languageserver_protocol_1.Range.create(2, 4, 2, 6), vscode_languageserver_protocol_1.Range.create(2, 4, 2, 7)),
            new range_mapping_1.RangeMapping(vscode_languageserver_protocol_1.Range.create(3, 2, 4, 3), vscode_languageserver_protocol_1.Range.create(3, 2, 6, 4)),
            new range_mapping_1.RangeMapping(vscode_languageserver_protocol_1.Range.create(4, 5, 4, 7), vscode_languageserver_protocol_1.Range.create(6, 6, 6, 9)),
        ]);
        const project = (line, character) => documentRangeMap.projectPosition({ line, character }).toString();
        (0, chai_1.expect)(project(1, 1)).to.be.equal('[1:1, 1:1) -> [1:1, 1:1)');
        (0, chai_1.expect)(project(2, 3)).to.be.equal('[2:3, 2:3) -> [2:3, 2:3)');
        (0, chai_1.expect)(project(2, 4)).to.be.equal('[2:4, 2:6) -> [2:4, 2:7)');
        (0, chai_1.expect)(project(2, 5)).to.be.equal('[2:4, 2:6) -> [2:4, 2:7)');
        (0, chai_1.expect)(project(2, 6)).to.be.equal('[2:6, 2:6) -> [2:7, 2:7)');
        (0, chai_1.expect)(project(2, 7)).to.be.equal('[2:7, 2:7) -> [2:8, 2:8)');
        (0, chai_1.expect)(project(3, 1)).to.be.equal('[3:1, 3:1) -> [3:1, 3:1)');
        (0, chai_1.expect)(project(3, 2)).to.be.equal('[3:2, 4:3) -> [3:2, 6:4)');
        (0, chai_1.expect)(project(4, 2)).to.be.equal('[3:2, 4:3) -> [3:2, 6:4)');
        (0, chai_1.expect)(project(4, 3)).to.be.equal('[4:3, 4:3) -> [6:4, 6:4)');
        (0, chai_1.expect)(project(4, 4)).to.be.equal('[4:4, 4:4) -> [6:5, 6:5)');
        (0, chai_1.expect)(project(4, 5)).to.be.equal('[4:5, 4:7) -> [6:6, 6:9)');
    });
});
//# sourceMappingURL=range-mapping.spec.js.map