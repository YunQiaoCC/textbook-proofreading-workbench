# Dependency license review

Reviewed against `package-lock.json` generated on 2026-09-18. The lockfile uses
the public npm registry and contains 270 installed package entries.

## Direct dependencies

| Scope | Package | Version | License |
| --- | --- | ---: | --- |
| runtime | `@modelcontextprotocol/client` | 2.0.0 | MIT |
| runtime | `inklayer-vue` | 1.2.3 | MIT |
| runtime | `vue` | 3.5.43 | MIT |
| development | `@types/node` | 24.13.5 | MIT |
| development | `@vitejs/plugin-vue` | 6.0.9 | MIT |
| development | `@vue/tsconfig` | 0.9.1 | MIT |
| development | `typescript` | 6.0.3 | Apache-2.0 |
| development | `vite` | 8.3.0 | MIT |
| development | `vue-tsc` | 3.3.11 | MIT |

## Lockfile review

The transitive license metadata resolves to permissive licenses plus MPL-2.0:
MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, MIT/X11,
MIT-and-Zlib, Unlicense, MPL-2.0, and one MIT-or-GPL-3.0-or-later dual license.
The dual-licensed package is `jszip@3.10.2`; this project uses it under MIT.
No GPL-only or AGPL-only dependency was found.

`buffers@0.1.1` is the sole package whose old npm metadata omits its license.
It was manually resolved as MIT using the Debian Sources copyright record for
`node-buffers` 0.1.1-2, which identifies the upstream package and records the
MIT declaration:

https://sources.debian.org/copyright/license/node-buffers/0.1.1-2/

This review covers declared package licenses and the lockfile graph. It is not
a legal opinion and should be repeated when dependencies change.
