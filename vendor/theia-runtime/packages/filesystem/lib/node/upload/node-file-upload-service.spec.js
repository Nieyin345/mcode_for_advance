"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
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
const chai_1 = require("chai");
const os = require("os");
const path = require("path");
const fs = require("@theia/core/shared/fs-extra");
const file_uri_1 = require("@theia/core/lib/common/file-uri");
const node_file_upload_service_1 = require("./node-file-upload-service");
describe('NodeFileUploadService', () => {
    let tempDir;
    function createService() {
        const service = new node_file_upload_service_1.NodeFileUploadService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        service['logger'] = { error: () => { } };
        return service;
    }
    function createResponse() {
        const captured = {};
        const res = {
            status(code) {
                captured.statusCode = code;
                return res;
            },
            send(body) {
                captured.body = body;
            },
            sendStatus(code) {
                captured.sentStatus = code;
            }
        };
        return { res, captured };
    }
    async function handleUpload(filePath, body) {
        const service = createService();
        const { res, captured } = createResponse();
        const request = { file: filePath === undefined ? undefined : { path: filePath }, body };
        // handleFileUpload is protected; invoke it directly to exercise the input validation.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await service.handleFileUpload(request, res);
        return captured;
    }
    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'theia-upload-spec-'));
    });
    afterEach(async () => {
        await fs.remove(tempDir);
    });
    it('should reject a non-file: URI with 400', async () => {
        const source = path.join(tempDir, 'source.txt');
        await fs.writeFile(source, 'payload');
        const captured = await handleUpload(source, { uri: 'http://evil.example/usr/bin/bash' });
        (0, chai_1.expect)(captured.sentStatus).to.equal(400);
        // The scoped-write guard must reject before any file operation runs.
        (0, chai_1.expect)(await fs.pathExists(source)).to.be.true;
    });
    it('should reject a remote-scheme URI with 400', async () => {
        const source = path.join(tempDir, 'source.txt');
        await fs.writeFile(source, 'payload');
        const captured = await handleUpload(source, { uri: 'vscode-remote://host/usr/bin/bash' });
        (0, chai_1.expect)(captured.sentStatus).to.equal(400);
        (0, chai_1.expect)(await fs.pathExists(source)).to.be.true;
    });
    it('should reject a missing uri field with 400', async () => {
        const source = path.join(tempDir, 'source.txt');
        await fs.writeFile(source, 'payload');
        const captured = await handleUpload(source, {});
        (0, chai_1.expect)(captured.sentStatus).to.equal(400);
    });
    it('should reject a missing file with 400', async () => {
        const target = file_uri_1.FileUri.create(path.join(tempDir, 'target.txt')).toString();
        const captured = await handleUpload(undefined, { uri: target });
        (0, chai_1.expect)(captured.sentStatus).to.equal(400);
    });
    it('should accept a file: URI and move the upload to the target', async () => {
        const source = path.join(tempDir, 'source.txt');
        await fs.writeFile(source, 'payload');
        const targetPath = path.join(tempDir, 'target.txt');
        const target = file_uri_1.FileUri.create(targetPath).toString();
        const captured = await handleUpload(source, { uri: target });
        (0, chai_1.expect)(captured.sentStatus).to.be.undefined;
        (0, chai_1.expect)(captured.statusCode).to.equal(200);
        // Compare against the canonical fs-path of the URI: on Windows the create/fsPath round-trip
        // normalizes the drive letter to lower-case (e.g. `C:` -> `c:`), which would otherwise fail
        // an exact string match against `targetPath` derived from `os.tmpdir()`.
        (0, chai_1.expect)(captured.body).to.equal(file_uri_1.FileUri.fsPath(target));
        (0, chai_1.expect)(await fs.pathExists(targetPath)).to.be.true;
        (0, chai_1.expect)(await fs.readFile(targetPath, 'utf8')).to.equal('payload');
        // The temp source file was moved, not copied.
        (0, chai_1.expect)(await fs.pathExists(source)).to.be.false;
    });
});
//# sourceMappingURL=node-file-upload-service.spec.js.map