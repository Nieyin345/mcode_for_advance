"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH and others.
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
exports.TabBarBadgeDecorator = void 0;
exports.bindBadgeDecoration = bindBadgeDecoration;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const view_container_1 = require("../view-container");
const tab_bar_decorator_1 = require("../shell/tab-bar-decorator");
const badge_service_1 = require("./badge-service");
let TabBarBadgeDecorator = class TabBarBadgeDecorator {
    constructor() {
        this.id = 'theia-plugin-view-container-badge-decorator';
    }
    onDidChangeDecorations(...[cb, thisArg, disposable]) { return this.badgeService.onDidChangeBadges(() => cb(), thisArg, disposable); }
    decorate({ owner }) {
        let total = 0;
        const result = [];
        const aggregate = (badge) => {
            if (badge?.value) {
                total += badge.value;
            }
            if (badge?.tooltip) {
                result.push({ tooltip: badge.tooltip });
            }
        };
        if (owner instanceof view_container_1.ViewContainer) {
            for (const { wrapped } of owner.getParts()) {
                aggregate(this.badgeService.getBadge(wrapped));
            }
        }
        else {
            aggregate(this.badgeService.getBadge(owner));
        }
        if (total !== 0) {
            result.push({ badge: total });
        }
        return result;
    }
};
exports.TabBarBadgeDecorator = TabBarBadgeDecorator;
tslib_1.__decorate([
    (0, inversify_1.inject)(badge_service_1.BadgeService),
    tslib_1.__metadata("design:type", badge_service_1.BadgeService)
], TabBarBadgeDecorator.prototype, "badgeService", void 0);
exports.TabBarBadgeDecorator = TabBarBadgeDecorator = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TabBarBadgeDecorator);
function bindBadgeDecoration(bind) {
    bind(badge_service_1.BadgeService).toSelf().inSingletonScope();
    bind(TabBarBadgeDecorator).toSelf().inSingletonScope();
    bind(tab_bar_decorator_1.TabBarDecorator).toService(TabBarBadgeDecorator);
}
//# sourceMappingURL=tabbar-badge-decorator.js.map