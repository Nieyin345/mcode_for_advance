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
exports.ProductNameVariableContribution = exports.PRODUCT_NAME_VARIABLE = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
const inversify_1 = require("@theia/core/shared/inversify");
exports.PRODUCT_NAME_VARIABLE = {
    id: 'product-name-provider',
    name: 'productName',
    description: core_1.nls.localize('theia/ai/core/productNameVariable/description', 'The name of the product/application the user is working with'),
};
let ProductNameVariableContribution = class ProductNameVariableContribution {
    registerVariables(service) {
        service.registerResolver(exports.PRODUCT_NAME_VARIABLE, this);
    }
    canResolve(request, context) {
        if (request.variable.name === exports.PRODUCT_NAME_VARIABLE.name) {
            return 1;
        }
        return -1;
    }
    async resolve(request, context) {
        if (request.variable.name === exports.PRODUCT_NAME_VARIABLE.name) {
            return { variable: request.variable, value: frontend_application_config_provider_1.FrontendApplicationConfigProvider.get().applicationName };
        }
        return undefined;
    }
};
exports.ProductNameVariableContribution = ProductNameVariableContribution;
exports.ProductNameVariableContribution = ProductNameVariableContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ProductNameVariableContribution);
//# sourceMappingURL=product-name-variable-contribution.js.map