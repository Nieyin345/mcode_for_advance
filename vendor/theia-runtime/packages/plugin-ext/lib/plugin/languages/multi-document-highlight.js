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
exports.MultiDocumentHighlightAdapter = void 0;
const vscode_uri_1 = require("@theia/core/shared/vscode-uri");
const types = require("../types-impl");
const Converter = require("../type-converters");
class MultiDocumentHighlightAdapter {
    constructor(provider, documents) {
        this.provider = provider;
        this.documents = documents;
    }
    provideMultiDocumentHighlights(resource, position, otherResources, token) {
        const documentData = this.documents.getDocumentData(resource);
        if (!documentData) {
            return Promise.reject(new Error(`There is no document for ${resource}`));
        }
        const document = documentData.document;
        const zeroBasedPosition = Converter.toPosition(position);
        const otherDocuments = [];
        for (const otherResource of otherResources) {
            const otherUri = vscode_uri_1.URI.revive(otherResource);
            const otherDocData = this.documents.getDocumentData(otherUri);
            if (otherDocData) {
                otherDocuments.push(otherDocData.document);
            }
        }
        return Promise.resolve(this.provider.provideMultiDocumentHighlights(document, zeroBasedPosition, otherDocuments, token)).then(result => {
            if (!result) {
                return undefined;
            }
            if (!this.isMultiDocumentHighlightArray(result)) {
                return undefined;
            }
            return result.map(multiHighlight => ({
                uri: multiHighlight.uri,
                highlights: multiHighlight.highlights.map(h => Converter.fromDocumentHighlight(h))
            }));
        });
    }
    isMultiDocumentHighlightArray(array) {
        return Array.isArray(array) && array.length > 0 && array[0] instanceof types.MultiDocumentHighlight;
    }
}
exports.MultiDocumentHighlightAdapter = MultiDocumentHighlightAdapter;
//# sourceMappingURL=multi-document-highlight.js.map