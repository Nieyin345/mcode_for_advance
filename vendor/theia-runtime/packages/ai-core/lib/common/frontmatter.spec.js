"use strict";
// *****************************************************************************
// Copyright (C) 2026 Safi Seid-Ahmad, K2view and others.
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
const chai_1 = require("chai");
const frontmatter_1 = require("./frontmatter");
function isAgentMeta(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const entry = value;
    return typeof entry.name === 'string' && typeof entry.defaultLLM === 'string';
}
describe('parseFrontmatter', () => {
    it('parses standard frontmatter with leading and trailing fences', () => {
        const content = '---\nname: my-agent\ndefaultLLM: default/universal\n---\nBody goes here.';
        const { metadata, body } = (0, frontmatter_1.parseFrontmatter)(content, { isValid: isAgentMeta });
        (0, chai_1.expect)(metadata).to.deep.equal({ name: 'my-agent', defaultLLM: 'default/universal' });
        (0, chai_1.expect)(body).to.equal('Body goes here.');
    });
    it('parses the legacy YAML-then-separator layout (no leading fence)', () => {
        const content = 'name: my-agent\ndefaultLLM: default/universal\n---\nBody goes here.';
        const { metadata, body } = (0, frontmatter_1.parseFrontmatter)(content, { isValid: isAgentMeta });
        (0, chai_1.expect)(metadata).to.deep.equal({ name: 'my-agent', defaultLLM: 'default/universal' });
        (0, chai_1.expect)(body).to.equal('Body goes here.');
    });
    it('returns undefined metadata when there is no frontmatter at all', () => {
        const content = '# Just markdown';
        const { metadata, body } = (0, frontmatter_1.parseFrontmatter)(content, { isValid: isAgentMeta });
        (0, chai_1.expect)(metadata).to.be.undefined;
        (0, chai_1.expect)(body).to.equal(content);
    });
    it('returns undefined metadata when the YAML is malformed', () => {
        const content = '---\nname: agent\nbad: [unclosed\n---\nbody';
        const { metadata, body } = (0, frontmatter_1.parseFrontmatter)(content, { isValid: isAgentMeta });
        (0, chai_1.expect)(metadata).to.be.undefined;
        (0, chai_1.expect)(body).to.equal(content);
    });
    it('falls back to undefined metadata when the type guard rejects the parsed YAML', () => {
        const content = '---\nname: my-agent\n---\nbody';
        const { metadata, body } = (0, frontmatter_1.parseFrontmatter)(content, { isValid: isAgentMeta });
        (0, chai_1.expect)(metadata).to.be.undefined;
        (0, chai_1.expect)(body).to.equal(content);
    });
    it('treats input that opens with --- but never closes as having no metadata', () => {
        const content = '---\nThis is not valid YAML front matter\nSkill content';
        const { metadata, body } = (0, frontmatter_1.parseFrontmatter)(content);
        (0, chai_1.expect)(metadata).to.be.undefined;
        (0, chai_1.expect)(body).to.equal(content);
    });
    it('round-trips through serializeFrontmatter', () => {
        const meta = { name: 'agent', defaultLLM: 'default/universal', showInChat: true };
        const body = 'Hello {{user_input}}';
        const serialized = (0, frontmatter_1.serializeFrontmatter)(meta, body);
        const parsed = (0, frontmatter_1.parseFrontmatter)(serialized);
        (0, chai_1.expect)(parsed.metadata).to.deep.equal(meta);
        (0, chai_1.expect)(parsed.body).to.equal(body);
    });
});
//# sourceMappingURL=frontmatter.spec.js.map