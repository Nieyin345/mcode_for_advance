"use strict";
// *****************************************************************************
// Copyright (C) 2023 Ericsson and others.
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
exports.WebviewContextKeys = void 0;
const tslib_1 = require("tslib");
const browser_1 = require("@theia/core/lib/browser");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const inversify_1 = require("@theia/core/shared/inversify");
const custom_editor_widget_1 = require("../custom-editors/custom-editor-widget");
const vscode_theia_menu_mappings_1 = require("../menus/vscode-theia-menu-mappings");
const webview_1 = require("./webview");
const ACTIVE_WEBVIEW_PANEL_ID = 'activeWebviewPanelId';
const ACTIVE_CUSTOM_EDITOR_ID = 'activeCustomEditorId';
let WebviewContextKeys = class WebviewContextKeys {
    init() {
        this.activeWebviewPanelId = this.contextKeyService.createKey(ACTIVE_WEBVIEW_PANEL_ID, '');
        this.activeCustomEditorId = this.contextKeyService.createKey(ACTIVE_CUSTOM_EDITOR_ID, '');
        this.applicationShell.onDidChangeCurrentWidget(this.handleDidChangeCurrentWidget, this);
    }
    getContextKeyValues(widget) {
        // A view toolbar item may key on the *active* editor, so only the editor-like widgets these keys can
        // describe get an answer; everything else keeps the ambient value.
        if (!vscode_theia_menu_mappings_1.CodeEditorWidgetUtil.is(widget)) {
            return undefined;
        }
        return [
            [ACTIVE_CUSTOM_EDITOR_ID, widget instanceof custom_editor_widget_1.CustomEditorWidget ? widget.viewType : ''],
            [ACTIVE_WEBVIEW_PANEL_ID, widget instanceof webview_1.WebviewWidget ? widget.viewType : '']
        ];
    }
    handleDidChangeCurrentWidget(change) {
        const { newValue } = change;
        if (newValue instanceof custom_editor_widget_1.CustomEditorWidget) {
            this.activeCustomEditorId.set(newValue.viewType);
        }
        else {
            this.activeCustomEditorId.set('');
        }
        if (newValue instanceof webview_1.WebviewWidget) {
            this.activeWebviewPanelId.set(newValue.viewType);
        }
        else {
            this.activeWebviewPanelId.set('');
        }
    }
};
exports.WebviewContextKeys = WebviewContextKeys;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ApplicationShell),
    tslib_1.__metadata("design:type", browser_1.ApplicationShell)
], WebviewContextKeys.prototype, "applicationShell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], WebviewContextKeys.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], WebviewContextKeys.prototype, "init", null);
exports.WebviewContextKeys = WebviewContextKeys = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WebviewContextKeys);
//# sourceMappingURL=webview-context-keys.js.map