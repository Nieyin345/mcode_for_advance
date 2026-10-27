"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Card = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
const keyboard_utils_1 = require("../keyboard/keyboard-utils");
/**
 * A reusable component for presentation of a card providing a capsule summary of some
 * data, article, or other object. Cards provide interaction behaviour when the `onClick`
 * call-back prop is supplied.
 */
exports.Card = React.memo(function Card(props) {
    const { icon, title, subtitle, onClick, className, children, maxTitleLines = 4, titleTooltip, actionButtons } = props;
    const isInteractive = onClick !== undefined;
    const [hasFocus, setHasFocus] = React.useState(false);
    const handleKeyDown = React.useCallback((e) => {
        if (onClick && (0, keyboard_utils_1.isActivationKey)(e)) {
            e.preventDefault();
            onClick();
        }
    }, [onClick]);
    const handleFocus = React.useCallback(() => setHasFocus(true), []);
    const handleBlur = React.useCallback((e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
            setHasFocus(false);
        }
    }, []);
    const cardClasses = [
        'theia-Card',
        isInteractive && 'theia-Card-interactive',
        className
    ].filter(Boolean).join(' ');
    const titleStyle = {
        WebkitLineClamp: maxTitleLines
    };
    return ((0, jsx_runtime_1.jsxs)("div", { className: cardClasses, onClick: onClick, role: isInteractive ? 'button' : undefined, tabIndex: isInteractive ? 0 : undefined, onKeyDown: isInteractive ? handleKeyDown : undefined, onFocus: actionButtons ? handleFocus : undefined, onBlur: actionButtons ? handleBlur : undefined, children: [icon && ((0, jsx_runtime_1.jsx)("div", { className: `theia-Card-icon ${icon}` })), (0, jsx_runtime_1.jsxs)("div", { className: "theia-Card-content", children: [(0, jsx_runtime_1.jsx)("div", { className: "theia-Card-title", title: titleTooltip, style: titleStyle, children: title }), actionButtons ? ((0, jsx_runtime_1.jsxs)("div", { className: "theia-Card-footer", children: [subtitle && (0, jsx_runtime_1.jsx)("span", { className: "theia-Card-footer-time", children: subtitle }), (0, jsx_runtime_1.jsx)("div", { className: "theia-Card-footer-actions", children: actionButtons.map((btn, i) => ((0, jsx_runtime_1.jsx)("button", { className: `theia-Card-action-btn ${btn.iconClass}`, title: btn.title, ...(0, keyboard_utils_1.buttonKeyboardProps)(btn.title, hasFocus ? 0 : -1), onClick: btn.onClick }, i))) })] })) : (subtitle && ((0, jsx_runtime_1.jsx)("div", { className: "theia-Card-subtitle", children: subtitle }))), children] })] }));
});
//# sourceMappingURL=card.js.map