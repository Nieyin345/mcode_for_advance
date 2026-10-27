"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource and others.
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
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
require("reflect-metadata");
const chai_1 = require("chai");
const js_yaml_1 = require("js-yaml");
const uri_1 = require("@theia/core/lib/common/uri");
const prompttemplate_parser_1 = require("./prompttemplate-parser");
const frontmatter_1 = require("../common/frontmatter");
const frontend_prompt_customization_service_1 = require("./frontend-prompt-customization-service");
disableJSDOM();
describe('Prompt Template Parser', () => {
    describe('YAML Front Matter Parsing', () => {
        it('extracts YAML front matter correctly', () => {
            const fileContent = `---
isCommand: true
commandName: hello
commandDescription: Say hello
commandArgumentHint: <name>
commandAgents:
  - Universal
  - Agent2
---
Template content here`;
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            (0, chai_1.expect)(result.template).to.equal('Template content here');
            (0, chai_1.expect)(result.metadata).to.not.be.undefined;
            (0, chai_1.expect)(result.metadata?.isCommand).to.be.true;
            (0, chai_1.expect)(result.metadata?.commandName).to.equal('hello');
            (0, chai_1.expect)(result.metadata?.commandDescription).to.equal('Say hello');
            (0, chai_1.expect)(result.metadata?.commandArgumentHint).to.equal('<name>');
            (0, chai_1.expect)(result.metadata?.commandAgents).to.deep.equal(['Universal', 'Agent2']);
        });
        it('returns template without front matter when none exists', () => {
            const fileContent = 'Just a regular template';
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            (0, chai_1.expect)(result.template).to.equal('Just a regular template');
            (0, chai_1.expect)(result.metadata).to.be.undefined;
        });
        it('handles missing front matter gracefully', () => {
            const fileContent = `---
This is not valid YAML front matter
Template content`;
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            // Should return content as-is when front matter is invalid
            (0, chai_1.expect)(result.template).to.equal(fileContent);
        });
        it('handles invalid YAML gracefully', () => {
            const fileContent = `---
isCommand: true
commandName: [unclosed array
---
Template content`;
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            // Should return template without metadata on parse error
            (0, chai_1.expect)(result.template).to.equal(fileContent);
            (0, chai_1.expect)(result.metadata).to.be.undefined;
        });
        it('validates command metadata types', () => {
            const fileContent = `---
isCommand: "true"
commandName: 123
commandDescription: valid
commandArgumentHint: <arg>
commandAgents: "not-an-array"
---
Template`;
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            (0, chai_1.expect)(result.template).to.equal('Template');
            (0, chai_1.expect)(result.metadata?.isCommand).to.be.undefined; // Wrong type
            (0, chai_1.expect)(result.metadata?.commandName).to.be.undefined; // Wrong type
            (0, chai_1.expect)(result.metadata?.commandDescription).to.equal('valid');
            (0, chai_1.expect)(result.metadata?.commandArgumentHint).to.equal('<arg>');
            (0, chai_1.expect)(result.metadata?.commandAgents).to.be.undefined; // Wrong type
        });
        it('filters commandAgents to strings only', () => {
            const fileContent = `---
commandAgents:
  - ValidAgent
  - 123
  - AnotherValid
  - true
  - LastValid
---
Template`;
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            (0, chai_1.expect)(result.metadata?.commandAgents).to.deep.equal(['ValidAgent', 'AnotherValid', 'LastValid']);
        });
        it('handles partial metadata fields', () => {
            const fileContent = `---
isCommand: true
commandName: test
---
Template content`;
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            (0, chai_1.expect)(result.template).to.equal('Template content');
            (0, chai_1.expect)(result.metadata?.isCommand).to.be.true;
            (0, chai_1.expect)(result.metadata?.commandName).to.equal('test');
            (0, chai_1.expect)(result.metadata?.commandDescription).to.be.undefined;
            (0, chai_1.expect)(result.metadata?.commandArgumentHint).to.be.undefined;
            (0, chai_1.expect)(result.metadata?.commandAgents).to.be.undefined;
        });
        it('preserves template content with special characters', () => {
            const fileContent = `---
isCommand: true
---
Template with $ARGUMENTS and {{variable}} and ~{function}`;
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            (0, chai_1.expect)(result.template).to.equal('Template with $ARGUMENTS and {{variable}} and ~{function}');
            (0, chai_1.expect)(result.metadata?.isCommand).to.be.true;
        });
        it('extracts name and description from front matter', () => {
            const fileContent = `---
name: My Fragment
description: A helpful description of this fragment
---
Template content`;
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            (0, chai_1.expect)(result.template).to.equal('Template content');
            (0, chai_1.expect)(result.metadata?.name).to.equal('My Fragment');
            (0, chai_1.expect)(result.metadata?.description).to.equal('A helpful description of this fragment');
        });
        it('extracts name and description alongside command metadata', () => {
            const fileContent = `---
name: App Tester
description: Delegate testing to AppTester
isCommand: true
commandName: apptester
---
Template content`;
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            (0, chai_1.expect)(result.metadata?.name).to.equal('App Tester');
            (0, chai_1.expect)(result.metadata?.description).to.equal('Delegate testing to AppTester');
            (0, chai_1.expect)(result.metadata?.isCommand).to.be.true;
            (0, chai_1.expect)(result.metadata?.commandName).to.equal('apptester');
        });
        it('handles missing name and description gracefully', () => {
            const fileContent = `---
isCommand: true
---
Template content`;
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            (0, chai_1.expect)(result.metadata?.name).to.be.undefined;
            (0, chai_1.expect)(result.metadata?.description).to.be.undefined;
            (0, chai_1.expect)(result.metadata?.isCommand).to.be.true;
        });
        it('rejects non-string name and description', () => {
            const fileContent = `---
name: 42
description: true
---
Template`;
            const result = (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
            (0, chai_1.expect)(result.metadata?.name).to.be.undefined;
            (0, chai_1.expect)(result.metadata?.description).to.be.undefined;
        });
    });
    describe('DefaultPromptFragmentCustomizationService - addTemplate conflict resolution', () => {
        before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
        after(() => disableJSDOM());
        /**
         * Test subclass that exposes the protected `addTemplate` and `provenanceLabel`
         * methods so we can unit-test conflict resolution without mocking the filesystem.
         */
        class TestableCustomizationService extends frontend_prompt_customization_service_1.DefaultPromptFragmentCustomizationService {
            // Prevent @postConstruct from running (it touches preferences)
            init() { }
            /** Configure fake workspace roots so provenanceLabel can resolve them. */
            setRoots(rootUris) {
                const roots = rootUris.map(r => new uri_1.default(r));
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.workspaceService = {
                    getWorkspaceRootUri(uri) {
                        return roots.find(root => uri.toString().startsWith(root.toString()));
                    }
                };
            }
            testAddTemplate(active, id, template, sourceUri, all, priority, origin) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.addTemplate(active, id, template, sourceUri, all, priority, origin);
            }
            testProvenanceLabel(sourceUri) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return this.provenanceLabel(sourceUri);
            }
        }
        let service;
        let activeMap;
        let allMap;
        beforeEach(() => {
            service = new TestableCustomizationService();
            service.setRoots([
                'file:///rootA',
                'file:///rootB',
                'file:///rootC',
                'file:///home/user/my-project'
            ]);
            activeMap = new Map();
            allMap = new Map();
        });
        it('adds a fragment when no conflict exists', () => {
            const uri = 'file:///rootA/.prompts/project-info.prompttemplate';
            service.testAddTemplate(activeMap, 'project-info', 'Content A', uri, allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            (0, chai_1.expect)(activeMap.has('project-info')).to.be.true;
            (0, chai_1.expect)(activeMap.get('project-info').template).to.equal('Content A');
            (0, chai_1.expect)(activeMap.get('project-info').sourceUris).to.deep.equal([uri]);
        });
        it('higher priority replaces lower priority', () => {
            service.testAddTemplate(activeMap, 'project-info', 'Low priority', 'file:///rootA/.prompts/project-info.prompttemplate', allMap, 1, frontend_prompt_customization_service_1.CustomizationSource.CUSTOMIZED);
            service.testAddTemplate(activeMap, 'project-info', 'High priority', 'file:///rootB/.prompts/project-info.prompttemplate', allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            (0, chai_1.expect)(activeMap.get('project-info').template).to.equal('High priority');
        });
        it('same source URI updates in place', () => {
            const uri = 'file:///rootA/.prompts/project-info.prompttemplate';
            service.testAddTemplate(activeMap, 'project-info', 'Original', uri, allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            service.testAddTemplate(activeMap, 'project-info', 'Updated', uri, allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            (0, chai_1.expect)(activeMap.get('project-info').template).to.equal('Updated');
            (0, chai_1.expect)(activeMap.get('project-info').sourceUris).to.deep.equal([uri]);
        });
        it('equal priority from different sources concatenates with provenance labels', () => {
            service.testAddTemplate(activeMap, 'project-info', 'Content A', 'file:///rootA/.prompts/project-info.prompttemplate', allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            service.testAddTemplate(activeMap, 'project-info', 'Content B', 'file:///rootB/.prompts/project-info.prompttemplate', allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            const entry = activeMap.get('project-info');
            (0, chai_1.expect)(entry.sourceUris).to.have.lengthOf(2);
            (0, chai_1.expect)(entry.template).to.contain('Content A');
            (0, chai_1.expect)(entry.template).to.contain('Content B');
            (0, chai_1.expect)(entry.template).to.contain('### rootA');
            (0, chai_1.expect)(entry.template).to.contain('### rootB');
        });
        it('three-way merge concatenates all sources in order', () => {
            service.testAddTemplate(activeMap, 'project-info', 'Content A', 'file:///rootA/.prompts/project-info.prompttemplate', allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            service.testAddTemplate(activeMap, 'project-info', 'Content B', 'file:///rootB/.prompts/project-info.prompttemplate', allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            service.testAddTemplate(activeMap, 'project-info', 'Content C', 'file:///rootC/.prompts/project-info.prompttemplate', allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            const entry = activeMap.get('project-info');
            (0, chai_1.expect)(entry.sourceUris).to.have.lengthOf(3);
            (0, chai_1.expect)(entry.template).to.contain('### rootA');
            (0, chai_1.expect)(entry.template).to.contain('### rootB');
            (0, chai_1.expect)(entry.template).to.contain('### rootC');
            // Verify ordering: A before B before C
            const idxA = entry.template.indexOf('Content A');
            const idxB = entry.template.indexOf('Content B');
            const idxC = entry.template.indexOf('Content C');
            (0, chai_1.expect)(idxA).to.be.lessThan(idxB);
            (0, chai_1.expect)(idxB).to.be.lessThan(idxC);
        });
        it('provenanceLabel extracts grandparent directory name from URI', () => {
            // For "file:///home/user/my-project/.prompts/foo.prompttemplate"
            // parent is ".prompts", grandparent is "my-project"
            const label = service.testProvenanceLabel('file:///home/user/my-project/.prompts/foo.prompttemplate');
            (0, chai_1.expect)(label).to.equal('my-project');
        });
        it('provenanceLabel falls back to parent if grandparent is empty', () => {
            (0, chai_1.expect)(service.testProvenanceLabel('file:///.prompts/foo.prompttemplate'))
                .to.equal('.prompts');
        });
        it('merged entry preserves primary sourceUri for backwards compatibility', () => {
            const uriA = 'file:///rootA/.prompts/project-info.prompttemplate';
            const uriB = 'file:///rootB/.prompts/project-info.prompttemplate';
            service.testAddTemplate(activeMap, 'project-info', 'Content A', uriA, allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            service.testAddTemplate(activeMap, 'project-info', 'Content B', uriB, allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            const entry = activeMap.get('project-info');
            // Primary sourceUri should be the first one added
            (0, chai_1.expect)(entry.sourceUri).to.equal(uriA);
            // All sources tracked
            (0, chai_1.expect)(entry.sourceUris).to.deep.equal([uriA, uriB]);
        });
        it('all map tracks each source independently', () => {
            const uriA = 'file:///rootA/.prompts/project-info.prompttemplate';
            const uriB = 'file:///rootB/.prompts/project-info.prompttemplate';
            service.testAddTemplate(activeMap, 'project-info', 'Content A', uriA, allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            service.testAddTemplate(activeMap, 'project-info', 'Content B', uriB, allMap, 2, frontend_prompt_customization_service_1.CustomizationSource.FOLDER);
            // allCustomizations is keyed by sourceUri, so both should be present
            (0, chai_1.expect)(allMap.has(uriA)).to.be.true;
            (0, chai_1.expect)(allMap.has(uriB)).to.be.true;
            (0, chai_1.expect)(allMap.get(uriA).template).to.equal('Content A');
            (0, chai_1.expect)(allMap.get(uriB).template).to.equal('Content B');
        });
    });
});
/**
 * Minimal in-memory {@link FileService} covering exactly the operations the customAgents.yml
 * migration uses (exists/read/resolve/createFile/move/delete). Files are keyed by their URI
 * string; directories are implied by the paths of the files they contain.
 */
class FakeFileService {
    constructor() {
        this.files = new Map();
        /** Target URIs for which `createFile` should throw, to simulate write failures. */
        this.failCreateFor = new Set();
    }
    write(uri, content) {
        this.files.set(uri.toString(), content);
    }
    content(uri) {
        return this.files.get(uri.toString());
    }
    childrenOf(dirUriStr) {
        const prefix = dirUriStr.endsWith('/') ? dirUriStr : dirUriStr + '/';
        const isDirectoryByName = new Map();
        for (const key of this.files.keys()) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            const rest = key.substring(prefix.length);
            const slash = rest.indexOf('/');
            if (slash === -1) {
                if (!isDirectoryByName.has(rest)) {
                    isDirectoryByName.set(rest, false);
                }
            }
            else {
                isDirectoryByName.set(rest.substring(0, slash), true);
            }
        }
        return Array.from(isDirectoryByName.entries()).map(([name, isDirectory]) => ({
            resource: new uri_1.default(prefix + name),
            isFile: !isDirectory,
            isDirectory
        }));
    }
    async exists(uri) {
        const key = uri.toString();
        return this.files.has(key) || this.childrenOf(key).length > 0;
    }
    async read(uri) {
        const key = uri.toString();
        if (!this.files.has(key)) {
            throw new Error('ENOENT: ' + key);
        }
        return { value: this.files.get(key) };
    }
    async resolve(uri) {
        const key = uri.toString();
        if (this.files.has(key)) {
            return { resource: uri, isFile: true, isDirectory: false };
        }
        const children = this.childrenOf(key);
        if (children.length === 0) {
            throw new Error('ENOENT: ' + key);
        }
        return { resource: uri, isFile: false, isDirectory: true, children };
    }
    async createFile(uri, value) {
        const key = uri.toString();
        if (this.failCreateFor.has(key)) {
            throw new Error('simulated write failure for ' + key);
        }
        this.files.set(key, value ? value.toString() : '');
    }
    async move(source, target) {
        const sourceKey = source.toString();
        if (!this.files.has(sourceKey)) {
            throw new Error('ENOENT: ' + sourceKey);
        }
        const content = this.files.get(sourceKey);
        this.files.delete(sourceKey);
        this.files.set(target.toString(), content);
    }
    async delete(uri) {
        const key = uri.toString();
        this.files.delete(key);
        const prefix = key.endsWith('/') ? key : key + '/';
        for (const existing of Array.from(this.files.keys())) {
            if (existing.startsWith(prefix)) {
                this.files.delete(existing);
            }
        }
    }
}
describe('DefaultPromptFragmentCustomizationService - customAgents.yml migration', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    /** Test subclass: skip @postConstruct and pin the scope so we don't need preferences/env. */
    class MigrationTestService extends frontend_prompt_customization_service_1.DefaultPromptFragmentCustomizationService {
        init() { }
        getTemplatesDirectoryURI() {
            return Promise.resolve(this.templatesDir);
        }
        testParse(raw) {
            return this.parseCustomAgentsYaml(raw);
        }
        testUnfold(raw) {
            return this.unfoldPromptBlockScalars(raw);
        }
    }
    const scope = new uri_1.default('file:///ws/.prompts');
    const yamlURI = scope.resolve('customAgents.yml');
    const backupURI = scope.resolve('customAgents.yml.bak');
    const agentMd = (id) => scope.resolve(frontend_prompt_customization_service_1.CUSTOM_AGENTS_DIRECTORY).resolve(id).resolve(frontend_prompt_customization_service_1.CUSTOM_AGENT_FILE_NAME);
    const agents = [
        { id: 'foo', name: 'Foo', description: 'Foo agent', prompt: 'Foo prompt', defaultLLM: 'default/universal' },
        { id: 'bar', name: 'Bar', description: 'Bar agent', prompt: 'Bar prompt', defaultLLM: 'default/universal' }
    ];
    let fileService;
    let service;
    beforeEach(() => {
        fileService = new FakeFileService();
        service = new MigrationTestService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        service.fileService = fileService;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        service.logger = { debug() { }, info() { }, warn() { }, error() { } };
        service.templatesDir = scope;
    });
    it('fresh migration writes agent.md per entry, folds in sibling prompt files, and backs up the yaml', async () => {
        fileService.write(yamlURI, (0, js_yaml_1.dump)(agents));
        fileService.write(scope.resolve('Foo_prompt.prompttemplate'), 'custom foo prompt');
        const [report] = await service.migrateCustomAgentsYaml();
        (0, chai_1.expect)(report.migrated).to.equal(2);
        (0, chai_1.expect)(report.alreadyPresent).to.equal(0);
        (0, chai_1.expect)(report.failed).to.equal(0);
        (0, chai_1.expect)(report.yamlBackedUp).to.be.true;
        (0, chai_1.expect)(report.promptOverridesMigrated).to.equal(1);
        (0, chai_1.expect)(await fileService.exists(agentMd('foo'))).to.be.true;
        (0, chai_1.expect)(await fileService.exists(agentMd('bar'))).to.be.true;
        // The sibling override is moved into the agent folder and removed from the scope root.
        (0, chai_1.expect)(await fileService.exists(scope.resolve('Foo_prompt.prompttemplate'))).to.be.false;
        (0, chai_1.expect)(await fileService.exists(scope.resolve(frontend_prompt_customization_service_1.CUSTOM_AGENTS_DIRECTORY).resolve('foo').resolve('Foo_prompt.prompttemplate'))).to.be.true;
        // The yaml is renamed to .bak rather than deleted.
        (0, chai_1.expect)(await fileService.exists(yamlURI)).to.be.false;
        (0, chai_1.expect)(await fileService.exists(backupURI)).to.be.true;
    });
    it('rerun after a successful migration is a no-op', async () => {
        fileService.write(yamlURI, (0, js_yaml_1.dump)(agents));
        await service.migrateCustomAgentsYaml();
        const fooAfterFirstRun = fileService.content(agentMd('foo'));
        const reports = await service.migrateCustomAgentsYaml();
        // The yaml is already backed up, so there is nothing left to migrate.
        (0, chai_1.expect)(reports).to.have.lengthOf(0);
        (0, chai_1.expect)(fileService.content(agentMd('foo'))).to.equal(fooAfterFirstRun);
    });
    it('is idempotent: never overwrites an already-migrated agent.md', async () => {
        fileService.write(yamlURI, (0, js_yaml_1.dump)(agents));
        fileService.write(agentMd('foo'), 'PRE-EXISTING FOO');
        const [report] = await service.migrateCustomAgentsYaml();
        (0, chai_1.expect)(report.alreadyPresent).to.equal(1);
        (0, chai_1.expect)(report.migrated).to.equal(1); // only 'bar' is written
        (0, chai_1.expect)(fileService.content(agentMd('foo'))).to.equal('PRE-EXISTING FOO');
        (0, chai_1.expect)(await fileService.exists(agentMd('bar'))).to.be.true;
    });
    it('partial failure with no existing backup still renames the yaml to .bak and reports the failure', async () => {
        fileService.write(yamlURI, (0, js_yaml_1.dump)(agents));
        fileService.failCreateFor.add(agentMd('bar').toString());
        const [report] = await service.migrateCustomAgentsYaml();
        (0, chai_1.expect)(report.migrated).to.equal(1); // 'foo' succeeds
        (0, chai_1.expect)(report.failed).to.equal(1); // 'bar' fails
        // The yaml was renamed to .bak (preserved, never silently deleted), so this is reported truthfully.
        (0, chai_1.expect)(report.yamlBackedUp).to.be.true;
        (0, chai_1.expect)(await fileService.exists(yamlURI)).to.be.false;
        (0, chai_1.expect)(await fileService.exists(backupURI)).to.be.true;
    });
    it('partial failure preserves a pre-existing .bak and leaves the yaml in place', async () => {
        fileService.write(yamlURI, (0, js_yaml_1.dump)(agents));
        fileService.write(backupURI, 'ORIGINAL BACKUP');
        fileService.failCreateFor.add(agentMd('bar').toString());
        const [report] = await service.migrateCustomAgentsYaml();
        (0, chai_1.expect)(report.failed).to.equal(1);
        (0, chai_1.expect)(report.yamlBackedUp).to.be.false;
        // An existing .bak is never overwritten...
        (0, chai_1.expect)(fileService.content(backupURI)).to.equal('ORIGINAL BACKUP');
        // ...and because a backup already exists, the yaml is left untouched for inspection.
        (0, chai_1.expect)(await fileService.exists(yamlURI)).to.be.true;
    });
    describe('folded block-scalar prompts', () => {
        // A folded YAML scalar (`>-`) collapses single newlines into spaces, which merges markdown
        // headings into the paragraph below them. Migration must recover the original line breaks.
        const foldedYaml = '- id: rel\n' +
            '  name: Rel\n' +
            '  description: Release agent\n' +
            '  defaultLLM: default/code\n' +
            '  prompt: >-\n' +
            '    ## Task\n' +
            '    Do the thing.\n' +
            '\n' +
            '    ## Workflow\n' +
            '    Step one.\n';
        it('migrates a folded prompt with its headings on separate lines', async () => {
            fileService.write(yamlURI, foldedYaml);
            const [report] = await service.migrateCustomAgentsYaml();
            (0, chai_1.expect)(report.migrated).to.equal(1);
            const content = fileService.content(agentMd('rel'));
            // js-yaml would have folded these into '## Task Do the thing.'; the fix keeps them split.
            (0, chai_1.expect)(content).to.contain('## Task\nDo the thing.');
            (0, chai_1.expect)(content).to.contain('## Workflow\nStep one.');
            (0, chai_1.expect)(content).to.not.contain('## Task Do the thing.');
        });
        it('loads an un-migrated folded prompt with separated headings at runtime', async () => {
            fileService.write(yamlURI, foldedYaml);
            const [agent] = await service.getCustomAgents();
            (0, chai_1.expect)(agent.prompt).to.contain('## Task\nDo the thing.');
            (0, chai_1.expect)(agent.prompt).to.not.contain('## Task Do the thing.');
        });
        it('leaves plain and quoted prompt values untouched', () => {
            const plain = 'prompt: just a short prompt';
            const quoted = 'prompt: "> not a header"';
            (0, chai_1.expect)(service.testUnfold(plain)).to.equal(plain);
            (0, chai_1.expect)(service.testUnfold(quoted)).to.equal(quoted);
            // Folded headers (with or without indicators) become literal.
            (0, chai_1.expect)(service.testUnfold('prompt: >-')).to.equal('prompt: |-');
            (0, chai_1.expect)(service.testUnfold('prompt: >2-')).to.equal('prompt: |2-');
        });
    });
    describe('correcting already-migrated agents', () => {
        // Reproduces the bytes the v1.73.0 migration wrote: parse the backup the old (folded) way and
        // serialize it with the same frontmatter format the migration used.
        const buggyAgentMd = (raw, id) => {
            const entry = (0, js_yaml_1.load)(raw).find(e => e.id === id);
            return (0, frontmatter_1.serializeFrontmatter)({ name: entry.name, description: entry.description, defaultLLM: entry.defaultLLM }, entry.prompt);
        };
        const foldedYaml = '- id: rel\n' +
            '  name: Rel\n' +
            '  description: Release agent\n' +
            '  defaultLLM: default/code\n' +
            '  prompt: >-\n' +
            '    ## Task\n' +
            '    Do the thing.\n';
        it('rewrites an untouched agent.md to recover folded headings', async () => {
            // Simulate the post-v1.73.0 state: yaml already backed up, agent.md written with merged headings.
            fileService.write(backupURI, foldedYaml);
            fileService.write(agentMd('rel'), buggyAgentMd(foldedYaml, 'rel'));
            const [report] = await service.migrateCustomAgentsYaml();
            (0, chai_1.expect)(report.corrected).to.equal(1);
            (0, chai_1.expect)(fileService.content(agentMd('rel'))).to.contain('## Task\nDo the thing.');
        });
        it('does not touch an agent.md the user edited after migration', async () => {
            fileService.write(backupURI, foldedYaml);
            const edited = buggyAgentMd(foldedYaml, 'rel') + '\n\nManually added section.';
            fileService.write(agentMd('rel'), edited);
            const reports = await service.migrateCustomAgentsYaml();
            // Nothing is migrated and the edited file is not eligible for correction, so no report.
            (0, chai_1.expect)(reports).to.have.lengthOf(0);
            (0, chai_1.expect)(fileService.content(agentMd('rel'))).to.equal(edited);
        });
        it('reports nothing to do when the backup prompt has no folded headings', async () => {
            fileService.write(backupURI, (0, js_yaml_1.dump)(agents));
            fileService.write(agentMd('foo'), buggyAgentMd((0, js_yaml_1.dump)(agents), 'foo'));
            const reports = await service.migrateCustomAgentsYaml();
            // Nothing to migrate and nothing correctable -> no report for the scope.
            (0, chai_1.expect)(reports).to.have.lengthOf(0);
        });
    });
    describe('hasPendingCustomAgentMigration', () => {
        it('is true while a legacy customAgents.yml exists', async () => {
            fileService.write(yamlURI, (0, js_yaml_1.dump)(agents));
            (0, chai_1.expect)(await service.hasPendingCustomAgentMigration()).to.be.true;
        });
        it('is true when a backup has correctable agents', async () => {
            const foldedYaml = '- id: rel\n  name: Rel\n  description: d\n  defaultLLM: default/code\n  prompt: >-\n    ## Task\n    Body.\n';
            fileService.write(backupURI, foldedYaml);
            const entry = (0, js_yaml_1.load)(foldedYaml)[0];
            fileService.write(agentMd('rel'), (0, frontmatter_1.serializeFrontmatter)({ name: entry.name, description: entry.description, defaultLLM: entry.defaultLLM }, entry.prompt));
            (0, chai_1.expect)(await service.hasPendingCustomAgentMigration()).to.be.true;
        });
        it('is false once everything is migrated and correct', async () => {
            fileService.write(yamlURI, (0, js_yaml_1.dump)(agents));
            await service.migrateCustomAgentsYaml();
            (0, chai_1.expect)(await service.hasPendingCustomAgentMigration()).to.be.false;
        });
    });
});
describe('DefaultPromptFragmentCustomizationService - custom agent scopes', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    /** Test subclass: skip @postConstruct and pin the global templates directory. */
    class AgentScopeTestService extends frontend_prompt_customization_service_1.DefaultPromptFragmentCustomizationService {
        constructor() {
            super(...arguments);
            this.globalDir = new uri_1.default('file:///global/prompt-templates');
        }
        init() { }
        getTemplatesDirectoryURI() {
            return Promise.resolve(this.globalDir);
        }
        setCustomAgentDirs(paths) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.customAgentDirs = new Set(paths);
        }
    }
    const agentMd = (scope, id) => scope.resolve(frontend_prompt_customization_service_1.CUSTOM_AGENTS_DIRECTORY).resolve(id).resolve(frontend_prompt_customization_service_1.CUSTOM_AGENT_FILE_NAME);
    const agentFile = (name, description) => `---\nname: ${name}\ndescription: ${description}\ndefaultLLM: default/universal\n---\n${name} prompt`;
    let fileService;
    let service;
    beforeEach(() => {
        fileService = new FakeFileService();
        service = new AgentScopeTestService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        service.fileService = fileService;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        service.logger = { debug() { }, info() { }, warn() { }, error() { } };
    });
    it('lists the built-in .agents scope before .prompts and the global directory', async () => {
        service.setCustomAgentDirs(['/ws/.agents', '/ws/.prompts']);
        const locations = await service.getCustomAgentsLocations();
        const agentDirParents = locations.filter(l => l.kind === 'agents-dir').map(l => l.uri.parent.path.toString());
        (0, chai_1.expect)(agentDirParents).to.deep.equal(['/ws/.agents', '/ws/.prompts', '/global/prompt-templates']);
    });
    it('discovers custom agents stored under the .agents directory', async () => {
        service.setCustomAgentDirs(['/ws/.agents']);
        fileService.write(agentMd(new uri_1.default('file:///ws/.agents'), 'foo'), agentFile('Foo', 'Foo agent'));
        const agents = await service.getCustomAgents();
        (0, chai_1.expect)(agents.map(a => a.id)).to.deep.equal(['foo']);
        (0, chai_1.expect)(agents[0].name).to.equal('Foo');
    });
    it('prefers an agent in .agents over one with the same id in .prompts', async () => {
        service.setCustomAgentDirs(['/ws/.agents', '/ws/.prompts']);
        fileService.write(agentMd(new uri_1.default('file:///ws/.agents'), 'shared'), agentFile('FromAgents', 'agents version'));
        fileService.write(agentMd(new uri_1.default('file:///ws/.prompts'), 'shared'), agentFile('FromPrompts', 'prompts version'));
        const agents = await service.getCustomAgents();
        (0, chai_1.expect)(agents).to.have.lengthOf(1);
        (0, chai_1.expect)(agents[0].description).to.equal('agents version');
    });
});
describe('DefaultPromptFragmentCustomizationService - custom agent change detection', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    class ChangeDetectionTestService extends frontend_prompt_customization_service_1.DefaultPromptFragmentCustomizationService {
        init() { }
        isAgentChange(path) {
            return this.isCustomAgentChange(path);
        }
    }
    let service;
    beforeEach(() => { service = new ChangeDetectionTestService(); });
    it('detects deletion of the whole agents directory', () => {
        (0, chai_1.expect)(service.isAgentChange('file:///ws/.agents/agents')).to.be.true;
    });
    it('detects changes to an agent.md inside the agents directory', () => {
        (0, chai_1.expect)(service.isAgentChange('file:///ws/.agents/agents/foo/agent.md')).to.be.true;
    });
    it('detects changes to a legacy customAgents.yml', () => {
        (0, chai_1.expect)(service.isAgentChange('file:///ws/.prompts/customAgents.yml')).to.be.true;
    });
    it('ignores the scope directory itself', () => {
        (0, chai_1.expect)(service.isAgentChange('file:///ws/.agents')).to.be.false;
    });
    it('ignores unrelated files such as skills', () => {
        (0, chai_1.expect)(service.isAgentChange('file:///ws/.agents/skills/foo/SKILL.md')).to.be.false;
    });
});
//# sourceMappingURL=frontend-prompt-customization-service.spec.js.map