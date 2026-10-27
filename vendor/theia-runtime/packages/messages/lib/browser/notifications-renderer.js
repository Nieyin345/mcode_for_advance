"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationsRenderer = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
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
const client_1 = require("@theia/core/shared/react-dom/client");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const notifications_manager_1 = require("./notifications-manager");
const notification_center_component_1 = require("./notification-center-component");
const notification_toasts_component_1 = require("./notification-toasts-component");
const core_1 = require("@theia/core");
let NotificationsRenderer = class NotificationsRenderer {
    init() {
        this.createOverlayContainer();
        this.render();
    }
    createOverlayContainer() {
        this.container = window.document.createElement('div');
        this.container.className = 'theia-notifications-overlay';
        if (window.document.body) {
            window.document.body.appendChild(this.container);
        }
        this.containerRoot = (0, client_1.createRoot)(this.container);
    }
    render() {
        this.containerRoot.render((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)(notification_toasts_component_1.NotificationToastsComponent, { manager: this.manager, corePreferences: this.corePreferences, contextMenuRenderer: this.contextMenuRenderer }), (0, jsx_runtime_1.jsx)(notification_center_component_1.NotificationCenterComponent, { manager: this.manager, contextMenuRenderer: this.contextMenuRenderer })] }));
    }
};
exports.NotificationsRenderer = NotificationsRenderer;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ApplicationShell),
    tslib_1.__metadata("design:type", browser_1.ApplicationShell)
], NotificationsRenderer.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notifications_manager_1.NotificationManager),
    tslib_1.__metadata("design:type", notifications_manager_1.NotificationManager)
], NotificationsRenderer.prototype, "manager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.CorePreferences),
    tslib_1.__metadata("design:type", Object)
], NotificationsRenderer.prototype, "corePreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ContextMenuRenderer),
    tslib_1.__metadata("design:type", browser_1.ContextMenuRenderer)
], NotificationsRenderer.prototype, "contextMenuRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], NotificationsRenderer.prototype, "init", null);
exports.NotificationsRenderer = NotificationsRenderer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotificationsRenderer);
//# sourceMappingURL=notifications-renderer.js.map