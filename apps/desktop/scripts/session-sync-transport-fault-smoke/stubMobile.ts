export let failMobile=false;export const mobileEvents:unknown[]=[];
export function setMobileFailure(x:boolean){failMobile=x;}
export const mobileEventBus={broadcast(e:unknown){if(failMobile)throw new Error("mobile SSE closed");mobileEvents.push(e);}};
