"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiSettingsRowControl = exports.AiSettingsRow = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
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
const core_1 = require("@theia/core");
const React = require("@theia/core/shared/react");
const ai_configuration_controls_1 = require("./ai-configuration-controls");
const ai_configuration_setting_row_1 = require("./ai-configuration-setting-row");
/**
 * Every control renders full-width below the label/description except the boolean toggle, which stays inline
 * on the right. This gives a single, consistent layout across the pages (mirroring the Settings UI, where the
 * control sits under the description) instead of mixing right-aligned and below controls.
 */
const INLINE_CONTROL_TYPES = new Set(['boolean']);
/**
 * Service-driven per-setting row: reads/writes a preference id via the injected
 * {@link AiSettingsRowService} and renders through the shared {@link AiConfigurationSettingRow}, so
 * it looks identical to the hand-authored rows on the General and Models pages. The control is chosen
 * from {@link AiSettingsRowProps.control}; compact controls render inline, wide ones (chips, text)
 * render full-width below.
 */
const AiSettingsRow = ({ service, preferenceId, label, description, scope, control, disabled, resourceUri, onDidChange, rowId, actions }) => {
    const inspection = service.inspect(preferenceId, scope, resourceUri);
    // Fall back to the (already-localized) label and description from the preference schema.
    const described = service.describe(preferenceId);
    const effectiveLabel = label ?? described.label ?? preferenceId;
    const effectiveDescription = description ?? described.description;
    // Stable identity so the description's effect does not re-render markdown on every render.
    const renderMarkdown = React.useCallback((markdown) => service.renderMarkdown(markdown), [service]);
    const commit = (value) => {
        service.set(preferenceId, value, scope, resourceUri)
            .then(() => onDidChange?.())
            // `console` rather than an `ILogger`: these row components are deliberately DI-free, so there is
            // no injection context here (the service they write through is the injected part).
            .catch(error => console.error(`Failed to set preference '${preferenceId}'`, error));
    };
    const openMenu = React.useCallback((gear) => service.openSettingContextMenu(gear, preferenceId, inspection.value, scope, resourceUri), [service, preferenceId, inspection.value, scope, resourceUri]);
    const controlNode = (0, jsx_runtime_1.jsx)(exports.AiSettingsRowControl, { control: control, value: inspection.value, label: effectiveLabel, disabled: disabled, onCommit: commit, onEditInSettings: () => service.editInSettings(preferenceId) });
    const below = !INLINE_CONTROL_TYPES.has(control.type);
    return (0, jsx_runtime_1.jsx)(ai_configuration_setting_row_1.AiConfigurationSettingRow, { preferenceId: rowId ?? preferenceId, title: effectiveLabel, description: effectiveDescription, renderMarkdown: renderMarkdown, modified: inspection.modified, tags: service.tags(preferenceId), onOpenMenu: openMenu, control: below ? undefined : controlNode, below: below ? controlNode : undefined, actions: actions });
};
exports.AiSettingsRow = AiSettingsRow;
/**
 * Renders the shared control for a schema-derived {@link AiSettingsControl}, so generically-discovered
 * preferences get the same controls as the hand-authored pages. Boolean→toggle, number→stepper,
 * enum→select, array→chip editor, object/array-of-objects→"Edit in settings.json", everything else→text.
 */
const AiSettingsRowControl = ({ control, value, label, disabled, onCommit, onEditInSettings }) => {
    switch (control.type) {
        case 'boolean':
            return (0, jsx_runtime_1.jsx)(ai_configuration_controls_1.AiToggleSwitch, { checked: value === true, ariaLabel: label, disabled: disabled, onChange: onCommit });
        case 'select':
            return (0, jsx_runtime_1.jsx)(ai_configuration_controls_1.AiEnumSelect, { value: value === undefined ? undefined : String(value), ariaLabel: label, disabled: disabled, options: control.options.map(option => ({
                    value: String(option.value ?? ''),
                    label: option.label ?? String(option.value ?? ''),
                    title: option.description
                })), onCommit: onCommit });
        case 'number':
            return (0, jsx_runtime_1.jsx)(ai_configuration_controls_1.AiNumberStepper, { value: typeof value === 'number' ? value : (control.min ?? 0), ariaLabel: label, integer: control.integer, min: control.min, max: control.max, disabled: disabled, onCommit: onCommit });
        case 'array':
            return (0, jsx_runtime_1.jsx)(ai_configuration_controls_1.AiArrayInput, { values: Array.isArray(value) ? value.map(String) : [], ariaLabel: label, addPlaceholder: control.placeholder ?? core_1.nls.localize('theia/ai/core/aiConfiguration/addValue', 'Add Value...'), validate: control.validate, disabled: disabled, onChange: onCommit });
        case 'json':
            return (0, jsx_runtime_1.jsx)(ai_configuration_controls_1.AiEditInSettingsButton, { label: core_1.nls.localizeByDefault('Edit in settings.json'), ariaLabel: label, disabled: disabled, onClick: onEditInSettings });
        case 'string':
        default:
            return (0, jsx_runtime_1.jsx)(ai_configuration_controls_1.AiTextInput, { value: typeof value === 'string' ? value : '', ariaLabel: label, placeholder: control.type === 'string' ? control.placeholder : undefined, password: control.type === 'string' ? control.password : undefined, disabled: disabled, onCommit: onCommit });
    }
};
exports.AiSettingsRowControl = AiSettingsRowControl;
//# sourceMappingURL=ai-settings-row.js.map