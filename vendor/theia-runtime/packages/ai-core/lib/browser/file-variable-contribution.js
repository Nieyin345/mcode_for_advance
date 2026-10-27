"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH.
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
exports.FileVariableContribution = exports.FILE_VARIABLE = exports.FileVariableArgs = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const inversify_1 = require("@theia/core/shared/inversify");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const workspace_service_1 = require("@theia/workspace/lib/browser/workspace-service");
var FileVariableArgs;
(function (FileVariableArgs) {
    FileVariableArgs.uri = 'uri';
})(FileVariableArgs || (exports.FileVariableArgs = FileVariableArgs = {}));
exports.FILE_VARIABLE = {
    id: 'file-provider',
    description: core_1.nls.localize('theia/ai/core/fileVariable/description', 'Resolves the contents of a file'),
    name: 'file',
    label: core_1.nls.localizeByDefault('File'),
    iconClasses: (0, browser_1.codiconArray)('file'),
    isContextVariable: true,
    args: [{ name: FileVariableArgs.uri, description: core_1.nls.localize('theia/ai/core/fileVariable/uri/description', 'The URI of the requested file.') }]
};
let FileVariableContribution = class FileVariableContribution {
    registerVariables(service) {
        service.registerResolver(exports.FILE_VARIABLE, this);
        service.registerOpener(exports.FILE_VARIABLE, this);
    }
    async canResolve(request, _) {
        return request.variable.name === exports.FILE_VARIABLE.name ? 1 : 0;
    }
    async resolve(request, _) {
        const uri = await this.toUri(request);
        if (!uri) {
            return undefined;
        }
        try {
            const content = await this.fileService.readFile(uri);
            const relativePath = this.wsService.getRootPrefixedPath(uri);
            return {
                variable: request.variable,
                value: relativePath,
                contextValue: content.value.toString(),
            };
        }
        catch (error) {
            return undefined;
        }
    }
    async toUri(request) {
        if (request.variable.name !== exports.FILE_VARIABLE.name || request.arg === undefined) {
            return undefined;
        }
        const path = request.arg;
        return this.makeAbsolute(path);
    }
    canOpen(request, context) {
        return this.canResolve(request, context);
    }
    async open(request, context) {
        const uri = await this.toUri(request);
        if (!uri) {
            throw new Error('Unable to resolve URI for request.');
        }
        await (0, browser_1.open)(this.openerService, uri);
    }
    async makeAbsolute(pathStr) {
        const normalizedPath = core_1.Path.normalizePathSeparator(pathStr);
        const path = new core_1.Path(normalizedPath);
        if (!path.isAbsolute) {
            const workspaceRoots = this.wsService.tryGetRoots();
            const segments = normalizedPath.split('/');
            if (segments.length > 0) {
                const potentialRootName = segments[0];
                for (const root of workspaceRoots) {
                    if (root.resource.path.base === potentialRootName) {
                        const restOfPath = segments.slice(1).join('/');
                        const uri = restOfPath ? root.resource.resolve(restOfPath) : root.resource;
                        if (await this.fileService.exists(uri)) {
                            return uri;
                        }
                    }
                }
            }
            const wsUris = workspaceRoots.map(root => root.resource.resolve(path));
            for (const uri of wsUris) {
                if (await this.fileService.exists(uri)) {
                    return uri;
                }
            }
        }
        const argUri = new core_1.URI(pathStr);
        if (await this.fileService.exists(argUri)) {
            return argUri;
        }
        return undefined;
    }
};
exports.FileVariableContribution = FileVariableContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], FileVariableContribution.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_service_1.WorkspaceService),
    tslib_1.__metadata("design:type", workspace_service_1.WorkspaceService)
], FileVariableContribution.prototype, "wsService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], FileVariableContribution.prototype, "openerService", void 0);
exports.FileVariableContribution = FileVariableContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FileVariableContribution);
//# sourceMappingURL=file-variable-contribution.js.map