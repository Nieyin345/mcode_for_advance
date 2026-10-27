"use strict";
// *****************************************************************************
// Copyright (C) 2019 TypeFox and others.
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
var NodeFileUploadService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeFileUploadService = void 0;
const tslib_1 = require("tslib");
const multer = require("multer");
const path = require("path");
const os = require("os");
const fs = require("@theia/core/shared/fs-extra");
const node_1 = require("@theia/core/lib/node");
const inversify_1 = require("@theia/core/shared/inversify");
const file_upload_1 = require("../../common/file-upload");
const core_1 = require("@theia/core");
let NodeFileUploadService = class NodeFileUploadService {
    static { NodeFileUploadService_1 = this; }
    static { this.UPLOAD_DIR = 'theia_upload'; }
    async configure(app) {
        const [dest, http_path] = await Promise.all([
            this.getTemporaryUploadDest(),
            this.getHttpFileUploadPath()
        ]);
        this.logger.debug(`HTTP file upload URL path: ${http_path}`);
        this.logger.debug(`Backend file upload cache path: ${dest}`);
        // Reject unauthenticated/cross-origin requests before `multer` writes any temp file.
        const guard = (request, response, next) => this.connectionValidator.validateRequest(request, response, next);
        app.post(http_path, guard, 
        // `multer` handles `multipart/form-data` containing our file to upload.
        multer({ dest }).single('file'), (request, response, next) => this.handleFileUpload(request, response));
    }
    /**
     * @returns URL path on which to accept file uploads.
     */
    async getHttpFileUploadPath() {
        return file_upload_1.HTTP_FILE_UPLOAD_PATH;
    }
    /**
     * @returns Path to a folder where to temporarily store uploads.
     */
    async getTemporaryUploadDest() {
        return path.join(os.tmpdir(), NodeFileUploadService_1.UPLOAD_DIR);
    }
    async handleFileUpload(request, response) {
        const fields = request.body;
        if (!request.file || typeof fields !== 'object' || typeof fields.uri !== 'string' || new core_1.URI(fields.uri).scheme !== 'file') {
            response.sendStatus(400); // bad request
            return;
        }
        try {
            const target = node_1.FileUri.fsPath(fields.uri);
            if (!fields.leaveInTemp) {
                await fs.move(request.file.path, target, { overwrite: true });
            }
            else {
                // leave the file where it is, just rename it to its original name
                fs.rename(request.file.path, request.file.path.replace(request.file.filename, request.file.originalname));
            }
            response.status(200).send(target); // ok
        }
        catch (error) {
            this.logger.error(error);
            if (error.message) {
                // internal server error with error message as response
                response.status(500).send(error.message);
            }
            else {
                // default internal server error
                response.sendStatus(500);
            }
        }
    }
};
exports.NodeFileUploadService = NodeFileUploadService;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('filesystem:NodeFileUploadService'),
    tslib_1.__metadata("design:type", Object)
], NodeFileUploadService.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(node_1.HttpConnectionValidator),
    tslib_1.__metadata("design:type", Object)
], NodeFileUploadService.prototype, "connectionValidator", void 0);
exports.NodeFileUploadService = NodeFileUploadService = NodeFileUploadService_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NodeFileUploadService);
//# sourceMappingURL=node-file-upload-service.js.map