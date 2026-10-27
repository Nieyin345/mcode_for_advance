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
var FuzzySearch_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.FuzzySearch = void 0;
const tslib_1 = require("tslib");
const fuzzy = require("fuzzy");
const inversify_1 = require("inversify");
const fuzzy_match_utils_1 = require("./fuzzy-match-utils");
let FuzzySearch = class FuzzySearch {
    static { FuzzySearch_1 = this; }
    static { this.PRE = '\x01'; }
    static { this.POST = '\x02'; }
    /**
     * Filters the input and returns with an array that contains all items that match the pattern.
     */
    async filter(input) {
        return fuzzy.filter(input.pattern, input.items.slice(), {
            pre: FuzzySearch_1.PRE,
            post: FuzzySearch_1.POST,
            extract: input.transform
        }).sort((left, right) => this.sortResultsForInput(left, right, input))
            .map(result => this.mapResultForInput(result, input));
    }
    sortResultsForInput(left, right, input) {
        const leftRank = (0, fuzzy_match_utils_1.matchRank)(input.transform(left.original), input.pattern);
        const rightRank = (0, fuzzy_match_utils_1.matchRank)(input.transform(right.original), input.pattern);
        if (leftRank !== rightRank) {
            return leftRank - rightRank;
        }
        return this.sortResults(left, right);
    }
    sortResults(left, right) {
        if (right.score !== left.score) {
            return right.score - left.score;
        }
        return left.index - right.index;
    }
    mapResultForInput(result, input) {
        const text = input.transform(result.original);
        const substringIndex = input.pattern ? (0, fuzzy_match_utils_1.findSubstringIndex)(text, input.pattern) : -1;
        if (substringIndex !== -1) {
            return {
                item: result.original,
                ranges: [{ offset: substringIndex, length: input.pattern.length }]
            };
        }
        return this.mapResult(result);
    }
    mapResult(result) {
        return {
            item: result.original,
            ranges: this.mapRanges(result.string)
        };
    }
    mapRanges(input) {
        const copy = input.split('').filter(s => s !== '');
        const ranges = [];
        const validate = (pre, post) => {
            if (preIndex > postIndex || (preIndex === -1) !== (postIndex === -1)) {
                throw new Error(`Error when trying to map ranges. Escaped string was: '${input}. [${[...input].join('|')}]'`);
            }
        };
        let preIndex = copy.indexOf(FuzzySearch_1.PRE);
        let postIndex = copy.indexOf(FuzzySearch_1.POST);
        validate(preIndex, postIndex);
        while (preIndex !== -1 && postIndex !== -1) {
            ranges.push({
                offset: preIndex,
                length: postIndex - preIndex - 1
            });
            copy.splice(postIndex, 1);
            copy.splice(preIndex, 1);
            preIndex = copy.indexOf(FuzzySearch_1.PRE);
            postIndex = copy.indexOf(FuzzySearch_1.POST);
        }
        if (ranges.length === 0) {
            throw new Error(`Unexpected zero ranges for match-string: ${input}.`);
        }
        return ranges;
    }
};
exports.FuzzySearch = FuzzySearch;
exports.FuzzySearch = FuzzySearch = FuzzySearch_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FuzzySearch);
//# sourceMappingURL=fuzzy-search.js.map