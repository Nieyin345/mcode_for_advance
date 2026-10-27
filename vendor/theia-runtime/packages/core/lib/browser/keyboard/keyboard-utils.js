"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
exports.isActivationKey = isActivationKey;
exports.buttonKeyboardProps = buttonKeyboardProps;
/**
 * Query whether the keyboard event represents an element activation.
 * That is, whether the user pressed `Enter` or `Space` on a focusable
 * element with `role="button"` or similar interactive role.
 */
function isActivationKey(e) {
    return e.key === 'Enter' || e.key === ' ';
}
/**
 * Returns the ARIA/accessibility props that make a non-button HTML element
 * keyboard-navigable and screen-reader-accessible as a button.
 *
 * Spread these onto the element alongside `onClick` and `onKeyDown`:
 * ```tsx
 * <div {...buttonKeyboardProps(label)} onClick={handler} onKeyDown={e => isActivationKey(e) && handler()} />
 * ```
 */
function buttonKeyboardProps(ariaLabel, tabIndex = 0) {
    return { tabIndex, role: 'button', 'aria-label': ariaLabel };
}
//# sourceMappingURL=keyboard-utils.js.map