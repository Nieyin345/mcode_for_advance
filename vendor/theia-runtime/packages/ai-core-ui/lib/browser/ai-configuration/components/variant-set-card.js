"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VariantSetCard = void 0;
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
const browser_1 = require("@theia/core/lib/browser");
const React = require("@theia/core/shared/react");
const prompt_service_1 = require("@theia/ai-core/lib/common/prompt-service");
const ai_configuration_item_row_1 = require("./ai-configuration-item-row");
const ai_configuration_primitives_1 = require("./ai-configuration-primitives");
const ai_configuration_controls_1 = require("./ai-configuration-controls");
const prompt_customization_dialogs_1 = require("./prompt-customization-dialogs");
/**
 * The reusable prompt-variant-set component rendered inside an agent's detail page: a single list row per
 * variant set, showing the set id, a select that picks the variant this agent uses (with `(default)` and
 * `[edited]` markers), an edit action to customize the selected variant, and a reset action that reverts a
 * customized variant to built-in. The agent detail is the single source of truth for prompt variant sets.
 */
const VariantSetCard = ({ agentId, promptVariantSetId, promptService, settingsRowService, variantLabels }) => {
    const variantIds = promptService.getVariantIds(promptVariantSetId);
    const defaultVariantId = promptService.getDefaultVariantId(promptVariantSetId);
    const [selectedVariantId, setSelectedVariantId] = React.useState(promptService.getSelectedVariantId(promptVariantSetId) ?? defaultVariantId);
    React.useEffect(() => {
        setSelectedVariantId(promptService.getSelectedVariantId(promptVariantSetId) ?? defaultVariantId);
        const disposable = promptService.onSelectedVariantChange(notification => {
            if (notification.promptVariantSetId === promptVariantSetId) {
                setSelectedVariantId(notification.variantId ?? defaultVariantId);
            }
        });
        return () => disposable.dispose();
    }, [promptVariantSetId, defaultVariantId, promptService]);
    const selected = selectedVariantId && variantIds.includes(selectedVariantId)
        ? selectedVariantId
        : defaultVariantId ?? variantIds[0];
    if (!selected) {
        return (0, jsx_runtime_1.jsx)(ai_configuration_item_row_1.AiConfigurationItemRow, { label: promptVariantSetId, description: core_1.nls.localize('theia/ai/core/promptFragmentsConfiguration/variantSetError', 'The selected variant does not exist and no default could be found. Please check your configuration.'), status: { kind: 'error', label: core_1.nls.localizeByDefault('Error') } });
    }
    const isVariantCustomized = (variantId) => {
        const fragment = promptService.getRawPromptFragment(variantId);
        return fragment ? (0, prompt_service_1.isCustomizedPromptFragment)(fragment) : false;
    };
    const variantName = (variantId) => variantLabels?.[variantId] ?? promptService.getRawPromptFragment(variantId)?.name ?? variantId;
    const selectVariant = (variantId) => {
        promptService.updateSelectedVariantId(agentId, promptVariantSetId, variantId);
    };
    const customize = (variantId) => {
        const fragment = promptService.getRawPromptFragment(variantId);
        if (fragment && (0, prompt_service_1.isCustomizedPromptFragment)(fragment)) {
            promptService.editCustomization(fragment.id, fragment.customizationId);
        }
        else {
            promptService.createBuiltInCustomization(variantId);
        }
    };
    const resetVariant = async (variantId) => {
        await prompt_customization_dialogs_1.PromptCustomizationDialogs.confirmAndReset(promptService, variantId, core_1.nls.localize('theia/ai/core/promptFragmentsConfiguration/resetToBuiltInDialogTitle', 'Reset to Built-in'), core_1.nls.localize('theia/ai/core/promptFragmentsConfiguration/resetToBuiltInDialogMsg', 'Are you sure you want to reset the prompt fragment "{0}" to its built-in version? This will remove all customizations.', variantId));
    };
    /**
     * A variant that exists only as a user file — a custom prompt template, which becomes a variant of this
     * set through its id prefix — has no built-in to fall back to, so it is deleted rather than reset. The
     * dialog names the file, since this removes it from disk.
     */
    const removeVariant = async (variantId) => {
        const removed = await prompt_customization_dialogs_1.PromptCustomizationDialogs.confirmAndRemove(promptService, variantId, {
            title: core_1.nls.localize('theia/ai/core/promptFragmentsConfiguration/removePromptTemplateDialogTitle', 'Remove Prompt Template'),
            message: ({ type, description }) => description
                ? core_1.nls.localize('theia/ai/core/promptFragmentsConfiguration/removePromptTemplateWithDescDialogMsg', 'Are you sure you want to remove the {0} customization for prompt template "{1}" ({2})? It has no built-in version, so it will be gone entirely.', type ?? '', variantId, description)
                : core_1.nls.localize('theia/ai/core/promptFragmentsConfiguration/removePromptTemplateDialogMsg', 'Are you sure you want to remove the {0} customization for prompt template "{1}"? It has no built-in version, so it will be gone entirely.', type ?? '', variantId)
        });
        // The agent still points at the template we just deleted, which would show up as an unavailable
        // selection. Selecting the default drops the stored selection, so the set is simply back to default.
        if (removed && defaultVariantId && promptService.getSelectedVariantId(promptVariantSetId) === variantId) {
            await promptService.updateSelectedVariantId(agentId, promptVariantSetId, defaultVariantId);
            setSelectedVariantId(defaultVariantId);
        }
    };
    const explicitSelection = promptService.getSelectedVariantId(promptVariantSetId);
    const invalidSelection = explicitSelection !== undefined && !variantIds.includes(explicitSelection);
    const selectedCustomized = isVariantCustomized(selected);
    // Without a built-in, `PromptService.resetToBuiltIn` is a no-op by design, so the action must delete.
    const selectedHasBuiltIn = prompt_customization_dialogs_1.PromptCustomizationDialogs.hasBuiltIn(promptService, selected);
    // The agent's selection deviates from the built-in default; the gear "Reset Setting" reverts it. (A
    // customized variant is a separate, global edit, surfaced by the `[edited]` marker and the reset icon.)
    const modified = defaultVariantId !== undefined && selected !== defaultVariantId;
    const variantCountLabel = variantIds.length === 1
        ? core_1.nls.localize('theia/ai/core/variantSet/variantCountSingular', '1 variant')
        : core_1.nls.localize('theia/ai/core/variantSet/variantCount', '{0} variants', variantIds.length);
    // Each option shows the variant name plus `(default)`/`[edited]` markers, so the collapsed select surfaces
    // the selected variant's state and the dropdown reveals which variants are customized.
    const options = variantIds.map(variantId => {
        const markers = [variantName(variantId)];
        if (variantId === defaultVariantId) {
            markers.push(`(${core_1.nls.localizeByDefault('Default')})`);
        }
        if (isVariantCustomized(variantId)) {
            markers.push(`[${core_1.nls.localize('theia/ai/chat-ui/edited', 'edited')}]`);
        }
        return { value: variantId, label: markers.join(' ') };
    });
    // A selection pointing at a template that no longer exists stays visible as a disabled, red "Unavailable"
    // entry instead of quietly showing the default: the effective prompt *is* the default, but silently
    // displaying it would hide that the agent's own selection is broken and needs a new pick.
    if (invalidSelection) {
        options.unshift({
            value: explicitSelection,
            label: core_1.nls.localize('theia/ai/core/variantSet/unavailableVariant', '{0} (unavailable)', explicitSelection),
            disabled: true
        });
    }
    const editLabel = core_1.nls.localize('theia/ai/core/promptFragmentsConfiguration/editPromptTemplate', 'Edit prompt template');
    const resetLabel = selectedHasBuiltIn
        ? core_1.nls.localize('theia/ai/core/promptFragmentsConfiguration/resetPromptTemplate', 'Reset prompt template')
        : core_1.nls.localize('theia/ai/core/promptFragmentsConfiguration/removePromptTemplate', 'Remove prompt template');
    return (0, jsx_runtime_1.jsx)(ai_configuration_item_row_1.AiConfigurationItemRow, { label: promptVariantSetId, description: variantCountLabel, modified: modified, onOpenMenu: modified && defaultVariantId
            ? gear => settingsRowService.openResetMenu(gear, () => selectVariant(defaultVariantId))
            : undefined, trailing: (0, jsx_runtime_1.jsxs)("div", { className: 'ai-variant-controls', children: [(0, jsx_runtime_1.jsx)(ai_configuration_controls_1.AiEnumSelect, { value: invalidSelection ? explicitSelection : selected, ariaLabel: core_1.nls.localizeByDefault('Template'), options: options, invalid: invalidSelection, onCommit: selectVariant }), (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationIconButton, { iconClass: (0, browser_1.codicon)('edit'), title: editLabel, onClick: () => customize(selected) }), selectedCustomized && (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationIconButton, { iconClass: (0, browser_1.codicon)(selectedHasBuiltIn ? 'discard' : 'trash'), title: resetLabel, onClick: () => selectedHasBuiltIn ? resetVariant(selected) : removeVariant(selected) })] }) });
};
exports.VariantSetCard = VariantSetCard;
//# sourceMappingURL=variant-set-card.js.map