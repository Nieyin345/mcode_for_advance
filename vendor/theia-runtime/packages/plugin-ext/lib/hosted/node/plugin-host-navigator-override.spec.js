"use strict";
// *****************************************************************************
// Copyright (C) 2026 STMicroelectronics and others.
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
const plugin_host_navigator_override_1 = require("./plugin-host-navigator-override");
describe('suppressNodeNavigator', () => {
    it('should override navigator to return undefined when env var is not set', () => {
        const target = { navigator: { userAgent: 'test' } };
        (0, plugin_host_navigator_override_1.suppressNodeNavigator)({}, target);
        (0, chai_1.expect)(target.navigator).to.be.undefined;
    });
    it('should override navigator to return undefined when env var is set to a non-true value', () => {
        const target = { navigator: { userAgent: 'test' } };
        (0, plugin_host_navigator_override_1.suppressNodeNavigator)({ 'THEIA_SUPPORT_NODE_GLOBAL_NAVIGATOR': 'false' }, target);
        (0, chai_1.expect)(target.navigator).to.be.undefined;
    });
    it('should preserve navigator when env var is set to true', () => {
        const original = { userAgent: 'test' };
        const target = { navigator: original };
        (0, plugin_host_navigator_override_1.suppressNodeNavigator)({ 'THEIA_SUPPORT_NODE_GLOBAL_NAVIGATOR': 'true' }, target);
        (0, chai_1.expect)(target.navigator).to.equal(original);
    });
    it('should make the override configurable so it can be restored', () => {
        const target = { navigator: { userAgent: 'test' } };
        (0, plugin_host_navigator_override_1.suppressNodeNavigator)({}, target);
        (0, chai_1.expect)(target.navigator).to.be.undefined;
        const restored = { userAgent: 'restored' };
        Object.defineProperty(target, 'navigator', {
            value: restored,
            configurable: true,
        });
        (0, chai_1.expect)(target.navigator).to.equal(restored);
    });
});
//# sourceMappingURL=plugin-host-navigator-override.spec.js.map