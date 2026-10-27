"use strict";
// *****************************************************************************
// Copyright (C) 2018 Ericsson and others.
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
const event_1 = require("./event");
describe('Event Objects', () => {
    it('Emitter firing should be synchronous', () => {
        const emitter = new event_1.Emitter();
        let counter = 0;
        emitter.event(() => counter++);
        (0, chai_1.expect)(counter).eq(0);
        emitter.fire(undefined);
        (0, chai_1.expect)(counter).eq(1);
    });
    describe('Emitter errorHandling option', () => {
        it('should log errors by default', () => {
            const emitter = new event_1.Emitter();
            const errors = [];
            const originalError = console.error;
            console.error = (e) => errors.push(e);
            try {
                emitter.event(() => { throw new Error('test error'); });
                emitter.fire(undefined);
                (0, chai_1.expect)(errors).to.have.lengthOf(1);
                (0, chai_1.expect)(errors[0].message).to.equal('test error');
            }
            finally {
                console.error = originalError;
            }
        });
        it('should propagate a single error when errorHandling is propagate', () => {
            const emitter = new event_1.Emitter({ errorHandling: 'propagate' });
            emitter.event(() => { throw new Error('boom'); });
            (0, chai_1.expect)(() => emitter.fire(undefined)).to.throw('boom');
        });
        it('should call all listeners before propagating the error', () => {
            const emitter = new event_1.Emitter({ errorHandling: 'propagate' });
            let secondCalled = false;
            emitter.event(() => { throw new Error('first fails'); });
            emitter.event(() => { secondCalled = true; });
            (0, chai_1.expect)(() => emitter.fire(undefined)).to.throw('first fails');
            (0, chai_1.expect)(secondCalled).to.be.true;
        });
        it('should throw AggregateError when multiple listeners fail with propagate', () => {
            const emitter = new event_1.Emitter({ errorHandling: 'propagate' });
            emitter.event(() => { throw new Error('error 1'); });
            emitter.event(() => { throw new Error('error 2'); });
            try {
                emitter.fire(undefined);
                chai_1.expect.fail('Expected an error to be thrown');
            }
            catch (err) {
                (0, chai_1.expect)(err).to.be.instanceOf(AggregateError);
                const aggregate = err;
                (0, chai_1.expect)(aggregate.errors).to.have.lengthOf(2);
                (0, chai_1.expect)(aggregate.errors[0].message).to.equal('error 1');
                (0, chai_1.expect)(aggregate.errors[1].message).to.equal('error 2');
            }
        });
        it('should invoke custom error handler for each error', () => {
            const errors = [];
            const emitter = new event_1.Emitter({ errorHandling: e => errors.push(e) });
            emitter.event(() => { throw new Error('handled 1'); });
            emitter.event(() => { throw new Error('handled 2'); });
            emitter.fire(undefined);
            (0, chai_1.expect)(errors).to.have.lengthOf(2);
            (0, chai_1.expect)(errors[0].message).to.equal('handled 1');
            (0, chai_1.expect)(errors[1].message).to.equal('handled 2');
        });
        it('should not throw when no listeners fail with propagate', () => {
            const emitter = new event_1.Emitter({ errorHandling: 'propagate' });
            let called = false;
            emitter.event(() => { called = true; });
            emitter.fire(undefined);
            (0, chai_1.expect)(called).to.be.true;
        });
    });
});
//# sourceMappingURL=event.spec.js.map