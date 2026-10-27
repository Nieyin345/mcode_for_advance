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
Object.defineProperty(exports, "__esModule", { value: true });
exports.isHighContrast = isHighContrast;
exports.getThemeMode = getThemeMode;
exports.isThemeColor = isThemeColor;
exports.isThemeIcon = isThemeIcon;
function isHighContrast(scheme) {
    return scheme === 'hc' || scheme === 'hcLight';
}
function getThemeMode(type) {
    return (type === 'hc' || type === 'dark') ? 'dark' : 'light';
}
// Copied from https://github.com/microsoft/vscode/blob/1.106.1/src/vs/base/common/themables.ts
function isThemeColor(obj) {
    return !!obj && typeof obj === 'object' && typeof obj.id === 'string';
}
// Copied and modified from https://github.com/microsoft/vscode/blob/1.106.1/src/vs/base/common/themables.ts
function isThemeIcon(obj) {
    return !!obj &&
        typeof obj === 'object' &&
        typeof obj.id === 'string' &&
        (typeof obj.color === 'undefined' || isThemeColor(obj.color));
}
//# sourceMappingURL=theme.js.map