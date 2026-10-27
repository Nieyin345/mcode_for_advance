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
var PreferenceSelectInputRendererContribution_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PreferenceSelectInputRendererContribution = exports.PreferenceSelectInputRenderer = void 0;
const tslib_1 = require("tslib");
const preference_node_renderer_1 = require("./preference-node-renderer");
const inversify_1 = require("@theia/core/shared/inversify");
const select_component_1 = require("@theia/core/lib/browser/widgets/select-component");
const preference_node_renderer_creator_1 = require("./preference-node-renderer-creator");
const React = require("@theia/core/shared/react");
const client_1 = require("@theia/core/shared/react-dom/client");
const strings_1 = require("@theia/core/lib/common/strings");
const core_1 = require("@theia/core");
let PreferenceSelectInputRenderer = class PreferenceSelectInputRenderer extends preference_node_renderer_1.PreferenceLeafNodeRenderer {
    constructor() {
        super(...arguments);
        this.selectComponent = React.createRef();
        this.selectOptions = [];
    }
    get enumValues() {
        return this.preferenceNode.preference.data.enum;
    }
    updateSelectOptions() {
        const updatedSelectOptions = [];
        const values = this.enumValues;
        const preferenceData = this.preferenceNode.preference.data;
        const defaultValue = preferenceData.default;
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            const stringValue = `${value}`;
            const label = (0, strings_1.escapeInvisibleChars)(preferenceData.enumItemLabels?.[i] ?? stringValue);
            const detail = core_1.PreferenceUtils.deepEqual(defaultValue, value) ? 'default' : undefined;
            let enumDescription = preferenceData.enumDescriptions?.[i];
            let markdown = false;
            const markdownEnumDescription = preferenceData.markdownEnumDescriptions?.[i];
            if (markdownEnumDescription) {
                enumDescription = this.markdownRenderer.renderInline(markdownEnumDescription);
                markdown = true;
            }
            updatedSelectOptions.push({
                label,
                value: stringValue,
                detail,
                description: enumDescription,
                markdown
            });
        }
        this.selectOptions = updatedSelectOptions;
    }
    createInteractable(parent) {
        this.updateSelectOptions();
        const interactable = document.createElement('div');
        const selectComponent = React.createElement(select_component_1.SelectComponent, {
            options: this.selectOptions,
            defaultValue: this.getDataValue(),
            onChange: (_, index) => this.handleUserInteraction(index),
            ref: this.selectComponent
        });
        this.interactable = interactable;
        const root = (0, client_1.createRoot)(interactable);
        root.render(selectComponent);
        parent.appendChild(interactable);
    }
    getFallbackValue() {
        const { default: schemaDefault, enum: enumValues } = this.preferenceNode.preference.data;
        return schemaDefault !== undefined ? schemaDefault : enumValues[0];
    }
    doHandleValueChange() {
        this.updateInspection();
        this.updateSelectOptions();
        const newValue = this.getDataValue();
        this.updateModificationStatus();
        if (document.activeElement !== this.interactable && this.selectComponent.current) {
            this.selectComponent.current.value = newValue;
        }
    }
    /**
     * Returns the stringified index corresponding to the currently selected value.
     */
    getDataValue() {
        const currentValue = this.getValue();
        let selected = this.enumValues.findIndex(value => core_1.PreferenceUtils.deepEqual(value, currentValue));
        if (selected === -1) {
            const fallback = this.getFallbackValue();
            selected = this.enumValues.findIndex(value => core_1.PreferenceUtils.deepEqual(value, fallback));
        }
        return Math.max(selected, 0);
    }
    handleUserInteraction(selected) {
        const value = this.enumValues[selected];
        this.setPreferenceImmediately(value);
    }
};
exports.PreferenceSelectInputRenderer = PreferenceSelectInputRenderer;
exports.PreferenceSelectInputRenderer = PreferenceSelectInputRenderer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceSelectInputRenderer);
let PreferenceSelectInputRendererContribution = class PreferenceSelectInputRendererContribution extends preference_node_renderer_creator_1.PreferenceLeafNodeRendererContribution {
    constructor() {
        super(...arguments);
        this.id = PreferenceSelectInputRendererContribution_1.ID;
    }
    static { PreferenceSelectInputRendererContribution_1 = this; }
    static { this.ID = 'preference-select-input-renderer'; }
    canHandleLeafNode(node) {
        return node.preference.data.enum ? 3 : 0;
    }
    createLeafNodeRenderer(container) {
        return container.get(PreferenceSelectInputRenderer);
    }
};
exports.PreferenceSelectInputRendererContribution = PreferenceSelectInputRendererContribution;
exports.PreferenceSelectInputRendererContribution = PreferenceSelectInputRendererContribution = PreferenceSelectInputRendererContribution_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceSelectInputRendererContribution);
//# sourceMappingURL=preference-select-input.js.map