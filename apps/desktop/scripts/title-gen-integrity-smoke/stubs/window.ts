export const notifications:unknown[]=((globalThis as unknown as {__titleNotifications?:unknown[]}).__titleNotifications ??= []);
export function sendToRenderer(...args:unknown[]){notifications.push(args);}
