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
const jsdom_1 = require("../test/jsdom");
// The widget module transitively imports `@lumino/widgets`, which touches `document` at load time.
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const inversify_1 = require("inversify");
const chai_1 = require("chai");
const common_1 = require("../../common");
const label_parser_1 = require("../label-parser");
const widgets_1 = require("../widgets");
const tree_view_welcome_widget_1 = require("./tree-view-welcome-widget");
disableJSDOM();
let labelParser;
before(() => {
    const container = new inversify_1.Container();
    container.bind(label_parser_1.LabelParser).toSelf().inSingletonScope();
    container.bind(common_1.CommandService).toDynamicValue(() => ({
        executeCommand() {
            return Promise.resolve(undefined);
        }
    })).inSingletonScope();
    labelParser = container.get(label_parser_1.LabelParser);
});
describe('TreeViewWelcomeWidget#renderLabelWithIcons', () => {
    // Exercise the protected helper without standing up the full TreeWidget DI graph.
    function render(label) {
        const widget = Object.create(tree_view_welcome_widget_1.TreeViewWelcomeWidget.prototype);
        widget.labelParser = labelParser;
        return widget.renderLabelWithIcons(label);
    }
    it('renders a leading $(codicon) as a codicon span and keeps the trailing text', () => {
        const nodes = render('$(robot) Launch AI Agent');
        (0, chai_1.expect)(nodes).to.have.lengthOf(2);
        (0, chai_1.expect)(nodes[0].props.className).to.equal((0, widgets_1.codicon)('robot'));
        (0, chai_1.expect)(nodes[0].props.children).to.be.undefined;
        (0, chai_1.expect)(nodes[1].props.className).to.be.undefined;
        (0, chai_1.expect)(nodes[1].props.children).to.equal(' Launch AI Agent');
    });
    it('renders a plain label as a single text span with no codicon', () => {
        const nodes = render('Open Documentation');
        (0, chai_1.expect)(nodes).to.have.lengthOf(1);
        (0, chai_1.expect)(nodes[0].props.className).to.be.undefined;
        (0, chai_1.expect)(nodes[0].props.children).to.equal('Open Documentation');
    });
    it('renders multiple codicons interleaved with text', () => {
        const nodes = render('$(package) Import $(gear) Library');
        const iconNodes = nodes.filter(n => typeof n.props.className === 'string' && n.props.className.includes('codicon-'));
        (0, chai_1.expect)(iconNodes).to.have.lengthOf(2);
        (0, chai_1.expect)(iconNodes[0].props.className).to.equal((0, widgets_1.codicon)('package'));
        (0, chai_1.expect)(iconNodes[1].props.className).to.equal((0, widgets_1.codicon)('gear'));
    });
});
//# sourceMappingURL=tree-view-welcome-widget.spec.js.map