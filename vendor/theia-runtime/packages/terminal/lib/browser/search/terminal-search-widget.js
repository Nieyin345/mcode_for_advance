"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalSearchWidget = exports.TerminalSearchWidgetFactory = exports.TERMINAL_SEARCH_WIDGET_FACTORY_ID = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2019 Red Hat, Inc. and others.
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
const inversify_1 = require("@theia/core/shared/inversify");
const react_widget_1 = require("@theia/core/lib/browser/widgets/react-widget");
require("../../../src/browser/style/terminal-search.css");
const xterm_1 = require("xterm");
const xterm_addon_search_1 = require("xterm-addon-search");
const browser_1 = require("@theia/core/lib/browser");
const core_1 = require("@theia/core");
exports.TERMINAL_SEARCH_WIDGET_FACTORY_ID = 'terminal-search';
exports.TerminalSearchWidgetFactory = Symbol('TerminalSearchWidgetFactory');
let TerminalSearchWidget = class TerminalSearchWidget extends react_widget_1.ReactWidget {
    constructor() {
        super(...arguments);
        this.searchOptions = {};
        this.onSearchInputFocus = () => {
            if (this.searchBox) {
                this.searchBox.classList.add('focused');
            }
        };
        this.onSearchInputBlur = () => {
            if (this.searchBox) {
                this.searchBox.classList.remove('focused');
            }
        };
        this.handleHide = () => {
            this.hide();
        };
        this.handleCaseSensitiveOptionClicked = (event) => {
            this.searchOptions.caseSensitive = !this.searchOptions.caseSensitive;
            this.updateSearchInputBox(this.searchOptions.caseSensitive, event.currentTarget);
        };
        this.handleWholeWordOptionClicked = (event) => {
            this.searchOptions.wholeWord = !this.searchOptions.wholeWord;
            this.updateSearchInputBox(this.searchOptions.wholeWord, event.currentTarget);
        };
        this.handleRegexOptionClicked = (event) => {
            this.searchOptions.regex = !this.searchOptions.regex;
            this.updateSearchInputBox(this.searchOptions.regex, event.currentTarget);
        };
        this.onInputChanged = (event) => {
            // move to previous search result on `Shift + Enter`
            if (event && event.shiftKey && event.keyCode === browser_1.Key.ENTER.keyCode) {
                this.search(false, 'previous');
                return;
            }
            // move to next search result on `Enter`
            if (event && event.keyCode === browser_1.Key.ENTER.keyCode) {
                this.search(false, 'next');
                return;
            }
            this.search(true, 'next');
        };
        this.handleNextButtonClicked = () => {
            this.search(false, 'next');
        };
        this.handlePreviousButtonClicked = () => {
            this.search(false, 'previous');
        };
    }
    init() {
        this.node.classList.add('theia-search-terminal-widget-parent');
        this.searchAddon = new xterm_addon_search_1.SearchAddon();
        this.terminal.loadAddon(this.searchAddon);
        this.hide();
        this.update();
    }
    render() {
        return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-search-terminal-widget', children: [(0, jsx_runtime_1.jsxs)("div", { className: 'theia-search-elem-box', ref: searchBox => { this.searchBox = searchBox; }, children: [(0, jsx_runtime_1.jsx)("input", { title: core_1.nls.localizeByDefault('Find'), type: 'text', spellCheck: 'false', placeholder: core_1.nls.localizeByDefault('Find'), ref: ip => { this.searchInput = ip; }, onKeyUp: this.onInputChanged, onFocus: this.onSearchInputFocus, onBlur: this.onSearchInputBlur }), (0, jsx_runtime_1.jsx)("div", { title: core_1.nls.localizeByDefault('Match Case'), tabIndex: 0, className: 'search-elem ' + (0, browser_1.codicon)('case-sensitive'), onClick: this.handleCaseSensitiveOptionClicked }), (0, jsx_runtime_1.jsx)("div", { title: core_1.nls.localizeByDefault('Match Whole Word'), tabIndex: 0, className: 'search-elem ' + (0, browser_1.codicon)('whole-word'), onClick: this.handleWholeWordOptionClicked }), (0, jsx_runtime_1.jsx)("div", { title: core_1.nls.localizeByDefault('Use Regular Expression'), tabIndex: 0, className: 'search-elem ' + (0, browser_1.codicon)('regex'), onClick: this.handleRegexOptionClicked })] }), (0, jsx_runtime_1.jsx)("button", { title: core_1.nls.localizeByDefault('Previous Match'), className: 'search-elem ' + (0, browser_1.codicon)('arrow-up'), onClick: this.handlePreviousButtonClicked }), (0, jsx_runtime_1.jsx)("button", { title: core_1.nls.localizeByDefault('Next Match'), className: 'search-elem ' + (0, browser_1.codicon)('arrow-down'), onClick: this.handleNextButtonClicked }), (0, jsx_runtime_1.jsx)("button", { title: core_1.nls.localizeByDefault('Close'), className: 'search-elem ' + (0, browser_1.codicon)('close'), onClick: this.handleHide })] });
    }
    updateSearchInputBox(enable, optionElement) {
        if (enable) {
            optionElement.classList.add('option-enabled');
        }
        else {
            optionElement.classList.remove('option-enabled');
        }
        this.searchInput.focus();
    }
    search(incremental, searchDirection) {
        if (this.searchInput) {
            this.searchOptions.incremental = incremental;
            const searchText = this.searchInput.value;
            if (searchDirection === 'next') {
                this.searchAddon.findNext(searchText, this.searchOptions);
            }
            if (searchDirection === 'previous') {
                this.searchAddon.findPrevious(searchText, this.searchOptions);
            }
        }
    }
    onAfterHide() {
        this.terminal.focus();
    }
    onAfterShow() {
        if (this.searchInput) {
            this.searchInput.select();
        }
    }
};
exports.TerminalSearchWidget = TerminalSearchWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(xterm_1.Terminal),
    tslib_1.__metadata("design:type", xterm_1.Terminal)
], TerminalSearchWidget.prototype, "terminal", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], TerminalSearchWidget.prototype, "init", null);
exports.TerminalSearchWidget = TerminalSearchWidget = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TerminalSearchWidget);
//# sourceMappingURL=terminal-search-widget.js.map