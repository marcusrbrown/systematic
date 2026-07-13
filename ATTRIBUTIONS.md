# Attributions

Systematic ships bundled skills and agents adapted from third-party sources. This file records the provenance, license, and pin point for each derivative work in the published package.

## License Conventions

Bundled skills and agents may declare a `license:` field in their YAML frontmatter to communicate their licensing origin. When this field is **present**, it reflects the upstream source's license — these files are derivative works adapted from clearly identified projects. When this field is **absent**, the file is unspecified Systematic-originated content, not "proprietary" or "unlicensed." Treat absence as "no upstream attribution required," not as a missing legal notice.

The full repository license is in `LICENSE` at the repository root.

## obra/superpowers — MIT

**Source repository:** [`obra/superpowers`](https://github.com/obra/superpowers)
**Pinned commit:** `f2cbfbefebbfef77321e4c9abc9e949826bea9d7` (tag `v5.1.0`)
**License:** MIT
**Copyright:** Copyright (c) 2025 Jesse Vincent
**Cloned at:** `.slim/clonedeps/repos/obra__superpowers/` (development inspection only; not shipped)

### Files derived

The following bundled skills are adaptations of the upstream `obra/superpowers` source:

- `skills/test-driven-development/SKILL.md`
- `skills/test-driven-development/references/testing-anti-patterns.md`
- `skills/writing-skills/SKILL.md`
- `skills/writing-skills/references/persuasion-principles.md`
- `skills/writing-skills/references/graphviz-conventions.dot`
- `skills/writing-skills/references/testing-skills-with-subagents.md`
- `skills/writing-skills/references/examples/skill-testing-walkthrough.md` (renamed from upstream's `examples/CLAUDE_MD_TESTING.md`)
- `skills/writing-skills/scripts/render-graphs.js`

The two `SKILL.md` files (`skills/test-driven-development/SKILL.md` and `skills/writing-skills/SKILL.md`) carry `license: MIT` in their frontmatter to make the licensing inheritance explicit at the file level. The reference files, script, and graphviz definition inherit MIT licensing from this attribution file — frontmatter `license:` is a YAML-only convention.

### Adaptation notes

- Adaptation was light: rewrote upstream's `@filename` force-load syntax to repo-local `references/` paths; rewrote `superpowers:<skill-name>` namespace cross-references to bare names (matching Systematic's runtime convention where the `systematic:` prefix is applied at load time); swapped `~/.claude/skills` path mentions to the canonical OpenCode path `~/.agents/skills/`; renamed the `CLAUDE_MD_TESTING.md` worked example to `skill-testing-walkthrough.md` to fit Systematic's descriptive-filename convention.
- Per-file copyright comments are deliberately omitted. Frontmatter `license: MIT` plus this attribution file constitute the full attribution surface.
- These files are load-bearing for `ce:work`, `ce:plan`, and the "Systematic Bundled Skills" section of `writing-skills` itself. Future contributors editing them should preserve the discipline-enforcing prose (e.g., the Iron Law, the rationalization tables, the RED-GREEN-REFACTOR cycle).

### Future refresh discipline

Future upstream refreshes from `obra/superpowers` are explicit human-reviewed events, not automatic syncs. Bumping the pinned commit requires re-running the adaptation pass and re-validating the two-layer originality check for the Anthropic-distilled reference (see below). The pinned commit above is the stable source-of-truth for the currently-shipped versions.

### Upstream MIT license text

The following is the full MIT license text from `obra/superpowers@v5.1.0`, reproduced here in compliance with the MIT license's notice requirements:

```
MIT License

Copyright (c) 2025 Jesse Vincent

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

## pbakaus/impeccable — Apache 2.0

**Source repository:** [https://github.com/pbakaus/impeccable](https://github.com/pbakaus/impeccable)  
**Pinned commit:** `642f03d5a10eb3deb91bd511241e387e23b9aa39`  
**License:** Apache 2.0  
**Copyright:** Paul Bakaus  

### Files derived

- `skills/frontend-design/SKILL.md` — Design Laws section

### Adaptation notes

Verbatim merge of the `## Shared design laws` section. Register-specific qualifiers ("both registers") replaced with register-agnostic phrasing ("every design"). The `{{model}}` placeholder found in the section intro was removed (not substituted). No other `{{placeholder}}` syntax was present in the imported section.

Impeccable itself incorporates Anthropic's frontend-design skill content (CC-BY-4.0). The Apache 2.0 license from Impeccable governs this derived work per its own attribution chain.

### Upstream Apache 2.0 license text

The following is the full Apache License, Version 2.0 text, reproduced here in compliance with the license's notice requirements:

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to the Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by the Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding any notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

## Anthropic — CC-BY-4.0

**Source page:** [Skill authoring best practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices)
**License:** [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) (Creative Commons Attribution 4.0 International). The distilled file is a **modified derivative work** of Anthropic's source under the CC-BY-4.0 grant — reorganized by Systematic-relevant authoring tasks (per the Distillation Outline below) rather than mirroring the upstream document structure.
**Publisher:** Anthropic
**Retrieved:** 2026-05-17

### File derived

- `skills/writing-skills/references/anthropic-best-practices-distilled.md`

This file is a distillation of Anthropic's published Skills authoring guidance. CC-BY-4.0 permits derivative works with attribution; this file's first paragraph carries the attribution line and source URL.

### Distillation Outline

The distilled file is organized around 6 Systematic-relevant authoring tasks rather than mirroring upstream's section structure. This ordering and category list is the authoritative outline for any future re-distillation pass:

1. **Triggering Skills Through Precise Descriptions** — when to use this skill / when not / triggering language patterns. Source signal: upstream's "Writing effective descriptions" section.
2. **Organizing Content for Progressive Disclosure** — when to inline content vs split into `references/`, how to keep SKILL.md scannable, naming conventions. Source signal: upstream's "Progressive disclosure patterns" and "Avoid deeply nested references" sections.
3. **Writing Concise Prose** — what to cut, what to keep, how to balance detail vs. agent context budget. Source signal: upstream's "Concise is key" + "Core principles" sections.
4. **Matching Skill Rigidity to Task Variance** — when skills are prescriptive vs flexible, how to match skill rigidity to task variance. Source signal: upstream's "Set appropriate degrees of freedom" section.
5. **Testing Skills Through Evaluation** — how to test that a skill changes agent behavior, evaluation patterns, falsifiable success criteria. Source signal: upstream's evaluation-related content (scattered, not in one named section).
6. **Common Content Patterns and Naming** — naming conventions, file structure conventions, when to use code examples vs prose. Source signal: upstream's "Naming conventions" + "Skill structure" sections.

**Wholesale drops** (not included in the distillation): model-specific testing matrix; advanced executable-code patterns (PDF processing, BigQuery, DOCX); MCP-tool-specific references; package dependency guidance; runtime environment guidance; YAML technical reference notes; Anthropic compliance / checklist sections; marketing-card / cross-link footers.

**Acceptance bar applied at distillation time:**

- Size in 3500–6000 bytes.
- CC-BY-4.0 attribution + `docs.claude.com` link in first 3 lines.
- Zero 1:1 heading matches with upstream.
- Heading sequence does not map 1:1 to upstream order.
- No paragraph contains a >120-character contiguous substring shared with upstream.
- At least 2 Systematic-specific organizing categories introduced (4 confirmed: triggering, freedom, evaluation, patterns).
- At least 3 upstream topic areas dropped wholesale (8 confirmed; see drops above).

If Anthropic's source page is restructured or relocated after this attribution date, the retrieval date above plus the page title triangulate the canonical replacement.
