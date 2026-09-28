/** `@main/lib/secretStore.js` 的替身 —— 真的那个走 electron safeStorage。这里只要可逆。 */
export const encrypt = (plain: string): string => `enc:${plain}`;
export const decrypt = (blob: string): string => (blob.startsWith("enc:") ? blob.slice(4) : "");
