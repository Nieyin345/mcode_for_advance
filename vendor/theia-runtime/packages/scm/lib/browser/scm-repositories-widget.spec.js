"use strict";
// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH and others.
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
let disableReactActEnvironment = (0, jsdom_1.enableReactActEnvironment)();
const chai_1 = require("chai");
const React = require("@theia/core/shared/react");
const client_1 = require("@theia/core/shared/react-dom/client");
const messaging_1 = require("@theia/core/shared/@lumino/messaging");
const event_1 = require("@theia/core/lib/common/event");
const label_parser_1 = require("@theia/core/lib/browser/label-parser");
const scm_repositories_widget_1 = require("./scm-repositories-widget");
disableReactActEnvironment();
disableJSDOM();
function makeRepo(opts) {
    return {
        provider: {
            id: opts.id,
            label: opts.label,
            rootUri: opts.rootUri,
            groups: [],
            statusBarCommands: opts.statusBarCommands,
            providerContextValue: opts.providerContextValue,
            onDidChange: new event_1.Emitter().event,
            onDidChangeCommitTemplate: new event_1.Emitter().event,
            dispose: () => { }
        },
        parentRootUri: opts.parentRootUri
    };
}
function createWidget(opts) {
    const widget = new scm_repositories_widget_1.ScmRepositoriesWidget();
    const mockScmService = {
        get repositories() { return opts.repositories; },
        get selectedRepository() { return opts.selectedRepositoryRef.value; },
        set selectedRepository(repo) { opts.selectedRepositoryRef.value = repo; },
        onDidAddRepository: opts.onAddEmitter.event,
        onDidRemoveRepository: opts.onRemoveEmitter.event,
        onDidChangeSelectedRepository: opts.onChangedSelectedEmitter.event,
    };
    const mockLabelProvider = {
        getName: (uri) => String(uri).split('/').pop() ?? '',
        getLongName: (uri) => String(uri)
    };
    const labelParser = new label_parser_1.LabelParser();
    const mockCommandService = {
        executeCommand: async (id, ...args) => {
            opts.executedCommands.push({ id, args });
            return undefined;
        }
    };
    const mockContextMenuRenderer = { render: () => ({ dispose: () => { } }) };
    const mockScmContextKeys = { scmProvider: { set: () => { } }, scmProviderContext: { set: () => { } } };
    widget.scmService = mockScmService;
    widget.labelProvider = mockLabelProvider;
    widget.labelParser = labelParser;
    widget.commandService = mockCommandService;
    widget.contextMenuRenderer = mockContextMenuRenderer;
    widget.scmContextKeys = mockScmContextKeys;
    React.act(() => {
        widget.init();
        messaging_1.MessageLoop.flush();
    });
    return widget;
}
describe('ScmRepositoriesWidget', () => {
    let repositories;
    let selectedRepositoryRef;
    let onAddEmitter;
    let onRemoveEmitter;
    let onChangedSelectedEmitter;
    let executedCommands;
    let widget;
    let renderedRoots;
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
        disableReactActEnvironment = (0, jsdom_1.enableReactActEnvironment)();
    });
    after(() => {
        disableReactActEnvironment();
        disableJSDOM();
    });
    beforeEach(() => {
        renderedRoots = [];
        repositories = [];
        selectedRepositoryRef = { value: undefined };
        onAddEmitter = new event_1.Emitter();
        onRemoveEmitter = new event_1.Emitter();
        onChangedSelectedEmitter = new event_1.Emitter();
        executedCommands = [];
        widget = createWidget({
            repositories,
            selectedRepositoryRef,
            onAddEmitter,
            onRemoveEmitter,
            onChangedSelectedEmitter,
            executedCommands
        });
    });
    afterEach(() => {
        try {
            React.act(() => {
                for (const { root } of renderedRoots) {
                    root.unmount();
                }
                widget.dispose();
                messaging_1.MessageLoop.flush();
            });
        }
        finally {
            for (const { container } of renderedRoots) {
                container.remove();
            }
            renderedRoots = [];
            onAddEmitter.dispose();
            onRemoveEmitter.dispose();
            onChangedSelectedEmitter.dispose();
        }
    });
    function actAndFlush(fn) {
        React.act(() => {
            fn();
            messaging_1.MessageLoop.flush();
        });
    }
    function fireRepositoryAdded(repository) {
        actAndFlush(() => onAddEmitter.fire(repository));
    }
    function fireRepositoryRemoved(repository) {
        actAndFlush(() => onRemoveEmitter.fire(repository));
    }
    // --- Visibility ---
    it('should not programmatically show when there are no repositories', () => {
        // The widget does not call setHidden(false) with < 2 repos.
        // Initial visibility depends on the ViewContainer's `initiallyHidden: true`.
        // In this standalone test the widget starts visible (no ViewContainer).
        (0, chai_1.expect)(widget.isHidden).to.be.false;
    });
    it('should not programmatically show when there is exactly one repository', () => {
        const repo = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/repo1' });
        repositories.push(repo);
        fireRepositoryAdded(repo);
        // With < 2 repos the widget does NOT call setHidden(false).
        // It remains in its initial state (visible in standalone test, hidden in real ViewContainer).
        (0, chai_1.expect)(widget.isHidden).to.be.false;
    });
    it('should be visible when there are two or more repositories', () => {
        const repo1 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/repo1' });
        const repo2 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/repo2' });
        repositories.push(repo1, repo2);
        fireRepositoryAdded(repo2);
        (0, chai_1.expect)(widget.isHidden).to.be.false;
    });
    it('should not programmatically hide when repositories drop below 2', () => {
        const repo1 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/repo1' });
        const repo2 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/repo2' });
        repositories.push(repo1, repo2);
        fireRepositoryAdded(repo2);
        (0, chai_1.expect)(widget.isHidden).to.be.false;
        repositories.splice(1, 1);
        fireRepositoryRemoved(repo2);
        // Widget stays visible — we never programmatically hide
        (0, chai_1.expect)(widget.isHidden).to.be.false;
    });
    it('should have title label "Repositories"', () => {
        (0, chai_1.expect)(widget.title.label).to.equal('Repositories');
    });
    // --- Rendering ---
    function renderIntoContainer(node) {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = (0, client_1.createRoot)(container);
        const renderedRoot = { container, root };
        renderedRoots.push(renderedRoot);
        React.act(() => {
            root.render(node);
        });
        return renderedRoot;
    }
    it('should render a repo icon, folder name, and status commands for each repository', () => {
        const repo1 = makeRepo({
            id: 'git', label: 'Git', rootUri: '/workspace/myrepo',
            statusBarCommands: [{ title: '$(git-branch) main', command: 'git.checkout', arguments: [] }]
        });
        const repo2 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/repo2' });
        repositories.push(repo1, repo2);
        fireRepositoryAdded(repo2);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        (0, chai_1.expect)(rows.length).to.equal(2);
        const myrepoRow = Array.from(rows).find(r => r.querySelector('.theia-scm-repository-name')?.textContent === 'myrepo');
        (0, chai_1.expect)(myrepoRow).to.exist;
        const iconEl = myrepoRow.querySelector('.theia-scm-repository-icon');
        (0, chai_1.expect)(iconEl).to.exist;
        const statusCmd = myrepoRow.querySelector('.theia-scm-repository-status-command');
        (0, chai_1.expect)(statusCmd).to.exist;
    });
    it('should apply "selected" class only to the selected repository row', () => {
        const repo1 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/repo1' });
        const repo2 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/repo2' });
        repositories.push(repo1, repo2);
        selectedRepositoryRef.value = repo1;
        fireRepositoryAdded(repo2);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        (0, chai_1.expect)(rows[0].classList.contains('selected')).to.be.true;
        (0, chai_1.expect)(rows[1].classList.contains('selected')).to.be.false;
    });
    it('should execute the status command when clicked and stop propagation', async () => {
        const repo1 = makeRepo({
            id: 'git', label: 'Git', rootUri: '/workspace/repo1',
            statusBarCommands: [{ title: '$(sync) main', command: 'git.sync', arguments: ['arg1'] }]
        });
        const repo2 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/repo2' });
        repositories.push(repo1, repo2);
        fireRepositoryAdded(repo2);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const statusCmd = container.querySelector('.theia-scm-repository-status-command');
        (0, chai_1.expect)(statusCmd).to.exist;
        statusCmd.click();
        await Promise.resolve();
        (0, chai_1.expect)(executedCommands).to.have.length(1);
        (0, chai_1.expect)(executedCommands[0].id).to.equal('git.sync');
        (0, chai_1.expect)(executedCommands[0].args).to.deep.equal(['arg1']);
    });
    // --- Grouping: parent-based nesting ---
    it('should show worktrees nested under their parent repo with collapse toggle', () => {
        const parent = makeRepo({
            id: 'git', label: 'Git', rootUri: '/projects/myrepo',
            providerContextValue: 'repository'
        });
        const wt1 = makeRepo({
            id: 'git', label: 'Git', rootUri: '/tmp/wt-feature',
            providerContextValue: 'worktree',
            parentRootUri: '/projects/myrepo'
        });
        const wt2 = makeRepo({
            id: 'git', label: 'Git', rootUri: '/tmp/wt-bugfix',
            providerContextValue: 'worktree',
            parentRootUri: '/projects/myrepo'
        });
        repositories.push(parent, wt1, wt2);
        fireRepositoryAdded(wt1);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        (0, chai_1.expect)(rows.length).to.equal(3);
        // Parent has collapse toggle
        (0, chai_1.expect)(rows[0].querySelector('.theia-scm-repository-collapse-toggle')).to.exist;
        // Children have .child class
        (0, chai_1.expect)(rows[1].classList.contains('child')).to.be.true;
        (0, chai_1.expect)(rows[2].classList.contains('child')).to.be.true;
        // Parent does not have .child class
        (0, chai_1.expect)(rows[0].classList.contains('child')).to.be.false;
    });
    it('should show submodules nested under their parent repo', () => {
        const parent = makeRepo({
            id: 'git', label: 'Git', rootUri: '/projects/myrepo',
            providerContextValue: 'repository'
        });
        const sub = makeRepo({
            id: 'git', label: 'Git', rootUri: '/projects/myrepo/vendor/lib',
            providerContextValue: 'submodule',
            parentRootUri: '/projects/myrepo'
        });
        repositories.push(parent, sub);
        fireRepositoryAdded(sub);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        (0, chai_1.expect)(rows.length).to.equal(2);
        (0, chai_1.expect)(rows[0].querySelector('.theia-scm-repository-collapse-toggle')).to.exist;
        (0, chai_1.expect)(rows[1].classList.contains('child')).to.be.true;
        // Submodule icon should be file-submodule
        const subIcon = rows[1].querySelector('.theia-scm-repository-icon');
        (0, chai_1.expect)(subIcon).to.exist;
        (0, chai_1.expect)(subIcon.className).to.include('codicon-file-submodule');
    });
    it('should show independent nested repos flat without grouping', () => {
        const gitRepo = makeRepo({
            id: 'git', label: 'Git', rootUri: '/workspace/myrepo',
            providerContextValue: 'repository'
        });
        const nestedRepo = makeRepo({
            id: 'git', label: 'Git', rootUri: '/workspace/myrepo/nested-project',
            providerContextValue: 'repository'
        });
        repositories.push(gitRepo, nestedRepo);
        fireRepositoryAdded(nestedRepo);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        // Both repos are flat (no parent relationship set)
        (0, chai_1.expect)(rows.length).to.equal(2);
        (0, chai_1.expect)(rows[0].classList.contains('child')).to.be.false;
        (0, chai_1.expect)(rows[1].classList.contains('child')).to.be.false;
        // Neither has a collapse toggle
        (0, chai_1.expect)(rows[0].querySelector('.theia-scm-repository-collapse-toggle')).to.not.exist;
        (0, chai_1.expect)(rows[1].querySelector('.theia-scm-repository-collapse-toggle')).to.not.exist;
        // Both should have codicon-repo icon
        const icon0 = rows[0].querySelector('.theia-scm-repository-icon');
        const icon1 = rows[1].querySelector('.theia-scm-repository-icon');
        (0, chai_1.expect)(icon0.className).to.include('codicon-repo');
        (0, chai_1.expect)(icon1.className).to.include('codicon-repo');
    });
    it('should use codicon-worktree for worktrees', () => {
        const parent = makeRepo({
            id: 'git', label: 'Git', rootUri: '/projects/myrepo'
        });
        const wt = makeRepo({
            id: 'git', label: 'Git', rootUri: '/tmp/wt-feature',
            providerContextValue: 'worktree',
            parentRootUri: '/projects/myrepo'
        });
        repositories.push(parent, wt);
        fireRepositoryAdded(wt);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        const wtIcon = rows[1].querySelector('.theia-scm-repository-icon');
        (0, chai_1.expect)(wtIcon.className).to.include('codicon-worktree');
    });
    it('should handle mixed scenario: parent + worktree + submodule + independent repo', () => {
        const parent = makeRepo({
            id: 'git', label: 'Git', rootUri: '/projects/myrepo',
            providerContextValue: 'repository'
        });
        const wt = makeRepo({
            id: 'git', label: 'Git', rootUri: '/tmp/wt-feature',
            providerContextValue: 'worktree',
            parentRootUri: '/projects/myrepo'
        });
        const sub = makeRepo({
            id: 'git', label: 'Git', rootUri: '/projects/myrepo/vendor/lib',
            providerContextValue: 'submodule',
            parentRootUri: '/projects/myrepo'
        });
        const independent = makeRepo({
            id: 'git', label: 'Git', rootUri: '/other/independent-repo',
            providerContextValue: 'repository'
        });
        repositories.push(parent, wt, sub, independent);
        fireRepositoryAdded(independent);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        // parent (root with toggle) + wt (child) + sub (child) + independent (root, no toggle)
        (0, chai_1.expect)(rows.length).to.equal(4);
        // First row: parent root with collapse toggle
        (0, chai_1.expect)(rows[0].querySelector('.theia-scm-repository-collapse-toggle')).to.exist;
        (0, chai_1.expect)(rows[0].classList.contains('child')).to.be.false;
        // Second & third: children
        (0, chai_1.expect)(rows[1].classList.contains('child')).to.be.true;
        (0, chai_1.expect)(rows[2].classList.contains('child')).to.be.true;
        // Fourth: independent, flat, no collapse toggle
        (0, chai_1.expect)(rows[3].classList.contains('child')).to.be.false;
        (0, chai_1.expect)(rows[3].querySelector('.theia-scm-repository-collapse-toggle')).to.not.exist;
    });
    it('should hide children when parent is collapsed', () => {
        const parent = makeRepo({
            id: 'git', label: 'Git', rootUri: '/projects/myrepo'
        });
        const child = makeRepo({
            id: 'git', label: 'Git', rootUri: '/tmp/wt-feature',
            providerContextValue: 'worktree',
            parentRootUri: '/projects/myrepo'
        });
        repositories.push(parent, child);
        fireRepositoryAdded(child);
        // Collapse the parent
        actAndFlush(() => widget.toggleCollapse(parent.provider.rootUri));
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        (0, chai_1.expect)(rows.length).to.equal(1);
        const toggle = rows[0].querySelector('.theia-scm-repository-collapse-toggle');
        (0, chai_1.expect)(toggle).to.exist;
        (0, chai_1.expect)(toggle.className).to.include('codicon-chevron-right');
    });
    it('should render a ... more-button on each repository row', () => {
        const repo1 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/repo1' });
        const repo2 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/repo2' });
        repositories.push(repo1, repo2);
        fireRepositoryAdded(repo2);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const moreButtons = container.querySelectorAll('.theia-scm-repository-more-button');
        (0, chai_1.expect)(moreButtons.length).to.equal(2);
    });
    it('should create separate flat entries for repos with different provider ids and no parent', () => {
        const gitRepo = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/myrepo' });
        const svnRepo = makeRepo({ id: 'svn', label: 'SVN', rootUri: '/workspace/other' });
        repositories.push(gitRepo, svnRepo);
        fireRepositoryAdded(svnRepo);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        (0, chai_1.expect)(rows.length).to.equal(2);
        (0, chai_1.expect)(rows[0].classList.contains('child')).to.be.false;
        (0, chai_1.expect)(rows[1].classList.contains('child')).to.be.false;
        (0, chai_1.expect)(rows[0].querySelector('.theia-scm-repository-collapse-toggle')).to.not.exist;
        (0, chai_1.expect)(rows[1].querySelector('.theia-scm-repository-collapse-toggle')).to.not.exist;
    });
    // --- Duplicate name disambiguation ---
    it('should show relative path descriptions when two repos share the same folder name', () => {
        // Simulates: workspace at /workspace, repos /workspace/foo and /workspace/bar/foo
        const repo1 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/foo' });
        const repo2 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/bar/foo' });
        repositories.push(repo1, repo2);
        fireRepositoryAdded(repo2);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        (0, chai_1.expect)(rows.length).to.equal(2);
        const desc0 = rows[0].querySelector('.theia-scm-repository-description');
        const desc1 = rows[1].querySelector('.theia-scm-repository-description');
        (0, chai_1.expect)(desc0).to.exist;
        (0, chai_1.expect)(desc1).to.exist;
        // Repo at workspace root shows "/", nested repo shows relative path
        (0, chai_1.expect)(desc0.textContent).to.equal('/');
        (0, chai_1.expect)(desc1.textContent).to.equal('bar');
    });
    it('should show relative descriptions when duplicate names are in sibling directories', () => {
        const repo1 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/projects/lib' });
        const repo2 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/vendor/lib' });
        repositories.push(repo1, repo2);
        fireRepositoryAdded(repo2);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        (0, chai_1.expect)(rows.length).to.equal(2);
        const desc0 = rows[0].querySelector('.theia-scm-repository-description');
        const desc1 = rows[1].querySelector('.theia-scm-repository-description');
        (0, chai_1.expect)(desc0).to.exist;
        (0, chai_1.expect)(desc1).to.exist;
        (0, chai_1.expect)(desc0.textContent).to.equal('projects');
        (0, chai_1.expect)(desc1.textContent).to.equal('vendor');
    });
    it('should not show a description path when all repos have unique folder names', () => {
        const repo1 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/alpha' });
        const repo2 = makeRepo({ id: 'git', label: 'Git', rootUri: '/workspace/beta' });
        repositories.push(repo1, repo2);
        fireRepositoryAdded(repo2);
        const rendered = widget.render();
        const { container } = renderIntoContainer(rendered);
        const rows = container.querySelectorAll('.theia-scm-repository-item');
        (0, chai_1.expect)(rows.length).to.equal(2);
        // No description elements since names are unique
        (0, chai_1.expect)(rows[0].querySelector('.theia-scm-repository-description')).to.not.exist;
        (0, chai_1.expect)(rows[1].querySelector('.theia-scm-repository-description')).to.not.exist;
    });
});
//# sourceMappingURL=scm-repositories-widget.spec.js.map