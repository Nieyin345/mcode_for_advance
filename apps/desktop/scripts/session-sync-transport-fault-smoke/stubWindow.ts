export let failDesktop = false; export const desktopEvents:unknown[]=[];
export function setDesktopFailure(x:boolean){failDesktop=x;}
export function sendToRenderer(channel:string,payload:unknown){if(failDesktop)throw new Error("desktop renderer destroyed");desktopEvents.push({channel,payload});}
