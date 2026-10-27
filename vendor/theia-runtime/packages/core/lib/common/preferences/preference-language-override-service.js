"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PreferenceLanguageOverrideService = exports.getOverridePattern = exports.OVERRIDE_PROPERTY_PATTERN = exports.OverridePreferenceName = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const types_1 = require("../types");
const preference_schema_1 = require("./preference-schema");
const strings_1 = require("../strings");
var OverridePreferenceName;
(function (OverridePreferenceName) {
    function is(arg) {
        return (0, types_1.isObject)(arg) && 'preferenceName' in arg && 'overrideIdentifier' in arg;
    }
    OverridePreferenceName.is = is;
})(OverridePreferenceName || (exports.OverridePreferenceName = OverridePreferenceName = {}));
const OVERRIDE_PROPERTY = '\\[(.*)\\]$';
exports.OVERRIDE_PROPERTY_PATTERN = new RegExp(OVERRIDE_PROPERTY);
const getOverridePattern = (identifier) => `\\[(${identifier})\\]$`;
exports.getOverridePattern = getOverridePattern;
let PreferenceLanguageOverrideService = class PreferenceLanguageOverrideService {
    static testOverrideValue(name, value) {
        return (0, types_1.isObject)(value) && exports.OVERRIDE_PROPERTY_PATTERN.test(name);
    }
    /**
     * @param overrideIdentifier the language id associated for a language override, e.g. `typescript`
     * @returns the form used to mark language overrides in preference files, e.g. `[typescript]`
     */
    markLanguageOverride(overrideIdentifier) {
        return `[${overrideIdentifier}]`;
    }
    /**
     * @returns the flat JSON path to an overridden preference, e.g. [typescript].editor.tabSize.
     */
    overridePreferenceName({ preferenceName, overrideIdentifier }) {
        return `${this.markLanguageOverride(overrideIdentifier)}.${preferenceName}`;
    }
    /**
     * @returns an OverridePreferenceName if the `name` contains a language override, e.g. [typescript].editor.tabSize.
     */
    overriddenPreferenceName(name) {
        const index = name.indexOf('.');
        if (index === -1) {
            return undefined;
        }
        const matches = name.substring(0, index).match(exports.OVERRIDE_PROPERTY_PATTERN);
        const overrideIdentifier = matches && matches[1];
        if (!overrideIdentifier || !this.preferenceSchemaService.overrideIdentifiers.has(overrideIdentifier)) {
            return undefined;
        }
        const preferenceName = name.substring(index + 1);
        return { preferenceName, overrideIdentifier };
    }
    computeOverridePatternPropertiesKey() {
        let param = '';
        for (const overrideIdentifier of this.preferenceSchemaService.overrideIdentifiers) {
            if (param.length) {
                param += '|';
            }
            param += new RegExp((0, strings_1.escapeRegExpCharacters)(overrideIdentifier)).source;
        }
        return param.length ? (0, exports.getOverridePattern)(param) : undefined;
    }
    *getOverridePreferenceNames(preferenceName) {
        for (const overrideIdentifier of this.preferenceSchemaService.overrideIdentifiers) {
            yield this.overridePreferenceName({ preferenceName, overrideIdentifier });
        }
    }
};
exports.PreferenceLanguageOverrideService = PreferenceLanguageOverrideService;
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_schema_1.PreferenceSchemaService),
    tslib_1.__metadata("design:type", Object)
], PreferenceLanguageOverrideService.prototype, "preferenceSchemaService", void 0);
exports.PreferenceLanguageOverrideService = PreferenceLanguageOverrideService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceLanguageOverrideService);
//# sourceMappingURL=preference-language-override-service.js.map