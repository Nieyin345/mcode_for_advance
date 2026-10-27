"use strict";
// *****************************************************************************
// Copyright (C) 2019 TypeFox and others.
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
exports.MonacoColorRegistry = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const color_registry_1 = require("@theia/core/lib/browser/color-registry");
const color_1 = require("@theia/core/lib/common/color");
const disposable_1 = require("@theia/core/lib/common/disposable");
const colorRegistry_1 = require("@theia/monaco-editor-core/esm/vs/platform/theme/common/colorRegistry");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const standaloneTheme_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/common/standaloneTheme");
const color_2 = require("@theia/monaco-editor-core/esm/vs/base/common/color");
const Colors = require("@theia/monaco-editor-core/esm/vs/platform/theme/common/colorRegistry");
let MonacoColorRegistry = class MonacoColorRegistry extends color_registry_1.ColorRegistry {
    constructor() {
        super(...arguments);
        this.monacoThemeService = standaloneServices_1.StandaloneServices.get(standaloneTheme_1.IStandaloneThemeService);
        this.monacoColorRegistry = (0, colorRegistry_1.getColorRegistry)();
    }
    *getColors() {
        for (const { id } of this.monacoColorRegistry.getColors()) {
            yield id;
        }
    }
    getCurrentColor(id) {
        return this.monacoThemeService.getColorTheme().getColor(id)?.toString();
    }
    getColor(id) {
        return this.monacoThemeService.getColorTheme().getColor(id);
    }
    doRegister(definition) {
        const defaults = {
            dark: this.toColor(color_1.ColorDefaults.getDark(definition.defaults)),
            light: this.toColor(color_1.ColorDefaults.getLight(definition.defaults)),
            hcDark: this.toColor(color_1.ColorDefaults.getHCDark(definition.defaults)),
            hcLight: this.toColor(color_1.ColorDefaults.getHCLight(definition.defaults)),
        };
        const identifier = this.monacoColorRegistry.registerColor(definition.id, defaults, definition.description);
        return disposable_1.Disposable.create(() => this.monacoColorRegistry.deregisterColor(identifier));
    }
    toColor(value) {
        if (!value || typeof value === 'string') {
            return value ?? null; // eslint-disable-line no-null/no-null
        }
        if ('kind' in value) {
            return Colors[value.kind](value.v, value.f);
        }
        else if ('r' in value) {
            const { r, g, b, a } = value;
            return new color_2.Color(new color_2.RGBA(r, g, b, a));
        }
        else {
            const { h, s, l, a } = value;
            return new color_2.Color(new color_2.HSLA(h, s, l, a));
        }
    }
};
exports.MonacoColorRegistry = MonacoColorRegistry;
exports.MonacoColorRegistry = MonacoColorRegistry = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoColorRegistry);
//# sourceMappingURL=monaco-color-registry.js.map