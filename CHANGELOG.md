# Changelog

## [0.22.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.21.0...v0.22.0) (2026-11-24)


### Features

* **smart-compact:** ask again only after more growth or a checkpoint ([59e9b54](https://github.com/tartinerlabs/claude-code-mods/commit/59e9b54d17464d745060456462ff7616b09aed83))
* **smart-compact:** let Haiku decide when to compact ([3516165](https://github.com/tartinerlabs/claude-code-mods/commit/351616531587a27b6f161b186dd597dea1d9135e))


### Bug Fixes

* **auto-resume:** back up the built-in auto-continue ([07bad8c](https://github.com/tartinerlabs/claude-code-mods/commit/07bad8c71f8d4348c5de0e98812ed5d2527bbc43))
* **limit-watch:** skip the toasts in the desktop app ([6230d5d](https://github.com/tartinerlabs/claude-code-mods/commit/6230d5d72f6d03fcdc7e43450eed5bbfbcdda599))
* **smart-compact:** leave the decider room to think ([69ef3e1](https://github.com/tartinerlabs/claude-code-mods/commit/69ef3e194b9635bd3c2a8320ac6bcb5108e9e80a))

## [0.21.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.20.1...v0.21.0) (2026-11-21)


### Features

* **vercel-watch:** follow pull request preview deploys ([21c930c](https://github.com/tartinerlabs/claude-code-mods/commit/21c930c6d56da2db23da7ce7595251acdf65eaf4))

## [0.20.1](https://github.com/tartinerlabs/claude-code-mods/compare/v0.20.0...v0.20.1) (2026-11-21)


### Bug Fixes

* **vercel-watch:** follow pushes and merges run with ! ([8695cfc](https://github.com/tartinerlabs/claude-code-mods/commit/8695cfc745a2f53a712a032a7ff3af4120de6e00))

## [0.20.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.19.4...v0.20.0) (2026-11-21)


### Features

* **vercel-watch:** follow Vercel deploys of pushes and merges ([8f47c3a](https://github.com/tartinerlabs/claude-code-mods/commit/8f47c3a9e167ffb7493392e08acd219d7820ee1c))


### Bug Fixes

* **vercel-watch:** address review of merges, polling and status text ([9a3a5ab](https://github.com/tartinerlabs/claude-code-mods/commit/9a3a5ab91edffa0f47bc2ccc078bea9de65435fb))
* **vercel-watch:** poll a newer watch at once while an older one waits ([6422167](https://github.com/tartinerlabs/claude-code-mods/commit/64221674c564b8aa42aaa5cc63a3ebd3d4de3460))
* **vercel-watch:** run one poll at a time so failures report once ([36cd368](https://github.com/tartinerlabs/claude-code-mods/commit/36cd3682441f6dde2cafd7769e136811ff1fd26f))

## [0.19.4](https://github.com/tartinerlabs/claude-code-mods/compare/v0.19.3...v0.19.4) (2026-11-21)


### Bug Fixes

* **auto-resume:** handle repeated hours and reset backoff on prompts ([0840aba](https://github.com/tartinerlabs/claude-code-mods/commit/0840aba703679f8ee36b25f9eca281a73483dcdf))
* **auto-resume:** wait out limits the usage windows miss ([b4354e3](https://github.com/tartinerlabs/claude-code-mods/commit/b4354e3a1fa296dd48e54880b4cc1f83421602cc)), closes [#54](https://github.com/tartinerlabs/claude-code-mods/issues/54)
* **limit-watch:** drop the API-equivalent session cost ([8186472](https://github.com/tartinerlabs/claude-code-mods/commit/8186472bcd5b8e275fc5572d824d3ef1f6cc61b8))

## [0.19.3](https://github.com/tartinerlabs/claude-code-mods/compare/v0.19.2...v0.19.3) (2026-11-21)


### Bug Fixes

* hide bands that duplicate the desktop app ([8b6e1b5](https://github.com/tartinerlabs/claude-code-mods/commit/8b6e1b5f8cd187532fd4d910758872552cacde33))
* keep the desktop bands' parts the app lacks ([b21a732](https://github.com/tartinerlabs/claude-code-mods/commit/b21a73248551a1db5a015b19af105cfba6ac6393))

## [0.19.2](https://github.com/tartinerlabs/claude-code-mods/compare/v0.19.1...v0.19.2) (2026-11-21)


### Bug Fixes

* **youtube:** read en-orig captions and keep details on 429 ([b020aa8](https://github.com/tartinerlabs/claude-code-mods/commit/b020aa808072558aae80fd952259d8574e53eec7))

## [0.19.1](https://github.com/tartinerlabs/claude-code-mods/compare/v0.19.0...v0.19.1) (2026-11-15)


### Bug Fixes

* **auto-resume:** resume on wake, retry on failure ([544aa15](https://github.com/tartinerlabs/claude-code-mods/commit/544aa15a8e8a499acb96e43aafc6a726330adf39))
* **git-status:** keep refresh promise void ([1680bef](https://github.com/tartinerlabs/claude-code-mods/commit/1680bef78645d06249f1cbd93f84265eb2f46c09))

## [0.19.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.18.0...v0.19.0) (2026-11-11)


### Features

* **auto-resume:** count down in the status line ([10f1e22](https://github.com/tartinerlabs/claude-code-mods/commit/10f1e22b521e86eb30af2fff05b0be1eca3ce3d4))

## [0.18.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.17.0...v0.18.0) (2026-11-01)


### Features

* **youtube:** add youtube mod ([ad7e983](https://github.com/tartinerlabs/claude-code-mods/commit/ad7e983ea5fabde88c8f51c216833684bc006d3a))

## [0.17.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.16.0...v0.17.0) (2026-10-29)


### Features

* **git-status:** add git status mod ([6abd634](https://github.com/tartinerlabs/claude-code-mods/commit/6abd634cb6808e15d58ec63a0d31157a10007616))
* **git-status:** draw the tree in the band with words and colours ([747916c](https://github.com/tartinerlabs/claude-code-mods/commit/747916ca774c2123ae6b088f34d9626b9aa6e8fe))
* **git-status:** merge pr-pilot into git-status ([7ab0b8d](https://github.com/tartinerlabs/claude-code-mods/commit/7ab0b8d94a05631b25234aae7720a037adfa5537))


### Bug Fixes

* **git-status:** ignore checks from superseded runs ([1978fad](https://github.com/tartinerlabs/claude-code-mods/commit/1978fad0fbcab3ec3c2f023c0b708fea1915e991))

## [0.16.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.15.0...v0.16.0) (2026-10-24)


### Features

* **auto-session-name:** keep session names current ([8ccbb45](https://github.com/tartinerlabs/claude-code-mods/commit/8ccbb45c5d49d7d1b07027ca9bba2db9cda3c23c))


### Bug Fixes

* **release-notes:** rename command to avoid clash ([b870dbe](https://github.com/tartinerlabs/claude-code-mods/commit/b870dbe8a57ccba932854813a9c8eb75d8493579))

## [0.15.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.14.0...v0.15.0) (2026-10-18)


### Features

* **resource-watch:** add resource watch mod for simulators, Claude Design projects and the Xcode app shared between sessions ([#31](https://github.com/tartinerlabs/claude-code-mods/pull/31))

## [0.14.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.13.1...v0.14.0) (2026-10-16)


### Features

* **release-notes:** add release notes mod ([0302933](https://github.com/tartinerlabs/claude-code-mods/commit/0302933effd00715697add54fc568cbb175b8fb4))


### Bug Fixes

* **release-notes:** escape the version in its pattern ([6c18213](https://github.com/tartinerlabs/claude-code-mods/commit/6c18213beffd13118cce54cd9e25e6c4a8d0e0d2))
* **release-notes:** refuse writes outside the repo ([cc36891](https://github.com/tartinerlabs/claude-code-mods/commit/cc36891509c991713010536b10c86dfcfc97c4a8))

## [0.13.1](https://github.com/tartinerlabs/claude-code-mods/compare/v0.13.0...v0.13.1) (2026-10-11)


### Bug Fixes

* **smart-compact:** detect the cache TTL ([cca5744](https://github.com/tartinerlabs/claude-code-mods/commit/cca5744164a79bf0bf411b925104e65d8957daf4))

## [0.13.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.12.0...v0.13.0) (2026-10-11)


### Features

* **smart-compact:** continue open tasks ([d7aac0d](https://github.com/tartinerlabs/claude-code-mods/commit/d7aac0dc3b5b5446699563e554690c5066a84d5c))

## [0.12.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.11.0...v0.12.0) (2026-10-11)


### Features

* **auto-session-name:** re-title short first prompts ([7d4645f](https://github.com/tartinerlabs/claude-code-mods/commit/7d4645fbaf0fda542f0c9d695fdaa92abf77ee92))

## [0.11.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.10.0...v0.11.0) (2026-10-10)


### Features

* **auto-session-name:** restore color option ([db3eca5](https://github.com/tartinerlabs/claude-code-mods/commit/db3eca5ba7af33ac28002757deaf925786d6d0be))

## [0.10.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.9.0...v0.10.0) (2026-10-10)


### Features

* **limit-watch:** show session cost in band ([3271d93](https://github.com/tartinerlabs/claude-code-mods/commit/3271d937408785f44ae15e91a27c19eef2c5a7e2))

## [0.9.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.8.0...v0.9.0) (2026-10-10)


### Features

* **cache-clock:** show emoji in band ([f62b27e](https://github.com/tartinerlabs/claude-code-mods/commit/f62b27eab84fd5629e86efa86e5388685ef6ce2b))
* **limit-watch:** show emoji in band ([5c157fb](https://github.com/tartinerlabs/claude-code-mods/commit/5c157fb8b6145ced7703dd8006d54ab3103d06aa))
* **pr-pilot:** show emoji in band ([cd9326f](https://github.com/tartinerlabs/claude-code-mods/commit/cd9326f731d32bf0366ffb3becfce160a3e91b64))
* **token-weather:** update band mid-turn ([4b33c4e](https://github.com/tartinerlabs/claude-code-mods/commit/4b33c4ec3552b6b8bae0b2438ee80379b5a12734))
* **token-weather:** use emoji forecast icons ([38f533f](https://github.com/tartinerlabs/claude-code-mods/commit/38f533fe86f55d4e6928c9fb6af7a10fd2048bfb))

## [0.8.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.7.1...v0.8.0) (2026-10-10)


### Features

* **auto-session-name:** remove color option ([12a4390](https://github.com/tartinerlabs/claude-code-mods/commit/12a43909d0570d5b37ee7ca4b0f38796635466ce))


### Bug Fixes

* **pr-pilot:** clear band after /merge ([9903edb](https://github.com/tartinerlabs/claude-code-mods/commit/9903edb93f4f8c4fcd37ea73fa78b480f730ea62))

## [0.7.1](https://github.com/tartinerlabs/claude-code-mods/compare/v0.7.0...v0.7.1) (2026-10-08)


### Bug Fixes

* **pr-pilot:** delete stack branches after /merge ([b4a8740](https://github.com/tartinerlabs/claude-code-mods/commit/b4a87405432fe50b4c14eeeba57014591e09d0ef))

## [0.7.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.6.0...v0.7.0) (2026-10-08)


### Features

* **smart-compact:** add checkpoint compaction ([a1dff80](https://github.com/tartinerlabs/claude-code-mods/commit/a1dff80894fbfeb66441a7c46cbd22aa375c28e5))

## [0.6.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.5.0...v0.6.0) (2026-10-07)


### Features

* **pr-pilot:** support gh-stack stacks ([394076c](https://github.com/tartinerlabs/claude-code-mods/commit/394076cc38683242393295a8491c918286b0662f))

## [0.5.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.4.0...v0.5.0) (2026-10-07)


### Features

* **pr-pilot:** add pr-pilot mod ([6da6a73](https://github.com/tartinerlabs/claude-code-mods/commit/6da6a731bff706724887dc98fce2a640d6ce644e))


### Bug Fixes

* **auto-session-name:** keep a colour set with /color ([f707424](https://github.com/tartinerlabs/claude-code-mods/commit/f7074240e2eb0db5af38afb9921b1e93a171b9a9))
* **pr-pilot:** harden /merge and check names ([b0219a9](https://github.com/tartinerlabs/claude-code-mods/commit/b0219a9beecd0f33244bf1b1e364f2e5aa7d1d4f))

## [0.4.0](https://github.com/tartinerlabs/claude-code-mods/compare/v0.3.0...v0.4.0) (2026-10-07)


### Features

* **auto-session-name:** add color option ([ca75e25](https://github.com/tartinerlabs/claude-code-mods/commit/ca75e2573b69350d0b1c36f0c1a02d8937c42059))
