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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
// @lumino/dragdrop (pulled in transitively) extends the DragEvent DOM global at
// module load, which JSDOM does not provide; stub it so the import succeeds.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!global.DragEvent) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.DragEvent = class DragEvent extends global.Event {
    };
}
const chai_1 = require("chai");
const colorRegistry_1 = require("@theia/monaco-editor-core/esm/vs/platform/theme/common/colorRegistry");
const monaco_quick_input_service_1 = require("./monaco-quick-input-service");
disableJSDOM();
/**
 * The quick input styles mirror VS Code's, referencing theme colors by id. Each
 * id is turned into a `var(--theia-<id>)` CSS custom property; a mis-cased or
 * misspelled id yields an undefined variable, silently breaking the styling
 * (e.g. the Command Palette hover highlight). This test guards against such
 * typos by checking every referenced color id against the registered colors.
 */
describe('MonacoQuickInputImplementation styles', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    it('should only reference registered color ids', () => {
        const registeredIds = new Set((0, colorRegistry_1.getColorRegistry)().getColors().map(color => color.id));
        // Mirror ColorRegistry.toCssVariableName without the full DI graph.
        const colorRegistry = { toCssVariableName: (id) => `--theia-${id.replace(/\./g, '-')}` };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const instance = Object.create(monaco_quick_input_service_1.MonacoQuickInputImplementation.prototype);
        instance.colorRegistry = colorRegistry;
        const styles = instance.computeStyles();
        const referencedIds = new Set();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const collect = (value) => {
            if (typeof value === 'string') {
                const match = /^var\(--theia-(.+)\)$/.exec(value);
                if (match) {
                    // No registered color id contains a dash, so dashes were dots.
                    referencedIds.add(match[1].replace(/-/g, '.'));
                }
            }
            else if (value && typeof value === 'object') {
                Object.values(value).forEach(collect);
            }
        };
        collect(styles);
        const unregistered = [...referencedIds].filter(id => !registeredIds.has(id)).sort();
        (0, chai_1.expect)(unregistered, `Unregistered color ids referenced by computeStyles: ${unregistered.join(', ')}`).to.be.empty;
    });
});
//# sourceMappingURL=monaco-quick-input-service.spec.js.map