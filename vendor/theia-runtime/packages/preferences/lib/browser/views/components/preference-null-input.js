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
var PreferenceNullRendererContribution_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PreferenceNullRendererContribution = exports.PreferenceNullInputRenderer = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const preference_node_renderer_1 = require("./preference-node-renderer");
const preference_node_renderer_creator_1 = require("./preference-node-renderer-creator");
let PreferenceNullInputRenderer = class PreferenceNullInputRenderer extends preference_node_renderer_1.PreferenceLeafNodeRenderer {
    createInteractable(container) {
        const span = document.createElement('span');
        this.interactable = span;
        container.appendChild(span);
    }
    getFallbackValue() {
        // eslint-disable-next-line no-null/no-null
        return null;
    }
    doHandleValueChange() { }
};
exports.PreferenceNullInputRenderer = PreferenceNullInputRenderer;
exports.PreferenceNullInputRenderer = PreferenceNullInputRenderer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
    /** For rendering preference items for which the only interesting feature is the description */
], PreferenceNullInputRenderer);
let PreferenceNullRendererContribution = class PreferenceNullRendererContribution extends preference_node_renderer_creator_1.PreferenceLeafNodeRendererContribution {
    constructor() {
        super(...arguments);
        this.id = PreferenceNullRendererContribution_1.ID;
    }
    static { PreferenceNullRendererContribution_1 = this; }
    static { this.ID = 'preference-null-renderer'; }
    canHandleLeafNode(node) {
        const isOnlyNull = node.preference.data.type === 'null' || Array.isArray(node.preference.data.type) && node.preference.data.type.every(candidate => candidate === 'null');
        return isOnlyNull ? 5 : 0;
    }
    createLeafNodeRenderer(container) {
        return container.get(PreferenceNullInputRenderer);
    }
};
exports.PreferenceNullRendererContribution = PreferenceNullRendererContribution;
exports.PreferenceNullRendererContribution = PreferenceNullRendererContribution = PreferenceNullRendererContribution_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceNullRendererContribution);
//# sourceMappingURL=preference-null-input.js.map