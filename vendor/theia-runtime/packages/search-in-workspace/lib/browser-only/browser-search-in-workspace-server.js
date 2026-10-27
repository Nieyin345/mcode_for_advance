"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserSearchInWorkspaceServer = void 0;
const tslib_1 = require("tslib");
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
const inversify_1 = require("@theia/core/shared/inversify");
const file_uri_1 = require("@theia/core/lib/common/file-uri");
const core_1 = require("@theia/core");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const file_search_1 = require("@theia/filesystem/lib/browser-only/file-search");
const strings_1 = require("@theia/core/lib/common/strings");
const files_1 = require("@theia/filesystem/lib/common/files");
;
const minimatchOpts = {
    dot: true,
    matchBase: true,
    nocase: true
};
let BrowserSearchInWorkspaceServer = class BrowserSearchInWorkspaceServer {
    constructor() {
        this.ongoingSearches = new Map();
        this.nextSearchId = 1;
    }
    /**
     * Sets the client for receiving search results
     */
    setClient(client) {
        this.client = client;
    }
    /**
     * Initiates a search operation and returns a search ID.
     * @param what - The search term or pattern
     * @param rootUris - Array of root URIs to search in
     * @param opts - Search options including filters and limits
     * @returns Promise resolving to the search ID
     */
    async search(what, rootUris, opts = {}) {
        const searchId = this.nextSearchId++;
        const controller = new AbortController();
        const { regex, searchPaths, options } = await this.processSearchOptions(what, rootUris, opts);
        this.ongoingSearches.set(searchId, {
            regex,
            searchPaths,
            options,
            isAborted: () => controller.signal.aborted,
            abort: () => controller.abort()
        });
        // Start search asynchronously and return searchId immediately
        this.doSearch(searchId).catch((error) => {
            const errorStr = `An error happened while searching (${error.message}).`;
            this.client?.onDone(searchId, errorStr);
        }).finally(() => {
            this.ongoingSearches.delete(searchId);
        });
        return searchId;
    }
    /**
     * Cancels an ongoing search operation.
     * @param searchId - The ID of the search to cancel
     */
    cancel(searchId) {
        const controller = this.ongoingSearches.get(searchId);
        if (controller) {
            this.ongoingSearches.delete(searchId);
            controller.abort();
            this.client?.onDone(searchId);
        }
        return Promise.resolve();
    }
    /**
     * Disposes the service by aborting all ongoing searches.
     */
    dispose() {
        this.ongoingSearches.forEach(controller => controller.abort());
        this.ongoingSearches.clear();
    }
    /**
     * Internal method to perform the search.
     * @param searchId - The ID of the search to perform.
     * @returns A promise that resolves when the search is complete.
     */
    async doSearch(searchId) {
        const ctx = this.ongoingSearches.get(searchId);
        if (!ctx) {
            return;
        }
        const { regex, searchPaths, options, isAborted } = ctx;
        const maxFileSize = options.maxFileSize ? files_1.BinarySize.parseSize(options.maxFileSize) : 20 * files_1.BinarySize.MB;
        const matcher = (0, file_search_1.createIgnoreMatcher)();
        let remaining = options.maxResults ?? Number.POSITIVE_INFINITY;
        for (const root of searchPaths) {
            if (isAborted()) {
                break;
            }
            const pathsStack = [root];
            let index = 0;
            while (index < pathsStack.length && !isAborted() && remaining > 0) {
                const current = pathsStack[index++];
                const relPath = current.path.toString().replace(/^\/|^\.\//, '');
                // Skip excluded paths
                if (this.shouldExcludePath(current, options.exclude)) {
                    continue;
                }
                // Skip ignored files unless explicitly included
                if (!options.includeIgnored && relPath && matcher.ignores(relPath)) {
                    continue;
                }
                let stat;
                try {
                    stat = await this.fs.resolve(current, { resolveMetadata: true });
                }
                catch {
                    continue;
                }
                // Skip files not matching include patterns
                if (stat.isFile && !this.shouldIncludePath(current, options.include)) {
                    continue;
                }
                // Skip files exceeding size limit
                if (stat.isFile && stat.size > maxFileSize) {
                    continue;
                }
                // Process directory contents
                if (stat.isDirectory) {
                    if (Array.isArray(stat.children)) {
                        // Load ignore patterns from files
                        if (!options.includeIgnored) {
                            const patterns = await (0, file_search_1.getIgnorePatterns)(current, uri => this.fs.read(uri).then(content => content.value));
                            matcher.add(patterns);
                        }
                        for (const child of stat.children) {
                            pathsStack.push(child.resource);
                        }
                    }
                    continue;
                }
                try {
                    const matches = await this.searchFileByLines(current, regex, isAborted, {
                        autoGuessEncoding: true,
                        acceptTextOnly: true
                    }, remaining);
                    if (matches.length > 0) {
                        const result = {
                            root: root.path.toString(),
                            fileUri: current.path.toString(),
                            matches
                        };
                        this.client?.onResult(searchId, result);
                        remaining -= matches.length;
                        if (remaining <= 0) {
                            break;
                        }
                    }
                }
                catch (err) {
                    if (err instanceof file_service_1.TextFileOperationError && err.textFileOperationResult === 0 /* TextFileOperationResult.FILE_IS_BINARY */) {
                        continue;
                    }
                    this.logger.error(`Error reading file ${current.path.toString()}: ${err.message}`);
                    continue;
                }
            }
            if (remaining <= 0 || isAborted()) {
                break;
            }
        }
        this.client?.onDone(searchId);
    }
    /**
     * Searches for matches within a file by processing it line by line.
     * @param uri - The file URI to search
     * @param re - The regex pattern to match
     * @param isAborted - Function to check if search was aborted
     * @param opts - File reading options
     * @param limit - Maximum number of matches to return
     * @returns Array of search matches found in the file
     */
    async searchFileByLines(uri, re, isAborted, opts, limit) {
        const { value: stream } = await this.fs.readStream(uri, opts);
        let leftover = '';
        let lineNo = 0;
        const matches = [];
        await new Promise((resolve, reject) => {
            stream.on('data', chunk => {
                if (isAborted()) {
                    stream.pause();
                    resolve();
                    return;
                }
                const data = leftover + chunk;
                const lines = data.split(/\r?\n/);
                leftover = lines.pop() ?? '';
                for (const line of lines) {
                    lineNo += 1; // 1-based
                    if (!line) {
                        continue;
                    }
                    // Reset regex lastIndex for global patterns
                    if (re.global) {
                        re.lastIndex = 0;
                    }
                    let m;
                    while ((m = re.exec(line))) {
                        matches.push({
                            line: lineNo,
                            character: m.index + 1, // 1-based
                            length: m[0].length,
                            lineText: line
                        });
                        if (matches.length >= limit) {
                            resolve();
                            return;
                        }
                    }
                }
            });
            stream.on('error', err => reject(err));
            stream.on('end', () => {
                if (leftover.length && matches.length < limit) {
                    lineNo += 1;
                    const line = leftover;
                    // Reset regex lastIndex for global patterns
                    if (re.global) {
                        re.lastIndex = 0;
                    }
                    let m;
                    while ((m = re.exec(line))) {
                        matches.push({
                            line: lineNo,
                            character: m.index + 1,
                            length: m[0].length,
                            lineText: line
                        });
                        if (matches.length >= limit) {
                            break;
                        }
                    }
                }
                resolve();
            });
        });
        return matches;
    }
    /**
     * Processes search options and returns clean paths and processed options.
     * This method consolidates the path processing logic and matchWholeWord handling for better readability.
     */
    async processSearchOptions(_searchTerm, _searchPaths, _options) {
        const options = { ..._options };
        options.maxResults = typeof options.maxResults === 'number' && options.maxResults > 0 ? options.maxResults : Number.POSITIVE_INFINITY;
        options.include = (options.include ?? []).map(glob => (0, file_search_1.normalizeGlob)(glob));
        options.exclude = (options.exclude ?? []).map(glob => (0, file_search_1.normalizeGlob)(glob));
        // If there are absolute paths in `include` we will remove them and use
        // those as paths to search from
        const paths = await this.extractSearchPathsFromIncludes(_searchPaths.map(p => file_uri_1.FileUri.fsPath(p)), options.include);
        // Build regex with consideration of useRegExp/matchCase/matchWholeWord
        const useRegExp = !!options.useRegExp;
        const matchCase = !!options.matchCase;
        const matchWholeWord = !!options.matchWholeWord;
        const flags = 'g' + (matchCase ? '' : 'i') + 'u';
        let source = useRegExp ? _searchTerm : (0, strings_1.escapeRegExpCharacters)(_searchTerm);
        // Unicode word boundaries: letters/numbers/underscore
        if (matchWholeWord) {
            const wbL = '(?<![\\p{L}\\p{N}_])';
            const wbR = '(?![\\p{L}\\p{N}_])';
            source = `${wbL}${source}${wbR}`;
        }
        const regex = new RegExp(source, flags);
        const searchPaths = paths.map(p => core_1.URI.fromFilePath(p));
        return { regex, searchPaths, options };
    }
    /**
     * Checks if a path should be excluded based on exclude patterns.
     * @param uri - The URI to check
     * @param exclude - Array of exclude patterns
     * @returns True if the path should be excluded
     */
    shouldExcludePath(uri, exclude) {
        if (!exclude?.length) {
            return false;
        }
        return (0, file_search_1.matchesPattern)(uri.path.toString(), exclude, minimatchOpts);
    }
    /**
     * Checks if a path should be included based on include patterns.
     * @param uri - The URI to check
     * @param include - Array of include patterns
     * @returns True if the path should be included
     */
    shouldIncludePath(uri, include) {
        if (!include?.length) {
            return true;
        }
        return (0, file_search_1.matchesPattern)(uri.path.toString(), include, minimatchOpts);
    }
    /**
     * The default search paths are set to be the root paths associated to a workspace
     * however the search scope can be further refined with the include paths available in the search options.
     * This method will replace the searching paths to the ones specified in the 'include' options but as long
     * as the 'include' paths can be successfully validated as existing.
     *
     * Therefore the returned array of paths can be either the workspace root paths or a set of validated paths
     * derived from the include options which can be used to perform the search.
     *
     * Any pattern that resulted in a valid search path will be removed from the 'include' list as it is
     * provided as an equivalent search path instead.
     */
    async extractSearchPathsFromIncludes(searchPaths, include) {
        if (!include) {
            return searchPaths;
        }
        const resolvedPaths = new Set();
        const searchPathsUris = searchPaths.map(p => new core_1.URI(p));
        for (const pattern of include) {
            const [base, _] = getGlobBase(pattern);
            const baseUri = new core_1.URI(base);
            for (const rootUri of searchPathsUris) {
                if (rootUri.isEqualOrParent(baseUri) && await this.fs.exists(baseUri)) {
                    resolvedPaths.add(baseUri.path.toString());
                }
            }
        }
        return resolvedPaths.size ? Array.from(resolvedPaths) : searchPaths;
    }
};
exports.BrowserSearchInWorkspaceServer = BrowserSearchInWorkspaceServer;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('search-in-workspace:BrowserSearchInWorkspaceServer'),
    tslib_1.__metadata("design:type", Object)
], BrowserSearchInWorkspaceServer.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], BrowserSearchInWorkspaceServer.prototype, "fs", void 0);
exports.BrowserSearchInWorkspaceServer = BrowserSearchInWorkspaceServer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserSearchInWorkspaceServer);
/**
 * Get the base + rest of a glob pattern.
 *
 * @param pattern - The glob pattern to get the base of (like 'workspace2/foo/*.md')
 * @returns The base + rest of the glob pattern. (like ['workspace2/foo/', '*.md'])
 */
function getGlobBase(pattern) {
    const isAbsolute = pattern.startsWith('/');
    const parts = pattern.replace(/^\//, '').split('/');
    const magic = /[*?[\]{}]/;
    const staticParts = [];
    for (const part of parts) {
        if (magic.test(part)) {
            break;
        }
        staticParts.push(part);
    }
    const base = (isAbsolute ? '/' : '') + staticParts.join('/');
    return [base, pattern.substring(base.length)];
}
//# sourceMappingURL=browser-search-in-workspace-server.js.map