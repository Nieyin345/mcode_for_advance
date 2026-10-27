"use strict";
// *****************************************************************************
// Copyright (C) 2026 Maksim Kachurin and others.
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
exports.ICON_NAME_SEGMENT = exports.PreferenceScope = void 0;
/** Keep numeric values aligned with `PreferenceScope` in `@theia/core`. */
var PreferenceScope;
(function (PreferenceScope) {
    PreferenceScope[PreferenceScope["Default"] = 0] = "Default";
    PreferenceScope[PreferenceScope["User"] = 1] = "User";
    PreferenceScope[PreferenceScope["Workspace"] = 2] = "Workspace";
    PreferenceScope[PreferenceScope["Folder"] = 3] = "Folder";
})(PreferenceScope || (exports.PreferenceScope = PreferenceScope = {}));
/** Same segment as `CSSIcon.iconNameSegment` in `@theia/core`. */
exports.ICON_NAME_SEGMENT = '[A-Za-z0-9]+';
//# sourceMappingURL=protocol-shims.js.map