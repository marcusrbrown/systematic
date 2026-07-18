# Visual Communication in Requirements Documents

Visual aids are conditional on content patterns, not on document depth classification — a Lightweight requirements doc about a complex multi-surface feature may warrant a diagram; a Deep doc about a straightforward change may not.

**When to include:**

| Requirements describe... | Visual aid | Placement |
|---|---|---|
| 4+ requirements with non-linear relationships (dependencies, groupings, fan-in/fan-out) | Mermaid dependency or grouping diagram | Before or after the Requirements heading |
| 3+ interacting system surfaces or cross-layer effects | Mermaid interaction or component diagram | Within the relevant section |
| 3+ behavioral modes, states, or variants being compared | Markdown comparison table | Within the relevant section |
| 3+ alternatives or trade-offs under consideration | Markdown comparison table | Within the relevant section |

**When to skip:**
- The requirements are 3 or fewer items in a straightforward list — prose bullets are sufficient
- Prose already communicates the relationships clearly
- The visual would duplicate what surrounding prose already shows
- The visual describes code-level detail (specific method names, SQL columns, API field lists)

**Format selection:**
- **Mermaid** (default) for dependency graphs and interaction diagrams — 5–15 nodes, no in-box annotations, standard flowchart shapes. Use `TB` (top-to-bottom) direction so diagrams stay narrow in both rendered and source form. Source should be readable as fallback in diff views and terminals.
- **ASCII/box-drawing diagrams** for annotated flows that need rich in-box content — decision logic branches, multi-column spatial arrangements. More expressive than mermaid when the diagram's value comes from annotations within nodes. Follow 80-column max for code blocks, use vertical stacking.
- **Markdown tables** for mode/variant comparisons and alternative comparisons.
- Keep diagrams proportionate to the document. A simple 4-requirement grouping gets a simple diagram. A complex dependency graph with fan-out and fan-in may need 10–15 nodes — that is fine if every node earns its place.
- Place inline at the point of relevance, not in a separate section.
- Requirements-structure level only — groupings, surface interactions, mode comparisons. Not implementation architecture, data schemas, or code structure.
- Prose is authoritative: when a visual aid and its surrounding prose disagree, the prose governs.

After generating a visual aid, verify it accurately represents the requirements it illustrates — correct relationships, no missing surfaces, no merged requirements.
