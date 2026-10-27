"use strict";
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
var MarkdownString_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarkdownString = void 0;
const tslib_1 = require("tslib");
const markdown_rendering_1 = require("@theia/core/lib/common/markdown-rendering");
const types_1 = require("../common/types");
const types_impl_1 = require("./types-impl");
// Copied from https://github.com/microsoft/vscode/blob/7d9b1c37f8e5ae3772782ba3b09d827eb3fdd833/src/vs/workbench/api/common/extHostTypes.ts
let MarkdownString = MarkdownString_1 = class MarkdownString {
    #delegate;
    /**
     * @returns whether the thing is a markdown string implementation with helper methods.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static isMarkdownString(thing) {
        if (thing instanceof MarkdownString_1) {
            return true;
        }
        return thing && thing.appendCodeblock && thing.appendMarkdown && thing.appendText && (thing.value !== undefined);
    }
    constructor(value, supportThemeIcons = false) {
        this.#delegate = new markdown_rendering_1.MarkdownStringImpl(value, { supportThemeIcons });
    }
    get value() {
        return this.#delegate.value;
    }
    set value(value) {
        this.#delegate.value = value;
    }
    get isTrusted() {
        return this.#delegate.isTrusted;
    }
    set isTrusted(value) {
        this.#delegate.isTrusted = value;
    }
    get supportThemeIcons() {
        return this.#delegate.supportThemeIcons;
    }
    set supportThemeIcons(value) {
        this.#delegate.supportThemeIcons = value;
    }
    get supportHtml() {
        return this.#delegate.supportHtml;
    }
    set supportHtml(value) {
        this.#delegate.supportHtml = value;
    }
    get baseUri() {
        return types_impl_1.URI.revive(this.#delegate.baseUri);
    }
    set baseUri(value) {
        this.#delegate.baseUri = value;
    }
    appendText(value) {
        this.#delegate.appendText(value);
        return this;
    }
    appendMarkdown(value) {
        this.#delegate.appendMarkdown(value);
        return this;
    }
    appendCodeblock(value, language) {
        this.#delegate.appendCodeblock(language ?? '', value);
        return this;
    }
    toJSON() {
        const plainObject = { value: this.value };
        if (this.isTrusted !== undefined) {
            plainObject.isTrusted = this.isTrusted;
        }
        if (this.supportThemeIcons !== undefined) {
            plainObject.supportThemeIcons = this.supportThemeIcons;
        }
        if (this.supportHtml !== undefined) {
            plainObject.supportHtml = this.supportHtml;
        }
        if (this.baseUri !== undefined) {
            plainObject.baseUri = this.baseUri.toJSON();
        }
        return plainObject;
    }
};
exports.MarkdownString = MarkdownString;
exports.MarkdownString = MarkdownString = MarkdownString_1 = tslib_1.__decorate([
    types_1.es5ClassCompat,
    tslib_1.__metadata("design:paramtypes", [String, Boolean])
], MarkdownString);
//# sourceMappingURL=markdown-string.js.map