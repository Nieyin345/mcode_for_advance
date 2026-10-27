"use strict";
// *****************************************************************************
// Copyright (C) 2025 and others.
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
exports.DefaultContentHoverWidgetPatcher = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const monaco_init_1 = require("./monaco-init");
let DefaultContentHoverWidgetPatcher = class DefaultContentHoverWidgetPatcher {
    onStart(app) {
        const shell = app.shell;
        this.updateContentHoverWidgetHeight({
            topHeight: this.getTopPanelHeight(shell),
            bottomHeight: this.getStatusBarHeight(shell)
        });
        shell['statusBar'].onDidChangeVisibility(() => {
            this.updateContentHoverWidgetHeight({
                bottomHeight: this.getStatusBarHeight(shell)
            });
        });
    }
    updateContentHoverWidgetHeight(params) {
        monaco_init_1.contentHoverWidgetPatcher.setActualHeightForContentHoverWidget(params);
    }
    getTopPanelHeight(shell) {
        return shell.topPanel.node.getBoundingClientRect().height;
    }
    getStatusBarHeight(shell) {
        return shell['statusBar'].node.getBoundingClientRect().height;
    }
};
exports.DefaultContentHoverWidgetPatcher = DefaultContentHoverWidgetPatcher;
exports.DefaultContentHoverWidgetPatcher = DefaultContentHoverWidgetPatcher = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DefaultContentHoverWidgetPatcher);
//# sourceMappingURL=default-content-hover-widget-patcher.js.map