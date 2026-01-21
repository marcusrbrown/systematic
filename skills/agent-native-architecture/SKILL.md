---
name: agent-native-architecture
description: Build applications where agents are first-class citizens - use when designing autonomous agents, creating MCP tools, or building apps where features are outcomes achieved by agents operating in a loop
---

# Agent-Native Architecture

**Purpose:** Design and build applications where features are outcomes achieved by agents with tools, operating in a loop until objectives are reached.

## Why Now

Software agents work reliably now. The same architecture that lets a coding agent refactor a codebase can let an agent organize files, manage workflows, or automate processes.

**The key insight:** A really good coding agent is actually a really good general-purpose agent.

## Core Principles

### 1. Parity

**Whatever the user can do through the UI, the agent should be able to achieve through tools.**

When adding any UI capability, ask: can the agent achieve this outcome? If not, add the necessary tools or primitives.

| User Action | How Agent Achieves It |
|-------------|----------------------|
| Create a note | `write_file` to notes directory |
| Tag a note | `update_file` metadata |
| Search notes | `search_files` tool |
| Delete a note | `delete_file` |

### 2. Granularity

**Prefer atomic primitives. Features are outcomes achieved by an agent operating in a loop.**

A tool is a primitive capability: read a file, write a file, run a command.

A **feature** is not a function you write. It's an outcome you describe in a prompt, achieved by an agent with tools operating in a loop.

**Less granular (limits the agent):**
```
Tool: classify_and_organize_files(files)
→ You wrote the decision logic
→ To change behavior, you refactor code
```

**More granular (empowers the agent):**
```
Tools: read_file, write_file, move_file, list_directory
Prompt: "Organize the user's downloads folder based on content and recency."
→ Agent makes the decisions
→ To change behavior, you edit the prompt
```

### 3. Composability

**With atomic tools and parity, new features are just new prompts.**

Want a "weekly review" feature?
```
"Review files modified this week. Summarize key changes. Suggest three priorities for next week."
```

The agent uses `list_files`, `read_file`, and judgment. You didn't write code—you described an outcome.

### 4. Emergent Capability

**The agent can accomplish things you didn't explicitly design for.**

Users will ask for things you never anticipated. With atomic tools and parity, the agent can often figure it out.

**The flywheel:**
1. Build with atomic tools and parity
2. Users ask for unanticipated things
3. Agent composes tools to accomplish them (or fails, revealing a gap)
4. Observe patterns in what's requested
5. Add domain tools to make common patterns efficient

### 5. Improvement Over Time

**Agent-native apps get better through accumulated context and prompt refinement.**

- **Context files:** Agent reads/updates a `context.md` for accumulated knowledge
- **Prompt refinement:** Ship updated prompts that change behavior for all users
- **Self-modification (advanced):** Agents that can edit their own prompts

## Architecture Checklist

Before implementation, verify:

- [ ] Every UI action has a corresponding agent capability (parity)
- [ ] Tools are primitives; features are prompt-defined outcomes (granularity)
- [ ] New features can be added via prompts alone (composability)
- [ ] Agent can handle open-ended requests in your domain (emergent capability)

### Tool Design
- [ ] CRUD Completeness: Every entity has create, read, update, AND delete
- [ ] Primitives not Workflows: Tools enable capability, don't encode business logic
- [ ] Dynamic over static: For APIs, use discover + access pattern over hardcoded tools

### Agent Execution
- [ ] Explicit completion: Agent has `complete_task` tool (not heuristic detection)
- [ ] Partial completion: Multi-step tasks track progress for resume
- [ ] Context limits: Designed for bounded context from the start

### Context Injection
- [ ] Available resources: System prompt includes what exists
- [ ] Available capabilities: System prompt documents tools with user vocabulary
- [ ] Dynamic context: Context refreshes for long sessions

## Anti-Patterns

**The Cardinal Sin: Agent executes your code instead of figuring things out**

```typescript
// WRONG - You wrote the workflow
tool("process_feedback", async ({ message }) => {
  const category = categorize(message);      // Your code decides
  const priority = calculatePriority(message); // Your code decides
  await store(message, category, priority);
});

// RIGHT - Agent figures it out
tools: store_item, send_message  // Primitives
prompt: "Rate importance 1-5, store feedback, notify if >= 4"
```

**Other anti-patterns:**
- Workflow-shaped tools that bundle judgment
- Context starvation (agent doesn't know what exists)
- Orphan UI actions (user can do something agent can't)
- Heuristic completion detection (should be explicit)
- Incomplete CRUD (can create but not update/delete)

## Quick Start

**Step 1: Define atomic tools**
```typescript
const tools = [
  tool("read_file", "Read any file", { path: z.string() }, ...),
  tool("write_file", "Write any file", { path: z.string(), content: z.string() }, ...),
  tool("list_files", "List directory", { path: z.string() }, ...),
  tool("complete_task", "Signal completion", { summary: z.string() }, ...),
];
```

**Step 2: Write behavior in the system prompt**
```markdown
## Your Responsibilities
When asked to organize content:
1. Read existing files to understand structure
2. Analyze what organization makes sense
3. Create/move files using your tools
4. Use your judgment about layout
5. Call complete_task when done
```

**Step 3: Let the agent work in a loop**
```typescript
const result = await agent.run({
  prompt: userMessage,
  tools: tools,
  systemPrompt: systemPrompt,
});
```

## Success Criteria

You've built agent-native when:

- [ ] Agent can achieve anything users can through UI (parity)
- [ ] Tools are atomic; domain tools are shortcuts, not gates (granularity)
- [ ] New features can be added by writing prompts (composability)
- [ ] Agent accomplishes tasks you didn't design for (emergent capability)
- [ ] Changing behavior means editing prompts, not refactoring code

**The Ultimate Test:** Describe an outcome in your domain that you didn't build a specific feature for. Can the agent figure it out?
