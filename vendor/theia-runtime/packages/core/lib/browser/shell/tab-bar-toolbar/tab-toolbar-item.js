"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReactToolbarItemImpl = exports.RenderedToolbarItemImpl = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const label_parser_1 = require("../../label-parser");
const common_1 = require("../../../common");
const widgets_1 = require("../../widgets");
const tab_bar_toolbar_1 = require("./tab-bar-toolbar");
const keyboard_utils_1 = require("../../keyboard/keyboard-utils");
const menu_1 = require("../../../common/menu");
/**
 * Class name indicating rendering of a toolbar item without an icon but instead with a text label.
 */
const NO_ICON_CLASS = 'no-icon';
class AbstractToolbarItemImpl {
    constructor(commandRegistry, contextKeyService, action) {
        this.commandRegistry = commandRegistry;
        this.contextKeyService = contextKeyService;
        this.action = action;
    }
    get id() {
        return this.action.id;
    }
    get when() {
        return this.action.when;
    }
    get group() {
        return this.action.group;
    }
    get priority() {
        return this.action.priority;
    }
    get onDidChange() {
        return this.action.onDidChange;
    }
    isVisible(widget, contextMatcher) {
        if (this.action.isVisible) {
            return this.action.isVisible(widget);
        }
        const actionVisible = !this.action.command || this.commandRegistry.isVisible(this.action.command, widget);
        const contextMatches = !this.action.when || contextMatcher.match(this.action.when);
        return actionVisible && contextMatches;
    }
    isEnabled(widget) {
        return this.action.command ? this.commandRegistry.isEnabled(this.action.command, widget) : !!this.action.menuPath;
    }
    isToggled(widget) {
        return this.action.command ? this.commandRegistry.isToggled(this.action.command, widget) : false;
    }
}
class RenderedToolbarItemImpl extends AbstractToolbarItemImpl {
    constructor(commandRegistry, contextKeyService, keybindingRegistry, labelParser, action) {
        super(commandRegistry, contextKeyService, action);
        this.keybindingRegistry = keybindingRegistry;
        this.labelParser = labelParser;
        this.disposables = new common_1.DisposableCollection();
        this.onDidChangeEmitter = new common_1.Emitter;
        this.onMouseDownEvent = (e) => {
            if (e.button === 0) {
                e.currentTarget.classList.add('active');
            }
        };
        this.onMouseUpEvent = (e) => {
            e.currentTarget.classList.remove('active');
        };
        this.onKeyDownEvent = (e, widget) => {
            if ((0, keyboard_utils_1.isActivationKey)(e)) {
                this.doExecuteCommand(e, widget);
            }
        };
        if (action.onDidChange) {
            this.disposables.push(action.onDidChange(() => this.onDidChangeEmitter.fire()));
        }
        this.disposables.push(common_1.Disposable.create(() => this.contextKeyListener?.dispose()));
    }
    dispose() {
        this.disposables.dispose();
    }
    updateContextKeyListener(when) {
        if (this.contextKeyListener) {
            this.contextKeyListener.dispose();
            this.contextKeyListener = undefined;
        }
        const contextKeys = new Set();
        this.contextKeyService.parseKeys(when)?.forEach(key => contextKeys.add(key));
        if (contextKeys.size > 0) {
            this.contextKeyListener = this.contextKeyService.onDidChange(change => {
                if (change.affects(contextKeys)) {
                    this.onDidChangeEmitter.fire();
                }
            });
        }
    }
    render(widget) {
        return this.renderItem(widget);
    }
    getToolbarItemClassNames(widget) {
        const classNames = [tab_bar_toolbar_1.TabBarToolbar.Styles.TAB_BAR_TOOLBAR_ITEM];
        if (this.isEnabled(widget)) {
            classNames.push('enabled');
        }
        if (this.isToggled(widget)) {
            classNames.push('toggled');
        }
        return classNames;
    }
    resolveKeybindingForCommand(widget, command) {
        let result = '';
        if (this.action.command) {
            const bindings = this.keybindingRegistry.getKeybindingsForCommand(this.action.command);
            let found = false;
            if (bindings && bindings.length > 0) {
                bindings.forEach(binding => {
                    if (binding.when) {
                        this.updateContextKeyListener(binding.when);
                    }
                    if (!found && this.keybindingRegistry.isEnabledInScope(binding, widget?.node)) {
                        found = true;
                        result = ` (${this.keybindingRegistry.acceleratorFor(binding, '+')})`;
                    }
                });
            }
        }
        return result;
    }
    get onDidChange() {
        return this.onDidChangeEmitter.event;
    }
    toMenuNode() {
        const action = new menu_1.ActionMenuNode({
            label: this.action.tooltip,
            commandId: this.action.command,
            when: this.action.when,
            order: this.action.order
        }, this.commandRegistry, this.keybindingRegistry, this.contextKeyService);
        // Register a submenu for the item, if the group is in format `<submenu group>/<submenu name>/.../<item group>`
        const menuPath = this.action.group?.split('/') || [];
        if (menuPath.length > 1) {
            let menu = new menu_1.GroupImpl(menuPath[0], this.action.order);
            menu = menu.getOrCreate(menuPath, 1, menuPath.length);
            menu.addNode(action);
            return menu;
        }
        return action;
    }
    executeCommand(e, widget) {
        this.doExecuteCommand(e, widget);
    }
    ;
    doExecuteCommand(e, widget) {
        e.preventDefault();
        e.stopPropagation();
        if (!this.isEnabled(widget)) {
            return;
        }
        if (this.action.command) {
            this.commandRegistry.executeCommand(this.action.command, widget);
        }
    }
    renderItem(widget) {
        let innerText = '';
        const classNames = [];
        const command = this.action.command ? this.commandRegistry.getCommand(this.action.command) : undefined;
        // Fall back to the item ID in extremis so there is _something_ to render in the
        // case that there is neither an icon nor a title
        const itemText = this.action.text || command?.label || command?.id || this.action.id;
        if (itemText) {
            for (const labelPart of this.labelParser.parse(itemText)) {
                if (label_parser_1.LabelIcon.is(labelPart)) {
                    const className = `fa fa-${labelPart.name}${labelPart.animation ? ' fa-' + labelPart.animation : ''}`;
                    classNames.push(...className.split(' '));
                }
                else {
                    innerText = labelPart;
                }
            }
        }
        const iconClass = (typeof this.action.icon === 'function' && this.action.icon()) || this.action.icon || (command && command.iconClass);
        if (iconClass) {
            classNames.push(iconClass);
        }
        const tooltipText = this.action.tooltip || (command && command.label) || '';
        const tooltip = `${this.labelParser.stripIcons(tooltipText)}${this.resolveKeybindingForCommand(widget, command?.id)}`;
        // Only present text if there is no icon
        if (classNames.length) {
            innerText = '';
        }
        else if (innerText) {
            // Make room for the label text
            classNames.push(NO_ICON_CLASS);
        }
        // In any case, this is an action item, with or without icon.
        classNames.push(widgets_1.ACTION_ITEM);
        const toolbarItemClassNames = this.getToolbarItemClassNames(widget);
        return (0, jsx_runtime_1.jsx)("div", { className: toolbarItemClassNames.join(' '), onMouseDown: this.onMouseDownEvent, onMouseUp: this.onMouseUpEvent, onMouseOut: this.onMouseUpEvent, children: (0, jsx_runtime_1.jsxs)("div", { id: this.action.id, className: classNames.join(' '), ...(0, keyboard_utils_1.buttonKeyboardProps)(tooltip), onClick: e => this.executeCommand(e, widget), onKeyDown: e => this.onKeyDownEvent(e, widget), title: tooltip, children: [" ", innerText] }) }, this.action.id);
    }
}
exports.RenderedToolbarItemImpl = RenderedToolbarItemImpl;
class ReactToolbarItemImpl extends AbstractToolbarItemImpl {
    render(widget) {
        return this.action.render(widget);
    }
}
exports.ReactToolbarItemImpl = ReactToolbarItemImpl;
//# sourceMappingURL=tab-toolbar-item.js.map