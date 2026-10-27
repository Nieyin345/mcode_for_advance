"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiSessionLimitControl = exports.AiEnumSelect = exports.AiEditInSettingsButton = exports.AiPathInput = exports.AiArrayInput = exports.AiNumberStepper = exports.AiTextInput = exports.AiToggleSwitch = void 0;
exports.clampNumber = clampNumber;
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
/**
 * Presentational, DI-free form controls shared across the AI configuration pages so that a given
 * logical control (a toggle, a text input, a select, a numeric stepper, a chip/tag editor) looks
 * and behaves the same regardless of which category renders it. Owners pass in the current value
 * and an `onChange`/`onCommit` callback; controls that edit free text commit on blur/Enter so that
 * typing does not write a preference per keystroke.
 *
 * All classes are prefixed `ai-config-` and are styled in `ai-configuration-components.css`.
 */
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const select_component_1 = require("@theia/core/lib/browser/widgets/select-component");
const React = require("@theia/core/shared/react");
/** Accessible toggle switch backed by a real checkbox; `large` renders the hero-sized variant. */
const AiToggleSwitch = ({ checked, ariaLabel, disabled, large, onChange }) => ((0, jsx_runtime_1.jsxs)("label", { className: `ai-config-switch${large ? ' ai-config-switch-large' : ''}`, children: [(0, jsx_runtime_1.jsx)("input", { type: 'checkbox', checked: checked, disabled: disabled, "aria-label": ariaLabel, onChange: e => onChange(e.target.checked) }), (0, jsx_runtime_1.jsx)("span", { className: 'ai-config-switch-track', children: (0, jsx_runtime_1.jsx)("span", { className: 'ai-config-switch-thumb' }) })] }));
exports.AiToggleSwitch = AiToggleSwitch;
/** Single-line text input committing on blur or Enter (so typing does not write a preference per keystroke). */
const AiTextInput = ({ value, ariaLabel, placeholder, disabled, monospace, password, invalid, errorMessage, onCommit }) => {
    const [draft, setDraft] = React.useState(value);
    React.useEffect(() => setDraft(value), [value]);
    const commitIfChanged = () => {
        if (draft !== value) {
            onCommit(draft);
        }
    };
    return (0, jsx_runtime_1.jsxs)("span", { className: 'ai-config-input-wrap', children: [(0, jsx_runtime_1.jsx)("input", { className: `theia-input ai-config-input${monospace ? ' ai-config-input-mono' : ''}${invalid ? ' error' : ''}`, type: password ? 'password' : 'text', value: draft, "aria-label": ariaLabel, placeholder: placeholder, disabled: disabled, autoComplete: password ? 'off' : undefined, spellCheck: false, onChange: e => setDraft(e.target.value), onBlur: commitIfChanged, onKeyDown: e => { if (e.key === 'Enter') {
                    commitIfChanged();
                } } }), invalid && errorMessage && (0, jsx_runtime_1.jsx)("span", { className: 'ai-config-input-error', children: errorMessage })] });
};
exports.AiTextInput = AiTextInput;
/** Keeps a value inside the preference's `minimum`/`maximum`, either of which may be absent. */
function clampNumber(value, min, max) {
    let result = value;
    if (min !== undefined) {
        result = Math.max(min, result);
    }
    if (max !== undefined) {
        result = Math.min(max, result);
    }
    return result;
}
/** A `− value +` numeric stepper. Commits on blur/Enter (typing) and immediately on the buttons. */
const AiNumberStepper = ({ value, ariaLabel, integer, min, max, disabled, onCommit }) => {
    const [draft, setDraft] = React.useState(String(value));
    React.useEffect(() => setDraft(String(value)), [value]);
    const commitDraft = () => {
        const parsed = Number(draft);
        const rounded = integer ? Math.round(parsed) : parsed;
        const next = clampNumber(Number.isNaN(parsed) ? value : rounded, min, max);
        setDraft(String(next));
        if (next !== value) {
            onCommit(next);
        }
    };
    const step = (delta) => {
        const next = clampNumber(value + delta, min, max);
        if (next !== value) {
            onCommit(next);
        }
    };
    return (0, jsx_runtime_1.jsx)("span", { className: 'ai-config-stepper-wrap', children: (0, jsx_runtime_1.jsxs)("span", { className: 'ai-config-stepper', children: [(0, jsx_runtime_1.jsx)("button", { type: 'button', className: 'ai-config-stepper-button', "aria-label": core_1.nls.localize('theia/ai/core/aiConfiguration/decrease', 'Decrease'), disabled: disabled || (min !== undefined && value <= min), onClick: () => step(-1), children: "\u2212" }), (0, jsx_runtime_1.jsx)("input", { className: 'ai-config-stepper-input', inputMode: 'numeric', "aria-label": ariaLabel, value: draft, disabled: disabled, onChange: e => setDraft(e.target.value), onBlur: commitDraft, onKeyDown: e => { if (e.key === 'Enter') {
                        commitDraft();
                    } } }), (0, jsx_runtime_1.jsx)("button", { type: 'button', className: 'ai-config-stepper-button', "aria-label": core_1.nls.localize('theia/ai/core/aiConfiguration/increase', 'Increase'), disabled: disabled || (max !== undefined && value >= max), onClick: () => step(1), children: "+" })] }) });
};
exports.AiNumberStepper = AiNumberStepper;
/**
 * A `string[]` editor mirroring the Settings UI array input: each value is a list row with a hover-revealed
 * remove button, and a final "Add Value…" input (Enter or the + button appends). It reuses the Settings UI's
 * DOM shape and class names (styled by our own `.ai-config-array` rules) so it looks identical, without
 * depending on the preferences package's DI-bound renderer. Values commit immediately on add/remove.
 */
const AiArrayInput = ({ values, ariaLabel, addPlaceholder, disabled, validate, onChange }) => {
    const [draft, setDraft] = React.useState('');
    const [error, setError] = React.useState(undefined);
    const addItem = () => {
        const entry = draft.trim();
        if (!entry) {
            setDraft('');
            setError(undefined);
            return;
        }
        const rejection = validate?.(entry);
        if (rejection) {
            // Keep the text so the user can correct it rather than retype it.
            setError(rejection);
            return;
        }
        setError(undefined);
        if (!values.includes(entry)) {
            onChange([...values, entry]);
        }
        setDraft('');
    };
    const removeAt = (index) => onChange(values.filter((_, itemIndex) => itemIndex !== index));
    return (0, jsx_runtime_1.jsxs)("ul", { className: 'preference-array ai-config-array', children: [values.map((value, index) => ((0, jsx_runtime_1.jsxs)("li", { className: 'preference-array-element', children: [(0, jsx_runtime_1.jsx)("span", { className: 'preference-array-element-val', children: value }), (0, jsx_runtime_1.jsx)("span", { className: 'preference-array-element-btn remove-btn', role: 'button', tabIndex: 0, title: core_1.nls.localizeByDefault('Remove'), onClick: () => { if (!disabled) {
                            removeAt(index);
                        } }, children: (0, jsx_runtime_1.jsx)("i", { className: (0, browser_1.codicon)('close') }) })] }, `${value}-${index}`))), (0, jsx_runtime_1.jsxs)("li", { className: 'ai-config-array-input-row', children: [(0, jsx_runtime_1.jsx)("input", { className: 'preference-array-input theia-input', type: 'text', "aria-label": ariaLabel, placeholder: addPlaceholder, spellCheck: false, value: draft, disabled: disabled, onChange: e => { setDraft(e.target.value); setError(undefined); }, onKeyDown: e => { if (e.key === 'Enter') {
                            e.preventDefault();
                            addItem();
                        } } }), (0, jsx_runtime_1.jsx)("span", { className: `preference-array-element-btn ${(0, browser_1.codicon)('add')}`, role: 'button', tabIndex: 0, title: core_1.nls.localizeByDefault('Add'), onClick: () => { if (!disabled) {
                            addItem();
                        } } })] }), error && (0, jsx_runtime_1.jsx)("li", { className: 'ai-config-array-error', children: (0, jsx_runtime_1.jsx)("span", { className: 'ai-config-input-error', children: error }) })] });
};
exports.AiArrayInput = AiArrayInput;
/** A monospace path input plus a "Browse…" button that delegates folder selection to `onBrowse`. */
const AiPathInput = ({ value, placeholder, browseLabel, disabled, onCommit, onBrowse }) => {
    const [draft, setDraft] = React.useState(value);
    React.useEffect(() => setDraft(value), [value]);
    const commitDraft = () => {
        if (draft !== value) {
            onCommit(draft);
        }
    };
    const browse = () => {
        onBrowse().then(picked => {
            if (picked !== undefined) {
                setDraft(picked);
                onCommit(picked);
            }
        });
    };
    return (0, jsx_runtime_1.jsxs)("div", { className: 'ai-config-path-row', children: [(0, jsx_runtime_1.jsx)("input", { className: 'theia-input ai-config-input ai-config-input-mono', type: 'text', value: draft, placeholder: placeholder, disabled: disabled, onChange: e => setDraft(e.target.value), onBlur: commitDraft, onKeyDown: e => { if (e.key === 'Enter') {
                    commitDraft();
                } } }), (0, jsx_runtime_1.jsx)("button", { type: 'button', className: 'theia-button secondary', disabled: disabled, onClick: browse, children: browseLabel })] });
};
exports.AiPathInput = AiPathInput;
/**
 * A button that hands editing off to the `settings.json` file. Used for preferences whose value is a
 * complex object (or array of objects) that cannot be edited meaningfully through an inline control;
 * clicking it opens `settings.json` focused on the preference, mirroring the Settings view's
 * "Edit in settings.json" link.
 */
const AiEditInSettingsButton = ({ label, ariaLabel, disabled, onClick }) => ((0, jsx_runtime_1.jsxs)("button", { type: 'button', className: 'theia-button secondary ai-config-edit-in-settings', "aria-label": ariaLabel, disabled: disabled, onClick: onClick, children: [(0, jsx_runtime_1.jsx)("span", { className: (0, browser_1.codicon)('edit') }), label] }));
exports.AiEditInSettingsButton = AiEditInSettingsButton;
/**
 * A theme-styled select over a fixed set of options, backed by the shared {@link SelectComponent} so
 * that each option can surface its own description (which native `<option>` cannot) and the control
 * matches the Settings UI. Commits the selected value via `onCommit`.
 */
const AiEnumSelect = ({ value, options, className, disabled, invalid, onCommit }) => {
    // `title` becomes the per-option `description` shown by SelectComponent's dropdown.
    const selectOptions = React.useMemo(() => options.map(option => ({
        value: option.value,
        label: option.label,
        description: option.title,
        disabled: option.disabled,
        separator: option.separator
    })), [options]);
    const handleChange = React.useCallback((option) => {
        // SelectComponent has no whole-control `disabled`; guard the commit so a disabled select never writes.
        if (!disabled && option.value !== undefined) {
            onCommit(option.value);
        }
    }, [disabled, onCommit]);
    const componentClassName = `ai-config-select${invalid ? ' error' : ''}${disabled ? ' disabled' : ''}${className ? ' ' + className : ''}`;
    return (0, jsx_runtime_1.jsx)(select_component_1.SelectComponent, { options: selectOptions, defaultValue: value, onChange: handleChange, className: componentClassName });
};
exports.AiEnumSelect = AiEnumSelect;
/**
 * A plain numeric input for a session-limit preference. Any special sentinel values (e.g. -1 = unlimited,
 * 0 = don't persist) can be entered directly, instead of being hidden behind a separate
 * "Limited / Unlimited / …" dropdown; the preference description explains what they mean.
 */
const AiSessionLimitControl = ({ value, limitedMin, limitedMax, specials, ariaLabel, disabled, onCommit }) => {
    // Special sentinel values sit below the "limited" minimum, so the input has to allow entering them.
    const min = specials.reduce((smallest, special) => Math.min(smallest, special.value), limitedMin);
    return (0, jsx_runtime_1.jsx)(exports.AiNumberStepper, { value: value, ariaLabel: ariaLabel, 
        // A session limit is a count, so it stays a whole number even though the stepper allows fractions.
        integer: true, min: min, max: limitedMax, disabled: disabled, onCommit: onCommit });
};
exports.AiSessionLimitControl = AiSessionLimitControl;
//# sourceMappingURL=ai-configuration-controls.js.map