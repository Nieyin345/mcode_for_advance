"use strict";
// *****************************************************************************
// Copyright (C) 2025 Eclipse GmbH and others.
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
exports.AIVariableUriLabelProvider = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const ai_variable_resource_1 = require("../common/ai-variable-resource");
const variable_service_1 = require("../common/variable-service");
let AIVariableUriLabelProvider = class AIVariableUriLabelProvider {
    isMine(element) {
        return element instanceof core_1.URI && element.scheme === ai_variable_resource_1.AI_VARIABLE_RESOURCE_SCHEME;
    }
    canHandle(element) {
        return this.isMine(element) ? 150 : -1;
    }
    getIcon(element) {
        if (!this.isMine(element)) {
            return undefined;
        }
        return this.labelProvider.getIcon(this.getResolutionRequest(element));
    }
    getName(element) {
        if (!this.isMine(element)) {
            return undefined;
        }
        return this.labelProvider.getName(this.getResolutionRequest(element));
    }
    getLongName(element) {
        if (!this.isMine(element)) {
            return undefined;
        }
        return this.labelProvider.getLongName(this.getResolutionRequest(element));
    }
    getDetails(element) {
        if (!this.isMine(element)) {
            return undefined;
        }
        return this.labelProvider.getDetails(this.getResolutionRequest(element));
    }
    getResolutionRequest(element) {
        if (!this.isMine(element)) {
            return undefined;
        }
        const metadata = this.variableResourceResolver.fromUri(element);
        if (!metadata) {
            return undefined;
        }
        const { variableName, arg } = metadata;
        const variable = this.variableService.getVariable(variableName);
        return variable && { variable, arg };
    }
};
exports.AIVariableUriLabelProvider = AIVariableUriLabelProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.LabelProvider),
    tslib_1.__metadata("design:type", browser_1.LabelProvider)
], AIVariableUriLabelProvider.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(ai_variable_resource_1.AIVariableResourceResolver),
    tslib_1.__metadata("design:type", ai_variable_resource_1.AIVariableResourceResolver)
], AIVariableUriLabelProvider.prototype, "variableResourceResolver", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(variable_service_1.AIVariableService),
    tslib_1.__metadata("design:type", Object)
], AIVariableUriLabelProvider.prototype, "variableService", void 0);
exports.AIVariableUriLabelProvider = AIVariableUriLabelProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AIVariableUriLabelProvider);
//# sourceMappingURL=ai-variable-uri-label-provider.js.map