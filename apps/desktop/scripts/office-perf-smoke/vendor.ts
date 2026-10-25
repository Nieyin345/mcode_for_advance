export const vendorAvailable=true;
export const configs: unknown[]=[];
export function configureNativeRuntimes(runtime:unknown){configs.push(runtime);}
export function createNativeView():never{throw new Error("unexpected: no Electron view in resource test");}
