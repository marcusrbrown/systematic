---
name: report-bug-ce
description: Use this skill when a user needs to report a bug in the Systematic plugin with complete reproduction details and environment data, then open a GitHub issue directly from the CLI.
argument-hint: '[optional: brief description of the bug]'
disable-model-invocation: true
---

# Report a Systematic Plugin Bug

Report bugs encountered while using the Systematic plugin. This skill gathers structured information and creates a GitHub issue for maintainers.

## Step 1: Gather Bug Information

Ask the user the following questions (using the platform's blocking question tool — e.g., `question` in OpenCode, `request_user_input` in Codex, `ask_user` in Gemini — or present numbered options and wait for a reply):

**Question 1: Bug Category**
- What type of issue are you experiencing?
- Options: Agent not working, Command not working, Skill not working, MCP server issue, Installation problem, Other

**Question 2: Specific Component**
- Which specific component is affected?
- Ask for the name of the agent, command, skill, or MCP server

**Question 3: What Happened (Actual Behavior)**
- Ask: "What happened when you used this component?"
- Get a clear description of the actual behavior

**Question 4: What Should Have Happened (Expected Behavior)**
- Ask: "What did you expect to happen instead?"
- Get a clear description of expected behavior

**Question 5: Steps to Reproduce**
- Ask: "What steps did you take before the bug occurred?"
- Get reproduction steps

**Question 6: Error Messages**
- Ask: "Did you see any error messages? If so, please share them."
- Capture any error output

## Step 2: Collect Environment Information

Automatically gather environment details. Detect the coding agent platform and collect what is available:

**OS info (all platforms):**
```bash
uname -a
```

**Plugin version:** Read the plugin manifest or installed plugin metadata. Common locations:
- OpenCode: `~/.config/opencode/plugins/installed_plugins.json`
- Codex: `.codex/plugins/` or project config
- Other platforms: check the platform's plugin registry

**Agent CLI version:** Run the platform's version command:
- OpenCode: `opencode --version`
- Codex: `codex --version`
- Other platforms: use the appropriate CLI version flag

If any of these fail, note "unknown" and continue — do not block the report.

## Step 3: Format the Bug Report

Create a well-structured bug report with:

```markdown
## Bug Description

**Component:** [Type] - [Name]
**Summary:** [Brief description from argument or collected info]

## Environment

- **Plugin Version:** [from plugin manifest/registry]
- **Agent Platform:** [e.g., OpenCode, Codex, Copilot, Pi, Kilo]
- **Agent Version:** [from CLI version command]
- **OS:** [from uname]

## What Happened

[Actual behavior description]

## Expected Behavior

[Expected behavior description]

## Steps to Reproduce

1. [Step 1]
2. [Step 2]
3. [Step 3]

## Error Messages

[Any error output]

## Additional Context

[Any other relevant information]

---
*Reported via `/report-bug-ce` skill*
```

## Step 4: Create GitHub Issue

Use the GitHub CLI to create the issue:

```bash
gh issue create \
  --repo marcusrbrown/systematic \
  --title "[systematic] Bug: [Brief description]" \
  --body "[Formatted bug report from Step 3]" \
  --label "bug"
```

**Note:** If labels don't exist, create without labels:
```bash
gh issue create \
  --repo marcusrbrown/systematic \
  --title "[systematic] Bug: [Brief description]" \
  --body "[Formatted bug report]"
```

## Step 5: Confirm Submission

After the issue is created:
1. Display the issue URL to the user
2. Thank them for reporting the bug
3. Let them know the maintainer (Kieran Klaassen) will be notified

## Output Format

```
Bug report submitted successfully!

Issue: https://github.com/marcusrbrown/systematic/issues/[NUMBER]
Title: [systematic] Bug: [description]

Thank you for helping improve Systematic!
The maintainer will review your report and respond as soon as possible.
```

## Error Handling

- If `gh` CLI is not installed or not authenticated: prompt the user to install/authenticate first
- If issue creation fails: display the formatted report so the user can manually create the issue
- If required information is missing: re-prompt for that specific field

## Privacy Notice

This skill does NOT collect:
- Personal information
- API keys or credentials
- Private code from projects
- File paths beyond basic OS info

Only technical information about the bug is included in the report.
