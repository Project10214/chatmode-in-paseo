# Third-party notices

The original code in this repository is released under the MIT License. See [LICENSE](LICENSE) (Copyright (c) 2026 Pennnnnnnnnn). The upstream portions listed below keep their original licenses and notices, which must be preserved when you copy or redistribute them; these obligations apply to every copy of this repository and to any derivative of it. See docs/UPSTREAM.md for versioned source links and docs/UPSTREAM_REUSE_AUDIT_20261016.md for the measured extent of reuse.

## Chat On Steroids — MIT

Upstream: <https://github.com/totec448-spec/chat-on-steroids> (version 2.1.35).

The twelve modules in `extension/upstream/` (`cos-*.js`) contain function-level transplants and adaptations of code from CoS `extension/chatgpt-dom.js` and `extension/fiber.js` at commit `ccd23b66cecf2f684fa3e12ca190297be02842cf`, and from `extension/content.js`, `extension/fiber.js` and `extension/usage.js` at commit `e40562640361ca8f74158b2262ca8c555b00abed`. They are modified excerpts, not byte-identical whole upstream files. `extension/dom-adapter.js` also retains adapted selectors and app-mention text handling. Namespacing, dependency injection, stricter send/config fences, no-nearest-effort policy and bounded projection adapters are documented in `vendor/cos/README.md` and its provenance manifest (`vendor/cos/provenance.json`, checked by `npm run verify:upstream`). The original Electron app, bridge server and full extension are not bundled.

A line-level comparison made on 2026-10-16 found that roughly 11–13% of this repository's runtime code lines are identical to CoS lines, almost all of them inside `extension/upstream/`; that is about 0.8% of CoS's own code.

```text
MIT License

Copyright (c) 2026 Chat On Steroids contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Dependencies and interfaces

Paseo packages, React, React Native, TypeScript, Zod and their dependencies are referenced in package.json, not redistributed as installed binaries in this source archive. Their own distributed license and notice files remain applicable when installed or bundled. Before redistributing a built product, generate a complete notice inventory from its reviewed dependency lockfile. This file does not claim to replace the dependencies' licenses.

The direct provider uses the publicly documented Paseo interface; the repository does not bundle Paseo SDK source. The new runtime is not the original CoS runtime and should not be represented as an official Paseo, CoS or OpenAI release.
