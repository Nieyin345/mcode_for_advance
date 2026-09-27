/** MAINT-M18 smoke: `electron` stand-in. Every call throws, so an installer
 *  path that would fall back to the real userData directory fails loudly. */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`maint-m18-smoke must not reach electron.${name}`);
  };
}

export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
};
