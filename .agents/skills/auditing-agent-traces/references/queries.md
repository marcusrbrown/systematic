# Trace Queries

Every recipe here was run against the stores on 2026-11-27. Replace the bracketed parts. Times are UTC.

## Attribute Names

Use the standard name when one exists. Private names are marked.

| Meaning | Tempo span attribute | Standard |
|---|---|---|
| Kind of span | `span.gen_ai.operation.name`: `chat`, `invoke_agent`, `execute_tool` | Yes |
| Agent | `span.gen_ai.agent.name` | Yes |
| Tool | `span.gen_ai.tool.name` | Yes |
| Model, provider | `span.gen_ai.request.model`, `span.gen_ai.provider.name` | Yes |
| Tokens | `span.gen_ai.usage.input_tokens`, `.output_tokens`, `.cache_read.input_tokens`, `.cache_write.input_tokens` | Yes |
| Error recorded | `status` (`error` or `unset`; `unset` means no error was recorded) | Yes. Prefer it to the private `span.fro_bot.outcome` |
| Why it failed | `span.error.type`: `tool.execution`, `permission.rejected`, `plugin.reuse-guard`, `unknown` | Yes |
| Session | `span.gen_ai.conversation.id` | Yes |
| Primary or subagent | `span.fro_bot.agent.role`: `root`, `child` | Private |
| Repository, trigger, run | `span.langfuse.trace.metadata.repository`, `.trigger`, `.run_id` | Private |
| Sender | `resource.sender.group`, for example `fro-bot`, `marcusrbrown`, `workstation`, `canary` | Private |
| Service | `resource.service.name` | Yes |

In Langfuse, each span attribute is a metadata key named `attributes.<name>`, for example
`attributes.gen_ai.agent.name`. The trace fields `repository`, `trigger`, `run_id` and `job` are plain metadata keys.

Exclude the canary in every query: `resource.service.name != "health-reporter-canary"` in Tempo, and
`environment = default` in Langfuse.

## Tempo Recipes

Call `query_tempo_metrics` with `datasourceUid: "tempo"`, `type: "instant"`, and a window of at most 24 h. Use one
UTC day per call (`start: [day]T00:00:00Z`, `end: [next day]T00:00:00Z`), and clip the first and last call to the
window you were asked about. Each call returns one value per series. Add the slices up with a script.

**T1. Tool calls by agent, tool and status**

```traceql
{ span.gen_ai.operation.name = "execute_tool" && resource.service.name != "health-reporter-canary" } | count_over_time() by (span.gen_ai.agent.name, span.gen_ai.tool.name, status)
```

A series with no agent label is a call that recorded no agent. Report it as its own row. On 2026-11-27 these were
all refused `subagent` resumes. Read one (L4) to see what they are now.

Some names are not tools the agent was offered. Those seen so far are a stray word joined to a real tool name
(`large_shell`, `hat_shell`, `kingdom_read`, `afraid_grep`), sometimes ending `_placeholder`.
L4 shows `No tool named "..." is currently available`. They are part of the recorded errors, not a separate
total. Show how many of an agent's errors they are. The test is L3: a name that agent's offered list lacks. Do
not judge by how the name looks; `session_read` is a real tool.

**T2. Failures by error type and tool**

```traceql
{ span.gen_ai.operation.name = "execute_tool" && status = error && resource.service.name != "health-reporter-canary" } | count_over_time() by (span.error.type, span.gen_ai.tool.name)
```

**T3. Model calls by agent**

```traceql
{ span.gen_ai.operation.name = "chat" && resource.service.name != "health-reporter-canary" } | count_over_time() by (span.gen_ai.agent.name)
```

Add `span.gen_ai.request.model` to the `by` list to split by model.

**T4. A token total by agent**

Run both and multiply, per agent and per day, then add the days. Do not use `sum_over_time` here: with only the
operation filter it undercounts.

```traceql
{ span.gen_ai.operation.name = "chat" && span.gen_ai.usage.cache_read.input_tokens >= 0 && resource.service.name != "health-reporter-canary" } | avg_over_time(span.gen_ai.usage.cache_read.input_tokens) by (span.gen_ai.agent.name)
```

```traceql
{ span.gen_ai.operation.name = "chat" && span.gen_ai.usage.cache_read.input_tokens >= 0 && resource.service.name != "health-reporter-canary" } | count_over_time() by (span.gen_ai.agent.name)
```

T3 minus the second count is the number of calls that lack the attribute. Report that share. The sender omits
`cache_read`, `cache_write` and `reasoning` keys when the value is zero, so a call that reports `input_tokens`
and lacks the key had none. The average is therefore per call that had any, not per call. For the per-call figure,
divide the total by the number of calls that report usage: the second query with
`span.gen_ai.usage.input_tokens >= 0` in place of the cache-read condition. T3 minus that number is the calls
with no usage reported. Give it as the unknown share and leave those calls out of the average.

T4 costs two calls per day, and a third (T3) for the share that lacks the attribute. L2 costs one call per agent for the whole window and is exact. Use whichever is
cheaper for the window, and check the fleet sum against one unfiltered L2 call.

**T5. Agent runs by role**

```traceql
{ span.gen_ai.operation.name = "invoke_agent" && resource.service.name != "health-reporter-canary" } | count_over_time() by (span.gen_ai.agent.name, span.fro_bot.agent.role)
```

T5 counts agent runs. The `subagent` rows of T1 count dispatch attempts by parent, refused ones included. Keep
the two apart. Some spans carry no role. Report those agents' role as unknown.

**T6. Where the calls came from**

```traceql
{ span.gen_ai.operation.name = "execute_tool" && resource.service.name != "health-reporter-canary" } | count_over_time() by (resource.sender.group, span.langfuse.trace.metadata.repository)
```

To narrow any recipe, add a condition such as `span.langfuse.trace.metadata.repository = "[owner/repo]"`,
`resource.sender.group = "[group]"` or `span.gen_ai.agent.name = "[agent]"`.

**T7. Find example spans**

Call `search_tempo_traces` (window up to 168 h) with a small `limit`:

```traceql
{ span.gen_ai.tool.name = "[tool]" && status = error && resource.service.name != "health-reporter-canary" } | select(span.gen_ai.agent.name, span.error.type, span.langfuse.trace.metadata.repository)
```

**When a recipe returns nothing, or one sender's rows drop out:** call `list_tempo_attribute_names` with
`scope: "span"` for that day. A sender may have renamed an attribute. Say so in Coverage.

## Langfuse Recipes

Call `queryMetrics` with `view: "observations"`, `fromTimestamp` and `toTimestamp`. Split a window longer than 15
days into several calls.

**L0. Which days hold data**

Add `"timeDimension": {"granularity": "day"}`. Rows come back per day and type: `TOOL` (tool calls), `GENERATION`
(model calls), `AGENT` (agent runs). Query Tempo first for the days that hold the type you need. A day L0 shows
without that type, or as one zero-count row with a blank type, is *empty in Langfuse*. L0 says nothing about
Tempo: a day you did not query there is *not checked in Tempo*, and the totals cover only the days you queried
in both stores.

```json
{
  "dimensions": [{"field": "type"}],
  "metrics": [{"measure": "count", "aggregation": "count"}],
  "filters": [{"column": "environment", "operator": "=", "value": "default", "type": "string"}]
}
```

**L1. Cross-check the Tempo totals**

Tool calls and recorded errors, for the same window as the Tempo slices. `ERROR` should equal T1's
`status = error` total, and the sum should equal T1's total. Add `"timeDimension": {"granularity": "day"}` to
get the figures per day, which shows which slice a gap is in:

```json
{
  "dimensions": [{"field": "level"}],
  "metrics": [{"measure": "count", "aggregation": "count"}],
  "filters": [
    {"column": "type", "operator": "=", "value": "TOOL", "type": "string"},
    {"column": "environment", "operator": "=", "value": "default", "type": "string"}
  ]
}
```

**L2. Token totals, for the fleet or one agent**

Rows come back as `input`, `output`, `input_cached_tokens`, `input_cache_creation`, `output_reasoning_tokens` and
`total`. `input_cached_tokens` is cache read. `total` already includes the other rows, so never add it to them.
Drop the metadata filter for the fleet total. The fleet total minus the per-agent totals you ran is usage
*outside the queried agents*. Do not call it usage with no agent name. L2 sums what was reported. It can't show how many calls reported nothing; T4's two counts can.

```json
{
  "dimensions": [{"field": "usageType"}],
  "metrics": [{"measure": "usageByType", "aggregation": "sum"}],
  "filters": [
    {"column": "type", "operator": "=", "value": "GENERATION", "type": "string"},
    {"column": "environment", "operator": "=", "value": "default", "type": "string"},
    {"column": "metadata", "key": "attributes.gen_ai.agent.name", "operator": "=", "value": "[agent]", "type": "stringObject"}
  ]
}
```

**L3. Tools offered to an agent**

One row per offered tool, with the number of model calls that offered it. Compare with the tools T1 shows the agent
calling. Unequal counts mean the offered list changed between runs. A name missing here is a lead, not proof the
tool was never offered. For one failed call, read the model call that asked for it (L6). For a claim about the
whole window, compare each tool's count with the agent's model-call count (T3).

```json
{
  "dimensions": [{"field": "toolNames"}],
  "metrics": [{"measure": "count", "aggregation": "count"}],
  "filters": [
    {"column": "type", "operator": "=", "value": "GENERATION", "type": "string"},
    {"column": "environment", "operator": "=", "value": "default", "type": "string"},
    {"column": "metadata", "key": "attributes.gen_ai.agent.name", "operator": "=", "value": "[agent]", "type": "stringObject"}
  ],
  "orderBy": [{"field": "count_count", "direction": "desc"}],
  "config": {"row_limit": 200}
}
```

On 2026-11-27 the `calledToolNames`, `toolCalls` and skill dimensions were empty for every sender, so the skills
offered to an agent were not recorded. Say that; do not report a skill as never offered or never loaded.

**L4. Read tool calls**

Call `listObservations` with `type: "TOOL"`, `environment: "default"`, a window of at most 14 days, and
`name: "[tool]"`. A page that includes `input` or `output` holds 50 rows. Add
`level: "ERROR"` for failures. Ask for `fields: ["id", "traceId", "name", "startTime", "statusMessage", "input"]`.
`statusMessage` holds the error text. Add `"output"` for what the tool returned.

To filter by agent, add
`filter: [{"column": "metadata", "key": "attributes.gen_ai.agent.name", "operator": "=", "value": "[agent]", "type": "stringObject"}]`.

Ask for `"metadata"` only when you need the repository or run. It is about 30 keys per row.

A failed `subagent` call is worth reading in full: its `input` holds the prompt the parent sent, which often
states what went wrong with the child's earlier answer.

**L5. Skill loads**

L4 with `name: "systematic_skill"` (bundled skills) or `name: "skill"`. The `input` is `{"name":"[skill]"}`. Count
by paging to the end, in slices of at most 14 days. These are load attempts; `level` says whether an error was recorded.

**L6. Read one run**

Call `listObservations` with `traceId: "[id]"`, a window around its start time, and
`fields: ["id", "parentObservationId", "type", "name", "startTime", "level", "statusMessage"]` to see the shape.
Then call `getObservation` on the observations you need with `fields: ["input", "output"]`, plus `traceId`,
`fromStartTime` and `toStartTime` around that observation's own start time. A GENERATION's `input` is the prompt
the model saw. Its `output` is what the model said and the tool calls it asked for.

An AGENT observation has no `output`. An agent's final answer is the `output` of its last GENERATION child:
list with `parentObservationId: "[agent observation id]"` and `type: "GENERATION"`.

## Standard Sweep Set

Run L0 first. For each day that holds data: T1, T2, T3, T5. Run once for the window: L1 per day, L2 for the
fleet, and L5. Run L2 and L3 per agent for the five busiest agents and for any agent a lead involves. Run T4 for
per-call averages on the busiest day only, and label them as that day's figures.

Spend about half your calls on this set and half on reading content. Numbers without a cause are not candidates.

Look for:

- A tool with a high failure share for one agent (T1), and what the failures say (L4).
- Calls to names the agent was not offered (T1 against L3, confirmed with L4).
- Tools offered on every call and never called (L3 against T1).
- A high per-call cache read for an agent that does little (T4).
- An agent that makes most of its calls through one tool.
- Which skills load, how often, and for which agent (L5).
- Dispatch attempts that did not become runs (T1 `subagent` rows against T5).
