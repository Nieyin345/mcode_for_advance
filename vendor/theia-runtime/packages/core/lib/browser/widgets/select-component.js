"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SelectComponent = exports.SELECT_COMPONENT_CONTAINER = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2022 TypeFox and others.
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
const React = require("react");
const ReactDOM = require("react-dom");
const DOMPurify = require("dompurify");
const widget_1 = require("./widget");
const browser_1 = require("../browser");
require("../../../src/browser/style/select-component.css");
exports.SELECT_COMPONENT_CONTAINER = 'select-component-container';
class SelectComponent extends React.Component {
    constructor(props) {
        super(props);
        this.fieldRef = React.createRef();
        this.dropdownRef = React.createRef();
        this.mountedListeners = new Map();
        this.optimalWidth = 0;
        this.optimalHeight = 0;
        /** Perfect-scrollbar ancestors the `ps-scroll-y` listener was attached to. The field may have moved to another window since, so the elements are remembered. */
        this.psScrollListenerTargets = [];
        const selected = this.getInitialSelectedIndex(props);
        this.state = {
            selected,
            original: selected,
            hover: selected
        };
        this.dropdownElement = this.resolveDropdownContainer(document);
    }
    /**
     * The document that currently hosts this component. Falls back to the main document before
     * the first render. Widgets can be moved to secondary windows, so this must be re-queried
     * instead of captured once.
     */
    getHostDocument() {
        return this.fieldRef.current?.ownerDocument ?? document;
    }
    /** Finds or creates the dropdown portal container in the given document. */
    resolveDropdownContainer(hostDocument) {
        let list = hostDocument.getElementById(exports.SELECT_COMPONENT_CONTAINER);
        if (!list) {
            list = hostDocument.createElement('div');
            list.id = exports.SELECT_COMPONENT_CONTAINER;
            list.className = 'theia-select-component-container';
            hostDocument.body.appendChild(list);
        }
        return list;
    }
    getInitialSelectedIndex(props) {
        let selected = 0;
        if (typeof props.defaultValue === 'number') {
            selected = props.defaultValue;
        }
        else if (typeof props.defaultValue === 'string') {
            selected = Math.max(props.options.findIndex(e => e.value === props.defaultValue), 0);
        }
        return selected;
    }
    componentDidUpdate(prevProps, prevState) {
        if (prevState.selected !== this.state.selected && this.state.dimensions) {
            const dropdownContainer = this.dropdownRef?.current;
            const selectedOption = dropdownContainer?.querySelector(`[data-option-index="${this.state.selected}"]`);
            if (dropdownContainer && selectedOption) {
                const optionBottom = selectedOption.offsetTop + selectedOption.offsetHeight;
                const visibleBottom = dropdownContainer.scrollTop + dropdownContainer.clientHeight;
                if (optionBottom > visibleBottom) {
                    dropdownContainer.scrollTop = optionBottom - dropdownContainer.clientHeight;
                }
                else if (selectedOption.offsetTop < dropdownContainer.scrollTop) {
                    dropdownContainer.scrollTop = selectedOption.offsetTop;
                }
            }
        }
        if (prevProps.defaultValue !== this.props.defaultValue || prevProps.options !== this.props.options) {
            const selected = this.getInitialSelectedIndex(this.props);
            this.setState({
                selected,
                original: selected,
                hover: selected
            });
        }
    }
    get options() {
        return this.props.options;
    }
    get value() {
        return this.props.options[this.state.selected].value ?? this.state.selected;
    }
    set value(value) {
        let index = -1;
        if (typeof value === 'number') {
            index = value;
        }
        else if (typeof value === 'string') {
            index = this.props.options.findIndex(e => e.value === value);
        }
        if (index >= 0) {
            this.setState({
                selected: index,
                original: index,
                hover: index
            });
        }
    }
    get alignLeft() {
        return this.props.alignment !== 'right';
    }
    getOptimalWidth() {
        const textWidth = (0, browser_1.measureTextWidth)(this.props.options.map(e => e.label || e.value || '' + (e.detail || '')));
        return Math.ceil(textWidth + 16);
    }
    getOptimalHeight(maxWidth) {
        const firstLine = this.props.options.find(e => e.label || e.value || e.detail);
        if (!firstLine) {
            return 0;
        }
        if (maxWidth) {
            maxWidth = Math.ceil(maxWidth) + 10; // Increase width by 10 due to side padding
        }
        const descriptionHeight = (0, browser_1.measureTextHeight)(this.props.options.map(e => e.description || ''), { maxWidth: `${maxWidth}px` }) + 18;
        const singleLineHeight = (0, browser_1.measureTextHeight)(firstLine.label || firstLine.value || firstLine.detail || '') + 6;
        const optimal = descriptionHeight + singleLineHeight * this.props.options.length;
        return optimal + 20; // Just to be safe, add another 20 pixels here
    }
    attachListeners() {
        const hide = (event) => {
            if (!this.dropdownRef.current?.contains(event.target)) {
                this.hide();
            }
        };
        const hideOnResize = () => this.hide();
        this.mountedListeners.set('scroll', hide);
        this.mountedListeners.set('wheel', hide);
        this.mountedListeners.set('resize', hideOnResize);
        let parent = this.fieldRef.current?.parentElement;
        while (parent) {
            // Workaround for perfect scrollbar, since using `overflow: hidden`
            // neither triggers the `scroll`, `wheel` nor `blur` event
            if (parent.classList.contains('ps')) {
                parent.addEventListener('ps-scroll-y', hide);
                this.psScrollListenerTargets.push(parent);
            }
            parent = parent.parentElement;
        }
        this.listenersWindow = this.getHostDocument().defaultView ?? window;
        for (const [key, listener] of this.mountedListeners.entries()) {
            this.listenersWindow.addEventListener(key, listener);
        }
        // Catch Lumino sash drags globally - observe the closest lm-Widget panel
        const fieldEl = this.fieldRef.current;
        const resizablePanel = fieldEl?.closest('.lm-Widget') ?? fieldEl?.parentElement;
        if (resizablePanel && typeof ResizeObserver !== 'undefined') {
            let lastWidth = 0;
            let lastHeight = 0;
            let isFirstFire = true;
            this.resizeObserver = new ResizeObserver(entries => {
                for (const entry of entries) {
                    const { width, height } = entry.contentRect;
                    // Ignore the initial automatic fire when the observer attaches
                    if (isFirstFire) {
                        lastWidth = width;
                        lastHeight = height;
                        isFirstFire = false;
                        continue;
                    }
                    // Only hide if the panel dimensions actually changed by more than 2 pixels
                    if (this.state.dimensions && (Math.abs(width - lastWidth) > 2 || Math.abs(height - lastHeight) > 2)) {
                        this.hide();
                    }
                    lastWidth = width;
                    lastHeight = height;
                }
            });
            this.resizeObserver.observe(resizablePanel);
        }
    }
    componentWillUnmount() {
        this.detachListeners();
    }
    detachListeners() {
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        if (this.mountedListeners.size > 0) {
            const eventListener = this.mountedListeners.get('scroll');
            for (const target of this.psScrollListenerTargets) {
                target.removeEventListener('ps-scroll-y', eventListener);
            }
            for (const [key, listener] of this.mountedListeners.entries()) {
                (this.listenersWindow ?? window).removeEventListener(key, listener);
            }
            this.mountedListeners.clear();
        }
        this.psScrollListenerTargets = [];
        this.listenersWindow = undefined;
    }
    render() {
        const { options } = this.props;
        let { selected } = this.state;
        if (options[selected]?.separator) {
            selected = this.nextNotSeparator('forwards');
        }
        const selectedItemLabel = options[selected]?.label ?? options[selected]?.value;
        // Expose when the currently shown option is disabled so consumers can style the field to match
        // it (e.g. the option previewed while navigating), instead of a fixed committed-value class.
        const selectionDisabled = !!options[selected]?.disabled;
        const fieldClassName = `theia-select-component${this.props.className ? ` ${this.props.className}` : ''}`
            + `${selectionDisabled ? ' theia-select-component-selection-disabled' : ''}`;
        return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { id: this.props.id, ref: this.fieldRef, tabIndex: 0, className: fieldClassName, onClick: e => this.handleClickEvent(e), onBlur: () => {
                        this.hide();
                        this.props.onBlur?.();
                    }, onFocus: () => this.props.onFocus?.(), onKeyDown: e => this.handleKeypress(e), children: [(0, jsx_runtime_1.jsx)("div", { className: "theia-select-component-label", children: selectedItemLabel }, "label"), (0, jsx_runtime_1.jsx)("div", { className: `theia-select-component-chevron ${(0, widget_1.codicon)('chevron-down')}` }, "icon")] }, "select-component"), ReactDOM.createPortal(this.renderDropdown(), this.dropdownElement)] });
    }
    nextNotSeparator(direction, startFrom) {
        const { options } = this.props;
        const step = direction === 'forwards' ? 1 : -1;
        const length = this.props.options.length;
        let selected = startFrom ?? this.state.selected;
        let count = 0;
        do {
            selected = (selected + step) % length;
            if (selected < 0) {
                selected = length - 1;
            }
            count++;
        } 
        // Skip separators and disabled options so keyboard navigation never lands on a non-selectable entry.
        while ((options[selected]?.separator || options[selected]?.disabled) && count < length);
        return selected;
    }
    handleKeypress(ev) {
        if (!this.fieldRef.current) {
            return;
        }
        if (ev.key === 'ArrowUp') {
            const selected = this.nextNotSeparator('backwards', this.state.hover);
            this.setState({
                selected,
                hover: selected
            });
        }
        else if (ev.key === 'ArrowDown') {
            if (this.state.dimensions) {
                const selected = this.nextNotSeparator('forwards', this.state.hover);
                this.setState({
                    selected,
                    hover: selected
                });
            }
            else {
                this.toggleVisibility();
                // Start on the first selectable option (startFrom -1 evaluates index 0 first), so a
                // leading separator or disabled option is skipped instead of becoming the active row.
                const selected = this.nextNotSeparator('forwards', -1);
                this.setState({
                    selected,
                    hover: selected,
                });
            }
        }
        else if (ev.key === 'Enter') {
            if (!this.state.dimensions) {
                this.toggleVisibility();
            }
            else {
                const selected = this.state.selected;
                const option = this.props.options[selected];
                if (!option?.disabled) {
                    this.selectOption(selected, option);
                }
            }
        }
        else if (ev.key === 'Escape' || ev.key === 'Tab') {
            this.hide(undefined, true);
        }
        ev.stopPropagation();
        ev.nativeEvent.stopImmediatePropagation();
    }
    handleClickEvent(event) {
        this.toggleVisibility();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
    }
    toggleVisibility() {
        if (!this.fieldRef.current) {
            return;
        }
        if (!this.state.dimensions) {
            // Re-resolve the portal container and listener window against the document that
            // currently hosts the field: the widget may have been moved to a secondary window
            // (or back to the main window) since the last time the dropdown was opened.
            const hostDocument = this.getHostDocument();
            this.dropdownElement = this.resolveDropdownContainer(hostDocument);
            if (this.listenersWindow && this.listenersWindow !== hostDocument.defaultView) {
                this.detachListeners();
            }
            const rect = this.fieldRef.current.getBoundingClientRect();
            this.setState({ dimensions: rect });
        }
        else {
            this.hide();
        }
    }
    hide(index, releaseFocus = false) {
        const selectedIndex = index === undefined ? this.state.original : index;
        this.setState({
            dimensions: undefined,
            selected: selectedIndex,
            original: selectedIndex,
            hover: selectedIndex
        });
        // Force releasing focus of the select element to allow closing via escape later on
        const hostDocument = this.getHostDocument();
        if (releaseFocus && hostDocument.activeElement && hostDocument.activeElement === this.fieldRef.current) {
            this.fieldRef.current.blur();
        }
    }
    renderDropdown() {
        if (!this.state.dimensions) {
            return;
        }
        // Secondary windows have no 'theia-app-shell' element; use the document element as the boundary there.
        const hostDocument = this.getHostDocument();
        const shellArea = (hostDocument.getElementById('theia-app-shell') ?? hostDocument.documentElement).getBoundingClientRect();
        const maxWidth = this.alignLeft ? shellArea.width - this.state.dimensions.left : this.state.dimensions.right;
        if (this.mountedListeners.size === 0) {
            // Only attach our listeners once we render our dropdown menu
            this.attachListeners();
            // We can now also calculate the optimal width
            this.optimalWidth = this.getOptimalWidth();
            this.optimalHeight = this.getOptimalHeight(Math.max(this.state.dimensions.width, this.optimalWidth));
        }
        const availableTop = this.state.dimensions.top - shellArea.top;
        const availableBottom = shellArea.top + shellArea.height - this.state.dimensions.bottom;
        // prefer rendering to the bottom unless there is not enough space and more content can be shown to the top
        const invert = availableBottom < this.optimalHeight && (availableBottom - this.optimalHeight) < (availableTop - this.optimalHeight);
        const { options } = this.props;
        const { hover } = this.state;
        const description = options[hover].description;
        const markdown = options[hover].markdown;
        const items = options.map((item, i) => this.renderOption(i, item));
        if (description) {
            let descriptionNode;
            const className = 'theia-select-component-description';
            if (markdown) {
                descriptionNode = (0, jsx_runtime_1.jsx)("div", { className: className, dangerouslySetInnerHTML: { __html: DOMPurify.sanitize(description) } }, "description"); // eslint-disable-line react/no-danger
            }
            else {
                descriptionNode = (0, jsx_runtime_1.jsx)("div", { className: className, children: description }, "description");
            }
            if (invert) {
                items.unshift(descriptionNode);
            }
            else {
                items.push(descriptionNode);
            }
        }
        return (0, jsx_runtime_1.jsx)("div", { className: "theia-select-component-dropdown", style: {
                top: invert ? 'none' : this.state.dimensions.bottom,
                bottom: invert ? shellArea.top - this.state.dimensions.top : 'none',
                left: this.alignLeft ? this.state.dimensions.left : 'none',
                right: this.alignLeft ? 'none' : shellArea.width - this.state.dimensions.right,
                width: Math.min(Math.max(this.state.dimensions.width, this.optimalWidth), maxWidth),
                maxHeight: shellArea.height - (invert ? shellArea.height - this.state.dimensions.bottom : this.state.dimensions.top) - this.state.dimensions.height,
                position: 'absolute'
            }, ref: this.dropdownRef, children: items }, "dropdown");
    }
    renderOption(index, option) {
        if (option.separator) {
            return (0, jsx_runtime_1.jsx)("div", { className: "theia-select-component-separator" }, index);
        }
        const selected = this.state.hover;
        const disabled = !!option.disabled;
        return ((0, jsx_runtime_1.jsxs)("div", { "data-option-index": index, className: `theia-select-component-option${index === selected ? ' selected' : ''}${disabled ? ' disabled' : ''}`, onMouseOver: () => {
                this.setState({
                    hover: index
                });
            }, onMouseDown: () => {
                if (!disabled) {
                    this.selectOption(index, option);
                }
            }, children: [(0, jsx_runtime_1.jsx)("div", { className: "theia-select-component-option-value", children: option.label ?? option.value }, "value"), option.detail && (0, jsx_runtime_1.jsx)("div", { className: "theia-select-component-option-detail", children: option.detail }, "detail")] }, index));
    }
    selectOption(index, option) {
        this.props.onChange?.(option, index);
        this.hide(index);
    }
}
exports.SelectComponent = SelectComponent;
//# sourceMappingURL=select-component.js.map