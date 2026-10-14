# Changelog

All notable changes to `@fro.bot/systematic` are listed here, newest first. Entries start with the first release made through the release pull request; earlier releases are on [GitHub Releases](https://github.com/marcusrbrown/systematic/releases).

<!-- release-entries -->

## [3.22.3](https://github.com/marcusrbrown/systematic/compare/v3.22.2...v3.22.3) (2026-10-14)

### Bug Fixes

* **guard:** fingerprint operations and identities of any size ([#1119](https://github.com/marcusrbrown/systematic/issues/1119)) ([d3b9234](https://github.com/marcusrbrown/systematic/commit/d3b923418d7cc032d753cf0b3643b0ab184edc75))
* **guard:** observe operations only while guarded work can use them ([#1116](https://github.com/marcusrbrown/systematic/issues/1116)) ([3632fb2](https://github.com/marcusrbrown/systematic/commit/3632fb2f85676f5e0ded567b8ee2001faf79f941))
* **release:** accept GitHub-signed release commits in the scheduled gate ([#1120](https://github.com/marcusrbrown/systematic/issues/1120)) ([3499d23](https://github.com/marcusrbrown/systematic/commit/3499d23b0bd6668f16c8dc7200d465bc4505d3f0))
* **security:** bound indexed source-map processing ([#1060](https://github.com/marcusrbrown/systematic/issues/1060)) ([6bb89a8](https://github.com/marcusrbrown/systematic/commit/6bb89a8dfc91b70822ea7f277cbf2ce75fb24991))
* **security:** patch Sharp librsvg vulnerability ([#1059](https://github.com/marcusrbrown/systematic/issues/1059)) ([bfcc401](https://github.com/marcusrbrown/systematic/commit/bfcc401bf23ffba32b963dc50541a5a63cd87176))
* **security:** reject injected URI authority components ([#1052](https://github.com/marcusrbrown/systematic/issues/1052)) ([68960f5](https://github.com/marcusrbrown/systematic/commit/68960f5f95da874d837338ab184ba03ed3e8a971))

### Build System

* **dev:** update OpenCode to v1.19.0 ([#1118](https://github.com/marcusrbrown/systematic/issues/1118)) ([f9ffc50](https://github.com/marcusrbrown/systematic/commit/f9ffc5037a9e9d7fdd68f0dad2d51403a2b3da06))

### Continuous Integration

* **fro-bot:** let trusted PR comments deliver fixes through the brokered push ([#1117](https://github.com/marcusrbrown/systematic/issues/1117)) ([15b1ec8](https://github.com/marcusrbrown/systematic/commit/15b1ec85b75fdc8fe5556ffc3d5fd05076527d12))
* **release:** drop the hourly release reconcile ([#1112](https://github.com/marcusrbrown/systematic/issues/1112)) ([6cd8a43](https://github.com/marcusrbrown/systematic/commit/6cd8a43cec3ee3df41f3e50cf956cf82715d220f))

### Miscellaneous Chores

* **deps:** update fro-bot/agent to v0.122.1 ([#1114](https://github.com/marcusrbrown/systematic/issues/1114)) ([ccc204d](https://github.com/marcusrbrown/systematic/commit/ccc204d39ef8509cc890b791ccafc0e34e769d9e))
* **lint:** align Biome schema with installed release ([#1056](https://github.com/marcusrbrown/systematic/issues/1056)) ([113a0e3](https://github.com/marcusrbrown/systematic/commit/113a0e32150abb7fb0740ff41cf32cc5bff26fad))

## [3.22.2](https://github.com/marcusrbrown/systematic/compare/v3.22.1...v3.22.2) (2026-10-13)

### Bug Fixes

* **guard:** only allowlisted skills activate a workflow epoch ([#1107](https://github.com/marcusrbrown/systematic/issues/1107)) ([3fb1b4b](https://github.com/marcusrbrown/systematic/commit/3fb1b4b916ee5b568d8dcde90bf310083eef1042))
* **skills:** name only skills the resolver can load ([#1111](https://github.com/marcusrbrown/systematic/issues/1111)) ([f6e6cad](https://github.com/marcusrbrown/systematic/commit/f6e6cad5a2482fb91b03ca9021123d64c9b429bc))
* **skills:** resolve bundled workflow handoff targets ([#1110](https://github.com/marcusrbrown/systematic/issues/1110)) ([a501c5a](https://github.com/marcusrbrown/systematic/commit/a501c5a68720a9638277c7303c45f7b07f872343))

### Tests

* **guard:** prove the large non-allowlisted skill load succeeded ([#1109](https://github.com/marcusrbrown/systematic/issues/1109)) ([63f09d8](https://github.com/marcusrbrown/systematic/commit/63f09d803b94065027aec457a183e7d1b898582a))

## [3.22.1](https://github.com/marcusrbrown/systematic/compare/v3.22.0...v3.22.1) (2026-10-13)

### Bug Fixes

* **deps:** update dependency web-tree-sitter to v0.27.1 ([#1085](https://github.com/marcusrbrown/systematic/issues/1085)) ([c95b217](https://github.com/marcusrbrown/systematic/commit/c95b2172c788d0a98c581c9e11ac9923dc9744b8))
* **guard:** keep the workflow guard available in large repositories and record why it is not ([#1101](https://github.com/marcusrbrown/systematic/issues/1101)) ([5480af4](https://github.com/marcusrbrown/systematic/commit/5480af4a8cf03181c943254e4a1b1c6e0efde955))

### Continuous Integration

* **release:** open the release pull request when nothing is published ([#1103](https://github.com/marcusrbrown/systematic/issues/1103)) ([20c2028](https://github.com/marcusrbrown/systematic/commit/20c20283c70a9c18cb05f33764a8c7e74f02df0f))
* **release:** publish only through the gated release with npm OIDC ([#1100](https://github.com/marcusrbrown/systematic/issues/1100)) ([15eca8f](https://github.com/marcusrbrown/systematic/commit/15eca8fbde96638fc912872660b830e4a185585e))
