# Changelog

All notable changes to `@fro.bot/systematic` are listed here, newest first. Entries start with the first release made through the release pull request; earlier releases are on [GitHub Releases](https://github.com/marcusrbrown/systematic/releases).

<!-- release-entries -->

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
