"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
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
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
// The skill service reaches browser-side modules at import time.
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
try {
    frontend_application_config_provider_1.FrontendApplicationConfigProvider.get();
}
catch {
    frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
}
const chai_1 = require("chai");
const core_1 = require("@theia/core");
const skill_prompt_coordinator_1 = require("./skill-prompt-coordinator");
after(() => disableJSDOM());
/** Records what the coordinator registers, which is all these tests are about. */
class FakePromptService {
    constructor() {
        this.added = [];
        this.removed = [];
    }
    addBuiltInPromptFragment(fragment) {
        this.added.push(fragment);
    }
    removePromptFragment(id) {
        this.removed.push(id);
    }
}
function skill(qualifiedName) {
    return {
        name: qualifiedName.substring(qualifiedName.indexOf(':') + 1),
        qualifiedName,
        description: 'Does a thing.',
        location: `/plugins/x/skills/${qualifiedName}`
    };
}
function coordinator(skills) {
    const prompts = new FakePromptService();
    const changed = new core_1.Emitter();
    const instance = new skill_prompt_coordinator_1.SkillPromptCoordinator();
    Object.assign(instance, {
        promptService: prompts,
        skillService: {
            ready: Promise.resolve(),
            getSkills: () => skills,
            onSkillsChanged: changed.event
        }
    });
    return { instance, prompts, changed };
}
describe('SkillPromptCoordinator', () => {
    it('keeps the colon out of the fragment id, because the id becomes a customization file name', async () => {
        // A colon is a reserved character in a Windows file name: `getTemplateURI` turns the fragment id
        // straight into one, so a customization of this fragment would either fail to write or land in
        // an alternate data stream that the directory scan never reads back.
        const { instance, prompts } = coordinator([skill('io.github.acme_tools:query-builder')]);
        await instance.onStart();
        (0, chai_1.expect)(prompts.added).to.have.lengthOf(1);
        (0, chai_1.expect)(prompts.added[0].id).to.equal('skill-command-io.github.acme_tools__query-builder');
        (0, chai_1.expect)(prompts.added[0].id).to.not.contain(':');
    });
    it('keeps the command name qualified, so the skill is still addressed as <qualifier>:<skill>', async () => {
        const { instance, prompts } = coordinator([skill('io.github.acme_tools:query-builder')]);
        await instance.onStart();
        (0, chai_1.expect)(prompts.added[0].commandName).to.equal('io.github.acme_tools:query-builder');
        (0, chai_1.expect)(prompts.added[0].isCommand).to.be.true;
    });
    it('removes a skill under the same id it registered it with', async () => {
        const skills = [skill('io.github.acme_tools:query-builder')];
        const { instance, prompts, changed } = coordinator(skills);
        await instance.onStart();
        skills.length = 0;
        changed.fire();
        (0, chai_1.expect)(prompts.removed).to.deep.equal(['skill-command-io.github.acme_tools__query-builder']);
    });
    it('leaves the id of an unqualified skill unchanged', async () => {
        const { instance, prompts } = coordinator([skill('deploy')]);
        await instance.onStart();
        (0, chai_1.expect)(prompts.added[0].id).to.equal('skill-command-deploy');
    });
});
//# sourceMappingURL=skill-prompt-coordinator.spec.js.map