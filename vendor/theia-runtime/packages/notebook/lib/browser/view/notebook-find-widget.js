"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotebookFindWidget = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2024 TypeFox and others.
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
const React = require("@theia/core/shared/react");
const browser_1 = require("@theia/core/lib/browser");
const debounce = require("@theia/core/shared/lodash.debounce");
class NotebookFindWidget extends React.Component {
    constructor(props) {
        super(props);
        this.searchRef = React.createRef();
        this.debounceSearch = debounce(this.search.bind(this), 50);
        this.state = {
            search: '',
            replace: '',
            currentMatch: 0,
            matches: [],
            expanded: false,
            matchCase: false,
            regex: false,
            wholeWord: false,
            activeFilters: props.filters?.filter(filter => filter.active).map(filter => filter.id) || []
        };
    }
    render() {
        const hasMatches = this.hasMatches();
        const canReplace = this.canReplace();
        const canReplaceAll = this.canReplaceAll();
        return ((0, jsx_runtime_1.jsxs)("div", { onKeyUp: event => {
                if (event.key === 'Escape') {
                    this.props.onClose();
                }
            }, className: `theia-notebook-find-widget ${!this.state.expanded ? 'search-mode' : ''} ${this.props.hidden ? 'hidden' : ''}`, children: [(0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-find-widget-expand', title: core_1.nls.localizeByDefault('Toggle Replace'), onClick: () => {
                        this.setState({
                            expanded: !this.state.expanded
                        });
                    }, children: (0, jsx_runtime_1.jsx)("div", { className: (0, browser_1.codicon)(`chevron-${this.state.expanded ? 'down' : 'right'}`) }) }), (0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-find-widget-inputs', children: [(0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-find-widget-input-wrapper', children: [(0, jsx_runtime_1.jsx)("input", { ref: this.searchRef, type: 'text', className: 'theia-input theia-notebook-find-widget-input', placeholder: core_1.nls.localizeByDefault('Find'), value: this.state.search, onChange: event => {
                                        this.setState({
                                            search: event.target.value
                                        });
                                        this.debounceSearch({});
                                    }, onKeyDown: event => {
                                        if (event.key === 'Enter') {
                                            if (event.shiftKey) {
                                                this.gotoPreviousMatch();
                                            }
                                            else {
                                                this.gotoNextMatch();
                                            }
                                            event.preventDefault();
                                        }
                                    } }), (0, jsx_runtime_1.jsx)("div", { className: `${(0, browser_1.codicon)('case-sensitive', true)} option ${this.state.matchCase ? 'enabled' : ''}`, title: core_1.nls.localizeByDefault('Match Case'), onClick: () => {
                                        this.search({
                                            matchCase: !this.state.matchCase
                                        });
                                    } }), (0, jsx_runtime_1.jsx)("div", { className: `${(0, browser_1.codicon)('whole-word', true)} option ${this.state.wholeWord ? 'enabled' : ''}`, title: core_1.nls.localizeByDefault('Match Whole Word'), onClick: () => {
                                        this.search({
                                            wholeWord: !this.state.wholeWord
                                        });
                                    } }), (0, jsx_runtime_1.jsx)("div", { className: `${(0, browser_1.codicon)('regex', true)} option ${this.state.regex ? 'enabled' : ''}`, title: core_1.nls.localizeByDefault('Use Regular Expression'), onClick: () => {
                                        this.search({
                                            regex: !this.state.regex
                                        });
                                    } })] }), (0, jsx_runtime_1.jsx)("input", { type: 'text', className: 'theia-input theia-notebook-find-widget-replace', placeholder: core_1.nls.localizeByDefault('Replace'), value: this.state.replace, onChange: event => {
                                this.setState({
                                    replace: event.target.value
                                });
                            }, onKeyDown: event => {
                                if (event.key === 'Enter') {
                                    this.replaceOne();
                                    event.preventDefault();
                                }
                            } })] }), (0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-find-widget-buttons', children: [(0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-find-widget-buttons-first', children: [(0, jsx_runtime_1.jsx)("div", { className: 'theia-notebook-find-widget-matches-count', children: this.getMatchesCount() }), (0, jsx_runtime_1.jsx)("div", { className: `${(0, browser_1.codicon)('arrow-up', hasMatches)} ${hasMatches ? '' : 'disabled'}`, title: core_1.nls.localizeByDefault('Previous Match'), onClick: () => {
                                        this.gotoPreviousMatch();
                                    } }), (0, jsx_runtime_1.jsx)("div", { className: `${(0, browser_1.codicon)('arrow-down', hasMatches)} ${hasMatches ? '' : 'disabled'}`, title: core_1.nls.localizeByDefault('Next Match'), onClick: () => {
                                        this.gotoNextMatch();
                                    } }), (0, jsx_runtime_1.jsx)("div", { className: (0, browser_1.codicon)('close', true), title: core_1.nls.localizeByDefault('Close'), onClick: () => {
                                        this.props.onClose();
                                    } })] }), (0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-find-widget-buttons-second', children: [(0, jsx_runtime_1.jsx)("div", { className: `${(0, browser_1.codicon)('replace', canReplace)} ${canReplace ? '' : 'disabled'}`, title: core_1.nls.localizeByDefault('Replace'), onClick: () => {
                                        this.replaceOne();
                                    } }), (0, jsx_runtime_1.jsx)("div", { className: `${(0, browser_1.codicon)('replace-all', canReplaceAll)} ${canReplaceAll ? '' : 'disabled'}`, title: core_1.nls.localizeByDefault('Replace All'), onClick: () => {
                                        this.replaceAll();
                                    } })] })] })] }));
    }
    hasMatches() {
        return this.state.matches.length > 0;
    }
    canReplace() {
        return Boolean(this.state.matches[this.state.currentMatch]?.replace);
    }
    canReplaceAll() {
        return this.state.matches.some(match => Boolean(match.replace));
    }
    getMatchesCount() {
        if (this.hasMatches()) {
            return core_1.nls.localizeByDefault('{0} of {1}', this.state.currentMatch + 1, this.state.matches.length);
        }
        else {
            return core_1.nls.localizeByDefault('No results');
        }
    }
    gotoNextMatch() {
        this.search({
            modifyIndex: (matches, index) => (index + 1) % matches.length,
            jumpToMatch: true
        });
    }
    gotoPreviousMatch() {
        this.search({
            modifyIndex: (matches, index) => (index === 0 ? matches.length : index) - 1,
            jumpToMatch: true
        });
    }
    replaceOne() {
        const existingMatches = this.state.matches;
        const match = existingMatches[this.state.currentMatch];
        if (match) {
            match.replace?.(this.state.replace);
            this.search({
                jumpToMatch: true,
                modifyIndex: (matches, index) => {
                    if (matches.length < existingMatches.length) {
                        return index % matches.length;
                    }
                    else {
                        const diff = matches.length - existingMatches.length;
                        return (index + diff + 1) % matches.length;
                    }
                }
            });
        }
    }
    replaceAll() {
        this.props.onReplace(this.state.matches, this.state.replace);
        this.search({});
    }
    componentDidUpdate(prevProps, prevState) {
        if (!this.props.hidden && prevProps.hidden) {
            // Focus the search input when the widget switches from hidden to visible.
            this.searchRef.current?.focus();
        }
    }
    focusSearch(content) {
        this.searchRef.current?.focus();
        if (content) {
            this.search({
                search: content,
                jumpToMatch: false
            });
        }
    }
    search(options) {
        const matchCase = options.matchCase ?? this.state.matchCase;
        const wholeWord = options.wholeWord ?? this.state.wholeWord;
        const regex = options.regex ?? this.state.regex;
        const search = options.search ?? this.state.search;
        const matches = this.props.onSearch({
            search,
            matchCase,
            wholeWord,
            regex,
            activeFilters: this.state.activeFilters
        });
        let currentMatch = Math.max(0, Math.min(this.state.currentMatch, matches.length - 1));
        if (options.modifyIndex && matches.length > 0) {
            currentMatch = options.modifyIndex(matches, currentMatch);
        }
        const selectedMatch = matches[currentMatch];
        if (selectedMatch) {
            selectedMatch.selected = true;
            if (options.jumpToMatch) {
                selectedMatch.show();
            }
        }
        this.setState({
            search,
            matches,
            currentMatch,
            matchCase,
            wholeWord,
            regex
        });
    }
}
exports.NotebookFindWidget = NotebookFindWidget;
//# sourceMappingURL=notebook-find-widget.js.map