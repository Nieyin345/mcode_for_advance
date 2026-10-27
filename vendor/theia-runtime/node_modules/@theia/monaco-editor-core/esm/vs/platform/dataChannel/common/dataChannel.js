/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
export const IDataChannelService = createDecorator('dataChannelService');
export class NullDataChannelService {
    get onDidSendData() {
        return Event.None;
    }
    getDataChannel(_channelId) {
        return {
            sendData: () => { },
        };
    }
}
//# sourceMappingURL=dataChannel.js.map