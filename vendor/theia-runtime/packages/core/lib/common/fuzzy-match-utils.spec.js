"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
const chai_1 = require("chai");
const fuzzy_match_utils_1 = require("./fuzzy-match-utils");
describe('fuzzy-match-utils', () => {
    describe('#findSubstringIndex', () => {
        it('should return the index of a case-insensitive substring match', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.findSubstringIndex)('fontSize', 'font')).to.equal(0);
            (0, chai_1.expect)((0, fuzzy_match_utils_1.findSubstringIndex)('setFont', 'font')).to.equal(3);
        });
        it('should be case-insensitive', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.findSubstringIndex)('FontSize', 'font')).to.equal(0);
            (0, chai_1.expect)((0, fuzzy_match_utils_1.findSubstringIndex)('fontSize', 'Font')).to.equal(0);
        });
        it('should return -1 when pattern is not a substring', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.findSubstringIndex)('reformatting', 'font')).to.equal(-1);
        });
        it('should return 0 for empty pattern', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.findSubstringIndex)('anything', '')).to.equal(0);
        });
    });
    describe('#hasSubstringMatch', () => {
        it('should return true for exact substring match', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasSubstringMatch)('fontSize', 'font')).to.be.true;
        });
        it('should be case-insensitive', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasSubstringMatch)('FontSize', 'font')).to.be.true;
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasSubstringMatch)('fontSize', 'Font')).to.be.true;
        });
        it('should return false when pattern is not a substring', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasSubstringMatch)('reformatting', 'font')).to.be.false;
        });
        it('should return true for empty pattern', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasSubstringMatch)('anything', '')).to.be.true;
        });
        it('should return true when text equals pattern', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasSubstringMatch)('font', 'font')).to.be.true;
        });
    });
    describe('#hasPrefixMatch', () => {
        it('should match simple prefix', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('fontSize', 'font')).to.be.true;
        });
        it('should match segmented prefix across punctuation', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('workspace-server', 'works-ser')).to.be.true;
        });
        it('should match when query parts skip segments', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('workspace-backend-service', 'works-ser')).to.be.true;
        });
        it('should not match when first segment does not match', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('backend-workspace-service', 'works-ser')).to.be.false;
        });
        it('should be case-insensitive', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('WorkspaceServer', 'work')).to.be.true;
        });
        it('should return true for empty pattern', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('anything', '')).to.be.true;
        });
        it('should handle various separators', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('workspace_server', 'works_ser')).to.be.true;
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('workspace.server.ts', 'works.ser')).to.be.true;
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('workspace/server', 'works/ser')).to.be.true;
        });
        it('should not match when query parts are out of order', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('service-workspace', 'works-ser')).to.be.false;
        });
        it('should return true when pattern is only separators', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('anything', '---')).to.be.true;
        });
        it('should return false when text is only separators', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('---', 'abc')).to.be.false;
        });
        it('should not match when a later query part has no matching segment', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.hasPrefixMatch)('workspace-server', 'works-zzz')).to.be.false;
        });
    });
    describe('#matchRank', () => {
        it('should return 0 for prefix matches', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.matchRank)('fontSize', 'font')).to.equal(0);
            (0, chai_1.expect)((0, fuzzy_match_utils_1.matchRank)('workspace-server', 'works-ser')).to.equal(0);
        });
        it('should return 1 for substring (non-prefix) matches', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.matchRank)('setFont', 'font')).to.equal(1);
            (0, chai_1.expect)((0, fuzzy_match_utils_1.matchRank)('base.tsconfig.json', 'con')).to.equal(1);
        });
        it('should return 2 for fuzzy-only matches', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.matchRank)('baconing', 'bcn')).to.equal(2);
        });
        it('should return 0 for empty pattern', () => {
            (0, chai_1.expect)((0, fuzzy_match_utils_1.matchRank)('anything', '')).to.equal(0);
        });
    });
});
//# sourceMappingURL=fuzzy-match-utils.spec.js.map