"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
var QuickFileSelectService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuickFileSelectService = exports.FileQuickPickItem = void 0;
const tslib_1 = require("tslib");
const browser_1 = require("@theia/core/lib/browser");
const label_provider_1 = require("@theia/core/lib/browser/label-provider");
const quick_input_service_1 = require("@theia/core/lib/browser/quick-input/quick-input-service");
const common_1 = require("@theia/core/lib/common");
const message_service_1 = require("@theia/core/lib/common/message-service");
const uri_1 = require("@theia/core/lib/common/uri");
const fuzzy = require("@theia/core/shared/fuzzy");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_2 = require("@theia/editor/lib/browser");
const navigation_location_service_1 = require("@theia/editor/lib/browser/navigation/navigation-location-service");
const workspace_service_1 = require("@theia/workspace/lib/browser/workspace-service");
const browser_3 = require("@theia/workspace/lib/browser");
const file_search_service_1 = require("../common/file-search-service");
// Supports patterns of <path><#|:><line><#|:|,><col?>
const LINE_COLON_PATTERN = /\s?[#:\(](?:line )?(\d*)(?:[#:,](\d*))?\)?\s*$/;
var FileQuickPickItem;
(function (FileQuickPickItem) {
    function is(obj) {
        return obj && 'uri' in obj;
    }
    FileQuickPickItem.is = is;
})(FileQuickPickItem || (exports.FileQuickPickItem = FileQuickPickItem = {}));
let QuickFileSelectService = class QuickFileSelectService {
    static { QuickFileSelectService_1 = this; }
    /**
     * The score constants when comparing file search results.
     */
    static { this.Scores = {
        max: 1000, // represents the maximum score from fuzzy matching (Infinity).
        exact: 5000, // represents the score assigned to exact matching.
        partial: 2000 // represents the score assigned to partial matching.
    }; }
    async getPicks(fileFilter = '', token = common_1.CancellationToken.None, options = {
        hideIgnoredFiles: true
    }) {
        const roots = this.workspaceService.tryGetRoots();
        const alreadyCollected = new Set();
        const recentlyUsedItems = [];
        if (this.preferences.get('search.quickOpen.includeHistory')) {
            const locations = [...this.navigationLocationService.locations()].reverse();
            for (const location of locations) {
                const uriString = location.uri.toString();
                if (location.uri.scheme === 'file' && !alreadyCollected.has(uriString) && fuzzy.test(fileFilter, uriString)) {
                    if (recentlyUsedItems.length === 0) {
                        recentlyUsedItems.push({
                            type: 'separator',
                            label: common_1.nls.localizeByDefault('recently opened')
                        });
                    }
                    const item = this.toItem(fileFilter, location.uri, options.onSelect);
                    recentlyUsedItems.push(item);
                    alreadyCollected.add(uriString);
                }
            }
        }
        if (fileFilter.length > 0) {
            const handler = async (results) => {
                if (token.isCancellationRequested || results.length <= 0) {
                    return [];
                }
                const result = [...recentlyUsedItems];
                const fileSearchResultItems = [];
                for (const fileUri of results) {
                    if (!alreadyCollected.has(fileUri)) {
                        const item = this.toItem(fileFilter, fileUri, options.onSelect);
                        fileSearchResultItems.push(item);
                        alreadyCollected.add(fileUri);
                    }
                }
                // Create a copy of the file search results and sort.
                const sortedResults = fileSearchResultItems.slice();
                sortedResults.sort((a, b) => this.compareItems(a, b, fileFilter));
                if (sortedResults.length > 0) {
                    result.push({
                        type: 'separator',
                        label: common_1.nls.localizeByDefault('file results')
                    });
                    result.push(...sortedResults);
                }
                // Return the recently used items, followed by the search results.
                return result;
            };
            return this.fileSearchService.find(fileFilter, {
                rootUris: roots.map(r => r.resource.toString()),
                fuzzyMatch: true,
                limit: 200,
                useGitIgnore: options.hideIgnoredFiles,
                excludePatterns: options.hideIgnoredFiles
                    ? this.getExcludePatterns()
                    : undefined,
            }, token).then(handler);
        }
        else {
            return roots.length !== 0 ? recentlyUsedItems : [];
        }
    }
    getExcludePatterns() {
        return this.searchFilterService.getExclusionGlobs();
    }
    compareItems(left, right, fileFilter) {
        /**
         * Score a given string.
         *
         * @param str the string to score on.
         * @returns the score.
         */
        function score(str) {
            if (!str) {
                return 0;
            }
            const lowerStr = str.toLowerCase();
            let exactMatch = true;
            const partialMatches = querySplit.reduce((matched, part) => {
                const partMatches = lowerStr.includes(part);
                exactMatch = exactMatch && partMatches;
                return partMatches ? matched + QuickFileSelectService_1.Scores.partial : matched;
            }, 0);
            // Check fuzzy matches.
            const fuzzyMatch = fuzzy.match(queryJoin, str) ?? { score: 0 };
            if (fuzzyMatch.score === Infinity && exactMatch) {
                return Number.MAX_SAFE_INTEGER;
            }
            return fuzzyMatch.score + partialMatches + (exactMatch ? QuickFileSelectService_1.Scores.exact : 0);
        }
        const query = normalize(fileFilter);
        // Adjust for whitespaces in the query.
        const querySplit = query.split(file_search_service_1.WHITESPACE_QUERY_SEPARATOR);
        const queryJoin = querySplit.join('');
        const compareByLabelScore = (l, r) => score(r.label) - score(l.label);
        const compareByLabelIndex = (l, r) => r.label.toLowerCase().indexOf(query) - l.label.toLowerCase().indexOf(query);
        const compareByLabel = (l, r) => l.label.localeCompare(r.label);
        const compareByPathScore = (l, r) => score(r.uri.path.toString()) - score(l.uri.path.toString());
        const compareByPathIndex = (l, r) => r.uri.path.toString().toLowerCase().indexOf(query) - l.uri.path.toString().toLowerCase().indexOf(query);
        const compareByPathLabel = (l, r) => l.uri.path.toString().localeCompare(r.uri.path.toString());
        return compareWithDiscriminators(left, right, compareByLabelScore, compareByLabelIndex, compareByLabel, compareByPathScore, compareByPathIndex, compareByPathLabel);
    }
    toItem(lookFor, uriOrString, onSelect) {
        const uri = uriOrString instanceof uri_1.default ? uriOrString : new uri_1.default(uriOrString);
        const label = this.labelProvider.getName(uri);
        const description = this.getItemDescription(uri);
        const iconClasses = this.getItemIconClasses(uri);
        const item = {
            label,
            description,
            highlights: {
                label: (0, quick_input_service_1.findMatches)(label, lookFor),
                description: (0, quick_input_service_1.findMatches)(description, lookFor)
            },
            iconClasses,
            uri
        };
        return {
            ...item,
            execute: () => onSelect ? onSelect(item) : undefined
        };
    }
    getItemIconClasses(uri) {
        const icon = this.labelProvider.getIcon(uri).split(' ').filter(v => v.length > 0);
        if (icon.length > 0) {
            icon.push('file-icon');
        }
        return icon;
    }
    getItemDescription(uri) {
        return this.labelProvider.getDetails(uri);
    }
    /**
     * Splits the given expression into a structure of search-file-filter and
     * location-range.
     *
     * @param expression patterns of <path><#|:><line><#|:|,><col?>
     */
    splitFilterAndRange(expression) {
        let filter = expression;
        let range = undefined;
        // Find line and column number from the expression using RegExp.
        const patternMatch = LINE_COLON_PATTERN.exec(expression);
        if (patternMatch) {
            const line = parseInt(patternMatch[1] ?? '', 10);
            if (Number.isFinite(line)) {
                const lineNumber = line > 0 ? line - 1 : 0;
                const column = parseInt(patternMatch[2] ?? '', 10);
                const startColumn = Number.isFinite(column) && column > 0 ? column - 1 : 0;
                const position = browser_2.Position.create(lineNumber, startColumn);
                filter = expression.substring(0, patternMatch.index);
                range = browser_2.Range.create(position, position);
            }
        }
        return { filter, range };
    }
};
exports.QuickFileSelectService = QuickFileSelectService;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.KeybindingRegistry),
    tslib_1.__metadata("design:type", browser_1.KeybindingRegistry)
], QuickFileSelectService.prototype, "keybindingRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_service_1.WorkspaceService),
    tslib_1.__metadata("design:type", workspace_service_1.WorkspaceService)
], QuickFileSelectService.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], QuickFileSelectService.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(quick_input_service_1.QuickInputService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], QuickFileSelectService.prototype, "quickInputService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.QuickAccessRegistry),
    tslib_1.__metadata("design:type", Object)
], QuickFileSelectService.prototype, "quickAccessRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_search_service_1.FileSearchService),
    tslib_1.__metadata("design:type", Object)
], QuickFileSelectService.prototype, "fileSearchService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(label_provider_1.LabelProvider),
    tslib_1.__metadata("design:type", label_provider_1.LabelProvider)
], QuickFileSelectService.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(navigation_location_service_1.NavigationLocationService),
    tslib_1.__metadata("design:type", navigation_location_service_1.NavigationLocationService)
], QuickFileSelectService.prototype, "navigationLocationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(message_service_1.MessageService),
    tslib_1.__metadata("design:type", message_service_1.MessageService)
], QuickFileSelectService.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], QuickFileSelectService.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_3.WorkspaceSearchFilterService),
    tslib_1.__metadata("design:type", browser_3.WorkspaceSearchFilterService)
], QuickFileSelectService.prototype, "searchFilterService", void 0);
exports.QuickFileSelectService = QuickFileSelectService = QuickFileSelectService_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], QuickFileSelectService);
/**
 * Normalize a given string.
 *
 * @param str the raw string value.
 * @returns the normalized string value.
 */
function normalize(str) {
    return str.trim().toLowerCase();
}
function compareWithDiscriminators(left, right, ...discriminators) {
    let comparisonValue = 0;
    let i = 0;
    while (comparisonValue === 0 && i < discriminators.length) {
        comparisonValue = discriminators[i](left, right);
        i++;
    }
    return comparisonValue;
}
//# sourceMappingURL=quick-file-select-service.js.map