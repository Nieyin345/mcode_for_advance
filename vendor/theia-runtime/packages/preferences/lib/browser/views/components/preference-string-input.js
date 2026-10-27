"use strict";
// *****************************************************************************
// Copyright (C) 2021 Ericsson and others.
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
var PreferenceStringInputRendererContribution_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PreferenceStringInputRendererContribution = exports.PreferenceStringInputRenderer = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const preference_types_1 = require("../../util/preference-types");
const preference_node_renderer_1 = require("./preference-node-renderer");
const preference_node_renderer_creator_1 = require("./preference-node-renderer-creator");
let PreferenceStringInputRenderer = class PreferenceStringInputRenderer extends preference_node_renderer_1.PreferenceLeafNodeRenderer {
    createInteractable(parent) {
        const interactable = document.createElement('input');
        this.interactable = interactable;
        interactable.type = 'text';
        interactable.spellcheck = false;
        interactable.classList.add('theia-input');
        interactable.defaultValue = this.getValue() ?? '';
        interactable.oninput = this.handleUserInteraction.bind(this);
        interactable.onblur = this.handleBlur.bind(this);
        parent.appendChild(interactable);
    }
    getFallbackValue() {
        return '';
    }
    doHandleValueChange() {
        const currentValue = this.interactable.value;
        this.updateInspection();
        const newValue = this.getValue();
        this.updateModificationStatus();
        if (newValue !== currentValue) {
            if (document.activeElement !== this.interactable) {
                this.interactable.value = newValue ?? this.getDefaultValue();
            }
            else {
                this.handleUserInteraction(); // give priority to the value of the input if it is focused.
            }
        }
    }
    handleUserInteraction() {
        this.setPreferenceWithDebounce(this.interactable.value);
    }
    async handleBlur() {
        await this.setPreferenceWithDebounce.flush();
        this.handleValueChange();
    }
};
exports.PreferenceStringInputRenderer = PreferenceStringInputRenderer;
exports.PreferenceStringInputRenderer = PreferenceStringInputRenderer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceStringInputRenderer);
let PreferenceStringInputRendererContribution = class PreferenceStringInputRendererContribution extends preference_node_renderer_creator_1.PreferenceLeafNodeRendererContribution {
    constructor() {
        super(...arguments);
        this.id = PreferenceStringInputRendererContribution_1.ID;
    }
    static { PreferenceStringInputRendererContribution_1 = this; }
    static { this.ID = 'preference-string-input-renderer'; }
    canHandleLeafNode(node) {
        return preference_types_1.Preference.LeafNode.getType(node) === 'string' ? 2 : 0;
    }
    createLeafNodeRenderer(container) {
        return container.get(PreferenceStringInputRenderer);
    }
};
exports.PreferenceStringInputRendererContribution = PreferenceStringInputRendererContribution;
exports.PreferenceStringInputRendererContribution = PreferenceStringInputRendererContribution = PreferenceStringInputRendererContribution_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceStringInputRendererContribution);
//# sourceMappingURL=preference-string-input.js.map