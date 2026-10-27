"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
var QuickFileOpenService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuickFileOpenService = exports.quickFileOpen = void 0;
const tslib_1 = require("tslib");
const browser_1 = require("@theia/core/lib/browser");
const quick_input_service_1 = require("@theia/core/lib/browser/quick-input/quick-input-service");
const common_1 = require("@theia/core/lib/common");
const message_service_1 = require("@theia/core/lib/common/message-service");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_2 = require("@theia/editor/lib/browser");
const navigation_location_service_1 = require("@theia/editor/lib/browser/navigation/navigation-location-service");
const workspace_service_1 = require("@theia/workspace/lib/browser/workspace-service");
const quick_file_select_service_1 = require("./quick-file-select-service");
exports.quickFileOpen = common_1.Command.toDefaultLocalizedCommand({
    id: 'file-search.openFile',
    category: browser_1.CommonCommands.FILE_CATEGORY,
    label: 'Open File...'
});
// Supports patterns of <path><#|:><line><#|:|,><col?>
const LINE_COLON_PATTERN = /\s?[#:\(](?:line )?(\d*)(?:[#:,](\d*))?\)?\s*$/;
let QuickFileOpenService = class QuickFileOpenService {
    constructor() {
        /**
         * Whether to hide .gitignored (and other ignored) files.
         */
        this.hideIgnoredFiles = true;
        /**
         * Whether the dialog is currently open.
         */
        this.isOpen = false;
        this.updateIsOpen = true;
        this.filterAndRangeDefault = { filter: '', range: undefined };
        /**
         * Tracks the user file search filter and location range e.g. fileFilter:line:column or fileFilter:line,column
         */
        this.filterAndRange = this.filterAndRangeDefault;
    }
    static { QuickFileOpenService_1 = this; }
    static { this.PREFIX = ''; }
    registerQuickAccessProvider() {
        this.quickAccessRegistry.registerQuickAccessProvider({
            getInstance: () => this,
            prefix: QuickFileOpenService_1.PREFIX,
            placeholder: this.getPlaceHolder(),
            helpEntries: [{ description: 'Open File', needsEditor: false }]
        });
    }
    init() {
        this.quickInputService?.onHide(() => {
            if (this.updateIsOpen) {
                this.isOpen = false;
            }
            else {
                this.updateIsOpen = true;
            }
        });
    }
    isEnabled() {
        return this.workspaceService.opened;
    }
    open() {
        // Triggering the keyboard shortcut while the dialog is open toggles
        // showing the ignored files.
        if (this.isOpen) {
            this.hideIgnoredFiles = !this.hideIgnoredFiles;
            this.hideQuickPick();
        }
        else {
            this.hideIgnoredFiles = true;
            this.filterAndRange = this.filterAndRangeDefault;
            this.isOpen = true;
        }
        this.quickInputService?.open(this.filterAndRange.filter);
    }
    hideQuickPick() {
        this.updateIsOpen = false;
        this.quickInputService?.hide();
    }
    /**
     * Get a string (suitable to show to the user) representing the keyboard
     * shortcut used to open the quick file open menu.
     */
    getKeyCommand() {
        const keyCommand = this.keybindingRegistry.getKeybindingsForCommand(exports.quickFileOpen.id);
        if (keyCommand) {
            // We only consider the first keybinding.
            const accel = this.keybindingRegistry.acceleratorFor(keyCommand[0], '+');
            return accel.join(' ');
        }
        return undefined;
    }
    async getPicks(filter, token) {
        this.filterAndRange = this.splitFilterAndRange(filter);
        const fileFilter = this.filterAndRange.filter;
        return this.quickFileSelectService.getPicks(fileFilter, token, {
            hideIgnoredFiles: this.hideIgnoredFiles,
            onSelect: item => this.openFile(item.uri)
        });
    }
    openFile(uri) {
        const options = this.buildOpenerOptions();
        const closedEditor = this.navigationLocationService.closedEditorsStack.find(editor => editor.uri.path.toString() === uri.path.toString());
        this.openerService.getOpener(uri, options)
            .then(opener => opener.open(uri, options))
            .then(widget => {
            // Attempt to restore the editor state if it exists, and no selection is explicitly requested.
            if (widget instanceof browser_2.EditorWidget && closedEditor && !options.selection) {
                widget.editor.restoreViewState(closedEditor.viewState);
            }
        })
            .catch(error => {
            this.logger.warn(error);
            this.messageService.error(common_1.nls.localizeByDefault("Unable to open '{0}'", uri.path.toString()));
        });
    }
    buildOpenerOptions() {
        return { selection: this.filterAndRange.range };
    }
    getPlaceHolder() {
        let placeholder = common_1.nls.localizeByDefault('Search files by name (append {0} to go to line or {1} to go to symbol)', ':', '@');
        const keybinding = this.getKeyCommand();
        if (keybinding) {
            placeholder += common_1.nls.localize('theia/file-search/toggleExcludedFiles', ' (Press {0} to show/hide excluded files)', keybinding);
        }
        return placeholder;
    }
    /**
     * Splits the given expression into a structure of search-file-filter and
     * location-range.
     *
     * @param expression patterns of <path><#|:><line><#|:|,><col?>
     */
    splitFilterAndRange(expression) {
        let filter = expression;
        let range = undefined;
        // Find line and column number from the expression using RegExp.
        const patternMatch = LINE_COLON_PATTERN.exec(expression);
        if (patternMatch) {
            const line = parseInt(patternMatch[1] ?? '', 10);
            if (Number.isFinite(line)) {
                const lineNumber = line > 0 ? line - 1 : 0;
                const column = parseInt(patternMatch[2] ?? '', 10);
                const startColumn = Number.isFinite(column) && column > 0 ? column - 1 : 0;
                const position = browser_2.Position.create(lineNumber, startColumn);
                filter = expression.substring(0, patternMatch.index);
                range = browser_2.Range.create(position, position);
            }
        }
        return { filter, range };
    }
};
exports.QuickFileOpenService = QuickFileOpenService;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.KeybindingRegistry),
    tslib_1.__metadata("design:type", browser_1.KeybindingRegistry)
], QuickFileOpenService.prototype, "keybindingRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_service_1.WorkspaceService),
    tslib_1.__metadata("design:type", workspace_service_1.WorkspaceService)
], QuickFileOpenService.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], QuickFileOpenService.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(quick_input_service_1.QuickInputService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], QuickFileOpenService.prototype, "quickInputService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.QuickAccessRegistry),
    tslib_1.__metadata("design:type", Object)
], QuickFileOpenService.prototype, "quickAccessRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(navigation_location_service_1.NavigationLocationService),
    tslib_1.__metadata("design:type", navigation_location_service_1.NavigationLocationService)
], QuickFileOpenService.prototype, "navigationLocationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(message_service_1.MessageService),
    tslib_1.__metadata("design:type", message_service_1.MessageService)
], QuickFileOpenService.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(quick_file_select_service_1.QuickFileSelectService),
    tslib_1.__metadata("design:type", quick_file_select_service_1.QuickFileSelectService)
], QuickFileOpenService.prototype, "quickFileSelectService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ILogger),
    (0, inversify_1.named)('file-search:QuickFileOpenService'),
    tslib_1.__metadata("design:type", Object)
], QuickFileOpenService.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], QuickFileOpenService.prototype, "init", null);
exports.QuickFileOpenService = QuickFileOpenService = QuickFileOpenService_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], QuickFileOpenService);
//# sourceMappingURL=quick-file-open.js.map