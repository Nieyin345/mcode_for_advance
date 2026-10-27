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
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuickInputService = exports.quickInputServicePath = exports.QuickInputHideReason = exports.QuickInputButtonLocation = exports.QuickPickSeparator = exports.QuickPickItem = exports.QuickPickService = exports.quickPickServicePath = void 0;
exports.filterItems = filterItems;
exports.findMatches = findMatches;
const fuzzy = require("fuzzy");
const fuzzy_match_utils_1 = require("./fuzzy-match-utils");
exports.quickPickServicePath = '/services/quickPick';
exports.QuickPickService = Symbol('QuickPickService');
var QuickPickItem;
(function (QuickPickItem) {
    function is(item) {
        // if it's not a separator, it's an item
        return item.type !== 'separator';
    }
    QuickPickItem.is = is;
})(QuickPickItem || (exports.QuickPickItem = QuickPickItem = {}));
var QuickPickSeparator;
(function (QuickPickSeparator) {
    function is(item) {
        return item.type === 'separator';
    }
    QuickPickSeparator.is = is;
})(QuickPickSeparator || (exports.QuickPickSeparator = QuickPickSeparator = {}));
/**
 * Specifies the location where a {@link QuickInputButton} should be rendered.
 */
var QuickInputButtonLocation;
(function (QuickInputButtonLocation) {
    /**
     * The button is rendered in the title bar.
     */
    QuickInputButtonLocation[QuickInputButtonLocation["Title"] = 1] = "Title";
    /**
     * The button is rendered inline to the right of the input box.
     */
    QuickInputButtonLocation[QuickInputButtonLocation["Inline"] = 2] = "Inline";
    /**
     * The button is rendered at the far end inside the input box.
     */
    QuickInputButtonLocation[QuickInputButtonLocation["Input"] = 3] = "Input";
})(QuickInputButtonLocation || (exports.QuickInputButtonLocation = QuickInputButtonLocation = {}));
var QuickInputHideReason;
(function (QuickInputHideReason) {
    /**
     * Focus was moved away from the input, but the user may not have explicitly closed it.
     */
    QuickInputHideReason[QuickInputHideReason["Blur"] = 1] = "Blur";
    /**
     * An explicit close gesture, like striking the Escape key
     */
    QuickInputHideReason[QuickInputHideReason["Gesture"] = 2] = "Gesture";
    /**
     * Any other reason
     */
    QuickInputHideReason[QuickInputHideReason["Other"] = 3] = "Other";
})(QuickInputHideReason || (exports.QuickInputHideReason = QuickInputHideReason = {}));
exports.quickInputServicePath = '/services/quickInput';
exports.QuickInputService = Symbol('QuickInputService');
/**
 * Filter the list of quick pick items based on the provided filter.
 * Items are filtered based on if:
 * - their `label` satisfies the filter using `fuzzy`.
 * - their `description` satisfies the filter using `fuzzy`.
 * - their `detail` satisfies the filter using `fuzzy`.
 * Filtered items are also updated to display proper highlights based on how they were filtered.
 * @param items the list of quick pick items.
 * @param filter the filter to search for.
 * @returns the list of quick pick items that satisfy the filter.
 */
function filterItems(items, filter) {
    filter = filter.trim().toLowerCase();
    if (filter.length === 0) {
        for (const item of items) {
            if (item.type !== 'separator') {
                item.highlights = undefined; // reset highlights from previous filtering.
            }
        }
        return items;
    }
    function matchesFilter(item) {
        return fuzzy.test(filter, item.label) ||
            (!!item.description && fuzzy.test(filter, item.description)) ||
            (!!item.detail && fuzzy.test(filter, item.detail));
    }
    function itemMatchRank(item) {
        return Math.min((0, fuzzy_match_utils_1.matchRank)(item.label, filter), item.description ? (0, fuzzy_match_utils_1.matchRank)(item.description, filter) : 2, item.detail ? (0, fuzzy_match_utils_1.matchRank)(item.detail, filter) : 2);
    }
    // Process items in separator groups, sorted by match rank within each group.
    const result = [];
    let currentSeparator;
    let groupMatches = [];
    const flushGroup = () => {
        if (groupMatches.length > 0) {
            if (currentSeparator) {
                result.push(currentSeparator);
            }
            groupMatches.sort((a, b) => a.rank - b.rank);
            result.push(...groupMatches.map(m => m.item));
        }
        groupMatches = [];
    };
    for (const item of items) {
        if (item.type === 'separator') {
            flushGroup();
            currentSeparator = item;
        }
        else if (matchesFilter(item)) {
            item.highlights = {
                label: findMatches(item.label, filter),
                description: item.description ? findMatches(item.description, filter) : undefined,
                detail: item.detail ? findMatches(item.detail, filter) : undefined
            };
            groupMatches.push({ item, rank: itemMatchRank(item) });
        }
    }
    flushGroup();
    return result;
}
/**
 * Find match highlights when testing a word against a pattern.
 * @param word the word to test.
 * @param pattern the word to match against.
 * @returns the list of highlights if present.
 */
function findMatches(word, pattern) {
    word = word.toLocaleLowerCase();
    pattern = pattern.toLocaleLowerCase();
    if (pattern.trim().length === 0) {
        return undefined;
    }
    // Prefer a contiguous substring highlight over scattered fuzzy character highlights.
    const substringIndex = (0, fuzzy_match_utils_1.findSubstringIndex)(word, pattern);
    if (substringIndex !== -1) {
        return [{ start: substringIndex, end: substringIndex + pattern.length }];
    }
    const delimiter = '\u0000'; // null byte that shouldn't appear in the input and is used to denote matches.
    const matchResult = fuzzy.match(pattern.replace(/\u0000/gu, ''), word, { pre: delimiter, post: delimiter });
    if (!matchResult) {
        return undefined;
    }
    const match = matchResult.rendered;
    const highlights = [];
    let lastIndex = 0;
    /** We need to account for the extra markers by removing them from the range */
    let offset = 0;
    while (true) {
        const start = match.indexOf(delimiter, lastIndex);
        if (start === -1) {
            break;
        }
        const end = match.indexOf(delimiter, start + 1);
        if (end === -1) {
            break;
        }
        highlights.push({
            start: start - offset++,
            end: end - offset++
        });
        lastIndex = end + 1;
    }
    return highlights.length > 0 ? highlights : undefined;
}
//# sourceMappingURL=quick-pick-service.js.map