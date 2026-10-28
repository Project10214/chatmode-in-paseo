// Paseo bundles the plugin from TypeScript sources, so `index.server.ts` imports
// siblings as `./x.js` while the file on disk is `x.ts`. Node's type stripping does
// not do that remap, so tests emulate the bundler's resolution.
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const mapped = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      return next(mapped.href, context);
    }
    throw error;
  }
}
