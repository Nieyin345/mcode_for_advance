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
var PreferenceNumberInputRendererContribution_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PreferenceNumberInputRendererContribution = exports.PreferenceNumberInputRenderer = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const preference_types_1 = require("../../util/preference-types");
const preference_node_renderer_1 = require("./preference-node-renderer");
const preference_node_renderer_creator_1 = require("./preference-node-renderer-creator");
let PreferenceNumberInputRenderer = class PreferenceNumberInputRenderer extends preference_node_renderer_1.PreferenceLeafNodeRenderer {
    get errorMessage() {
        if (!this._errorMessage) {
            const errorMessage = document.createElement('div');
            errorMessage.classList.add('pref-error-notification');
            this._errorMessage = errorMessage;
        }
        return this._errorMessage;
    }
    createInteractable(parent) {
        const interactableWrapper = document.createElement('div');
        this.interactableWrapper = interactableWrapper;
        interactableWrapper.classList.add('pref-input-container');
        const interactable = document.createElement('input');
        this.interactable = interactable;
        interactable.type = 'number';
        interactable.step = this.preferenceNode.preference.data.type === 'integer' ? '1' : 'any';
        interactable.classList.add('theia-input');
        interactable.defaultValue = this.getValue()?.toString() ?? '';
        interactable.oninput = this.handleUserInteraction.bind(this);
        interactable.onblur = this.handleBlur.bind(this);
        interactableWrapper.appendChild(interactable);
        parent.appendChild(interactableWrapper);
    }
    getFallbackValue() {
        return 0;
    }
    handleUserInteraction() {
        const { value, message } = this.getInputValidation(this.interactable.value);
        if (isNaN(value)) {
            this.showErrorMessage(message);
        }
        else {
            this.hideErrorMessage();
            this.setPreferenceWithDebounce(value);
        }
    }
    async handleBlur() {
        this.hideErrorMessage();
        await this.setPreferenceWithDebounce.flush();
        this.handleValueChange();
    }
    doHandleValueChange() {
        const { value } = this.interactable;
        const currentValue = value.length ? Number(value) : NaN;
        this.updateInspection();
        const newValue = this.getValue();
        this.updateModificationStatus();
        if (newValue !== currentValue) {
            if (document.activeElement !== this.interactable) {
                this.interactable.value = (newValue ?? this.getDefaultValue()).toString();
            }
            else {
                this.handleUserInteraction(); // give priority to the value of the input if it is focused.
            }
        }
    }
    getInputValidation(input) {
        const { preference: { data } } = this.preferenceNode;
        const inputValue = Number(input);
        const errorMessages = [];
        if (input === '' || isNaN(inputValue)) {
            return { value: NaN, message: core_1.nls.localizeByDefault('Value must be a number.') };
        }
        if (data.type === 'integer' && !Number.isInteger(inputValue)) {
            errorMessages.push(core_1.nls.localizeByDefault('Value must be an integer.'));
        }
        if (data.minimum !== undefined && isFinite(data.minimum)) {
            // https://json-schema.org/understanding-json-schema/reference/numeric
            // "In JSON Schema Draft 4, exclusiveMinimum and exclusiveMaximum work differently.
            // There they are boolean values, that indicate whether minimum and maximum are exclusive of the value"
            if ((0, core_1.isBoolean)(data.exclusiveMinimum) && data.exclusiveMinimum) {
                if (inputValue <= data.minimum) {
                    errorMessages.push(core_1.nls.localizeByDefault('Value must be strictly greater than {0}.', data.minimum));
                }
            }
            else {
                if (inputValue < data.minimum) {
                    errorMessages.push(core_1.nls.localizeByDefault('Value must be greater than or equal to {0}.', data.minimum));
                }
            }
        }
        if (data.maximum !== undefined && isFinite(data.maximum)) {
            // https://json-schema.org/understanding-json-schema/reference/numeric
            // "In JSON Schema Draft 4, exclusiveMinimum and exclusiveMaximum work differently.
            // There they are boolean values, that indicate whether minimum and maximum are exclusive of the value"
            if ((0, core_1.isBoolean)(data.exclusiveMaximum) && data.exclusiveMaximum) {
                if (inputValue >= data.maximum) {
                    errorMessages.push(core_1.nls.localizeByDefault('Value must be strictly less than {0}.', data.maximum));
                }
            }
            else {
                if (inputValue > data.maximum) {
                    errorMessages.push(core_1.nls.localizeByDefault('Value must be less than or equal to {0}.', data.maximum));
                }
            }
        }
        // Using JSON Schema before Draft 4 both exclusive and non-exclusive variants can be set
        if ((0, core_1.isNumber)(data.exclusiveMinimum) && isFinite(data.exclusiveMinimum)) {
            if (inputValue <= data.exclusiveMinimum) {
                errorMessages.push(core_1.nls.localizeByDefault('Value must be strictly greater than {0}.', data.exclusiveMinimum));
            }
        }
        if ((0, core_1.isNumber)(data.exclusiveMaximum) && isFinite(data.exclusiveMaximum)) {
            if (inputValue >= data.exclusiveMaximum) {
                errorMessages.push(core_1.nls.localizeByDefault('Value must be strictly less than {0}.', data.exclusiveMaximum));
            }
        }
        if ((0, core_1.isNumber)(data.multipleOf) && data.multipleOf !== 0 && !Number.isInteger(inputValue / data.multipleOf)) {
            errorMessages.push(core_1.nls.localizeByDefault('Value must be a multiple of {0}.', data.multipleOf));
        }
        return {
            value: errorMessages.length ? NaN : inputValue,
            message: errorMessages.join(' ')
        };
    }
    showErrorMessage(message) {
        this.errorMessage.textContent = message;
        this.interactableWrapper.appendChild(this.errorMessage);
    }
    hideErrorMessage() {
        this.errorMessage.remove();
    }
};
exports.PreferenceNumberInputRenderer = PreferenceNumberInputRenderer;
exports.PreferenceNumberInputRenderer = PreferenceNumberInputRenderer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceNumberInputRenderer);
let PreferenceNumberInputRendererContribution = class PreferenceNumberInputRendererContribution extends preference_node_renderer_creator_1.PreferenceLeafNodeRendererContribution {
    constructor() {
        super(...arguments);
        this.id = PreferenceNumberInputRendererContribution_1.ID;
    }
    static { PreferenceNumberInputRendererContribution_1 = this; }
    static { this.ID = 'preference-number-input-renderer'; }
    canHandleLeafNode(node) {
        const type = preference_types_1.Preference.LeafNode.getType(node);
        return type === 'integer' || type === 'number' ? 2 : 0;
    }
    createLeafNodeRenderer(container) {
        return container.get(PreferenceNumberInputRenderer);
    }
};
exports.PreferenceNumberInputRendererContribution = PreferenceNumberInputRendererContribution;
exports.PreferenceNumberInputRendererContribution = PreferenceNumberInputRendererContribution = PreferenceNumberInputRendererContribution_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceNumberInputRendererContribution);
//# sourceMappingURL=preference-number-input.js.map