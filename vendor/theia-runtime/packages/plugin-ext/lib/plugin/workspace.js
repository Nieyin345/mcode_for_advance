"use strict";
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
// copied and modified from https://github.com/Microsoft/vscode/blob/master/src/vs/workbench/services/workspace/node/workspaceEditingService.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceExtImpl = void 0;
const tslib_1 = require("tslib");
const paths = require("path");
const inversify_1 = require("@theia/core/shared/inversify");
const event_1 = require("@theia/core/lib/common/event");
const cancellation_1 = require("@theia/core/lib/common/cancellation");
const plugin_api_rpc_1 = require("../common/plugin-api-rpc");
const path_1 = require("@theia/core/lib/common/path");
const rpc_protocol_1 = require("../common/rpc-protocol");
const editors_and_documents_1 = require("./editors-and-documents");
const types_impl_1 = require("./types-impl");
const paths_1 = require("@theia/core/lib/common/paths");
const paths_util_1 = require("../common/paths-util");
const uri_components_1 = require("../common/uri-components");
const message_registry_1 = require("./message-registry");
const Converter = require("./type-converters");
const types_1 = require("../common/types");
const logger_1 = require("./logger");
const stream_1 = require("@theia/core/lib/common/stream");
const encoding_service_1 = require("@theia/core/lib/common/encoding-service");
const buffer_1 = require("@theia/core/lib/common/buffer");
let WorkspaceExtImpl = class WorkspaceExtImpl {
    constructor() {
        this.workspaceFoldersChangedEmitter = new event_1.Emitter();
        this.onDidChangeWorkspaceFolders = this.workspaceFoldersChangedEmitter.event;
        this.documentContentProviders = new Map();
        this.searchInWorkspaceEmitter = new event_1.Emitter();
        this.workspaceSearchSequence = 0;
        this._trusted = undefined;
        this.didGrantWorkspaceTrustEmitter = new event_1.Emitter();
        this.onDidGrantWorkspaceTrust = this.didGrantWorkspaceTrustEmitter.event;
        this.didChangeWorkspaceTrustEmitter = new event_1.Emitter();
        this.onDidChangeWorkspaceTrust = this.didChangeWorkspaceTrustEmitter.event;
        this.canonicalUriProviders = new Map();
    }
    initialize() {
        this.proxy = this.rpc.getProxy(plugin_api_rpc_1.PLUGIN_RPC_CONTEXT.WORKSPACE_MAIN);
        this.logger = new logger_1.PluginLogger(this.rpc, 'workspace');
    }
    get rootPath() {
        const folder = this.folders && this.folders[0];
        return folder && folder.uri.fsPath;
    }
    get workspaceFolders() {
        if (this.folders && this.folders.length === 0) {
            return undefined;
        }
        return this.folders;
    }
    get workspaceFile() {
        return this.workspaceFileUri;
    }
    get name() {
        if (this.workspaceFolders && this.workspaceFolders.length > 0) {
            return new path_1.Path(this.workspaceFolders[0].uri.path).base;
        }
        return undefined;
    }
    resolveProxy(url) {
        return this.proxy.$resolveProxy(url);
    }
    $onWorkspaceFoldersChanged(event) {
        const newRoots = event.roots || [];
        const oldFoldersByUri = new Map();
        if (this.folders) {
            for (const folder of this.folders) {
                oldFoldersByUri.set(folder.uri.toString(), folder);
            }
        }
        const newFolders = newRoots.map((root, index) => {
            const existing = oldFoldersByUri.get(root);
            if (existing) {
                // Preserve object identity even if the index changed,
                // since extensions may use folder objects as Map keys.
                Object.assign(existing, { index });
                return existing;
            }
            return this.toWorkspaceFolder(root, index);
        });
        const delta = this.deltaFolders(this.folders, newFolders);
        this.folders = newFolders;
        this.refreshWorkspaceFile();
        this.workspaceFoldersChangedEmitter.fire(delta);
    }
    $onWorkspaceLocationChanged(stat) {
        this.updateWorkSpace(stat);
    }
    $onTextSearchResult(searchRequestId, done, result) {
        if (result) {
            result.matches.map(next => {
                const range = {
                    endColumn: next.character + next.length,
                    endLineNumber: next.line + 1,
                    startColumn: next.character,
                    startLineNumber: next.line + 1
                };
                const tRange = Converter.toRange(range);
                const searchResult = {
                    uri: types_impl_1.URI.parse(result.fileUri),
                    preview: {
                        text: typeof next.lineText === 'string' ? next.lineText : next.lineText.text,
                        matches: tRange
                    },
                    ranges: tRange
                };
                return searchResult;
            }).forEach(next => this.searchInWorkspaceEmitter.fire({ result: next, searchId: searchRequestId }));
        }
        else if (done) {
            this.searchInWorkspaceEmitter.fire({ searchId: searchRequestId });
        }
    }
    deltaFolders(currentFolders = [], newFolders = []) {
        const added = this.foldersDiff(newFolders, currentFolders);
        const removed = this.foldersDiff(currentFolders, newFolders);
        return { added, removed };
    }
    foldersDiff(folder1 = [], folder2 = []) {
        const map = new Map();
        folder1.forEach(folder => map.set(folder.uri.toString(), folder));
        folder2.forEach(folder => map.delete(folder.uri.toString()));
        return folder1.filter(folder => map.has(folder.uri.toString()));
    }
    toWorkspaceFolder(root, index) {
        const uri = types_impl_1.URI.parse(root);
        const path = new path_1.Path(uri.path);
        return {
            uri: uri,
            name: path.base,
            index: index
        };
    }
    pickWorkspaceFolder(options) {
        return new Promise((resolve, reject) => {
            const optionsMain = {
                placeHolder: options && options.placeHolder ? options.placeHolder : undefined,
                ignoreFocusOut: options && options.ignoreFocusOut
            };
            this.proxy.$pickWorkspaceFolder(optionsMain).then(value => {
                resolve(value);
            });
        });
    }
    findFiles(include, exclude, maxResults, token = cancellation_1.CancellationToken.None) {
        let includePattern;
        let includeFolderUri;
        if (include) {
            if (typeof include === 'string') {
                includePattern = include;
            }
            else {
                includePattern = include.pattern;
                includeFolderUri = include.baseUri.toString();
            }
        }
        else {
            includePattern = '';
        }
        let excludeString = '';
        let useFileExcludes = true;
        if (exclude === null) {
            useFileExcludes = false;
        }
        else if (exclude !== undefined) {
            if (typeof exclude === 'string') {
                excludeString = exclude;
            }
            else {
                excludeString = exclude.pattern;
            }
        }
        if (token && token.isCancellationRequested) {
            return Promise.resolve([]);
        }
        return this.proxy.$startFileSearch(includePattern, includeFolderUri, {
            maxResults,
            exclude: excludeString,
            useDefaultExcludes: useFileExcludes,
            useDefaultSearchExcludes: false,
            useIgnoreFiles: false
        }, token).then(data => Array.isArray(data) ? data.map(uri => types_impl_1.URI.revive(uri)) : []);
    }
    findTextInFiles(query, optionsOrCallback, callbackOrToken, token) {
        let options;
        let callback;
        if (typeof optionsOrCallback === 'object') {
            options = optionsOrCallback;
            callback = callbackOrToken;
        }
        else {
            options = {};
            callback = optionsOrCallback;
            token = callbackOrToken;
        }
        const nextSearchID = this.workspaceSearchSequence + 1;
        this.workspaceSearchSequence = nextSearchID;
        const disposable = this.searchInWorkspaceEmitter.event(searchResult => {
            if (searchResult.searchId === nextSearchID) {
                if (searchResult.result) {
                    callback(searchResult.result);
                }
                else {
                    disposable.dispose();
                }
            }
        });
        if (token) {
            token.onCancellationRequested(() => {
                disposable.dispose();
            });
        }
        return this.proxy.$findTextInFiles(query, options || {}, nextSearchID, token);
    }
    registerTextDocumentContentProvider(scheme, provider) {
        // `file` and `untitled` schemas are reserved by `workspace.openTextDocument` API:
        // `file`-scheme for opening a file
        // `untitled`-scheme for opening a new file that should be saved
        if (scheme === uri_components_1.Schemes.file || scheme === uri_components_1.Schemes.untitled) {
            throw new Error(`Text Content Document Provider for scheme '${scheme}' is already registered`);
        }
        else if (this.documentContentProviders.has(scheme)) {
            // TODO: we should be able to handle multiple registrations, but for now we should ensure that it doesn't crash plugin activation.
            this.logger.warn(`Repeat registration of TextContentDocumentProvider for scheme '${scheme}'. This registration will be ignored.`);
            return { dispose: () => { } };
        }
        this.documentContentProviders.set(scheme, provider);
        this.proxy.$registerTextDocumentContentProvider(scheme);
        let onDidChangeSubscription;
        if (typeof provider.onDidChange === 'function') {
            onDidChangeSubscription = provider.onDidChange(async (uri) => {
                if (uri.scheme === scheme && this.editorsAndDocuments.getDocument(uri.toString())) {
                    const content = await this.$provideTextDocumentContent(uri.toString());
                    if (content) {
                        this.proxy.$onTextDocumentContentChange(uri.toString(), content);
                    }
                }
            });
        }
        const instance = this;
        return {
            dispose() {
                if (instance.documentContentProviders.delete(scheme)) {
                    instance.proxy.$unregisterTextDocumentContentProvider(scheme);
                }
                if (onDidChangeSubscription) {
                    onDidChangeSubscription.dispose();
                }
            }
        };
    }
    async $provideTextDocumentContent(documentURI) {
        const uri = types_impl_1.URI.parse(documentURI);
        const provider = this.documentContentProviders.get(uri.scheme);
        if (provider) {
            return provider.provideTextDocumentContent(uri, cancellation_1.CancellationToken.None);
        }
        return undefined;
    }
    getWorkspaceFolder(uri, resolveParent) {
        if (!this.folders || !this.folders.length) {
            return undefined;
        }
        function dirname(resource) {
            if (resource.scheme === 'file') {
                return types_impl_1.URI.file(paths.dirname(resource.fsPath));
            }
            return resource.with({
                path: paths.dirname(resource.path)
            });
        }
        if (resolveParent && this.hasFolder(uri)) {
            uri = dirname(uri);
        }
        const resourcePath = uri.toString();
        let workspaceFolder;
        for (let i = 0; i < this.folders.length; i++) {
            const folder = this.folders[i];
            const folderPath = folder.uri.toString();
            if (resourcePath === folderPath) {
                return folder;
            }
            if (resourcePath.startsWith(folderPath)
                && resourcePath[folderPath.length] === '/'
                && (!workspaceFolder || folderPath.length > workspaceFolder.uri.toString().length)) {
                workspaceFolder = folder;
            }
        }
        return workspaceFolder;
    }
    hasFolder(uri) {
        if (!this.folders) {
            return false;
        }
        return this.folders.some(folder => folder.uri.toString() === uri.toString());
    }
    getRelativePath(pathOrUri, includeWorkspace) {
        let path;
        if (typeof pathOrUri === 'string') {
            path = pathOrUri;
        }
        else if (typeof pathOrUri !== 'undefined') {
            path = pathOrUri.fsPath;
        }
        if (!path) {
            return path;
        }
        const folder = this.getWorkspaceFolder(typeof pathOrUri === 'string' ? types_impl_1.URI.file(pathOrUri) : pathOrUri, true);
        if (!folder) {
            return path;
        }
        if (typeof includeWorkspace === 'undefined') {
            includeWorkspace = this.folders.length > 1;
        }
        let result = (0, paths_util_1.relative)(folder.uri.fsPath, path);
        if (includeWorkspace) {
            result = `${folder.name}/${result}`;
        }
        return (0, paths_1.normalize)(result, true);
    }
    updateWorkspaceFolders(start, deleteCount, ...workspaceFoldersToAdd) {
        const rootsToAdd = new Set();
        if (Array.isArray(workspaceFoldersToAdd)) {
            workspaceFoldersToAdd.forEach(folderToAdd => {
                const uri = types_impl_1.URI.isUri(folderToAdd.uri) && folderToAdd.uri.toString();
                if (uri && !rootsToAdd.has(uri)) {
                    rootsToAdd.add(uri);
                }
            });
        }
        if ([start, deleteCount].some(i => typeof i !== 'number' || i < 0)) {
            return false; // validate numbers
        }
        if (deleteCount === 0 && rootsToAdd.size === 0) {
            return false; // nothing to delete or add
        }
        const currentWorkspaceFolders = this.workspaceFolders || [];
        if (start + deleteCount > currentWorkspaceFolders.length) {
            return false; // cannot delete more than we have
        }
        // Simulate the updateWorkspaceFolders method on our data to do more validation
        const newWorkspaceFolders = currentWorkspaceFolders.slice(0);
        newWorkspaceFolders.splice(start, deleteCount, ...[...rootsToAdd].map(uri => ({ uri: types_impl_1.URI.parse(uri), name: undefined, index: undefined })));
        for (let i = 0; i < newWorkspaceFolders.length; i++) {
            const folder = newWorkspaceFolders[i];
            if (newWorkspaceFolders.some((otherFolder, index) => index !== i && folder.uri.toString() === otherFolder.uri.toString())) {
                return false; // cannot add the same folder multiple times
            }
        }
        const { added, removed } = this.deltaFolders(currentWorkspaceFolders, newWorkspaceFolders);
        if (added.length === 0 && removed.length === 0) {
            return false; // nothing actually changed
        }
        // Trigger on main side
        this.proxy.$updateWorkspaceFolders(start, deleteCount, ...rootsToAdd).then(undefined, error => this.messageService.showMessage(plugin_api_rpc_1.MainMessageType.Error, `Failed to update workspace folders: ${error}`));
        return true;
    }
    async refreshWorkspaceFile() {
        const workspace = await this.proxy.$getWorkspace();
        this.updateWorkSpace(workspace);
    }
    updateWorkSpace(workspace) {
        // A workspace directory implies an undefined workspace file
        if (workspace && !workspace.isDirectory) {
            this.workspaceFileUri = types_impl_1.URI.parse(workspace.resource.toString());
        }
    }
    get trusted() {
        if (this._trusted === undefined) {
            this.requestWorkspaceTrust();
        }
        return !!this._trusted;
    }
    requestWorkspaceTrust(options) {
        return this.proxy.$requestWorkspaceTrust(options);
    }
    $onWorkspaceTrustChanged(trust) {
        const wasTrusted = this._trusted;
        this._trusted = trust;
        // Fire onDidChangeWorkspaceTrust if value actually changed
        if (wasTrusted !== trust && trust !== undefined) {
            this.didChangeWorkspaceTrustEmitter.fire(trust);
        }
        // Fire onDidGrantWorkspaceTrust when transitioning from untrusted to trusted
        if (!wasTrusted && trust) {
            this.didGrantWorkspaceTrustEmitter.fire();
        }
    }
    registerCanonicalUriProvider(scheme, provider) {
        if (this.canonicalUriProviders.has(scheme)) {
            throw new Error(`Canonical URI provider for scheme: '${scheme}' already exists locally`);
        }
        this.canonicalUriProviders.set(scheme, provider);
        this.proxy.$registerCanonicalUriProvider(scheme).catch(e => {
            this.logger.error(`Canonical URI provider for scheme: '${scheme}' already exists globally`);
            this.canonicalUriProviders.delete(scheme);
        });
        const result = types_impl_1.Disposable.create(() => { this.proxy.$unregisterCanonicalUriProvider(scheme); });
        return result;
    }
    $disposeCanonicalUriProvider(scheme) {
        if (!this.canonicalUriProviders.delete(scheme)) {
            this.logger.warn(`diposeCanonicalUriProvider: No canonical uri provider registered for '${scheme}'`);
        }
    }
    async getCanonicalUri(uri, options, token) {
        const canonicalUri = await this.proxy.$getCanonicalUri(uri.toString(), options.targetScheme, token);
        return (0, types_1.isUndefined)(canonicalUri) ? undefined : types_impl_1.URI.parse(canonicalUri);
    }
    async $provideCanonicalUri(uri, targetScheme, token) {
        const parsed = types_impl_1.URI.parse(uri);
        const provider = this.canonicalUriProviders.get(parsed.scheme);
        if (!provider) {
            this.logger.warn(`provideCanonicalUri: No canonical uri provider registered for '${parsed.scheme}'`);
            return undefined;
        }
        const result = await provider.provideCanonicalUri(parsed, { targetScheme: targetScheme }, token);
        return (0, types_1.isUndefinedOrNull)(result) ? undefined : result.toString();
    }
    /** @stubbed */
    $registerEditSessionIdentityProvider(scheme, provider) {
        return types_impl_1.Disposable.NULL;
    }
    async decode(content, args) {
        const [uri, opts] = this.asEncodeDecodeParameters(args);
        const { preferredEncoding, guessEncoding } = await this.proxy.$resolveDecoding(uri, opts);
        const decodeStreamOptions = {
            guessEncoding,
            overwriteEncoding: (detectedEncoding) => {
                if (detectedEncoding === null || detectedEncoding === preferredEncoding) {
                    return Promise.resolve(preferredEncoding);
                }
                return this.proxy.$getValidEncoding(uri, detectedEncoding, opts);
            }
        };
        const stream = (await this.encodingService.decodeStream(buffer_1.BinaryBufferReadableStream.fromBuffer(buffer_1.BinaryBuffer.wrap(content)), decodeStreamOptions)).stream;
        return (0, stream_1.consumeStream)(stream, s => s.join(''));
    }
    async encode(content, args) {
        const [uri, options] = this.asEncodeDecodeParameters(args);
        const { encoding, hasBOM } = await this.proxy.$resolveEncoding(uri, options);
        const buffer = this.encodingService.encode(content, { encoding, hasBOM });
        return buffer.buffer;
    }
    asEncodeDecodeParameters(opts) {
        const uri = Converter.isUriComponents(opts?.uri) ? opts.uri : undefined;
        const encoding = typeof opts?.encoding === 'string' ? opts.encoding : undefined;
        return [uri, encoding ? { encoding } : undefined];
    }
};
exports.WorkspaceExtImpl = WorkspaceExtImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(rpc_protocol_1.RPCProtocol),
    tslib_1.__metadata("design:type", Object)
], WorkspaceExtImpl.prototype, "rpc", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(editors_and_documents_1.EditorsAndDocumentsExtImpl),
    tslib_1.__metadata("design:type", editors_and_documents_1.EditorsAndDocumentsExtImpl)
], WorkspaceExtImpl.prototype, "editorsAndDocuments", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(message_registry_1.MessageRegistryExt),
    tslib_1.__metadata("design:type", message_registry_1.MessageRegistryExt)
], WorkspaceExtImpl.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(encoding_service_1.EncodingService),
    tslib_1.__metadata("design:type", encoding_service_1.EncodingService)
], WorkspaceExtImpl.prototype, "encodingService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], WorkspaceExtImpl.prototype, "initialize", null);
exports.WorkspaceExtImpl = WorkspaceExtImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WorkspaceExtImpl);
//# sourceMappingURL=workspace.js.map