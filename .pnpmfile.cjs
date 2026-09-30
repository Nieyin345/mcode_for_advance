/** The app/contracts use Zod 3, but this SDK requires a Zod 4 runtime.
 * Materialize its own Zod 4 dependency instead of taking the incompatible app peer.
 * No peer-range suppression: post-pack checks verify the shipped SDK resolves Zod 4.
 * Scope this metadata repair to the reviewed SDK version; leave other packages alone.
 */
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name !== '@anthropic-ai/claude-agent-sdk' || pkg.version !== '0.3.258') return pkg;
      const { zod: _peer, ...peers } = pkg.peerDependencies || {};
      return { ...pkg, dependencies: { ...pkg.dependencies, zod: '4.4.3' }, peerDependencies: peers };
    },
  },
};
