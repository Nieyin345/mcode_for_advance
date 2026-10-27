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
exports.BadgeService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const common_1 = require("../../common");
let BadgeService = class BadgeService {
    constructor() {
        this.badges = new WeakMap();
        this.onDidChangeBadgesEmitter = new common_1.Emitter();
    }
    get onDidChangeBadges() { return this.onDidChangeBadgesEmitter.event; }
    getBadge(widget) {
        return this.badges.get(widget);
    }
    showBadge(widget, badge) {
        if (badge) {
            this.badges.set(widget, badge);
            this.onDidChangeBadgesEmitter.fire(widget);
        }
        else if (this.badges.delete(widget)) {
            this.onDidChangeBadgesEmitter.fire(widget);
        }
    }
};
exports.BadgeService = BadgeService;
exports.BadgeService = BadgeService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BadgeService);
//# sourceMappingURL=badge-service.js.map