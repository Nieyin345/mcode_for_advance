"use strict";
// *****************************************************************************
// Copyright (C) 2022 Ericsson and others.
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
var EditorLanguageStatusService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditorLanguageStatusService = exports.LanguageStatusSeverity = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const language_service_1 = require("@theia/core/lib/browser/language-service");
const core_1 = require("@theia/core");
const editor_command_1 = require("../editor-command");
const language_selector_1 = require("../../common/language-selector");
const uri_1 = require("@theia/core/lib/common/uri");
const editor_manager_1 = require("../editor-manager");
const severity_1 = require("@theia/core/lib/common/severity");
const label_parser_1 = require("@theia/core/lib/browser/label-parser");
const editor_formatter_service_1 = require("../editor-formatter-service");
const editor_formatter_status_contribution_1 = require("./editor-formatter-status-contribution");
/**
 * Represents the severity of a language status item.
 */
var LanguageStatusSeverity;
(function (LanguageStatusSeverity) {
    LanguageStatusSeverity[LanguageStatusSeverity["Information"] = 0] = "Information";
    LanguageStatusSeverity[LanguageStatusSeverity["Warning"] = 1] = "Warning";
    LanguageStatusSeverity[LanguageStatusSeverity["Error"] = 2] = "Error";
})(LanguageStatusSeverity || (exports.LanguageStatusSeverity = LanguageStatusSeverity = {}));
let EditorLanguageStatusService = class EditorLanguageStatusService {
    constructor() {
        this.status = new Map();
        this.pinnedCommands = new Set();
        this.currentlyPinnedItems = new Set();
        this.toDisposeOnEditorChange = new core_1.DisposableCollection();
    }
    static { EditorLanguageStatusService_1 = this; }
    static { this.LANGUAGE_MODE_ID = 'editor-status-language'; }
    static { this.LANGUAGE_STATUS_ID = 'editor-language-status-items'; }
    setLanguageStatusItem(handle, item) {
        this.status.set(handle, item);
        this.updateLanguageStatusItems();
    }
    removeLanguageStatusItem(handle) {
        this.status.delete(handle);
        this.updateLanguageStatusItems();
    }
    updateLanguageStatus(editor) {
        this.toDisposeOnEditorChange.dispose();
        this.scheduleUpdate(editor, true);
        if (editor) {
            this.toDisposeOnEditorChange.push(editor.onLanguageChanged(() => this.scheduleUpdate(editor, false)));
            if (this.formatterService) {
                this.toDisposeOnEditorChange.push(this.formatterService.onDidChangeFormatters(() => this.scheduleUpdate(editor, false)));
            }
        }
    }
    /**
     * Schedules an update to the status bar. All updates are chained to prevent race conditions.
     * @param editor The current editor, or undefined if no editor is active
     * @param updateLanguageMode Whether to update the language mode element (only needed on editor change)
     */
    scheduleUpdate(editor, updateLanguageMode) {
        const doUpdate = async () => {
            if (updateLanguageMode) {
                await this.updateLanguageModeElement(editor);
            }
            await this.doUpdateLanguageStatusItems(editor);
        };
        if (!this.pendingUpdate) {
            this.pendingUpdate = Promise.resolve();
        }
        this.pendingUpdate = this.pendingUpdate.then(doUpdate, doUpdate);
    }
    async updateLanguageModeElement(editor) {
        if (!editor) {
            await this.statusBar.removeElement(EditorLanguageStatusService_1.LANGUAGE_MODE_ID);
            return;
        }
        const language = this.languages.getLanguage(editor.document.languageId);
        const languageName = language ? language.name : '';
        await this.statusBar.setElement(EditorLanguageStatusService_1.LANGUAGE_MODE_ID, {
            text: languageName,
            alignment: browser_1.StatusBarAlignment.RIGHT,
            priority: 1,
            command: editor_command_1.EditorCommands.CHANGE_LANGUAGE.id,
            tooltip: core_1.nls.localizeByDefault('Select Language Mode')
        });
    }
    createFormatterStatusItem(editor) {
        return this.formatterStatusContribution?.createFormatterStatusItem(editor);
    }
    /**
     * Schedules a language status items update. Called when language status items are added/removed.
     */
    updateLanguageStatusItems(editor = this.editorAccess.editor) {
        this.scheduleUpdate(editor, false);
    }
    /**
     * Performs the actual language status items update.
     */
    async doUpdateLanguageStatusItems(editor) {
        if (!editor) {
            await this.statusBar.removeElement(EditorLanguageStatusService_1.LANGUAGE_STATUS_ID);
            await this.updatePinnedItems();
            return;
        }
        const uri = new uri_1.default(editor.document.uri);
        const formatterItemId = editor_formatter_status_contribution_1.EditorFormatterStatusContribution.FORMATTER_STATUS_ITEM_ID;
        const items = Array.from(this.status.values())
            .filter(item => item.id !== formatterItemId)
            .filter(item => (0, language_selector_1.score)(item.selector, uri.scheme, uri.path.toString(), editor.document.languageId, true))
            .sort((left, right) => right.severity - left.severity);
        const formatterItem = this.createFormatterStatusItem(editor);
        const allItems = formatterItem ? [formatterItem, ...items] : items;
        if (!allItems.length) {
            await this.statusBar.removeElement(EditorLanguageStatusService_1.LANGUAGE_STATUS_ID);
            await this.updatePinnedItems();
            return;
        }
        const maxSeverity = allItems.reduce((max, item) => Math.max(max, item.severity), severity_1.Severity.Ignore);
        const severityText = maxSeverity === severity_1.Severity.Info
            ? '$(bracket)'
            : maxSeverity === severity_1.Severity.Warning
                ? '$(bracket-dot)'
                : '$(bracket-error)';
        await this.statusBar.setElement(EditorLanguageStatusService_1.LANGUAGE_STATUS_ID, {
            text: severityText,
            alignment: browser_1.StatusBarAlignment.RIGHT,
            priority: 2,
            tooltip: this.createTooltip(allItems, editor),
            affinity: { id: EditorLanguageStatusService_1.LANGUAGE_MODE_ID, alignment: browser_1.StatusBarAlignment.LEFT, compact: true },
        });
        await this.updatePinnedItems(allItems, editor);
    }
    /**
     * Updates pinned status bar items. Removes all currently pinned items first,
     * then adds back only those relevant to the current editor context.
     */
    async updatePinnedItems(items, editor) {
        for (const id of this.currentlyPinnedItems) {
            await this.statusBar.removeElement(id);
        }
        this.currentlyPinnedItems.clear();
        for (const item of items ?? []) {
            if (this.pinnedCommands.has(item.id)) {
                await this.statusBar.setElement(item.id, this.toPinnedItem(item, editor));
                this.currentlyPinnedItems.add(item.id);
            }
        }
    }
    toPinnedItem(item, editor) {
        if (this.isFormatterItem(item)) {
            return this.createFormatterPinnedItem(item, editor);
        }
        return this.createDefaultPinnedItem(item);
    }
    isFormatterItem(item) {
        return item.id === editor_formatter_status_contribution_1.EditorFormatterStatusContribution.FORMATTER_STATUS_ITEM_ID;
    }
    createFormatterPinnedItem(item, editor) {
        if (!this.formatterStatusContribution) {
            return this.createDefaultPinnedItem(item);
        }
        const currentEditor = editor ?? this.editorAccess.editor;
        return this.formatterStatusContribution.createPinnedStatusBarEntry(currentEditor, e => {
            e.preventDefault();
            if (currentEditor) {
                this.formatterStatusContribution?.showFormatterQuickPick(currentEditor);
            }
        });
    }
    createDefaultPinnedItem(item) {
        let onclick;
        if (item.command) {
            onclick = e => {
                e.preventDefault();
                this.commandRegistry.executeCommand(item.command.id, ...(item.command?.arguments ?? []));
            };
        }
        return {
            text: item.label,
            affinity: { id: EditorLanguageStatusService_1.LANGUAGE_MODE_ID, alignment: browser_1.StatusBarAlignment.RIGHT, compact: false },
            alignment: browser_1.StatusBarAlignment.RIGHT,
            onclick,
        };
    }
    createTooltip(items, editor) {
        const hoverContainer = document.createElement('div');
        hoverContainer.classList.add('hover-row');
        for (const item of items) {
            hoverContainer.appendChild(this.createTooltipItem(item, editor));
        }
        return hoverContainer;
    }
    createTooltipItem(item, editor) {
        const itemContainer = document.createElement('div');
        itemContainer.classList.add('hover-language-status');
        itemContainer.appendChild(this.createSeverityIndicator(item.severity));
        const textContainer = document.createElement('div');
        textContainer.className = 'element';
        textContainer.appendChild(this.createLabelSection(item));
        textContainer.appendChild(this.createCommandSection(item, editor));
        itemContainer.appendChild(textContainer);
        return itemContainer;
    }
    createSeverityIndicator(severity, alwaysShow = false) {
        const severityContainer = document.createElement('div');
        severityContainer.classList.add('severity', `sev${severity}`);
        severityContainer.classList.toggle('show', alwaysShow || severity === severity_1.Severity.Error || severity === severity_1.Severity.Warning);
        const severityIcon = document.createElement('span');
        severityIcon.className = this.getSeverityIconClasses(severity);
        severityContainer.appendChild(severityIcon);
        return severityContainer;
    }
    createLabelSection(item) {
        const labelContainer = document.createElement('div');
        labelContainer.className = 'left';
        const label = document.createElement('span');
        label.classList.add('label');
        const labelText = item.busy ? `$(sync~spin)\u00A0\u00A0${item.label}` : item.label;
        this.renderWithIcons(label, labelText);
        labelContainer.appendChild(label);
        const detail = document.createElement('span');
        detail.classList.add('detail');
        this.renderWithIcons(detail, item.detail);
        labelContainer.appendChild(detail);
        return labelContainer;
    }
    createCommandSection(item, editor) {
        const commandContainer = document.createElement('div');
        commandContainer.classList.add('right');
        if (this.isFormatterItem(item) && editor && this.formatterStatusContribution) {
            this.addFormatterCommands(commandContainer, item, editor);
        }
        else if (item.command) {
            commandContainer.appendChild(this.createCommandLink(item));
            commandContainer.appendChild(this.createPinButton(item, editor));
        }
        return commandContainer;
    }
    addFormatterCommands(commandContainer, item, editor) {
        const hasConfigureAction = this.formatterStatusContribution.hasConfigureAction(editor);
        if (hasConfigureAction) {
            commandContainer.appendChild(this.createFormatterConfigureButton(editor));
        }
        commandContainer.appendChild(this.createFormatterInfoButton(editor));
        commandContainer.appendChild(this.createPinButton(item, editor));
    }
    createFormatterConfigureButton(editor) {
        const link = document.createElement('a');
        link.classList.add('language-status-link');
        link.onclick = e => {
            e.preventDefault();
            this.hoverService.cancelHover();
            this.formatterStatusContribution?.showFormatterQuickPick(editor);
        };
        link.textContent = core_1.nls.localizeByDefault('Configure');
        link.title = core_1.nls.localizeByDefault('Configure Default Formatter');
        link.ariaRoleDescription = 'button';
        link.ariaDisabled = 'false';
        return link;
    }
    createFormatterInfoButton(editor) {
        const link = document.createElement('a');
        link.classList.add('language-status-link');
        link.onclick = e => {
            e.preventDefault();
            this.hoverService.cancelHover();
            const tooltip = this.formatterStatusContribution?.getTooltip(editor) ?? '';
            this.messageService.info(tooltip);
        };
        link.textContent = core_1.nls.localizeByDefault('Info');
        link.title = core_1.nls.localize('theia/editor/showFormatterInfo', 'Show Formatter Info');
        link.ariaRoleDescription = 'button';
        link.ariaDisabled = 'false';
        return link;
    }
    createCommandLink(item) {
        const command = item.command;
        const link = document.createElement('a');
        link.classList.add('language-status-link');
        link.href = new uri_1.default()
            .withScheme('command')
            .withPath(command.id)
            .withQuery(command.arguments ? encodeURIComponent(JSON.stringify(command.arguments)) : '')
            .toString(false);
        link.onclick = e => {
            e.preventDefault();
            this.commandRegistry.executeCommand(command.id, ...(command.arguments ?? []));
        };
        link.textContent = command.title ?? command.id;
        link.title = command.tooltip ?? '';
        link.ariaRoleDescription = 'button';
        link.ariaDisabled = 'false';
        return link;
    }
    createPinButton(item, editor) {
        const pinContainer = document.createElement('div');
        pinContainer.classList.add('language-status-action-bar');
        const pin = document.createElement('a');
        this.setPinProperties(pin, item.id);
        pin.onclick = e => {
            e.preventDefault();
            this.togglePinned(item, editor);
            this.setPinProperties(pin, item.id);
        };
        pinContainer.appendChild(pin);
        return pinContainer;
    }
    setPinProperties(pin, id) {
        pin.className = this.pinnedCommands.has(id) ? (0, browser_1.codicon)('pinned', true) : (0, browser_1.codicon)('pin', true);
        pin.ariaRoleDescription = 'button';
        const pinText = this.pinnedCommands.has(id)
            ? core_1.nls.localizeByDefault('Remove from Status Bar')
            : core_1.nls.localizeByDefault('Add to Status Bar');
        pin.ariaLabel = pinText;
        pin.title = pinText;
    }
    /**
     * Toggles whether a language status item is pinned to the status bar.
     */
    togglePinned(item, editor) {
        if (this.pinnedCommands.has(item.id)) {
            this.pinnedCommands.delete(item.id);
        }
        else {
            this.pinnedCommands.add(item.id);
        }
        this.updateLanguageStatusItems(editor);
    }
    getSeverityIconClasses(severity) {
        switch (severity) {
            case severity_1.Severity.Error: return (0, browser_1.codicon)('error');
            case severity_1.Severity.Warning: return (0, browser_1.codicon)('warning');
            default: return (0, browser_1.codicon)('info');
        }
    }
    renderWithIcons(host, text) {
        if (text) {
            for (const chunk of this.labelParser.parse(text)) {
                if (typeof chunk === 'string') {
                    host.append(chunk);
                }
                else {
                    const iconSpan = document.createElement('span');
                    const className = (0, browser_1.codicon)(chunk.name) + (chunk.animation ? ` fa-${chunk.animation}` : '');
                    iconSpan.className = className;
                    host.append(iconSpan);
                }
            }
        }
    }
};
exports.EditorLanguageStatusService = EditorLanguageStatusService;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.StatusBar),
    tslib_1.__metadata("design:type", Object)
], EditorLanguageStatusService.prototype, "statusBar", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(language_service_1.LanguageService),
    tslib_1.__metadata("design:type", language_service_1.LanguageService)
], EditorLanguageStatusService.prototype, "languages", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(editor_manager_1.CurrentEditorAccess),
    tslib_1.__metadata("design:type", editor_manager_1.CurrentEditorAccess)
], EditorLanguageStatusService.prototype, "editorAccess", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.CommandRegistry),
    tslib_1.__metadata("design:type", core_1.CommandRegistry)
], EditorLanguageStatusService.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(label_parser_1.LabelParser),
    tslib_1.__metadata("design:type", label_parser_1.LabelParser)
], EditorLanguageStatusService.prototype, "labelParser", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(editor_formatter_service_1.FormatterService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], EditorLanguageStatusService.prototype, "formatterService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(editor_formatter_status_contribution_1.EditorFormatterStatusContribution),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], EditorLanguageStatusService.prototype, "formatterStatusContribution", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], EditorLanguageStatusService.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.HoverService),
    tslib_1.__metadata("design:type", browser_1.HoverService)
], EditorLanguageStatusService.prototype, "hoverService", void 0);
exports.EditorLanguageStatusService = EditorLanguageStatusService = EditorLanguageStatusService_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], EditorLanguageStatusService);
//# sourceMappingURL=editor-language-status-service.js.map