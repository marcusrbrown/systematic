# Changelog

All notable changes to `@fro.bot/systematic` are listed here, newest first. Entries start with the first release made through the release pull request; earlier releases are on [GitHub Releases](https://github.com/marcusrbrown/systematic/releases).

<!-- release-entries -->

## [3.27.1](https://github.com/marcusrbrown/systematic/compare/v3.27.0...v3.27.1) (2026-10-29)

### Bug Fixes

* let managed skill lists and disabled skills apply to both skill tools on OpenCode v1 ([#1246](https://github.com/marcusrbrown/systematic/issues/1246)) ([ef2acec](https://github.com/marcusrbrown/systematic/commit/ef2acec36cf6aa658d1f15753dbb28a75a0621fc))
* make the OCX plugin component install on OCX 2.x ([#1245](https://github.com/marcusrbrown/systematic/issues/1245)) ([ccd87c7](https://github.com/marcusrbrown/systematic/commit/ccd87c768781771201ff21e57028b8346c74d30d))

### Documentation

* **solutions:** record OpenCode v2 port lessons and refresh v1-only docs ([#1244](https://github.com/marcusrbrown/systematic/issues/1244)) ([aedf744](https://github.com/marcusrbrown/systematic/commit/aedf744adaffd3e83344d2e8a69a5f733318b2cb))

## [3.27.0](https://github.com/marcusrbrown/systematic/compare/v3.26.4...v3.27.0) (2026-10-28)

### Features

* support OpenCode v2 alongside OpenCode v1 ([#1239](https://github.com/marcusrbrown/systematic/issues/1239)) ([73fdd01](https://github.com/marcusrbrown/systematic/commit/73fdd019431a7a0e4e869da6522b5b5b69656f44))

### Tests

* clean up temp directories that unit tests create ([#1236](https://github.com/marcusrbrown/systematic/issues/1236)) ([21b5f29](https://github.com/marcusrbrown/systematic/commit/21b5f295784ee308ef54f77666a39dab1fed458f))

### Continuous Integration

* check every generated surface with one list and one drift command ([#1233](https://github.com/marcusrbrown/systematic/issues/1233)) ([4ec4c4c](https://github.com/marcusrbrown/systematic/commit/4ec4c4cbc3dfb60849f41c5cc7d90bc4d911676a))
* remove omo-providers from fro-bot.yaml ([#1238](https://github.com/marcusrbrown/systematic/issues/1238)) ([73ebc5a](https://github.com/marcusrbrown/systematic/commit/73ebc5ac937163a789daac177ab5d9734364fdfa))

### Miscellaneous Chores

* **deps:** update dependency @biomejs/biome to v2.6.3 ([#1235](https://github.com/marcusrbrown/systematic/issues/1235)) ([22444fc](https://github.com/marcusrbrown/systematic/commit/22444fc608eca982fcdb486d5c8c6cdb9f539307))
* **deps:** update fro-bot/agent to v0.126.0 ([#1234](https://github.com/marcusrbrown/systematic/issues/1234)) ([da61c20](https://github.com/marcusrbrown/systematic/commit/da61c20b2fe3123c7d70e986202cdb995f83ec4c))
* **deps:** update fro-bot/agent to v0.127.0 ([#1237](https://github.com/marcusrbrown/systematic/issues/1237)) ([bc2f272](https://github.com/marcusrbrown/systematic/commit/bc2f272063386eeecbecea1b715200e147671336))

## [3.26.4](https://github.com/marcusrbrown/systematic/compare/v3.26.3...v3.26.4) (2026-10-26)

### Bug Fixes

* **skills:** align compound refresh deletes, overlap output and doc naming ([#1231](https://github.com/marcusrbrown/systematic/issues/1231)) ([db26033](https://github.com/marcusrbrown/systematic/commit/db26033d4f1e47c4b7ddd4e1988abf6a102e500e))

## [3.26.3](https://github.com/marcusrbrown/systematic/compare/v3.26.2...v3.26.3) (2026-10-26)

### Bug Fixes

* **skills:** make the solution-doc contract stack-neutral and consistent ([#1228](https://github.com/marcusrbrown/systematic/issues/1228)) ([aca6b9a](https://github.com/marcusrbrown/systematic/commit/aca6b9a632136aeb0a06a297d3e539036ebbb72c))

### Documentation

* **contributing:** add test isolation, verification and release-title rules to AGENTS.md ([#1224](https://github.com/marcusrbrown/systematic/issues/1224)) ([1ab2fe8](https://github.com/marcusrbrown/systematic/commit/1ab2fe8ef211f8e586035bee3f5d6bf888f727fa))
* **plans:** reconcile plan statuses with shipped work and record the 2026-10-25 ideation ([#1225](https://github.com/marcusrbrown/systematic/issues/1225)) ([de3ab1b](https://github.com/marcusrbrown/systematic/commit/de3ab1bdaab9e02465d09b0019ef8835588938f9))
* **solutions:** record restating CI-only lifecycle rules in agent prose and reporting circular YAML values ([#1230](https://github.com/marcusrbrown/systematic/issues/1230)) ([e2e7644](https://github.com/marcusrbrown/systematic/commit/e2e764471680a06138097533e7be42032df79f94))
* **solutions:** record sizing a skill refresh to the ask and inferring the main worktree root ([#1222](https://github.com/marcusrbrown/systematic/issues/1222)) ([671d8b5](https://github.com/marcusrbrown/systematic/commit/671d8b563fd8b232b0521e0403582c3e56f64f44))

### Miscellaneous Chores

* **deps:** update fro-bot/agent to v0.125.4 ([#1226](https://github.com/marcusrbrown/systematic/issues/1226)) ([1fade54](https://github.com/marcusrbrown/systematic/commit/1fade5451b26373dcc9d99fff35a86fd89579fb9))
* **deps:** update fro-bot/agent to v0.125.5 ([#1227](https://github.com/marcusrbrown/systematic/issues/1227)) ([4b395a5](https://github.com/marcusrbrown/systematic/commit/4b395a5bc97bb1ad876673297754334f2a5b3e2a))
* **dev:** update dependency agent-browser to v0.39.2 ([#1223](https://github.com/marcusrbrown/systematic/issues/1223)) ([0cbde86](https://github.com/marcusrbrown/systematic/commit/0cbde86f1ffbee9afa8c350932aaa6a1c7c7e106))

## [3.26.2](https://github.com/marcusrbrown/systematic/compare/v3.26.1...v3.26.2) (2026-10-25)

### Bug Fixes

* **skills:** refresh git-worktree and place worktrees under .worktrees ([#1220](https://github.com/marcusrbrown/systematic/issues/1220)) ([86b667d](https://github.com/marcusrbrown/systematic/commit/86b667d463332747a2df9ef1c00f31daac1ca611))

### Build System

* **dev:** update OpenCode to v1.19.4 ([#1219](https://github.com/marcusrbrown/systematic/issues/1219)) ([53aede5](https://github.com/marcusrbrown/systematic/commit/53aede5333aa1e19ecb2c17f1785282fdbbb4956))

### Miscellaneous Chores

* **dev:** update dependency typebox to v1.4.3 ([#1218](https://github.com/marcusrbrown/systematic/issues/1218)) ([6674504](https://github.com/marcusrbrown/systematic/commit/6674504071c69116e0540bad67cfeba21d51f317))

## [3.26.1](https://github.com/marcusrbrown/systematic/compare/v3.26.0...v3.26.1) (2026-10-25)

### Bug Fixes

* **security:** patch compatible Undici consumers ([#1215](https://github.com/marcusrbrown/systematic/issues/1215)) ([3de13d4](https://github.com/marcusrbrown/systematic/commit/3de13d481b792ea0901f88fa57c5b7a0a235fdbd))
* **skills:** pass git-commit-push-pr PR bodies with --body-file ([#1213](https://github.com/marcusrbrown/systematic/issues/1213)) ([c62268a](https://github.com/marcusrbrown/systematic/commit/c62268ab84009d0e88c1e82005aa795b633318f3))

### Build System

* **deps:** update Pi to v1.4.0 ([#1217](https://github.com/marcusrbrown/systematic/issues/1217)) ([518cec3](https://github.com/marcusrbrown/systematic/commit/518cec36b813dc49e454cdaeef49a7bf35d51434))

### Documentation

* **solutions:** record how to publish PR evidence images and edit a managed Markdown section safely ([#1212](https://github.com/marcusrbrown/systematic/issues/1212)) ([75ea6ea](https://github.com/marcusrbrown/systematic/commit/75ea6ea39e25d3c634f9e89d3f0f2c5c5120b558))

### Miscellaneous Chores

* **deps:** update dependency @biomejs/biome to v2.6.2 ([#1216](https://github.com/marcusrbrown/systematic/issues/1216)) ([e4c101e](https://github.com/marcusrbrown/systematic/commit/e4c101e45f62eac3faf55dc7a9bc6ed867a243ba))
* **deps:** update fro-bot/agent to v0.125.3 ([#1211](https://github.com/marcusrbrown/systematic/issues/1211)) ([b1cdfb0](https://github.com/marcusrbrown/systematic/commit/b1cdfb0536c8056b07c27516d939d7d2d7474318))

## [3.26.0](https://github.com/marcusrbrown/systematic/compare/v3.25.2...v3.26.0) (2026-10-24)

### Features

* **skills:** add a skill for attaching screenshots to pull requests ([#1210](https://github.com/marcusrbrown/systematic/issues/1210)) ([c0d5f85](https://github.com/marcusrbrown/systematic/commit/c0d5f854b84469e70708d1598945798c71b3b882))

### Bug Fixes

* **security:** patch Mermaid's DOMPurify sanitizer ([#1208](https://github.com/marcusrbrown/systematic/issues/1208)) ([03fd7d4](https://github.com/marcusrbrown/systematic/commit/03fd7d4d8a3c2e34e40e317fa9137a5cc079a2c6))

### Miscellaneous Chores

* **deps:** update fro-bot/agent to v0.125.2 ([#1204](https://github.com/marcusrbrown/systematic/issues/1204)) ([01c4b00](https://github.com/marcusrbrown/systematic/commit/01c4b00b132a10e315f36e1f13d523a38362603c))

## [3.25.2](https://github.com/marcusrbrown/systematic/compare/v3.25.1...v3.25.2) (2026-10-22)

### Bug Fixes

* **review:** let ce:review runs with more than 32 findings finish ([#1205](https://github.com/marcusrbrown/systematic/issues/1205)) ([e2546a0](https://github.com/marcusrbrown/systematic/commit/e2546a04f0c683390c6214fb1c23223a135e4594))

### Documentation

* **solutions:** record why ce:review runs over 32 findings died at merge ([#1207](https://github.com/marcusrbrown/systematic/issues/1207)) ([3436a22](https://github.com/marcusrbrown/systematic/commit/3436a22ec48b091611b00b043566f1caca0d5d22))

## [3.25.1](https://github.com/marcusrbrown/systematic/compare/v3.25.0...v3.25.1) (2026-10-22)

### Bug Fixes

* **release:** retry transient GitHub API errors in the release gate ([#1202](https://github.com/marcusrbrown/systematic/issues/1202)) ([2715a49](https://github.com/marcusrbrown/systematic/commit/2715a49cbdcb45d2878150c652da58a5d15ec27d))

## [3.25.0](https://github.com/marcusrbrown/systematic/compare/v3.24.2...v3.25.0) (2026-10-22)

### Features

* **pi:** ship Systematic personas as pi-subagents package agents ([#1199](https://github.com/marcusrbrown/systematic/issues/1199)) ([8805a97](https://github.com/marcusrbrown/systematic/commit/8805a97cc6e1dbf4a0e3a359ae3c659c90df91c0))

### Bug Fixes

* **pi:** honor disabled skills and agents on Pi ([#1196](https://github.com/marcusrbrown/systematic/issues/1196)) ([cb69d73](https://github.com/marcusrbrown/systematic/commit/cb69d73d669df17a648f977cc0dbf0cf2002f5ae))
* **security:** bound Markdownlint parser denial of service ([#1190](https://github.com/marcusrbrown/systematic/issues/1190)) ([837134a](https://github.com/marcusrbrown/systematic/commit/837134a1c645f95eed0146a052727c3668d0d6d4))
* **security:** patch Vite Windows editor command injection ([#1191](https://github.com/marcusrbrown/systematic/issues/1191)) ([8df5d81](https://github.com/marcusrbrown/systematic/commit/8df5d812cd9bcd4e7cba1ec0018263e3257c1806))

### Documentation

* **solutions:** record packaged Pi personas, once-per-process warnings and completed-step rollback ([#1200](https://github.com/marcusrbrown/systematic/issues/1200)) ([872bef0](https://github.com/marcusrbrown/systematic/commit/872bef0c5a31e306646a736be8d47f2fc0bfe30f))

### Miscellaneous Chores

* **deps:** update bfra-me/.github to v4.43.0 ([#1198](https://github.com/marcusrbrown/systematic/issues/1198)) ([d58f157](https://github.com/marcusrbrown/systematic/commit/d58f1571f8fbfb1dd5b39c6a176a7e7d5575d0c0))
* **deps:** update dependency vite to ~8.3.0 ([#1194](https://github.com/marcusrbrown/systematic/issues/1194)) ([2772700](https://github.com/marcusrbrown/systematic/commit/27727001bee2c938b926288cabee54b036d690cd))
* **deps:** update fro-bot/agent to v0.125.0 ([#1187](https://github.com/marcusrbrown/systematic/issues/1187)) ([9431f8a](https://github.com/marcusrbrown/systematic/commit/9431f8ad59b69eaccbae66d74e00bbe4e9cd504b))
* **deps:** update github/codeql-action action to v4.39.1 ([#1192](https://github.com/marcusrbrown/systematic/issues/1192)) ([1b76cdd](https://github.com/marcusrbrown/systematic/commit/1b76cdd6bb81c02b454b614b80b008dbb9f6774c))
* **opencode:** update .gitignore and remove package-lock.json ([#1195](https://github.com/marcusrbrown/systematic/issues/1195)) ([5bdd3f6](https://github.com/marcusrbrown/systematic/commit/5bdd3f64760860cfe4a9dc549f593c4c83b76a51))

## [3.24.2](https://github.com/marcusrbrown/systematic/compare/v3.24.1...v3.24.2) (2026-10-21)

### Build System

* **deps:** update Pi to v1 ([#1184](https://github.com/marcusrbrown/systematic/issues/1184)) ([d2e6647](https://github.com/marcusrbrown/systematic/commit/d2e6647b97e95c489bd1df2b4f469e9f5ed8f0c0))

### Tests

* **evals:** give the R2 coverage probe an explicit timeout ([#1186](https://github.com/marcusrbrown/systematic/issues/1186)) ([c2bb180](https://github.com/marcusrbrown/systematic/commit/c2bb1808466dacfcefa1d6dad41279ee9084e911))
* **pi:** ask the pi-subagents Agent tool for an inline result ([#1189](https://github.com/marcusrbrown/systematic/issues/1189)) ([14a12ab](https://github.com/marcusrbrown/systematic/commit/14a12ab828e9facf0101d1fff07465d335e61384))
* **pi:** build before_agent_start fixtures that type on both Pi 0.99 and 1.x ([#1185](https://github.com/marcusrbrown/systematic/issues/1185)) ([cd8c2bc](https://github.com/marcusrbrown/systematic/commit/cd8c2bc8c1514c58e6db134042d7676d856c64df))

### Miscellaneous Chores

* **dev:** update dependency @tintinweb/pi-subagents to v0.22.0 ([#1166](https://github.com/marcusrbrown/systematic/issues/1166)) ([b291bf5](https://github.com/marcusrbrown/systematic/commit/b291bf560f99fedd642adc8e9220fc466a710953))

## [3.24.1](https://github.com/marcusrbrown/systematic/compare/v3.24.0...v3.24.1) (2026-10-20)

### Bug Fixes

* **deps:** update dependency @astrojs/starlight to ^0.42.0 ([#1168](https://github.com/marcusrbrown/systematic/issues/1168)) ([519d5bb](https://github.com/marcusrbrown/systematic/commit/519d5bb903590413d2e99e8f6231e8c276aae491))
* **plugin:** keep loaded skill output visible after OpenCode prunes it ([#1178](https://github.com/marcusrbrown/systematic/issues/1178)) ([1a43e25](https://github.com/marcusrbrown/systematic/commit/1a43e25d2db7f008d717542db75f52a6faeded59))

### Build System

* **deps:** update Pi to v0.99.2 ([#1165](https://github.com/marcusrbrown/systematic/issues/1165)) ([030406b](https://github.com/marcusrbrown/systematic/commit/030406b73ab9f5c4f073df2cb1c4654807b10295))
* **dev:** add the Markdown dependencies Starlight 0.42 needs ([#1183](https://github.com/marcusrbrown/systematic/issues/1183)) ([012da0a](https://github.com/marcusrbrown/systematic/commit/012da0a34f67c770a95d0d45898915f2fb046d0b))

### Documentation

* **solutions:** record how to test host prune from a plugin ([#1180](https://github.com/marcusrbrown/systematic/issues/1180)) ([dc79ac8](https://github.com/marcusrbrown/systematic/commit/dc79ac8bc8adab15dc4e341a9f2c3ea49dcc14be))
* **solutions:** record the config-key removal pattern and two release-automation races ([#1172](https://github.com/marcusrbrown/systematic/issues/1172)) ([913c2c6](https://github.com/marcusrbrown/systematic/commit/913c2c69508d490a460220212d31895ed6903264))
* **solutions:** record the queue: max fix for cancelled Renovate checks ([#1176](https://github.com/marcusrbrown/systematic/issues/1176)) ([041aeaf](https://github.com/marcusrbrown/systematic/commit/041aeaf9e74c70b048dfd86d6e9bcd170a6ec064))

### Tests

* **config-schema:** keep the version fixture's git commands out of an inherited repository ([#1174](https://github.com/marcusrbrown/systematic/issues/1174)) ([265948a](https://github.com/marcusrbrown/systematic/commit/265948a6ff8d36da80fed21c4240fe404b55a406))
* isolate eval cleanup fixture Git initialization ([#1173](https://github.com/marcusrbrown/systematic/issues/1173)) ([41f57ec](https://github.com/marcusrbrown/systematic/commit/41f57ec73e011ba30fc9c71fbc9b37038cb680d6))
* **pi:** derive the delegate tool's execute context from the tool definition ([#1182](https://github.com/marcusrbrown/systematic/issues/1182)) ([885cd5c](https://github.com/marcusrbrown/systematic/commit/885cd5cdebab7b6215e3bbec4f3f30c4d6415287))

### Continuous Integration

* **content-integrity:** verify path:line citations in solution docs ([#1181](https://github.com/marcusrbrown/systematic/issues/1181)) ([6d2d12a](https://github.com/marcusrbrown/systematic/commit/6d2d12a61f11e96f03a002c3c6466f014531f253))
* **release:** replace the release PR's merge subject when re-arming auto-merge ([#1170](https://github.com/marcusrbrown/systematic/issues/1170)) ([db76640](https://github.com/marcusrbrown/systematic/commit/db76640dd9168fcde4b027a7c501e94fb50e89b8))

### Miscellaneous Chores

* **deps:** update bfra-me/.github to v4.41.0 ([#1171](https://github.com/marcusrbrown/systematic/issues/1171)) ([c1d9d07](https://github.com/marcusrbrown/systematic/commit/c1d9d07de6f6ec653357434727e98700ec8b0cee))
* **deps:** update bfra-me/.github to v4.42.0 ([#1177](https://github.com/marcusrbrown/systematic/issues/1177)) ([066a8ef](https://github.com/marcusrbrown/systematic/commit/066a8ef01821d7902678eb3a462ddb4115828ef4))
* **deps:** update fro-bot/agent to v0.124.1 ([#1175](https://github.com/marcusrbrown/systematic/issues/1175)) ([9c65c71](https://github.com/marcusrbrown/systematic/commit/9c65c719766d1515c9d13f529affc28557e97b17))
* **dev:** update dependency typebox to v1.4.1 ([#1163](https://github.com/marcusrbrown/systematic/issues/1163)) ([c6488f7](https://github.com/marcusrbrown/systematic/commit/c6488f7c4de9317863c68e056313e4a0542f7c38))

## [3.24.0](https://github.com/marcusrbrown/systematic/compare/v3.23.0...v3.24.0) (2026-10-19)

### Features

* **guard:** remove the workflow guard ([#1169](https://github.com/marcusrbrown/systematic/issues/1169)) ([a36df25](https://github.com/marcusrbrown/systematic/commit/a36df2573e1ec0f5e661b5e1325f1f32ed521be3))

### Bug Fixes

* **test:** isolate plugin wiring fixture Git commands ([#1157](https://github.com/marcusrbrown/systematic/issues/1157)) ([2adcc71](https://github.com/marcusrbrown/systematic/commit/2adcc71da5f64378fa6c887ce3ff3e30fc4c641d))

### Build System

* **dev:** update OpenCode to v1.19.3 ([#1154](https://github.com/marcusrbrown/systematic/issues/1154)) ([1a91ea9](https://github.com/marcusrbrown/systematic/commit/1a91ea9b57573cea0b4b4179d5727db2bfe31216))

### Documentation

* **solutions:** describe the sharded host contract job ([#1162](https://github.com/marcusrbrown/systematic/issues/1162)) ([ecba5de](https://github.com/marcusrbrown/systematic/commit/ecba5de3231c8acb25d836ed90182b8758a529bf))

### Continuous Integration

* **host-contract:** run the host contract suite in four timed shards ([#1161](https://github.com/marcusrbrown/systematic/issues/1161)) ([d781d84](https://github.com/marcusrbrown/systematic/commit/d781d8457bdd332dbce385f716d5f368ce5c4ce9))

### Miscellaneous Chores

* **deps:** update bfra-me/.github action to v4.40.0 ([#1155](https://github.com/marcusrbrown/systematic/issues/1155)) ([90bf636](https://github.com/marcusrbrown/systematic/commit/90bf6364fa5afd2ee02e3e5743e7b3f2959c432a))
* **deps:** update fro-bot/agent to v0.124.0 ([#1156](https://github.com/marcusrbrown/systematic/issues/1156)) ([9a81ac0](https://github.com/marcusrbrown/systematic/commit/9a81ac0428e652a44a3d2af5c6897b736ec95c6b))
* **dev:** update dependency agent-browser to v0.39.1 ([#1167](https://github.com/marcusrbrown/systematic/issues/1167)) ([f253766](https://github.com/marcusrbrown/systematic/commit/f253766ddf4fb200317f50beba435bf3043320af))

## [3.23.0](https://github.com/marcusrbrown/systematic/compare/v3.22.7...v3.23.0) (2026-10-19)

### Features

* **guard:** turn the workflow guard off by default ([#1158](https://github.com/marcusrbrown/systematic/issues/1158)) ([317e7ed](https://github.com/marcusrbrown/systematic/commit/317e7edd0fdaed1a301d81995e3812559e02b8ed))

### Miscellaneous Chores

* **deps:** update fro-bot/agent to v0.123.1 ([#1150](https://github.com/marcusrbrown/systematic/issues/1150)) ([7d67734](https://github.com/marcusrbrown/systematic/commit/7d67734312087fc0470d9baa921772f814a58a2e))

## [3.22.7](https://github.com/marcusrbrown/systematic/compare/v3.22.6...v3.22.7) (2026-10-18)

### Bug Fixes

* **observer:** read submodule and nested repository contents in the local snapshot ([#1151](https://github.com/marcusrbrown/systematic/issues/1151)) ([52ce22b](https://github.com/marcusrbrown/systematic/commit/52ce22bb8cb8a7f6dc592f1dfc96bd8195ee53cc))

## [3.22.6](https://github.com/marcusrbrown/systematic/compare/v3.22.5...v3.22.6) (2026-10-18)

### Bug Fixes

* **guard:** fence core observations against redeclaration and keep seed timeouts visible ([#1144](https://github.com/marcusrbrown/systematic/issues/1144)) ([3e5667b](https://github.com/marcusrbrown/systematic/commit/3e5667b4a5521b4a7f0f9a86783cf4cd6ec64374))
* **test:** isolate workflow guard fixture Git commands ([#1148](https://github.com/marcusrbrown/systematic/issues/1148)) ([95a761c](https://github.com/marcusrbrown/systematic/commit/95a761cc15d2a5338fac0a0500ead66d275c0590))

### Documentation

* **solutions:** record the declaration fence and the propagated-baseline seed rule ([#1146](https://github.com/marcusrbrown/systematic/issues/1146)) ([e70b070](https://github.com/marcusrbrown/systematic/commit/e70b070720c06868d5ad7cb90455c9d039faaa15))

### Miscellaneous Chores

* **deps:** update fro-bot/agent to v0.123.0 ([#1149](https://github.com/marcusrbrown/systematic/issues/1149)) ([c0cdb25](https://github.com/marcusrbrown/systematic/commit/c0cdb25ba6923707ab42dbcc9b3037fba5c69e3a))
* **dev:** update dependency playwright to v1.64.1 ([#1141](https://github.com/marcusrbrown/systematic/issues/1141)) ([d1533e5](https://github.com/marcusrbrown/systematic/commit/d1533e56fd8fba54a836a28d59a63e7d4a0b802d))

## [3.22.5](https://github.com/marcusrbrown/systematic/compare/v3.22.4...v3.22.5) (2026-10-17)

### Bug Fixes

* **guard:** block the unit instead of disabling the guard when the worktree breaks a snapshot ([#1134](https://github.com/marcusrbrown/systematic/issues/1134)) ([e1ef220](https://github.com/marcusrbrown/systematic/commit/e1ef22055ffb811a80a69e03f2cf361dccd3e7dd))
* **guard:** do not receipt a verification that overlapped another local call ([#1142](https://github.com/marcusrbrown/systematic/issues/1142)) ([5cad8aa](https://github.com/marcusrbrown/systematic/commit/5cad8aa588b5727d99c555fdf56c73843a1cf95d))
* **guard:** isolate operation timeouts and rejected pushes to the one call instead of disabling the guard ([#1138](https://github.com/marcusrbrown/systematic/issues/1138)) ([6983602](https://github.com/marcusrbrown/systematic/commit/69836021c1d85ceba02672f35ee9af9f80cd03cf))
* **security:** patch transitive YAML denial of service ([#1137](https://github.com/marcusrbrown/systematic/issues/1137)) ([4fa8c8c](https://github.com/marcusrbrown/systematic/commit/4fa8c8c6cc64b4a2f5766b8fbdfc6346a9e9edef))
* **security:** preserve release client's undici connection checks ([#1139](https://github.com/marcusrbrown/systematic/issues/1139)) ([ef0decf](https://github.com/marcusrbrown/systematic/commit/ef0decf2359a53593a5110b346d33e512f57870e))

### Documentation

* **solutions:** record how transient operation timeouts and rejected pushes stay confined to one call ([#1140](https://github.com/marcusrbrown/systematic/issues/1140)) ([e97c59f](https://github.com/marcusrbrown/systematic/commit/e97c59f7b682eb1a448c98f2bb5a23f145da5864))
* **solutions:** record the recoverable snapshot block, the async-commit version fence, and unprovable defensive checks ([#1136](https://github.com/marcusrbrown/systematic/issues/1136)) ([b5eea14](https://github.com/marcusrbrown/systematic/commit/b5eea14b01475ee06679c8334f49e0e32f9e95f6))
* **solutions:** record why a verification that overlapped another local call is sealed ([#1143](https://github.com/marcusrbrown/systematic/issues/1143)) ([b6e45c5](https://github.com/marcusrbrown/systematic/commit/b6e45c5b4669067adb3aa814e2ac3f50ba800c52))

### Miscellaneous Chores

* **dev:** update dependency typebox to v1.3.37 ([#1133](https://github.com/marcusrbrown/systematic/issues/1133)) ([56cddff](https://github.com/marcusrbrown/systematic/commit/56cddff54eb87b9ccfba4da526f67eca3cac016f))

## [3.22.4](https://github.com/marcusrbrown/systematic/compare/v3.22.3...v3.22.4) (2026-10-15)

### Bug Fixes

* **guard:** stop the operation observer from reading a changed worktree as unchanged ([#1129](https://github.com/marcusrbrown/systematic/issues/1129)) ([5a4ed40](https://github.com/marcusrbrown/systematic/commit/5a4ed40bba271f75a778ca0b0c7dfa9b19ba232a))
* **security:** patch PostCSS Nano ID denial of service ([#1127](https://github.com/marcusrbrown/systematic/issues/1127)) ([6f23f58](https://github.com/marcusrbrown/systematic/commit/6f23f5820bb5dd95badb7d6a0d90c7fb3c9e8e22))

### Documentation

* **solutions:** record the digest collapse, release gate, brokered push and action pin fixes ([#1122](https://github.com/marcusrbrown/systematic/issues/1122)) ([1709656](https://github.com/marcusrbrown/systematic/commit/1709656d64fbba2a45a0b04d69f3c5f44c1d10dd))
* **solutions:** record the operation observer false-clean fixes and the review-spiral scope cut ([#1130](https://github.com/marcusrbrown/systematic/issues/1130)) ([f812849](https://github.com/marcusrbrown/systematic/commit/f81284966831da6f20e1fa26fd1123e18a6347e0))

### Tests

* **release:** accept any pinned release App token action ([#1121](https://github.com/marcusrbrown/systematic/issues/1121)) ([cef2d11](https://github.com/marcusrbrown/systematic/commit/cef2d1190741a6560d8d1e9fce1fda7ee3d2628e))

### Miscellaneous Chores

* **deps:** update actions/create-github-app-token action to v3.3.0 ([#1102](https://github.com/marcusrbrown/systematic/issues/1102)) ([30ec28b](https://github.com/marcusrbrown/systematic/commit/30ec28bf1f32b706b057ab16bbb1a5938b000c2d))
* **deps:** update fro-bot/agent to v0.122.2 ([#1123](https://github.com/marcusrbrown/systematic/issues/1123)) ([12f3f17](https://github.com/marcusrbrown/systematic/commit/12f3f17841f2147677a9fb75734901a3036aa561))
* **deps:** update github/codeql-action action to v4.39.0 ([#1132](https://github.com/marcusrbrown/systematic/issues/1132)) ([b9f80cf](https://github.com/marcusrbrown/systematic/commit/b9f80cf532d584b35ea5e6bcc1a60e7caa9c8065))

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
