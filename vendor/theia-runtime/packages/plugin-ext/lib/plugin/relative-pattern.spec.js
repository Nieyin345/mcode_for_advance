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
const chai_1 = require("chai");
const os = require("os");
const path = require("path");
const glob_1 = require("@theia/core/lib/common/glob");
const os_1 = require("@theia/core/lib/common/os");
const vscode_uri_1 = require("@theia/core/shared/vscode-uri");
const types_impl_1 = require("./types-impl");
// This is the matching a `FileSystemWatcher` performs on every incoming event:
// `ExtHostFileSystemEventService` builds `parse(globPattern)` once and applies it
// to each event's `fsPath`. `wrapRelativePattern` rejects a base that is not a
// parent of the path under `nativeSep`, so a backslash-separated base is only
// reachable on Windows — elsewhere the pattern is rejected before the glob runs.
(os_1.isWindows ? describe : describe.skip)('RelativePattern matching against native Windows paths', () => {
    // Derive the child paths from the URI's own `fsPath`: `Uri.file` lower-cases the
    // drive letter, and the parent check is case-sensitive.
    const base = vscode_uri_1.URI.file(path.join(os.tmpdir(), 'theia-relative-pattern'));
    it('should match a file named by a bare-filename pattern', () => {
        const matches = (0, glob_1.parse)(new types_impl_1.RelativePattern(base, 'Project.toml'));
        (0, chai_1.expect)(matches(path.join(base.fsPath, 'Project.toml'))).to.be.ok;
    });
    it('should not match a different file in the same folder', () => {
        const matches = (0, glob_1.parse)(new types_impl_1.RelativePattern(base, 'Project.toml'));
        (0, chai_1.expect)(matches(path.join(base.fsPath, 'Manifest.toml'))).to.not.be.ok;
    });
    it('should match a nested file named by a subpath pattern', () => {
        const matches = (0, glob_1.parse)(new types_impl_1.RelativePattern(base, 'generated/*.jl'));
        (0, chai_1.expect)(matches(path.join(base.fsPath, 'generated', 'definitions.jl'))).to.be.ok;
    });
    it('should not match a file outside the subpath of the pattern', () => {
        const matches = (0, glob_1.parse)(new types_impl_1.RelativePattern(base, 'generated/*.jl'));
        (0, chai_1.expect)(matches(path.join(base.fsPath, 'definitions.jl'))).to.not.be.ok;
    });
});
//# sourceMappingURL=relative-pattern.spec.js.map