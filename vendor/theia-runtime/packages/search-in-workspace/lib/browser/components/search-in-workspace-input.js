"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchInWorkspaceInput = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2021 Ericsson and others.
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
const React = require("@theia/core/shared/react");
const browser_1 = require("@theia/core/lib/browser");
const debounce = require("@theia/core/shared/lodash.debounce");
;
class SearchInWorkspaceInput extends React.Component {
    static { this.LIMIT = 100; }
    constructor(props) {
        super(props);
        this.input = React.createRef();
        /**
         * Handle history navigation without overriding the parent's onKeyDown handler, if any.
         */
        this.onKeyDown = (e) => {
            if (browser_1.Key.ARROW_UP.keyCode === browser_1.KeyCode.createKeyCode(e.nativeEvent).key?.keyCode) {
                e.preventDefault();
                this.previousValue();
            }
            else if (browser_1.Key.ARROW_DOWN.keyCode === browser_1.KeyCode.createKeyCode(e.nativeEvent).key?.keyCode) {
                e.preventDefault();
                this.nextValue();
            }
            this.props.onKeyDown?.(e);
        };
        /**
         * Handle history collection without overriding the parent's onChange handler, if any.
         */
        this.onChange = (e) => {
            this.addToHistory();
            this.props.onChange?.(e);
        };
        /**
         * Add a nonempty current value to the history, if not already present. (Debounced, 1 second delay.)
         */
        this.addToHistory = debounce(this.doAddToHistory, 1000);
        this.state = {
            history: [],
            index: 0,
        };
    }
    updateState(index, history) {
        this.value = history ? history[index] : this.state.history[index];
        this.setState(prevState => {
            const newState = {
                ...prevState,
                index,
            };
            if (history) {
                newState.history = history;
            }
            return newState;
        });
    }
    get value() {
        return this.input.current?.value ?? '';
    }
    set value(value) {
        if (this.input.current) {
            this.input.current.value = value;
        }
    }
    /**
     * Switch the input's text to the previous value, if any.
     */
    previousValue() {
        const { history, index } = this.state;
        if (!this.value) {
            this.value = history[index];
        }
        else if (index > 0 && index < history.length) {
            this.updateState(index - 1);
        }
    }
    /**
     * Switch the input's text to the next value, if any.
     */
    nextValue() {
        const { history, index } = this.state;
        if (index === history.length - 1) {
            this.value = '';
        }
        else if (!this.value) {
            this.value = history[index];
        }
        else if (index >= 0 && index < history.length - 1) {
            this.updateState(index + 1);
        }
    }
    doAddToHistory() {
        if (!this.value) {
            return;
        }
        const history = this.state.history
            .filter(term => term !== this.value)
            .concat(this.value)
            .slice(-SearchInWorkspaceInput.LIMIT);
        this.updateState(history.length - 1, history);
    }
    render() {
        return ((0, jsx_runtime_1.jsx)("input", { ...this.props, onKeyDown: this.onKeyDown, onChange: this.onChange, spellCheck: false, ref: this.input }));
    }
}
exports.SearchInWorkspaceInput = SearchInWorkspaceInput;
//# sourceMappingURL=search-in-workspace-input.js.map