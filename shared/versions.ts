// The builds this package ships.
//
// The Paseo plugin loader only lets plugin modules live in client/, server/
// and shared/, and the server bundle is evaluated from memory, so neither the
// client nor the server can read package.json or extension/manifest.json at
// runtime. The shipped versions therefore live here, and scripts/check.mjs
// refuses the tree when they drift from the files they describe.
//
// The version the RUNNING extension reports is not here: it arrives over the
// wire and is proven by the server.

export const PLUGIN_VERSION = '0.1.0-alpha.4.49';
export const INSTALLED_EXTENSION_VERSION = '0.2.52';
