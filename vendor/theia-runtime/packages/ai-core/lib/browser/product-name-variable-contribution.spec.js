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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({ applicationName: 'Test IDE' });
require("reflect-metadata");
const chai_1 = require("chai");
const product_name_variable_contribution_1 = require("./product-name-variable-contribution");
disableJSDOM();
describe('ProductNameVariableContribution', () => {
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
        frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({ applicationName: 'Test IDE' });
    });
    after(() => disableJSDOM());
    let contribution;
    beforeEach(() => {
        contribution = new product_name_variable_contribution_1.ProductNameVariableContribution();
    });
    it('should resolve to the configured application name', async () => {
        const result = await contribution.resolve({ variable: product_name_variable_contribution_1.PRODUCT_NAME_VARIABLE }, {});
        (0, chai_1.expect)(result).to.not.be.undefined;
        (0, chai_1.expect)(result.value).to.equal('Test IDE');
    });
    it('should return undefined for unknown variables', async () => {
        const result = await contribution.resolve({ variable: { id: 'other', name: 'other', description: 'other' } }, {});
        (0, chai_1.expect)(result).to.be.undefined;
    });
    it('should return a positive priority from canResolve', async () => {
        const priority = await contribution.canResolve({ variable: product_name_variable_contribution_1.PRODUCT_NAME_VARIABLE }, {});
        (0, chai_1.expect)(priority).to.equal(1);
    });
});
//# sourceMappingURL=product-name-variable-contribution.spec.js.map