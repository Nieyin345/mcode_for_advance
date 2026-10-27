"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceTrustDialog = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const react_dialog_1 = require("@theia/core/lib/browser/dialogs/react-dialog");
class WorkspaceTrustDialog extends react_dialog_1.ReactDialog {
    constructor(folderUris) {
        super({
            title: '',
            maxWidth: 500
        });
        this.folderUris = folderUris;
        this.confirmed = true;
        this.node.classList.add('workspace-trust-dialog');
        this.appendCloseButton(core_1.nls.localizeByDefault("No, I don't trust the authors"));
        this.appendAcceptButton(core_1.nls.localizeByDefault('Yes, I trust the authors'));
        this.controlPanel.removeChild(this.errorMessageNode);
    }
    get value() {
        return this.confirmed;
    }
    handleEscape() {
        this.confirmed = false;
        this.accept();
    }
    close() {
        this.confirmed = false;
        this.accept();
    }
    render() {
        return ((0, jsx_runtime_1.jsxs)("div", { className: "workspace-trust-content", children: [(0, jsx_runtime_1.jsxs)("div", { className: "workspace-trust-header", children: [(0, jsx_runtime_1.jsx)("i", { className: (0, browser_1.codicon)('shield') }), (0, jsx_runtime_1.jsx)("div", { className: "workspace-trust-title", children: core_1.nls.localizeByDefault('Do you trust the authors of the files in this folder?') })] }), (0, jsx_runtime_1.jsx)("div", { className: "workspace-trust-description", children: core_1.nls.localize('theia/workspace/trustDialogMessage', 'If you trust the authors, code in this folder may be executed, including tasks, debug configurations, extensions, and AI features.') }), (0, jsx_runtime_1.jsx)("div", { className: "workspace-trust-description", children: core_1.nls.localize('theia/workspace/trustDialogRestricted', "If you don't trust the authors, the workspace will open in Restricted Mode, which disables these features to protect against potentially harmful code.") }), (0, jsx_runtime_1.jsx)("div", { className: "workspace-trust-description", children: (0, jsx_runtime_1.jsx)("a", { href: "https://theia-ide.org/docs/workspace_trust/", title: "https://theia-ide.org/docs/workspace_trust/", target: "_blank", rel: "noopener noreferrer", children: core_1.nls.localize('theia/workspace/trustLearnMore', "Learn more about Theia's Workspace Trust") }) }), this.folderUris.length > 0 && ((0, jsx_runtime_1.jsx)("div", { className: "workspace-trust-folder", children: (0, jsx_runtime_1.jsx)("ul", { className: "workspace-trust-folder-list", children: this.folderUris.map(uri => {
                            const stringified = uri.path.fsPath();
                            return ((0, jsx_runtime_1.jsx)("li", { children: stringified }, stringified));
                        }) }) }))] }));
    }
}
exports.WorkspaceTrustDialog = WorkspaceTrustDialog;
//# sourceMappingURL=workspace-trust-dialog.js.map