"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
// Guarded: another spec in the same mocha process may already have set it, and `set` throws on a
// second call.
try {
    frontend_application_config_provider_1.FrontendApplicationConfigProvider.get();
}
catch {
    frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
}
const chai_1 = require("chai");
const sinon = require("sinon");
const skill_1 = require("../common/skill");
const path_1 = require("@theia/core/lib/common/path");
const core_1 = require("@theia/core");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const skill_service_1 = require("./skill-service");
disableJSDOM();
describe('SkillService', () => {
    describe('tilde expansion', () => {
        it('should expand ~ to home directory in configured paths', () => {
            const homePath = '/home/testuser';
            const configuredDirectories = ['~/skills', '~/.theia/skills', '/absolute/path'];
            const expanded = configuredDirectories.map(dir => path_1.Path.untildify(dir, homePath));
            (0, chai_1.expect)(expanded).to.deep.equal([
                '/home/testuser/skills',
                '/home/testuser/.theia/skills',
                '/absolute/path'
            ]);
        });
        it('should handle empty home path gracefully', () => {
            const configuredDirectories = ['~/skills'];
            const expanded = configuredDirectories.map(dir => path_1.Path.untildify(dir, ''));
            // With empty home, tilde is not expanded
            (0, chai_1.expect)(expanded).to.deep.equal(['~/skills']);
        });
    });
    describe('directory prioritization', () => {
        it('workspace directories come first when all directories provided', () => {
            const result = (0, skill_1.combineSkillDirectories)(['/workspace/.prompts/skills', '/workspace/.agents/skills'], ['/custom/skills1', '/custom/skills2'], ['/home/user/.theia/skills', '/home/user/.agents/skills']);
            (0, chai_1.expect)(result).to.deep.equal([
                { path: '/workspace/.prompts/skills', tier: 'workspace' },
                { path: '/workspace/.agents/skills', tier: 'workspace' },
                { path: '/custom/skills1', tier: 'configured' },
                { path: '/custom/skills2', tier: 'configured' },
                { path: '/home/user/.theia/skills', tier: 'default' },
                { path: '/home/user/.agents/skills', tier: 'default' }
            ]);
        });
        it('preserves the workspace-tier order: .prompts/skills wins over .agents/skills on duplicate skill names', () => {
            // The `.prompts/skills` directory is intentionally listed first within the workspace tier
            // because it is the Theia-explicit folder; users opting into it signal stronger intent than
            // those relying on the generic `.agents/skills` convention.
            const result = (0, skill_1.combineSkillDirectories)(['/workspace/.prompts/skills', '/workspace/.agents/skills'], [], []);
            (0, chai_1.expect)(result.map(entry => entry.path)).to.deep.equal([
                '/workspace/.prompts/skills',
                '/workspace/.agents/skills'
            ]);
        });
        it('works without workspace directories', () => {
            const result = (0, skill_1.combineSkillDirectories)([], ['/custom/skills'], ['/home/user/.theia/skills']);
            (0, chai_1.expect)(result).to.deep.equal([
                { path: '/custom/skills', tier: 'configured' },
                { path: '/home/user/.theia/skills', tier: 'default' }
            ]);
        });
        it('works with only default directories', () => {
            const result = (0, skill_1.combineSkillDirectories)([], [], ['/home/user/.theia/skills', '/home/user/.agents/skills']);
            (0, chai_1.expect)(result).to.deep.equal([
                { path: '/home/user/.theia/skills', tier: 'default' },
                { path: '/home/user/.agents/skills', tier: 'default' }
            ]);
        });
        it('deduplicates workspace directory if also in configured', () => {
            const result = (0, skill_1.combineSkillDirectories)(['/workspace/.prompts/skills'], ['/workspace/.prompts/skills', '/custom/skills'], ['/home/user/.theia/skills']);
            (0, chai_1.expect)(result).to.deep.equal([
                { path: '/workspace/.prompts/skills', tier: 'workspace' },
                { path: '/custom/skills', tier: 'configured' },
                { path: '/home/user/.theia/skills', tier: 'default' }
            ]);
        });
        it('deduplicates default directory if also in configured', () => {
            const result = (0, skill_1.combineSkillDirectories)(['/workspace/.prompts/skills'], ['/home/user/.theia/skills'], ['/home/user/.theia/skills']);
            (0, chai_1.expect)(result).to.deep.equal([
                { path: '/workspace/.prompts/skills', tier: 'workspace' },
                { path: '/home/user/.theia/skills', tier: 'configured' }
            ]);
        });
        it('handles empty configured directories', () => {
            const result = (0, skill_1.combineSkillDirectories)(['/workspace/.prompts/skills'], [], ['/home/user/.theia/skills']);
            (0, chai_1.expect)(result).to.deep.equal([
                { path: '/workspace/.prompts/skills', tier: 'workspace' },
                { path: '/home/user/.theia/skills', tier: 'default' }
            ]);
        });
        it('handles empty default directories', () => {
            const result = (0, skill_1.combineSkillDirectories)(['/workspace/.prompts/skills'], ['/custom/skills'], []);
            (0, chai_1.expect)(result).to.deep.equal([
                { path: '/workspace/.prompts/skills', tier: 'workspace' },
                { path: '/custom/skills', tier: 'configured' }
            ]);
        });
        it('deduplicates duplicate workspace directories', () => {
            const result = (0, skill_1.combineSkillDirectories)(['/workspace/.prompts/skills', '/workspace/.prompts/skills'], [], []);
            (0, chai_1.expect)(result).to.deep.equal([
                { path: '/workspace/.prompts/skills', tier: 'workspace' }
            ]);
        });
    });
    describe('parseSkillFile', () => {
        it('extracts YAML front matter correctly', () => {
            const fileContent = `---
name: my-skill
description: A test skill for testing purposes
license: MIT
compatibility: ">=1.0.0"
metadata:
  author: test
  version: "1.0.0"
---
# My Skill

This is the skill content.`;
            const result = (0, skill_1.parseSkillFile)(fileContent);
            (0, chai_1.expect)(result.content).to.equal(`# My Skill

This is the skill content.`);
            (0, chai_1.expect)(result.metadata).to.not.be.undefined;
            (0, chai_1.expect)(result.metadata?.name).to.equal('my-skill');
            (0, chai_1.expect)(result.metadata?.description).to.equal('A test skill for testing purposes');
            (0, chai_1.expect)(result.metadata?.license).to.equal('MIT');
            (0, chai_1.expect)(result.metadata?.compatibility).to.equal('>=1.0.0');
            (0, chai_1.expect)(result.metadata?.metadata).to.deep.equal({ author: 'test', version: '1.0.0' });
        });
        it('returns content without metadata when no front matter exists', () => {
            const fileContent = '# Just a regular markdown file';
            const result = (0, skill_1.parseSkillFile)(fileContent);
            (0, chai_1.expect)(result.content).to.equal('# Just a regular markdown file');
            (0, chai_1.expect)(result.metadata).to.be.undefined;
        });
        it('handles missing front matter gracefully', () => {
            const fileContent = `---
This is not valid YAML front matter
Skill content`;
            const result = (0, skill_1.parseSkillFile)(fileContent);
            (0, chai_1.expect)(result.content).to.equal(fileContent);
            (0, chai_1.expect)(result.metadata).to.be.undefined;
        });
        it('handles invalid YAML gracefully', () => {
            const fileContent = `---
name: my-skill
description: [unclosed array
---
Skill content`;
            const result = (0, skill_1.parseSkillFile)(fileContent);
            (0, chai_1.expect)(result.content).to.equal(fileContent);
            (0, chai_1.expect)(result.metadata).to.be.undefined;
        });
        it('handles minimal required fields', () => {
            const fileContent = `---
name: minimal-skill
description: A minimal skill
---
Content`;
            const result = (0, skill_1.parseSkillFile)(fileContent);
            (0, chai_1.expect)(result.content).to.equal('Content');
            (0, chai_1.expect)(result.metadata?.name).to.equal('minimal-skill');
            (0, chai_1.expect)(result.metadata?.description).to.equal('A minimal skill');
            (0, chai_1.expect)(result.metadata?.license).to.be.undefined;
            (0, chai_1.expect)(result.metadata?.compatibility).to.be.undefined;
            (0, chai_1.expect)(result.metadata?.metadata).to.be.undefined;
        });
        it('handles allowedTools field', () => {
            const fileContent = `---
name: tool-skill
description: A skill with allowed tools
allowedTools:
  - tool1
  - tool2
---
Content`;
            const result = (0, skill_1.parseSkillFile)(fileContent);
            (0, chai_1.expect)(result.metadata?.allowedTools).to.deep.equal(['tool1', 'tool2']);
        });
        it('preserves markdown content with special characters', () => {
            const fileContent = `---
name: special-skill
description: Test
---
# Skill with {{variable}} and \`code\` and **bold**

\`\`\`javascript
const x = 1;
\`\`\``;
            const result = (0, skill_1.parseSkillFile)(fileContent);
            (0, chai_1.expect)(result.content).to.contain('{{variable}}');
            (0, chai_1.expect)(result.content).to.contain('`code`');
            (0, chai_1.expect)(result.content).to.contain('**bold**');
            (0, chai_1.expect)(result.content).to.contain('const x = 1;');
        });
        it('handles empty content after front matter', () => {
            const fileContent = `---
name: empty-content
description: Skill with no content
---
`;
            const result = (0, skill_1.parseSkillFile)(fileContent);
            (0, chai_1.expect)(result.metadata?.name).to.equal('empty-content');
            (0, chai_1.expect)(result.content).to.equal('');
        });
    });
    describe('parent directory watching', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let fileServiceMock;
        let loggerWarnSpy;
        let loggerInfoSpy;
        let loggerDebugSpy;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let envVariablesServerMock;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let workspaceServiceMock;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let preferencesMock;
        let fileChangesEmitter;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let preferenceChangedEmitter;
        function createService(contributions = []) {
            const service = new skill_service_1.DefaultSkillService();
            service.skillDirectoryContributions = {
                getContributions: () => contributions
            };
            service.preferences = preferencesMock;
            service.fileService = fileServiceMock;
            const loggerMock = sinon.createStubInstance(core_1.Logger);
            loggerMock.warn = loggerWarnSpy;
            loggerMock.info = loggerInfoSpy;
            loggerMock.debug = loggerDebugSpy;
            service.logger = loggerMock;
            service.envVariablesServer = envVariablesServerMock;
            service.workspaceService = workspaceServiceMock;
            return service;
        }
        beforeEach(() => {
            fileChangesEmitter = new core_1.Emitter();
            preferenceChangedEmitter = new core_1.Emitter();
            fileServiceMock = {
                exists: sinon.stub(),
                watch: sinon.stub().returns(core_1.Disposable.NULL),
                resolve: sinon.stub(),
                read: sinon.stub(),
                onDidFilesChange: (listener) => fileChangesEmitter.event(listener)
            };
            loggerWarnSpy = sinon.stub();
            loggerInfoSpy = sinon.stub();
            loggerDebugSpy = sinon.stub();
            envVariablesServerMock = {
                getHomeDirUri: sinon.stub().resolves('file:///home/testuser'),
                getConfigDirUri: sinon.stub().resolves('file:///home/testuser/.theia-ide')
            };
            workspaceServiceMock = {
                ready: Promise.resolve(),
                tryGetRoots: sinon.stub().returns([]),
                onWorkspaceChanged: sinon.stub().returns(core_1.Disposable.NULL)
            };
            preferencesMock = {
                'ai-features.skills.skillDirectories': [],
                ready: Promise.resolve(),
                onPreferenceChanged: preferenceChangedEmitter.event
            };
        });
        afterEach(() => {
            sinon.restore();
            fileChangesEmitter.dispose();
            preferenceChangedEmitter.dispose();
        });
        it('should watch parent directory when skills directory does not exist', async () => {
            const service = createService();
            // Default skills directory does not exist, but parent does
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills'))
                .resolves(false);
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide'))
                .resolves(true);
            // Call init to trigger update
            service.init();
            await workspaceServiceMock.ready;
            // Allow async operations to complete
            await new Promise(resolve => setTimeout(resolve, 10));
            // Verify parent directory is watched
            (0, chai_1.expect)(fileServiceMock.watch.calledWith(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide'), sinon.match({ recursive: false, excludes: [] }))).to.be.true;
            // Verify debug log about watching parent (demoted from info to keep startup quiet)
            (0, chai_1.expect)(loggerDebugSpy.calledWith(sinon.match(/Watching parent directory.*for skills folder creation/))).to.be.true;
            // And the same line must not be emitted at info level any more.
            (0, chai_1.expect)(loggerInfoSpy.calledWith(sinon.match(/Watching parent directory/))).to.be.false;
        });
        it('should log a debug entry when parent directory does not exist', async () => {
            const service = createService();
            // Neither skills directory nor parent exists
            fileServiceMock.exists.resolves(false);
            // Call init to trigger update
            service.init();
            await workspaceServiceMock.ready;
            await new Promise(resolve => setTimeout(resolve, 10));
            // The absent-default-tree case is expected on fresh machines and is now debug-level only.
            (0, chai_1.expect)(loggerDebugSpy.calledWith(sinon.match(/Cannot watch skills directory.*parent directory does not exist/))).to.be.true;
            // It must no longer surface as a startup warning.
            (0, chai_1.expect)(loggerWarnSpy.calledWith(sinon.match(/Cannot watch skills directory.*parent directory does not exist/))).to.be.false;
        });
        it('coalesces concurrent update() calls so a single scan runs at a time', async () => {
            const service = createService();
            // Default skills directory does not exist, but parent does, so each update logs once.
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills'))
                .resolves(false);
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide'))
                .resolves(true);
            // Drive two updates in the same tick - the second must be coalesced into a follow-up
            // re-schedule rather than racing the first and producing duplicated log lines.
            const update = service.update.bind(service);
            await Promise.all([update(), update()]);
            // Give the rescheduled run (debounced via scheduleUpdate) time to fire.
            await new Promise(resolve => setTimeout(resolve, 80));
            // The watcher must be installed (the underlying scan must have run); the same log line
            // must have been emitted at most once per scan, never twice from interleaved scans.
            const matchingDebugCalls = loggerDebugSpy.getCalls().filter(call => /Watching parent directory.*for skills folder creation/.test(String(call.args[0])));
            // Two scans (initial + rescheduled) are allowed, but never more, and never zero.
            (0, chai_1.expect)(matchingDebugCalls.length).to.be.greaterThan(0);
            (0, chai_1.expect)(matchingDebugCalls.length).to.be.lessThan(3);
        });
        it('should log warning for non-existent configured directories', async () => {
            const service = createService();
            // Set up configured directory that doesn't exist
            preferencesMock['ai-features.skills.skillDirectories'] = ['/custom/nonexistent/skills'];
            // Default skills directory exists (to avoid additional warnings)
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills'))
                .resolves(true);
            fileServiceMock.resolve
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills'))
                .resolves({ children: [] });
            // Configured directory does not exist
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/custom/nonexistent/skills'))
                .resolves(false);
            // Call init to trigger update
            service.init();
            await workspaceServiceMock.ready;
            await new Promise(resolve => setTimeout(resolve, 10));
            // Verify warning is logged for non-existent configured directory
            (0, chai_1.expect)(loggerWarnSpy.calledWith(sinon.match(/Configured skill directory.*does not exist/))).to.be.true;
        });
        it('should scan configured directories that only become known once the preferences are ready', async () => {
            // The preference proxy serves defaults until its `ready` promise resolves, so a scan started before
            // that point misses the configured directories.
            const preferencesReady = new promise_util_1.Deferred();
            preferencesMock.ready = preferencesReady.promise;
            // Default skills directory exists and is empty, so the configured directory is the only source of warnings.
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills'))
                .resolves(true);
            fileServiceMock.resolve
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills'))
                .resolves({ children: [] });
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/custom/configured/skills'))
                .resolves(false);
            const service = createService();
            service.init();
            await workspaceServiceMock.ready;
            await new Promise(resolve => setTimeout(resolve, 10));
            // Nothing may be scanned yet, the preference value is still the default one.
            (0, chai_1.expect)(fileServiceMock.exists.called).to.be.false;
            preferencesMock['ai-features.skills.skillDirectories'] = ['/custom/configured/skills'];
            preferencesReady.resolve();
            await new Promise(resolve => setTimeout(resolve, 10));
            // The scan picked up the configured directory instead of the default preference value.
            (0, chai_1.expect)(loggerWarnSpy.calledWith(sinon.match(/Configured skill directory '\/custom\/configured\/skills' does not exist/))).to.be.true;
        });
        it('should load skills when directory is created after initialization', async () => {
            const service = createService();
            // Initially, skills directory does not exist but parent does
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills'))
                .resolves(false);
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide'))
                .resolves(true);
            // Call init to trigger initial update
            service.init();
            await workspaceServiceMock.ready;
            await new Promise(resolve => setTimeout(resolve, 10));
            // Verify no skills initially
            (0, chai_1.expect)(service.getSkills()).to.have.length(0);
            // Now simulate skills directory being created with a skill
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills'))
                .resolves(true);
            fileServiceMock.resolve
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills'))
                .resolves({
                children: [{
                        isDirectory: true,
                        name: 'test-skill',
                        resource: core_1.URI.fromFilePath('/home/testuser/.theia-ide/skills/test-skill')
                    }]
            });
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills/test-skill/SKILL.md'))
                .resolves(true);
            fileServiceMock.read
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills/test-skill/SKILL.md'))
                .resolves({
                value: `---
name: test-skill
description: A test skill
---
Test skill content`
            });
            // Simulate file change event for skills directory creation
            fileChangesEmitter.fire({
                changes: [{
                        type: 1, // FileChangeType.ADDED
                        resource: core_1.URI.fromFilePath('/home/testuser/.theia-ide/skills')
                    }],
                rawChanges: []
            });
            // Wait for async operations to complete
            await new Promise(resolve => setTimeout(resolve, 100));
            // Verify skill was loaded
            const skills = service.getSkills();
            (0, chai_1.expect)(skills).to.have.length(1);
            (0, chai_1.expect)(skills[0].name).to.equal('test-skill');
        });
        it('prefers a workspace `.prompts/skills` skill over a same-named `.agents/skills` skill in the same root', async () => {
            const service = createService();
            workspaceServiceMock.tryGetRoots.returns([
                { resource: core_1.URI.fromFilePath('/workspace') }
            ]);
            // Stub default skill directories as non-existent to keep focus on workspace behavior.
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide/skills'))
                .resolves(false);
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.theia-ide'))
                .resolves(false);
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.agents/skills'))
                .resolves(false);
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === '/home/testuser/.agents'))
                .resolves(false);
            // Both workspace skill directories exist and contain a `dup-skill` directory.
            const promptsSkillDir = '/workspace/.prompts/skills';
            const agentsSkillDir = '/workspace/.agents/skills';
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === promptsSkillDir))
                .resolves(true);
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === agentsSkillDir))
                .resolves(true);
            fileServiceMock.resolve
                .withArgs(sinon.match((uri) => uri.path.toString() === promptsSkillDir))
                .resolves({
                children: [{
                        isDirectory: true,
                        name: 'dup-skill',
                        resource: core_1.URI.fromFilePath(`${promptsSkillDir}/dup-skill`)
                    }]
            });
            fileServiceMock.resolve
                .withArgs(sinon.match((uri) => uri.path.toString() === agentsSkillDir))
                .resolves({
                children: [{
                        isDirectory: true,
                        name: 'dup-skill',
                        resource: core_1.URI.fromFilePath(`${agentsSkillDir}/dup-skill`)
                    }]
            });
            // Each tier provides its own SKILL.md so we can distinguish them by location.
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === `${promptsSkillDir}/dup-skill/SKILL.md`))
                .resolves(true);
            fileServiceMock.exists
                .withArgs(sinon.match((uri) => uri.path.toString() === `${agentsSkillDir}/dup-skill/SKILL.md`))
                .resolves(true);
            fileServiceMock.read
                .withArgs(sinon.match((uri) => uri.path.toString() === `${promptsSkillDir}/dup-skill/SKILL.md`))
                .resolves({
                value: '---\nname: dup-skill\ndescription: from prompts\n---\nFrom prompts'
            });
            fileServiceMock.read
                .withArgs(sinon.match((uri) => uri.path.toString() === `${agentsSkillDir}/dup-skill/SKILL.md`))
                .resolves({
                value: '---\nname: dup-skill\ndescription: from agents\n---\nFrom agents'
            });
            service.init();
            await workspaceServiceMock.ready;
            await new Promise(resolve => setTimeout(resolve, 10));
            const skill = service.getSkill('dup-skill');
            (0, chai_1.expect)(skill, 'dup-skill should be discovered').to.not.be.undefined;
            (0, chai_1.expect)(skill.description).to.equal('from prompts');
            (0, chai_1.expect)(skill.location).to.equal(new path_1.Path(`${promptsSkillDir}/dup-skill/SKILL.md`).fsPath());
            // The second occurrence is reported (not silently swallowed) via a warning.
            (0, chai_1.expect)(loggerWarnSpy.calledWith(sinon.match(/Duplicate skill found.*dup-skill/))).to.be.true;
        });
        describe('contributed skill directories', () => {
            const bigQueryQualifier = 'bigquery-data-analytics';
            const athenaQualifier = 'athena-analytics';
            /** A contribution returning a fixed set of roots. */
            function contributing(...entries) {
                return { getSkillDirectories: () => entries };
            }
            /**
             * Stubs `directory` as an existing skills root holding one skill directory per given name,
             * each with a valid `SKILL.md` whose description names the root it came from.
             */
            function stubSkillsRoot(directory, ...skillNames) {
                fileServiceMock.exists
                    .withArgs(sinon.match((uri) => uri.path.toString() === directory))
                    .resolves(true);
                fileServiceMock.resolve
                    .withArgs(sinon.match((uri) => uri.path.toString() === directory))
                    .resolves({
                    children: skillNames.map(name => ({
                        isDirectory: true,
                        name,
                        resource: core_1.URI.fromFilePath(`${directory}/${name}`)
                    }))
                });
                for (const name of skillNames) {
                    const skillFile = `${directory}/${name}/SKILL.md`;
                    fileServiceMock.exists
                        .withArgs(sinon.match((uri) => uri.path.toString() === skillFile))
                        .resolves(true);
                    fileServiceMock.read
                        .withArgs(sinon.match((uri) => uri.path.toString() === skillFile))
                        .resolves({ value: `---\nname: ${name}\ndescription: from ${directory}\n---\nBody of ${name}` });
                }
            }
            async function initialize(service) {
                service.init();
                await workspaceServiceMock.ready;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            it('qualifies the names of skills found under an owned contributed root', async () => {
                const pluginSkills = '/home/testuser/.agents/plugins/bigquery/skills';
                stubSkillsRoot(pluginSkills, 'query-builder');
                const service = createService([contributing({ path: pluginSkills, tier: 'plugin', qualifier: bigQueryQualifier })]);
                await initialize(service);
                const skills = service.getSkills();
                (0, chai_1.expect)(skills).to.have.length(1);
                (0, chai_1.expect)(skills[0].name).to.equal('query-builder');
                (0, chai_1.expect)(skills[0].qualifiedName).to.equal('bigquery-data-analytics:query-builder');
                (0, chai_1.expect)(skill_1.Skill.qualifierOf(skills[0])).to.equal('bigquery-data-analytics');
            });
            it('leaves the qualified name of a skill from a built-in root equal to its plain name', async () => {
                stubSkillsRoot('/home/testuser/.theia-ide/skills', 'code-review');
                const service = createService();
                await initialize(service);
                const skills = service.getSkills();
                (0, chai_1.expect)(skills).to.have.length(1);
                (0, chai_1.expect)(skills[0].qualifiedName).to.equal('code-review');
                (0, chai_1.expect)(skill_1.Skill.qualifierOf(skills[0])).to.be.undefined;
            });
            it('resolves an owned skill by its qualified name and by its plain name', async () => {
                const pluginSkills = '/home/testuser/.agents/plugins/bigquery/skills';
                stubSkillsRoot(pluginSkills, 'query-builder');
                const service = createService([contributing({ path: pluginSkills, tier: 'plugin', qualifier: bigQueryQualifier })]);
                await initialize(service);
                (0, chai_1.expect)(service.getSkill('bigquery-data-analytics:query-builder')?.name).to.equal('query-builder');
                // The plain name keeps working, so every reference written before the skill was owned
                // still resolves.
                (0, chai_1.expect)(service.getSkill('query-builder')?.qualifiedName).to.equal('bigquery-data-analytics:query-builder');
            });
            it('loads a skill of the same name from two different plugins and keeps both addressable', async () => {
                const bigQuerySkills = '/home/testuser/.agents/plugins/bigquery/skills';
                const athenaSkills = '/home/testuser/.agents/plugins/athena/skills';
                stubSkillsRoot(bigQuerySkills, 'query-builder');
                stubSkillsRoot(athenaSkills, 'query-builder');
                const service = createService([contributing({ path: bigQuerySkills, tier: 'plugin', qualifier: bigQueryQualifier }, { path: athenaSkills, tier: 'plugin', qualifier: athenaQualifier })]);
                await initialize(service);
                (0, chai_1.expect)(service.getSkills()).to.have.length(2);
                (0, chai_1.expect)(service.getSkill('bigquery-data-analytics:query-builder')?.description).to.equal(`from ${bigQuerySkills}`);
                (0, chai_1.expect)(service.getSkill('athena-analytics:query-builder')?.description).to.equal(`from ${athenaSkills}`);
                // Neither is dropped as a duplicate, because they no longer share a name.
                (0, chai_1.expect)(loggerWarnSpy.calledWith(sinon.match(/Duplicate skill found/))).to.be.false;
            });
            it('resolves an ambiguous plain name to undefined rather than guessing one of the candidates', async () => {
                const bigQuerySkills = '/home/testuser/.agents/plugins/bigquery/skills';
                const athenaSkills = '/home/testuser/.agents/plugins/athena/skills';
                stubSkillsRoot(bigQuerySkills, 'query-builder');
                stubSkillsRoot(athenaSkills, 'query-builder');
                const service = createService([contributing({ path: bigQuerySkills, tier: 'plugin', qualifier: bigQueryQualifier }, { path: athenaSkills, tier: 'plugin', qualifier: athenaQualifier })]);
                await initialize(service);
                (0, chai_1.expect)(service.getSkill('query-builder')).to.be.undefined;
            });
            it('keeps loading the remaining roots when one contribution fails', async () => {
                const pluginSkills = '/home/testuser/.agents/plugins/bigquery/skills';
                stubSkillsRoot(pluginSkills, 'query-builder');
                stubSkillsRoot('/home/testuser/.theia-ide/skills', 'code-review');
                const failing = {
                    getSkillDirectories: () => { throw new Error('cannot enumerate plugins'); }
                };
                const service = createService([
                    failing,
                    contributing({ path: pluginSkills, tier: 'plugin', qualifier: bigQueryQualifier })
                ]);
                await initialize(service);
                (0, chai_1.expect)(service.getSkills().map(skill => skill.qualifiedName).sort())
                    .to.deep.equal(['bigquery-data-analytics:query-builder', 'code-review']);
            });
            it('watches the parent of a contributed root that does not exist yet instead of warning about it', async () => {
                const pluginRoot = '/home/testuser/.agents/plugins/bigquery';
                fileServiceMock.exists
                    .withArgs(sinon.match((uri) => uri.path.toString() === `${pluginRoot}/skills`))
                    .resolves(false);
                fileServiceMock.exists
                    .withArgs(sinon.match((uri) => uri.path.toString() === pluginRoot))
                    .resolves(true);
                const service = createService([contributing({ path: `${pluginRoot}/skills`, tier: 'plugin', qualifier: bigQueryQualifier })]);
                await initialize(service);
                (0, chai_1.expect)(fileServiceMock.watch.calledWith(sinon.match((uri) => uri.path.toString() === pluginRoot), sinon.match({ recursive: false, excludes: [] }))).to.be.true;
                // A plugin without skills is not a misconfiguration, so it must not warn like a
                // non-existent configured directory does.
                (0, chai_1.expect)(loggerWarnSpy.calledWith(sinon.match(/does not exist/))).to.be.false;
            });
            it('rescans when a contribution reports that its set of roots changed', async () => {
                const pluginSkills = '/home/testuser/.agents/plugins/bigquery/skills';
                const onDidChangeEmitter = new core_1.Emitter();
                let entries = [];
                const contribution = {
                    getSkillDirectories: () => entries,
                    onDidChange: onDidChangeEmitter.event
                };
                const service = createService([contribution]);
                await initialize(service);
                (0, chai_1.expect)(service.getSkills()).to.have.length(0);
                stubSkillsRoot(pluginSkills, 'query-builder');
                entries = [{ path: pluginSkills, tier: 'plugin', qualifier: bigQueryQualifier }];
                onDidChangeEmitter.fire();
                await new Promise(resolve => setTimeout(resolve, 100));
                (0, chai_1.expect)(service.getSkills().map(skill => skill.qualifiedName)).to.deep.equal(['bigquery-data-analytics:query-builder']);
                onDidChangeEmitter.dispose();
            });
        });
    });
});
//# sourceMappingURL=skill-service.spec.js.map