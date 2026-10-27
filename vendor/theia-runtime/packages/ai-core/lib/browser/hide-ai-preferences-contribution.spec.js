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
const chai_1 = require("chai");
const core_1 = require("@theia/core");
const hide_ai_preferences_contribution_1 = require("./hide-ai-preferences-contribution");
/**
 * Stub of the parts of {@link PreferenceSchemaService} the contribution touches, faithful in the two ways
 * that matter here: `getSchemaProperties` hands out the live map, and `updateSchemaProperty` merges into it
 * and fires `onDidChangeSchema` synchronously.
 */
function createService(entries) {
    const properties = new Map(entries);
    const schemaChanged = new core_1.Emitter();
    const updates = [];
    const service = {
        getSchemaProperties: () => properties,
        updateSchemaProperty: (key, property) => {
            updates.push(key);
            properties.set(key, { ...properties.get(key), ...property });
            schemaChanged.fire();
        },
        onDidChangeSchema: schemaChanged.event
    };
    return {
        service: service,
        updates,
        addProperty: (key, property) => {
            properties.set(key, property);
            schemaChanged.fire();
        },
        isHidden: key => properties.get(key)?.hidden
    };
}
describe('HideAiPreferencesContribution', () => {
    it('hides every ai-features.* preference from the Settings UI, keeping non-AI ones and leaving the AI Configuration view unaffected', async () => {
        const test = createService([
            ['ai-features.chat.tokenUsageIndicator.enabled', { type: 'boolean' }],
            ['ai-features.anthropic.apiKey', { type: 'string' }],
            // The redirect placeholder that links to the view stays visible in Settings.
            [hide_ai_preferences_contribution_1.AI_CONFIGURATION_OPEN_PREFERENCE_ID, { type: 'null' }],
            // Already hidden: left as-is (not re-updated).
            ['ai-features.mcp.mcpServers', { type: 'object', hidden: true }],
            // Non-AI preference: untouched.
            ['editor.fontSize', { type: 'number' }]
        ]);
        await new hide_ai_preferences_contribution_1.HideAiPreferencesContribution().initSchema(test.service);
        // Exactly the not-yet-hidden AI preferences are hidden — never the redirect placeholder or non-AI ones.
        (0, chai_1.expect)([...test.updates].sort()).to.deep.equal(['ai-features.anthropic.apiKey', 'ai-features.chat.tokenUsageIndicator.enabled']);
        (0, chai_1.expect)(test.isHidden('ai-features.anthropic.apiKey')).to.equal(true);
        (0, chai_1.expect)(test.isHidden('ai-features.chat.tokenUsageIndicator.enabled')).to.equal(true);
        (0, chai_1.expect)(test.isHidden(hide_ai_preferences_contribution_1.AI_CONFIGURATION_OPEN_PREFERENCE_ID)).to.equal(undefined);
        (0, chai_1.expect)(test.isHidden('editor.fontSize')).to.equal(undefined);
    });
    it('hides ai-features.* preferences registered after the initial pass', async () => {
        const test = createService([['editor.fontSize', { type: 'number' }]]);
        await new hide_ai_preferences_contribution_1.HideAiPreferencesContribution().initSchema(test.service);
        (0, chai_1.expect)(test.updates).to.be.empty;
        // A schema contributed later, e.g. by a contribution whose own `initSchema` awaited first.
        test.addProperty('ai-features.google.apiKey', { type: 'string' });
        (0, chai_1.expect)(test.isHidden('ai-features.google.apiKey')).to.equal(true);
    });
    it('leaves the redirect placeholder visible when later schema changes retrigger the pass', async () => {
        const test = createService([[hide_ai_preferences_contribution_1.AI_CONFIGURATION_OPEN_PREFERENCE_ID, { type: 'null' }]]);
        await new hide_ai_preferences_contribution_1.HideAiPreferencesContribution().initSchema(test.service);
        test.addProperty('ai-features.openai.apiKey', { type: 'string' });
        (0, chai_1.expect)(test.isHidden(hide_ai_preferences_contribution_1.AI_CONFIGURATION_OPEN_PREFERENCE_ID)).to.equal(undefined);
    });
    it('writes each preference once even though every update fires a schema change', async () => {
        const test = createService([
            ['ai-features.a', { type: 'string' }],
            ['ai-features.b', { type: 'string' }],
            ['ai-features.c', { type: 'string' }]
        ]);
        await new hide_ai_preferences_contribution_1.HideAiPreferencesContribution().initSchema(test.service);
        // Each write re-triggers the listener, so a non-idempotent pass would rewrite keys it already hid.
        (0, chai_1.expect)(test.updates).to.have.lengthOf(3);
        (0, chai_1.expect)([...test.updates].sort()).to.deep.equal(['ai-features.a', 'ai-features.b', 'ai-features.c']);
    });
});
//# sourceMappingURL=hide-ai-preferences-contribution.spec.js.map