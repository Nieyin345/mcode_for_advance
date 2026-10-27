"use strict";
// *****************************************************************************
// Copyright (C) 2021 TypeFox and others.
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
exports.loadPackageTranslations = loadPackageTranslations;
const path = require("path");
const fs = require("fs-extra");
const utils_1 = require("../common/utils");
const package_nls_1 = require("../common/package-nls");
async function loadPackageTranslations(pluginPath, locale) {
    const defaultPath = path.join(pluginPath, 'package.nls.json');
    try {
        const defaultValue = (0, package_nls_1.coerceLocalizations)(await fs.readJson(defaultPath));
        if (locale) {
            const localizedPath = path.join(pluginPath, `package.nls.${locale}.json`);
            if (await fs.pathExists(localizedPath)) {
                return {
                    translation: (0, package_nls_1.coerceLocalizations)(await fs.readJson(localizedPath)),
                    default: defaultValue
                };
            }
        }
        return { default: defaultValue };
    }
    catch (error) {
        if ((0, utils_1.isENOENT)(error)) {
            return {};
        }
        throw error;
    }
}
//# sourceMappingURL=package-nls.js.map