"use strict";
// *****************************************************************************
// Copyright (C) 2021 SAP SE or an SAP affiliate company and others.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MonacoQuickPickItem = exports.MonacoQuickInputService = exports.MonacoQuickInputImplementation = void 0;
const tslib_1 = require("tslib");
const browser_1 = require("@theia/core/lib/browser");
const inversify_1 = require("@theia/core/shared/inversify");
const quickInputController_1 = require("@theia/monaco-editor-core/esm/vs/platform/quickinput/browser/quickInputController");
const monaco_resolved_keybinding_1 = require("./monaco-resolved-keybinding");
const quickAccess_1 = require("@theia/monaco-editor-core/esm/vs/platform/quickinput/browser/quickAccess");
const contextkey_1 = require("@theia/monaco-editor-core/esm/vs/platform/contextkey/common/contextkey");
const instantiation_1 = require("@theia/monaco-editor-core/esm/vs/platform/instantiation/common/instantiation");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const core_1 = require("@theia/core");
const monaco_color_registry_1 = require("./monaco-color-registry");
const theming_1 = require("@theia/core/lib/browser/theming");
const standaloneTheme_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/common/standaloneTheme");
const layoutService_1 = require("@theia/monaco-editor-core/esm/vs/platform/layout/browser/layoutService");
const severity_1 = require("@theia/monaco-editor-core/esm/vs/base/common/severity");
const severity_2 = require("@theia/core/lib/common/severity");
const storage_1 = require("@theia/monaco-editor-core/esm/vs/platform/storage/common/storage");
const contextView_1 = require("@theia/monaco-editor-core/esm/vs/platform/contextview/browser/contextView");
/**
 * Converts Theia's {@link Severity} to Monaco's {@link MonacoSeverity}.
 *
 * These enums have different numeric values for Error and Info:
 * - Theia: Ignore=0, Error=1, Warning=2, Info=3
 * - Monaco: Ignore=0, Info=1, Warning=2, Error=3
 */
function severityToMonaco(severity) {
    switch (severity) {
        case severity_2.Severity.Error: return severity_1.default.Error;
        case severity_2.Severity.Warning: return severity_1.default.Warning;
        case severity_2.Severity.Info: return severity_1.default.Info;
        case severity_2.Severity.Ignore:
        default: return severity_1.default.Ignore;
    }
}
class HoverDelegate {
    showHover(options, focus) {
        return undefined;
    }
}
let MonacoQuickInputImplementation = class MonacoQuickInputImplementation {
    get currentQuickInput() {
        return this.controller.currentQuickInput;
    }
    get backButton() { return this.controller.backButton; }
    get onShow() { return this.controller.onShow; }
    get onHide() { return this.controller.onHide; }
    init() {
        this.initContainer();
        this.initController();
        this.quickAccess = new quickAccess_1.QuickAccessController(this, standaloneServices_1.StandaloneServices.get(instantiation_1.IInstantiationService));
        const contextService = standaloneServices_1.StandaloneServices.get(contextkey_1.IContextKeyService);
        this.inQuickOpen = contextService.createKey('inQuickOpen', false);
        this.scopedContextKeyService = contextService.createScoped(this.container);
        this.scopedInQuickOpen = this.scopedContextKeyService.createKey('inQuickOpen', false);
        this.controller.onShow(() => {
            this.container.style.top = this.shell.mainPanel.node.getBoundingClientRect().top + 'px';
            this.inQuickOpen.set(true);
            this.scopedInQuickOpen.set(true);
        });
        this.controller.onHide(() => {
            this.inQuickOpen.set(false);
            this.scopedInQuickOpen.set(false);
        });
        this.themeService.initialized.then(() => this.controller.applyStyles(this.computeStyles()));
        // Hook into the theming service of Monaco to ensure that the updates are ready.
        standaloneServices_1.StandaloneServices.get(standaloneTheme_1.IStandaloneThemeService).onDidColorThemeChange(() => this.controller.applyStyles(this.computeStyles()));
        window.addEventListener('resize', () => this.updateLayout());
    }
    setContextKey(key) {
        if (key) {
            standaloneServices_1.StandaloneServices.get(contextkey_1.IContextKeyService).createKey(key, undefined);
        }
    }
    createQuickWidget() {
        return this.controller.createQuickWidget();
    }
    createQuickPick(options) {
        return this.controller.createQuickPick({
            useSeparators: options.useSeparators
        });
    }
    createInputBox() {
        return this.controller.createInputBox();
    }
    createQuickTree() {
        return this.controller.createQuickTree();
    }
    open(filter) {
        this.quickAccess.show(filter);
    }
    input(options, token) {
        return this.controller.input(options, token);
    }
    pick(picks, options, token) {
        return this.controller.pick(picks, options, token);
    }
    hide() {
        this.controller.hide();
    }
    focus() {
        this.controller.focus();
    }
    toggle() {
        this.controller.toggle();
    }
    applyStyles(styles) {
        this.controller.applyStyles(styles);
    }
    layout(dimension, titleBarOffset) {
        this.controller.layout(dimension, titleBarOffset);
    }
    navigate(next, quickNavigate) {
        this.controller.navigate(next, quickNavigate);
    }
    dispose() {
        this.scopedContextKeyService.dispose();
        this.controller.dispose();
    }
    async cancel() {
        this.controller.cancel();
    }
    async back() {
        this.controller.back();
    }
    async accept(keyMods) {
        this.controller.accept(keyMods);
    }
    toggleHover() {
        return this.controller.toggleHover();
    }
    setAlignment(alignment) {
        this.controller.setAlignment(alignment);
    }
    initContainer() {
        const container = this.container = document.createElement('div');
        container.id = 'quick-input-container';
        document.body.appendChild(this.container);
    }
    initController() {
        const contextKeyService = standaloneServices_1.StandaloneServices.get(contextkey_1.IContextKeyService);
        const instantiationService = standaloneServices_1.StandaloneServices.get(instantiation_1.IInstantiationService);
        const layoutService = standaloneServices_1.StandaloneServices.get(layoutService_1.ILayoutService);
        const storageService = standaloneServices_1.StandaloneServices.get(storage_1.IStorageService);
        const options = {
            idPrefix: 'quickInput_',
            container: this.container,
            styles: this.computeStyles(),
            ignoreFocusOut: () => false,
            backKeybindingLabel: () => undefined,
            setContextKey: (id) => this.setContextKey(id),
            returnFocus: () => this.container.focus(),
            hoverDelegate: new HoverDelegate(),
            linkOpenerDelegate: () => {
                // @monaco-uplift: not sure what to do here
            }
        };
        const contextMenuService = standaloneServices_1.StandaloneServices.get(contextView_1.IContextMenuService);
        this.controller = new quickInputController_1.QuickInputController(options, layoutService, instantiationService, contextKeyService, storageService, contextMenuService);
        this.updateLayout();
    }
    updateLayout() {
        // Initialize the layout using screen dimensions as monaco computes the actual sizing.
        // https://github.com/microsoft/vscode/blob/6261075646f055b99068d3688932416f2346dd3b/src/vs/base/parts/quickinput/browser/quickInput.ts#L1799
        this.controller.layout(this.getClientDimension(), 0);
    }
    getClientDimension() {
        return { width: window.innerWidth, height: window.innerHeight };
    }
    /**
     * Wraps a color ID as a CSS variable reference: `var(--theia-<id>)`.
     * Monaco applies these values as inline styles, so the `var()` wrapper is required.
     */
    asCssVariable(id) {
        return `var(${this.colorRegistry.toCssVariableName(id)})`;
    }
    // @monaco-uplift
    // Keep the styles up to date with https://github.com/microsoft/vscode/blob/7888ff3a6b104e9e2e3d0f7890ca92dd0828215f/src/vs/platform/quickinput/browser/quickInput.ts#L171.
    computeStyles() {
        return {
            toggle: {
                inputActiveOptionBorder: this.asCssVariable('inputOption.activeBorder'),
                inputActiveOptionForeground: this.asCssVariable('inputOption.activeForeground'),
                inputActiveOptionBackground: this.asCssVariable('inputOption.activeBackground')
            },
            pickerGroup: {
                pickerGroupBorder: this.asCssVariable('pickerGroup.border'),
                pickerGroupForeground: this.asCssVariable('pickerGroup.foreground')
            },
            widget: {
                quickInputBackground: this.asCssVariable('quickInput.background'),
                quickInputForeground: this.asCssVariable('quickInput.foreground'),
                quickInputTitleBackground: this.asCssVariable('quickInputTitle.background'),
                widgetBorder: this.asCssVariable('widget.border'),
                widgetShadow: this.asCssVariable('widget.shadow')
            },
            list: {
                listBackground: this.asCssVariable('quickInput.background'),
                listInactiveFocusForeground: this.asCssVariable('quickInputList.focusForeground'),
                listInactiveSelectionIconForeground: this.asCssVariable('quickInputList.focusIconForeground'),
                listInactiveFocusBackground: this.asCssVariable('quickInputList.focusBackground'),
                listFocusOutline: this.asCssVariable('contrastActiveBorder'),
                listInactiveFocusOutline: this.asCssVariable('contrastActiveBorder'),
                listFocusBackground: this.asCssVariable('list.focusBackground'),
                listFocusForeground: this.asCssVariable('list.focusForeground'),
                listActiveSelectionBackground: this.asCssVariable('list.activeSelectionBackground'),
                listActiveSelectionForeground: this.asCssVariable('list.activeSelectionForeground'),
                listActiveSelectionIconForeground: this.asCssVariable('list.activeSelectionIconForeground'),
                listFocusAndSelectionOutline: this.asCssVariable('list.focusAndSelectionOutline'),
                listFocusAndSelectionBackground: this.asCssVariable('list.activeSelectionBackground'),
                listFocusAndSelectionForeground: this.asCssVariable('list.activeSelectionForeground'),
                listInactiveSelectionBackground: this.asCssVariable('list.inactiveSelectionBackground'),
                listInactiveSelectionForeground: this.asCssVariable('list.inactiveSelectionForeground'),
                listHoverBackground: this.asCssVariable('list.hoverBackground'),
                listHoverForeground: this.asCssVariable('list.hoverForeground'),
                listDropOverBackground: this.asCssVariable('list.dropBackground'),
                listDropBetweenBackground: this.asCssVariable('list.dropBetweenBackground'),
                listSelectionOutline: this.asCssVariable('contrastActiveBorder'),
                listHoverOutline: this.asCssVariable('contrastActiveBorder'),
                treeIndentGuidesStroke: this.asCssVariable('tree.indentGuidesStroke'),
                treeInactiveIndentGuidesStroke: this.asCssVariable('tree.inactiveIndentGuidesStroke'),
                treeStickyScrollBackground: undefined,
                treeStickyScrollBorder: undefined,
                treeStickyScrollShadow: this.asCssVariable('scrollbar.shadow'),
                tableColumnsBorder: this.asCssVariable('tree.tableColumnsBorder'),
                tableOddRowsBackgroundColor: this.asCssVariable('tree.tableOddRowsBackground'),
            },
            inputBox: {
                inputForeground: this.asCssVariable('input.foreground'),
                inputBackground: this.asCssVariable('input.background'),
                inputBorder: this.asCssVariable('input.border'),
                inputValidationInfoBackground: this.asCssVariable('inputValidation.infoBackground'),
                inputValidationInfoForeground: this.asCssVariable('inputValidation.infoForeground'),
                inputValidationInfoBorder: this.asCssVariable('inputValidation.infoBorder'),
                inputValidationWarningBackground: this.asCssVariable('inputValidation.warningBackground'),
                inputValidationWarningForeground: this.asCssVariable('inputValidation.warningForeground'),
                inputValidationWarningBorder: this.asCssVariable('inputValidation.warningBorder'),
                inputValidationErrorBackground: this.asCssVariable('inputValidation.errorBackground'),
                inputValidationErrorForeground: this.asCssVariable('inputValidation.errorForeground'),
                inputValidationErrorBorder: this.asCssVariable('inputValidation.errorBorder'),
            },
            countBadge: {
                badgeBackground: this.asCssVariable('badge.background'),
                badgeForeground: this.asCssVariable('badge.foreground'),
                badgeBorder: this.asCssVariable('contrastBorder')
            },
            button: {
                buttonForeground: this.asCssVariable('button.foreground'),
                buttonBackground: this.asCssVariable('button.background'),
                buttonHoverBackground: this.asCssVariable('button.hoverBackground'),
                buttonBorder: this.asCssVariable('contrastBorder'),
                buttonSeparator: this.asCssVariable('button.separator'),
                buttonSecondaryForeground: this.asCssVariable('button.secondaryForeground'),
                buttonSecondaryBackground: this.asCssVariable('button.secondaryBackground'),
                buttonSecondaryHoverBackground: this.asCssVariable('button.secondaryHoverBackground'),
            },
            progressBar: {
                progressBarBackground: this.asCssVariable('progressBar.background')
            },
            keybindingLabel: {
                keybindingLabelBackground: this.asCssVariable('keybindingLabel.background'),
                keybindingLabelForeground: this.asCssVariable('keybindingLabel.foreground'),
                keybindingLabelBorder: this.asCssVariable('keybindingLabel.border'),
                keybindingLabelBottomBorder: this.asCssVariable('keybindingLabel.bottomBorder'),
                keybindingLabelShadow: this.asCssVariable('widget.shadow')
            },
        };
    }
};
exports.MonacoQuickInputImplementation = MonacoQuickInputImplementation;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ApplicationShell),
    tslib_1.__metadata("design:type", browser_1.ApplicationShell)
], MonacoQuickInputImplementation.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_color_registry_1.MonacoColorRegistry),
    tslib_1.__metadata("design:type", monaco_color_registry_1.MonacoColorRegistry)
], MonacoQuickInputImplementation.prototype, "colorRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(theming_1.ThemeService),
    tslib_1.__metadata("design:type", theming_1.ThemeService)
], MonacoQuickInputImplementation.prototype, "themeService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], MonacoQuickInputImplementation.prototype, "init", null);
exports.MonacoQuickInputImplementation = MonacoQuickInputImplementation = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoQuickInputImplementation);
let MonacoQuickInputService = class MonacoQuickInputService {
    get backButton() {
        // need to cast because of vscode issue https://github.com/microsoft/vscode/issues/190584
        return this.monacoService.backButton;
    }
    get onShow() { return this.monacoService.onShow; }
    get onHide() { return this.monacoService.onHide; }
    open(filter) {
        this.monacoService.open(filter);
    }
    createInputBox() {
        const monacoInputBox = this.monacoService.createInputBox();
        return new Proxy(monacoInputBox, {
            set(target, prop, value) {
                if (prop === 'severity') {
                    target[prop] = severityToMonaco(value);
                    return true;
                }
                target[prop] = value;
                return true;
            },
            get(target, prop) {
                const result = target[prop];
                if (typeof result === 'function') {
                    return result.bind(target);
                }
                return result;
            }
        });
    }
    input(options, token) {
        let inputOptions;
        if (options) {
            const { validateInput, ...props } = options;
            inputOptions = { ...props };
            if (validateInput) {
                inputOptions.validateInput = async (input) => {
                    const result = await validateInput(input);
                    if (result && typeof result !== 'string') {
                        return { content: result.content, severity: severityToMonaco(result.severity) };
                    }
                    return result;
                };
            }
        }
        return this.monacoService.input(inputOptions, token);
    }
    async pick(picks, options, token) {
        return this.monacoService.pick(picks, options, token);
    }
    showQuickPick(items, options) {
        return new Promise((resolve, reject) => {
            const wrapped = this.createQuickPick();
            wrapped.items = items;
            if (options) {
                wrapped.canSelectMany = !!options.canSelectMany;
                wrapped.contextKey = options.contextKey;
                wrapped.description = options.description;
                wrapped.enabled = options.enabled ?? true;
                wrapped.ignoreFocusOut = !!options.ignoreFocusOut;
                wrapped.matchOnDescription = options.matchOnDescription ?? true;
                wrapped.matchOnDetail = options.matchOnDetail ?? true;
                wrapped.keepScrollPosition = options.keepScrollPosition ?? false;
                wrapped.placeholder = options.placeholder;
                wrapped.step = options.step;
                wrapped.title = options.title;
                wrapped.totalSteps = options.totalSteps;
                if (options.activeItem) {
                    wrapped.activeItems = [options.activeItem];
                }
                if (options.value) {
                    wrapped.value = options.value;
                }
                wrapped.onDidChangeValue((filter) => {
                    if (options.onDidChangeValue) {
                        options.onDidChangeValue(wrapped, filter);
                    }
                });
                wrapped.onDidChangeActive((activeItems) => {
                    if (options.onDidChangeActive) {
                        options.onDidChangeActive(wrapped, activeItems);
                    }
                });
                wrapped.onDidTriggerButton((button) => {
                    if (options.onDidTriggerButton) {
                        // need to cast because of vscode issue https://github.com/microsoft/vscode/issues/190584
                        options.onDidTriggerButton(button);
                    }
                });
                wrapped.onDidTriggerItemButton((event) => {
                    if (options.onDidTriggerItemButton) {
                        // https://github.com/theia-ide/vscode/blob/standalone/0.23.x/src/vs/base/parts/quickinput/browser/quickInput.ts#L1387
                        options.onDidTriggerItemButton({
                            ...event,
                            removeItem: () => {
                                wrapped.items = wrapped.items.filter(item => item !== event.item);
                                wrapped.activeItems = wrapped.activeItems.filter(item => item !== event.item);
                            }
                        });
                    }
                });
                wrapped.onDidChangeSelection((selectedItems) => {
                    if (options.onDidChangeSelection) {
                        options.onDidChangeSelection(wrapped, selectedItems);
                    }
                });
            }
            wrapped.onDidAccept(() => {
                if (options?.onDidAccept) {
                    options.onDidAccept();
                }
                wrapped.hide();
                resolve(wrapped.selectedItems[0]);
            });
            wrapped.onDidHide(() => {
                if (options?.onDidHide) {
                    options?.onDidHide();
                }
                ;
                wrapped.dispose();
                setTimeout(() => resolve(undefined));
            });
            wrapped.show();
        }).then(item => {
            if (item?.execute) {
                item.execute();
            }
            return item;
        });
    }
    createQuickPick() {
        const quickPick = this.monacoService.createQuickPick({ useSeparators: true });
        return this.wrapQuickPick(quickPick);
    }
    wrapQuickPick(wrapped) {
        return new MonacoQuickPick(wrapped, this.keybindingRegistry);
    }
    convertItems(item) {
        return new MonacoQuickPickItem(item, this.keybindingRegistry);
    }
    hide() {
        return this.monacoService.hide();
    }
};
exports.MonacoQuickInputService = MonacoQuickInputService;
tslib_1.__decorate([
    (0, inversify_1.inject)(MonacoQuickInputImplementation),
    tslib_1.__metadata("design:type", MonacoQuickInputImplementation)
], MonacoQuickInputService.prototype, "monacoService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.KeybindingRegistry),
    tslib_1.__metadata("design:type", browser_1.KeybindingRegistry)
], MonacoQuickInputService.prototype, "keybindingRegistry", void 0);
exports.MonacoQuickInputService = MonacoQuickInputService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoQuickInputService);
class MonacoQuickInput {
    constructor(wrapped) {
        this.wrapped = wrapped;
    }
    get onDidHide() { return this.wrapped.onDidHide; }
    get onDispose() { return this.wrapped.onDispose; }
    get title() {
        return this.wrapped.title;
    }
    set title(v) {
        this.wrapped.title = v;
    }
    get description() {
        return this.wrapped.description;
    }
    set description(v) {
        this.wrapped.description = v;
    }
    get step() {
        return this.wrapped.step;
    }
    set step(v) {
        this.wrapped.step = v;
    }
    get enabled() {
        return this.wrapped.enabled;
    }
    set enabled(v) {
        this.wrapped.enabled = v;
    }
    get totalSteps() {
        return this.wrapped.totalSteps;
    }
    set totalSteps(v) {
        this.wrapped.totalSteps = v;
    }
    get contextKey() {
        return this.wrapped.contextKey;
    }
    set contextKey(v) {
        this.wrapped.contextKey = v;
    }
    get busy() {
        return this.wrapped.busy;
    }
    set busy(v) {
        this.wrapped.busy = v;
    }
    get ignoreFocusOut() {
        return this.wrapped.ignoreFocusOut;
    }
    set ignoreFocusOut(v) {
        this.wrapped.ignoreFocusOut = v;
    }
    show() {
        this.wrapped.show();
    }
    hide() {
        this.wrapped.hide();
    }
    dispose() {
        this.wrapped.dispose();
    }
}
class MonacoQuickPick extends MonacoQuickInput {
    constructor(wrapped, keybindingRegistry) {
        super(wrapped);
        this.wrapped = wrapped;
        this.keybindingRegistry = keybindingRegistry;
        this.onDidAccept = this.wrapped.onDidAccept;
        this.onDidChangeValue = this.wrapped.onDidChangeValue;
        // need to cast because of vscode issue https://github.com/microsoft/vscode/issues/190584
        this.onDidTriggerButton = this.wrapped.onDidTriggerButton;
        this.onDidTriggerItemButton = core_1.Event.map(this.wrapped.onDidTriggerItemButton, (evt) => ({
            item: evt.item.item,
            button: evt.button
        }));
        this.onDidChangeActive = core_1.Event.map(this.wrapped.onDidChangeActive, (items) => items.map(item => item.item));
        this.onDidChangeSelection = core_1.Event.map(this.wrapped.onDidChangeSelection, (items) => items.map(item => item.item));
    }
    get value() {
        return this.wrapped.value;
    }
    ;
    set value(v) {
        this.wrapped.value = v;
    }
    get placeholder() {
        return this.wrapped.placeholder;
    }
    set placeholder(v) {
        this.wrapped.placeholder = v;
    }
    get canSelectMany() {
        return this.wrapped.canSelectMany;
    }
    set canSelectMany(v) {
        this.wrapped.canSelectMany = v;
    }
    get matchOnDescription() {
        return this.wrapped.matchOnDescription;
    }
    set matchOnDescription(v) {
        this.wrapped.matchOnDescription = v;
    }
    get matchOnDetail() {
        return this.wrapped.matchOnDetail;
    }
    set matchOnDetail(v) {
        this.wrapped.matchOnDetail = v;
    }
    get keepScrollPosition() {
        return this.wrapped.keepScrollPosition;
    }
    set keepScrollPosition(v) {
        this.wrapped.keepScrollPosition = v;
    }
    get items() {
        // need to cast because of vscode issue https://github.com/microsoft/vscode/issues/190584
        return this.wrapped.items.map(item => {
            if (item instanceof MonacoQuickPickItem) {
                return item.item;
            }
            else {
                return item;
            }
        });
    }
    get buttons() {
        return this.wrapped.buttons;
    }
    set buttons(buttons) {
        this.wrapped.buttons = buttons;
    }
    set items(itemList) {
        // We need to store and apply the currently selected active items.
        // Since monaco compares these items by reference equality, creating new wrapped items will unmark any active items.
        // Assigning the `activeItems` again will restore all active items even after the items array has changed.
        // See also the `findMonacoItemReferences` method.
        const active = this.activeItems;
        this.wrapped.items = itemList.map(item => browser_1.QuickPickSeparator.is(item) ? item : new MonacoQuickPickItem(item, this.keybindingRegistry));
        if (active.length !== 0) {
            this.activeItems = active; // If this is done with an empty activeItems array, then it will undo first item focus on quick menus.
        }
    }
    set activeItems(itemList) {
        this.wrapped.activeItems = this.findMonacoItemReferences(this.wrapped.items, itemList);
    }
    get activeItems() {
        return this.wrapped.activeItems.map(item => item.item);
    }
    set selectedItems(itemList) {
        this.wrapped.selectedItems = this.findMonacoItemReferences(this.wrapped.items, itemList);
    }
    get selectedItems() {
        return this.wrapped.selectedItems.map(item => item.item);
    }
    /**
     * Monaco doesn't check for deep equality when setting the `activeItems` or `selectedItems`.
     * Instead we have to find the references of the monaco wrappers that contain the selected/active items
     */
    findMonacoItemReferences(source, items) {
        const monacoReferences = [];
        for (const item of items) {
            for (const wrappedItem of source) {
                if (wrappedItem instanceof MonacoQuickPickItem && wrappedItem.item === item) {
                    monacoReferences.push(wrappedItem);
                }
            }
        }
        return monacoReferences;
    }
}
class MonacoQuickPickItem {
    constructor(item, kbRegistry) {
        this.item = item;
        this.type = item.type;
        this.id = item.id;
        this.label = item.label;
        this.meta = item.meta;
        this.ariaLabel = item.ariaLabel;
        this.description = item.description;
        this.detail = item.detail;
        this.keybinding = item.keySequence ? new monaco_resolved_keybinding_1.MonacoResolvedKeybinding(item.keySequence, kbRegistry) : undefined;
        this.iconClasses = item.iconClasses;
        this.buttons = item.buttons;
        this.alwaysShow = item.alwaysShow;
        this.highlights = item.highlights;
    }
    accept() {
        if (this.item.execute) {
            this.item.execute();
        }
    }
}
exports.MonacoQuickPickItem = MonacoQuickPickItem;
//# sourceMappingURL=monaco-quick-input-service.js.map