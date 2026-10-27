"use strict";
// *****************************************************************************
// Copyright (C) 2025 Maksim Kachurin and others.
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
exports.FileSearchServiceImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const file_search_service_1 = require("../common/file-search-service");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const fuzzy = require("@theia/core/shared/fuzzy");
const core_1 = require("@theia/core");
const file_search_1 = require("@theia/filesystem/lib/browser-only/file-search");
let FileSearchServiceImpl = class FileSearchServiceImpl {
    /**
     * Searches for files matching the given pattern.
     * @param searchPattern - The pattern to search for
     * @param options - Search options including root URIs and filters
     * @param clientToken - Optional cancellation token
     * @returns Promise resolving to array of matching file URIs
     */
    async find(searchPattern, options, clientToken) {
        const cancellationSource = new core_1.CancellationTokenSource();
        if (clientToken) {
            clientToken.onCancellationRequested(() => cancellationSource.cancel());
        }
        const token = cancellationSource.token;
        const opts = {
            fuzzyMatch: true,
            limit: Number.MAX_SAFE_INTEGER,
            useGitIgnore: true,
            ...options
        };
        // Merge root-specific options with global options
        const roots = options.rootOptions || {};
        if (options.rootUris) {
            for (const rootUri of options.rootUris) {
                if (!roots[rootUri]) {
                    roots[rootUri] = {};
                }
            }
        }
        // eslint-disable-next-line guard-for-in
        for (const rootUri in roots) {
            const rootOptions = roots[rootUri];
            if (opts.includePatterns) {
                const includePatterns = rootOptions.includePatterns || [];
                rootOptions.includePatterns = [...includePatterns, ...opts.includePatterns];
            }
            if (opts.excludePatterns) {
                const excludePatterns = rootOptions.excludePatterns || [];
                rootOptions.excludePatterns = [...excludePatterns, ...opts.excludePatterns];
            }
            if (rootOptions.useGitIgnore === undefined) {
                rootOptions.useGitIgnore = opts.useGitIgnore;
            }
        }
        const exactMatches = new Set();
        const fuzzyMatches = new Set();
        // Split search pattern into individual terms for matching
        const patterns = searchPattern.toLowerCase().split(file_search_service_1.WHITESPACE_QUERY_SEPARATOR).map(pattern => pattern.trim()).filter(Boolean);
        await Promise.all(Object.keys(roots).map(async (root) => {
            try {
                const rootUri = new core_1.URI(root);
                const rootOptions = roots[root];
                await this.doFind(rootUri, rootOptions, (fileUri) => {
                    // Skip already matched files
                    if (exactMatches.has(fileUri) || fuzzyMatches.has(fileUri)) {
                        return;
                    }
                    // Check for exact pattern matches
                    const candidatePattern = fileUri.toLowerCase();
                    const patternExists = patterns.every(pattern => candidatePattern.includes(pattern));
                    if (patternExists) {
                        exactMatches.add(fileUri);
                    }
                    else if (!searchPattern || searchPattern === '*') {
                        exactMatches.add(fileUri);
                    }
                    else {
                        // Check for fuzzy matches if enabled
                        const fuzzyPatternExists = patterns.every(pattern => fuzzy.test(pattern, candidatePattern));
                        if (opts.fuzzyMatch && fuzzyPatternExists) {
                            fuzzyMatches.add(fileUri);
                        }
                    }
                    // Cancel search if limit reached
                    if ((exactMatches.size + fuzzyMatches.size) >= opts.limit) {
                        cancellationSource.cancel();
                    }
                }, token);
            }
            catch (e) {
                this.logger.error('Failed to search:', root, e);
            }
        }));
        if (clientToken?.isCancellationRequested) {
            return [];
        }
        // Return results up to the specified limit
        return [...exactMatches, ...fuzzyMatches].slice(0, opts.limit);
    }
    /**
     * Performs the actual file search within a root directory.
     * @param rootUri - The root URI to search in
     * @param options - Search options for this root
     * @param accept - Callback function for each matching file
     * @param token - Cancellation token
     */
    async doFind(rootUri, options, accept, token) {
        const matcher = (0, file_search_1.createIgnoreMatcher)();
        const queue = [rootUri];
        let queueIndex = 0;
        while (queueIndex < queue.length) {
            if (token.isCancellationRequested) {
                return;
            }
            const currentUri = queue[queueIndex++];
            try {
                // Skip excluded paths
                if (this.shouldExcludePath(currentUri, options.excludePatterns)) {
                    continue;
                }
                const stat = await this.fs.resolve(currentUri);
                const relPath = currentUri.path.toString().replace(/^\/|^\.\//, '');
                // Skip paths ignored by gitignore patterns
                if (options.useGitIgnore && relPath && matcher.ignores(relPath)) {
                    continue;
                }
                // Accept file if it matches include patterns
                if (stat.isFile && this.shouldIncludePath(currentUri, options.includePatterns)) {
                    accept(currentUri.toString());
                }
                else if (stat.isDirectory && Array.isArray(stat.children)) {
                    // Process ignore files in directory
                    if (options.useGitIgnore) {
                        const patterns = await (0, file_search_1.getIgnorePatterns)(currentUri, uri => this.fs.read(uri).then(content => content.value));
                        matcher.add(patterns);
                    }
                    // Add children to search queue
                    for (const child of stat.children) {
                        queue.push(child.resource);
                    }
                }
            }
            catch (e) {
                this.logger.error(`Error reading directory: ${currentUri.toString()}`, e);
            }
        }
    }
    /**
     * Checks if a path should be excluded based on exclude patterns.
     * @param uri - The URI to check
     * @param excludePatterns - Array of exclude patterns
     * @returns True if the path should be excluded
     */
    shouldExcludePath(uri, excludePatterns) {
        if (!excludePatterns?.length) {
            return false;
        }
        const path = uri.path.toString();
        return (0, file_search_1.matchesPattern)(path, excludePatterns, {
            dot: true,
            matchBase: true,
            nocase: true
        });
    }
    /**
     * Checks if a path should be included based on include patterns.
     * @param uri - The URI to check
     * @param includePatterns - Array of include patterns
     * @returns True if the path should be included
     */
    shouldIncludePath(uri, includePatterns) {
        if (!includePatterns?.length) {
            return true;
        }
        const path = uri.path.toString();
        return (0, file_search_1.matchesPattern)(path, includePatterns, {
            dot: true,
            matchBase: true,
            nocase: true
        });
    }
};
exports.FileSearchServiceImpl = FileSearchServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('file-search:FileSearchServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], FileSearchServiceImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], FileSearchServiceImpl.prototype, "fs", void 0);
exports.FileSearchServiceImpl = FileSearchServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FileSearchServiceImpl);
//# sourceMappingURL=file-search-service-impl.js.map