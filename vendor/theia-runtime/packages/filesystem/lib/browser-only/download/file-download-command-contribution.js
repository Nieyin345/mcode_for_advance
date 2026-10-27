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
exports.FileDownloadCommandContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const selection_service_1 = require("@theia/core/lib/common/selection-service");
const uri_command_handler_1 = require("@theia/core/lib/common/uri-command-handler");
const file_download_1 = require("../../common/download/file-download");
const file_download_command_contribution_1 = require("../../browser/download/file-download-command-contribution");
let FileDownloadCommandContribution = class FileDownloadCommandContribution {
    registerCommands(registry) {
        registry.registerCommand(file_download_command_contribution_1.FileDownloadCommands.DOWNLOAD, uri_command_handler_1.UriAwareCommandHandler.MultiSelect(this.selectionService, {
            execute: uris => this.executeDownload(uris),
            isEnabled: uris => this.isDownloadEnabled(uris),
            isVisible: uris => this.isDownloadVisible(uris),
        }));
    }
    async executeDownload(uris, options) {
        this.downloadService.download(uris, options);
    }
    isDownloadEnabled(uris) {
        return uris.length > 0 && uris.every(u => u.scheme === 'file');
    }
    isDownloadVisible(uris) {
        return this.isDownloadEnabled(uris);
    }
};
exports.FileDownloadCommandContribution = FileDownloadCommandContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(file_download_1.FileDownloadService),
    tslib_1.__metadata("design:type", Object)
], FileDownloadCommandContribution.prototype, "downloadService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(selection_service_1.SelectionService),
    tslib_1.__metadata("design:type", selection_service_1.SelectionService)
], FileDownloadCommandContribution.prototype, "selectionService", void 0);
exports.FileDownloadCommandContribution = FileDownloadCommandContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FileDownloadCommandContribution);
//# sourceMappingURL=file-download-command-contribution.js.map