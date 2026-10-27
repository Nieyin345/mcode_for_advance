"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiConfigurationSelectionModel = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
/**
 * Shared selection bus for the AI Configuration view. The tree, the detail host,
 * and renderers navigate through this single model instead of talking directly
 * to each other.
 */
let AiConfigurationSelectionModel = class AiConfigurationSelectionModel {
    constructor() {
        this.onDidChangeSelectionEmitter = new core_1.Emitter();
        this.onDidChangeSelection = this.onDidChangeSelectionEmitter.event;
    }
    getSelection() {
        return this.selection;
    }
    select(selection) {
        this.selection = selection;
        this.onDidChangeSelectionEmitter.fire(selection);
    }
};
exports.AiConfigurationSelectionModel = AiConfigurationSelectionModel;
exports.AiConfigurationSelectionModel = AiConfigurationSelectionModel = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AiConfigurationSelectionModel);
//# sourceMappingURL=ai-configuration-selection-model.js.map