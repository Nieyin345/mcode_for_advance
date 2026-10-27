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
const chai_1 = require("chai");
const launch_arguments_1 = require("../../common/launch-arguments");
const electron_window_launch_args_1 = require("./electron-window-launch-args");
class TestElectronWindowLaunchArgs extends electron_window_launch_args_1.ElectronWindowLaunchArgs {
    constructor(metadata) {
        super();
        this.metadata = metadata;
    }
    getLaunchArgs() {
        return this.metadata.launchArgs;
    }
}
describe('ElectronWindowLaunchArgs', () => {
    it('returns undefined for a cold-start window (main attached no options)', () => {
        const service = new TestElectronWindowLaunchArgs({ webcontentId: '1' });
        (0, chai_1.expect)(service.getLaunchArgs()).to.equal(undefined);
    });
    it('returns the options attached to the window metadata', () => {
        const launchArgs = { values: { 'attach-container': ['B'], 'session-preference': ['foo=1'] }, negated: [] };
        const service = new TestElectronWindowLaunchArgs({ webcontentId: '1', launchArgs });
        const args = service.getLaunchArgs();
        (0, chai_1.expect)(launch_arguments_1.LaunchArguments.lastValue(args, 'attach-container')).to.equal('B');
        (0, chai_1.expect)(launch_arguments_1.LaunchArguments.values(args, 'session-preference')).to.deep.equal(['foo=1']);
    });
});
//# sourceMappingURL=electron-window-launch-args.spec.js.map