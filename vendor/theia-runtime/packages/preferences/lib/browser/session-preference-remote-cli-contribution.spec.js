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
const launchArgs = (values) => ({ values, negated: [] });
const cli_preferences_1 = require("../common/cli-preferences");
const session_preference_remote_cli_contribution_1 = require("./session-preference-remote-cli-contribution");
class TestContribution extends session_preference_remote_cli_contribution_1.SessionPreferenceRemoteCliContribution {
    set forwardedArgs(args) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.launchArgs = { getLaunchArgs: () => args };
    }
}
describe('SessionPreferenceRemoteCliContribution#getRemoteCliArgs', () => {
    let contribution;
    beforeEach(() => {
        contribution = new TestContribution();
    });
    it('returns no args for a cold-start window (no forwarded options)', async () => {
        contribution.forwardedArgs = undefined;
        (0, chai_1.expect)(await contribution.getRemoteCliArgs()).to.deep.equal([]);
    });
    it('returns no args for a forwarded window without --session-preference', async () => {
        contribution.forwardedArgs = launchArgs({ 'attach-container': ['B'] });
        (0, chai_1.expect)(await contribution.getRemoteCliArgs()).to.deep.equal([]);
    });
    it('formats forwarded --session-preference values for the remote backend', async () => {
        contribution.forwardedArgs = launchArgs({ 'attach-container': ['B'], 'session-preference': ['editor.fontSize=20'] });
        const args = await contribution.getRemoteCliArgs();
        (0, chai_1.expect)(args).to.have.lengthOf(1);
        // The produced arg must parse back to the original entry on the remote.
        const value = args[0].substring('--session-preference='.length);
        (0, chai_1.expect)(cli_preferences_1.CliPreferenceEntry.parse(value)).to.deep.equal(['editor.fontSize', 20]);
    });
});
//# sourceMappingURL=session-preference-remote-cli-contribution.spec.js.map