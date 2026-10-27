"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchBoxFactory = exports.SearchBox = exports.SearchBoxProps = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2018 TypeFox and others.
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
const search_box_debounce_1 = require("../tree/search-box-debounce");
const widgets_1 = require("../widgets");
const event_1 = require("../../common/event");
const keys_1 = require("../keyboard/keys");
const nls_1 = require("../../common/nls");
var SearchBoxProps;
(function (SearchBoxProps) {
    /**
     * The default search box widget option.
     */
    SearchBoxProps.DEFAULT = search_box_debounce_1.SearchBoxDebounceOptions.DEFAULT;
})(SearchBoxProps || (exports.SearchBoxProps = SearchBoxProps = {}));
/**
 * The search box widget.
 */
class SearchBox extends widgets_1.ReactWidget {
    static { this.SPECIAL_KEYS = [
        keys_1.Key.ESCAPE,
        keys_1.Key.BACKSPACE
    ]; }
    static { this.MAX_CONTENT_LENGTH = 15; }
    constructor(props, debounce) {
        super();
        this.props = props;
        this.debounce = debounce;
        this.nextEmitter = new event_1.Emitter();
        this.previousEmitter = new event_1.Emitter();
        this.closeEmitter = new event_1.Emitter();
        this.textChangeEmitter = new event_1.Emitter();
        this.filterToggleEmitter = new event_1.Emitter();
        this._isFiltering = false;
        this.hasMatch = true;
        this.inputText = '';
        this.toDispose.pushAll([
            this.nextEmitter,
            this.previousEmitter,
            this.closeEmitter,
            this.textChangeEmitter,
            this.filterToggleEmitter,
            this.debounce,
            this.debounce.onChanged(data => this.fireTextChange(data))
        ]);
        this.hide();
        this.addClass('theia-search-box-widget');
        this.node.setAttribute('tabIndex', '0');
    }
    get onPrevious() {
        return this.previousEmitter.event;
    }
    get onNext() {
        return this.nextEmitter.event;
    }
    get onClose() {
        return this.closeEmitter.event;
    }
    get onTextChange() {
        return this.textChangeEmitter.event;
    }
    get onFilterToggled() {
        return this.filterToggleEmitter.event;
    }
    get isFiltering() {
        return this._isFiltering;
    }
    get keyCodePredicate() {
        return this.canHandle.bind(this);
    }
    firePrevious() {
        this.previousEmitter.fire(undefined);
    }
    fireNext() {
        this.nextEmitter.fire(undefined);
    }
    fireClose() {
        this.closeEmitter.fire(undefined);
    }
    fireTextChange(input) {
        this.textChangeEmitter.fire(input);
    }
    fireFilterToggle() {
        this.doFireFilterToggle();
    }
    doFireFilterToggle(toggleTo = !this._isFiltering) {
        this._isFiltering = toggleTo;
        this.filterToggleEmitter.fire(toggleTo);
        this.update();
    }
    handle(event) {
        event.preventDefault();
        const keyCode = keys_1.KeyCode.createKeyCode(event);
        if (this.canHandle(keyCode)) {
            if (keys_1.Key.equals(keys_1.Key.ESCAPE, keyCode) || this.isCtrlBackspace(keyCode)) {
                this.hide();
            }
            else {
                this.show();
                this.handleKey(keyCode);
            }
        }
    }
    handleArrowUp() {
        this.firePrevious();
    }
    handleArrowDown() {
        this.fireNext();
    }
    onBeforeHide() {
        this.hasMatch = true;
        this.doFireFilterToggle(false);
        this.inputText = '';
        this.debounce.append(undefined);
        this.fireClose();
    }
    handleKey(keyCode) {
        const character = keys_1.Key.equals(keys_1.Key.BACKSPACE, keyCode) ? '\b' : keyCode.character;
        const data = this.debounce.append(character);
        if (data) {
            this.inputText = data;
            this.update();
        }
        else {
            this.hide();
        }
    }
    getTrimmedContent(data) {
        if (data.length > SearchBox.MAX_CONTENT_LENGTH) {
            return '...' + data.substring(data.length - SearchBox.MAX_CONTENT_LENGTH);
        }
        return data;
    }
    canHandle(keyCode) {
        if (keyCode === undefined) {
            return false;
        }
        const { ctrl, alt, meta } = keyCode;
        if (this.isCtrlBackspace(keyCode)) {
            return true;
        }
        if (ctrl || alt || meta || keyCode.key === keys_1.Key.SPACE) {
            return false;
        }
        if (keyCode.character || (this.isVisible && SearchBox.SPECIAL_KEYS.some(key => keys_1.Key.equals(key, keyCode)))) {
            return true;
        }
        return false;
    }
    isCtrlBackspace(keyCode) {
        if (keyCode.ctrl && keys_1.Key.equals(keys_1.Key.BACKSPACE, keyCode)) {
            return true;
        }
        return false;
    }
    updateHighlightInfo(info) {
        if (info.filterText && info.filterText.length > 0) {
            this.hasMatch = info.matched > 0;
            this.update();
        }
    }
    render() {
        const displayText = this.inputText ? this.getTrimmedContent(this.inputText) : '';
        return ((0, jsx_runtime_1.jsxs)("div", { className: `theia-search-box${this.hasMatch ? '' : ' no-match'}`, children: [(0, jsx_runtime_1.jsx)("span", { className: 'theia-search-input', children: displayText }), (0, jsx_runtime_1.jsxs)("div", { className: 'theia-search-buttons-wrapper', children: [this.props.showFilter &&
                            (0, jsx_runtime_1.jsx)("div", { className: `theia-search-button action-label ${this.isFiltering ? (0, widgets_1.codicon)('list-filter') : (0, widgets_1.codicon)('list-selection')}`, title: this.isFiltering ?
                                    nls_1.nls.localize('theia/core/searchbox/showAll', 'Show all items') :
                                    nls_1.nls.localize('theia/core/searchbox/showOnlyMatching', 'Show only matching items'), onClick: () => this.fireFilterToggle() }), this.props.showButtons &&
                            (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { className: `theia-search-button ${this.hasMatch ? 'action-label' : 'no-match'} ${(0, widgets_1.codicon)('find-previous-match')}`, title: nls_1.nls.localize('theia/core/searchbox/previous', 'Previous (Up)'), onClick: () => this.hasMatch && this.firePrevious() }), (0, jsx_runtime_1.jsx)("div", { className: `theia-search-button ${this.hasMatch ? 'action-label' : 'no-match'} ${(0, widgets_1.codicon)('find-next-match')}`, title: nls_1.nls.localize('theia/core/searchbox/next', 'Next (Down)'), onClick: () => this.hasMatch && this.fireNext() })] }), (this.props.showButtons || this.props.showFilter) &&
                            (0, jsx_runtime_1.jsx)("div", { className: `theia-search-button action-label ${(0, widgets_1.codicon)('widget-close')}`, title: nls_1.nls.localize('theia/core/searchbox/close', 'Close (Escape)'), onClick: () => this.hide() })] })] }));
    }
}
exports.SearchBox = SearchBox;
/**
 * Search box factory.
 */
exports.SearchBoxFactory = Symbol('SearchBoxFactory');
//# sourceMappingURL=search-box.js.map