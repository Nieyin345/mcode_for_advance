"use strict";
// *****************************************************************************
// Copyright (C) 2026 JuliaHub, Inc. and others.
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
exports.AbstractFileOpeningLinkProvider = void 0;
const tslib_1 = require("tslib");
const browser_1 = require("@theia/core/lib/browser");
const inversify_1 = require("@theia/core/shared/inversify");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
/**
 * Base for terminal link providers that resolve a matched string to a local file URI and open it in
 * the editor. Subclasses contribute their own matching in {@link provideLinks} and a named logger.
 */
let AbstractFileOpeningLinkProvider = class AbstractFileOpeningLinkProvider {
    async isValidFileURI(uri) {
        try {
            const stat = await this.fileService.resolve(uri);
            return !stat.isDirectory;
        }
        catch { }
        return false;
    }
    async openURI(uri, position) {
        const options = position ? { selection: { start: position } } : {};
        try {
            const opener = await this.openerService.getOpener(uri, options);
            await opener.open(uri, options);
        }
        catch (err) {
            this.logger.error('Cannot open link ' + uri, err);
        }
    }
};
exports.AbstractFileOpeningLinkProvider = AbstractFileOpeningLinkProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], AbstractFileOpeningLinkProvider.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], AbstractFileOpeningLinkProvider.prototype, "fileService", void 0);
exports.AbstractFileOpeningLinkProvider = AbstractFileOpeningLinkProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AbstractFileOpeningLinkProvider);
//# sourceMappingURL=terminal-file-opening-link-provider.js.map