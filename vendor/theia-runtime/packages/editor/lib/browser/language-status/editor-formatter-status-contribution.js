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
var EditorFormatterStatusContribution_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditorFormatterStatusContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const core_1 = require("@theia/core");
const severity_1 = require("@theia/core/lib/common/severity");
const editor_formatter_service_1 = require("../editor-formatter-service");
const SCOPE_DISPLAY_MAP = {
    user: () => ({
        icon: '$(account)',
        text: core_1.nls.localizeByDefault('User Settings')
    }),
    workspace: () => ({
        icon: '$(folder)',
        text: core_1.nls.localizeByDefault('Workspace Settings')
    }),
    folder: () => ({
        icon: '$(folder-opened)',
        text: core_1.nls.localizeByDefault('Folder Settings')
    }),
    auto: () => ({
        icon: '$(check)',
        text: core_1.nls.localize('theia/editor/onlyAvailableFormatter', 'Only Available Formatter')
    }),
    none: () => ({
        icon: '$(question)',
        text: core_1.nls.localizeByDefault('Unknown')
    })
};
function getScopeDisplayInfo(scope) {
    return SCOPE_DISPLAY_MAP[scope]();
}
/**
 * Handles formatter-related status bar functionality.
 * Responsible for creating formatter status items, displaying formatter quick picks,
 * and managing pinned formatter items in the status bar.
 */
let EditorFormatterStatusContribution = class EditorFormatterStatusContribution {
    static { EditorFormatterStatusContribution_1 = this; }
    static { this.FORMATTER_STATUS_ITEM_ID = 'editor-formatter-status'; }
    /**
     * Creates a language status item for the formatter.
     * Returns undefined if no formatter service is available.
     */
    createFormatterStatusItem(editor) {
        if (!this.formatterService) {
            return undefined;
        }
        const displayInfo = this.getFormatterDisplayInfo(editor);
        return {
            id: EditorFormatterStatusContribution_1.FORMATTER_STATUS_ITEM_ID,
            name: core_1.nls.localize('theia/editor/formatter', 'Formatter'),
            selector: { language: editor.document.languageId },
            severity: displayInfo.severity,
            label: displayInfo.label,
            detail: '',
            busy: false,
            source: 'theia',
            command: {
                id: EditorFormatterStatusContribution_1.FORMATTER_STATUS_ITEM_ID,
                title: '',
                tooltip: displayInfo.tooltip
            },
            accessibilityInfo: undefined
        };
    }
    /**
     * Gets the tooltip text for the formatter status item.
     */
    getTooltip(editor) {
        if (!this.formatterService) {
            return '';
        }
        const displayInfo = this.getFormatterDisplayInfo(editor);
        return displayInfo.tooltip;
    }
    /**
     * Creates a status bar entry for a pinned formatter item.
     * Includes proper tooltip and icon.
     */
    createPinnedStatusBarEntry(editor, onclick) {
        if (!this.formatterService || !editor) {
            return {
                text: `${"$(warning)" /* FormatterIcon.Warning */} ${core_1.nls.localize('theia/editor/formatter', 'Formatter')}`,
                tooltip: core_1.nls.localize('theia/editor/noEditor', 'No editor active'),
                affinity: { id: 'editor-status-language', alignment: browser_1.StatusBarAlignment.RIGHT, compact: false },
                alignment: browser_1.StatusBarAlignment.RIGHT,
                onclick,
            };
        }
        const displayInfo = this.getFormatterDisplayInfo(editor, true);
        return {
            text: `${displayInfo.icon} ${displayInfo.label}`,
            tooltip: displayInfo.tooltip,
            affinity: { id: 'editor-status-language', alignment: browser_1.StatusBarAlignment.RIGHT, compact: false },
            alignment: browser_1.StatusBarAlignment.RIGHT,
            onclick,
        };
    }
    /**
     * Shows the formatter selection quick pick dialog.
     */
    async showFormatterQuickPick(editor) {
        if (!this.formatterService || !this.quickInputService) {
            return;
        }
        const formatters = this.formatterService.getAvailableFormatters(editor);
        if (formatters.length === 0) {
            await this.quickInputService.showQuickPick([{ label: core_1.nls.localize('theia/editor/noFormattersAvailable', 'No formatters available for this language') }], { placeholder: core_1.nls.localize('theia/editor/selectFormatter', 'Select Default Formatter') });
            return;
        }
        const selectedFormatter = await this.showFormatterSelectionPick(editor, formatters);
        if (selectedFormatter === undefined) {
            return;
        }
        const targetScope = await this.determineTargetScope(editor);
        if (targetScope === undefined) {
            return;
        }
        const formatterId = selectedFormatter.id === '' ? undefined : selectedFormatter.id;
        await this.formatterService.setDefaultFormatter(editor, formatterId, targetScope);
    }
    /**
     * Returns true if the formatter service is available.
     */
    isAvailable() {
        return this.formatterService !== undefined;
    }
    /**
     * Returns true if the configure action should be available for the given editor.
     * Configure is available when there are multiple formatters or an invalid configuration.
     */
    hasConfigureAction(editor) {
        if (!this.formatterService) {
            return false;
        }
        const displayInfo = this.getFormatterDisplayInfo(editor);
        return displayInfo.hasConfigureAction;
    }
    /**
     * Gets the formatter display info for the given editor.
     * Caches the status to avoid repeated service calls.
     */
    getFormatterDisplayInfo(editor, useShortLabel = false) {
        const status = this.formatterService.getFormatterStatus(editor);
        const availableFormatters = this.formatterService.getAvailableFormatters(editor);
        return this.buildDisplayInfo(status, availableFormatters, useShortLabel);
    }
    /**
     * Builds display info based on the current formatter state.
     * @param status The formatter status
     * @param availableFormatters List of available formatters
     * @param useShortLabel If true, uses shorter labels suitable for status bar
     */
    buildDisplayInfo(status, availableFormatters, useShortLabel = false) {
        const formatterCount = availableFormatters.length;
        if (formatterCount === 0) {
            return this.buildNoFormattersDisplayInfo(status, useShortLabel);
        }
        if (formatterCount === 1) {
            return this.buildSingleFormatterDisplayInfo(status, availableFormatters[0]);
        }
        return this.buildMultipleFormattersDisplayInfo(status, formatterCount);
    }
    buildNoFormattersDisplayInfo(status, useShortLabel = false) {
        const label = useShortLabel
            ? core_1.nls.localize('theia/editor/noFormatter', 'No Formatter')
            : core_1.nls.localize('theia/editor/noFormatterInstalled', 'No Formatter installed');
        if (status.configuredFormatterId) {
            const scopeInfo = getScopeDisplayInfo(status.scope);
            return {
                icon: "$(error)" /* FormatterIcon.Error */,
                label,
                tooltip: core_1.nls.localize('theia/editor/configuredNotInstalled', "'{0}' configured in {1} but not installed", status.configuredFormatterId, scopeInfo.text),
                hasConfigureAction: false,
                severity: severity_1.Severity.Error
            };
        }
        return {
            icon: "$(info)" /* FormatterIcon.Info */,
            label,
            tooltip: core_1.nls.localize('theia/editor/noFormattersInstalledTooltip', 'No formatters are installed for this language.'),
            hasConfigureAction: false,
            severity: severity_1.Severity.Info
        };
    }
    buildSingleFormatterDisplayInfo(status, formatter) {
        // Invalid config but we have a fallback
        if (status.isInvalid && status.configuredFormatterId) {
            const scopeInfo = getScopeDisplayInfo(status.scope);
            return {
                icon: "$(warning)" /* FormatterIcon.Warning */,
                label: formatter.displayName,
                tooltip: core_1.nls.localize('theia/editor/configuredNotInstalledFallbackNamed', "'{0}' configured in {1} not installed, using '{2}'", status.configuredFormatterId, scopeInfo.text, formatter.displayName),
                hasConfigureAction: true,
                severity: severity_1.Severity.Warning
            };
        }
        // Normal case - auto-selected single formatter
        return {
            icon: "$(info)" /* FormatterIcon.Info */,
            label: formatter.displayName,
            tooltip: core_1.nls.localize('theia/editor/onlyFormatterInstalled', '{0} (only formatter installed)', formatter.displayName),
            hasConfigureAction: false,
            severity: severity_1.Severity.Info
        };
    }
    buildMultipleFormattersDisplayInfo(status, formatterCount) {
        // Invalid config - configured formatter not installed
        if (status.isInvalid && status.configuredFormatterId) {
            const scopeInfo = getScopeDisplayInfo(status.scope);
            return {
                icon: "$(error)" /* FormatterIcon.Error */,
                label: status.configuredFormatterId,
                tooltip: core_1.nls.localize('theia/editor/configuredNotInstalled', "'{0}' configured in {1} but not installed", status.configuredFormatterId, scopeInfo.text),
                hasConfigureAction: true,
                severity: severity_1.Severity.Error
            };
        }
        // Configured formatter
        if (status.formatter) {
            const scopeInfo = getScopeDisplayInfo(status.scope);
            return {
                icon: "$(info)" /* FormatterIcon.Info */,
                label: status.formatter.displayName,
                tooltip: core_1.nls.localize('theia/editor/configuredIn', 'Configured in {0}', scopeInfo.text),
                hasConfigureAction: true,
                severity: severity_1.Severity.Info
            };
        }
        // No formatter configured
        return {
            icon: "$(info)" /* FormatterIcon.Info */,
            label: core_1.nls.localize('theia/editor/noDefaultConfiguredLabel', 'No default formatter configured'),
            tooltip: core_1.nls.localize('theia/editor/noDefaultConfiguredTooltip', 'No default formatter configured ({0} formatters available)', formatterCount),
            hasConfigureAction: true,
            severity: severity_1.Severity.Info
        };
    }
    async showFormatterSelectionPick(editor, formatters) {
        if (!this.formatterService || !this.quickInputService) {
            return undefined;
        }
        const status = this.formatterService.getFormatterStatus(editor);
        const currentFormatterId = status.formatter?.id;
        const currentLabel = core_1.nls.localize('theia/editor/currentFormatter', '(Current)');
        const formatterItems = formatters.map(formatter => ({
            label: formatter.displayName,
            description: formatter.id === currentFormatterId ? currentLabel : undefined,
            detail: formatter.id,
            id: formatter.id
        }));
        const noneItem = {
            label: core_1.nls.localizeByDefault('None'),
            description: !currentFormatterId ? currentLabel : undefined,
            detail: core_1.nls.localize('theia/editor/clearFormatterSetting', 'Clear formatter setting'),
            id: ''
        };
        return this.quickInputService.showQuickPick([noneItem, ...formatterItems], { placeholder: core_1.nls.localize('theia/editor/selectFormatter', 'Select Default Formatter') });
    }
    async determineTargetScope(editor) {
        if (!this.formatterService) {
            return undefined;
        }
        const currentScope = this.formatterService.getConfiguredScope(editor);
        if (currentScope === core_1.PreferenceScope.Folder || currentScope === core_1.PreferenceScope.Workspace) {
            return currentScope;
        }
        return this.showScopeSelectionPick();
    }
    async showScopeSelectionPick() {
        if (!this.quickInputService) {
            return undefined;
        }
        const userScopeInfo = getScopeDisplayInfo('user');
        const workspaceScopeInfo = getScopeDisplayInfo('workspace');
        const scopeItems = [
            {
                label: `${userScopeInfo.icon} ${userScopeInfo.text}`,
                detail: core_1.nls.localize('theia/editor/userSettingsDetail', 'Apply to all workspaces'),
                value: core_1.PreferenceScope.User
            },
            {
                label: `${workspaceScopeInfo.icon} ${workspaceScopeInfo.text}`,
                detail: core_1.nls.localize('theia/editor/workspaceSettingsDetail', 'Apply to current workspace only'),
                value: core_1.PreferenceScope.Workspace
            }
        ];
        const result = await this.quickInputService.showQuickPick(scopeItems, { placeholder: core_1.nls.localize('theia/editor/selectScope', 'Select where to save the setting') });
        return result?.value;
    }
};
exports.EditorFormatterStatusContribution = EditorFormatterStatusContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(editor_formatter_service_1.FormatterService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], EditorFormatterStatusContribution.prototype, "formatterService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.QuickInputService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], EditorFormatterStatusContribution.prototype, "quickInputService", void 0);
exports.EditorFormatterStatusContribution = EditorFormatterStatusContribution = EditorFormatterStatusContribution_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], EditorFormatterStatusContribution);
//# sourceMappingURL=editor-formatter-status-contribution.js.map