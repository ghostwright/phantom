---
name: thread
x-phantom-source: built-in
description: Show how the user's thinking on a specific topic has evolved over time. A chronological narrative with turning-point callouts.
when_to_use: Use when the user says "thread <topic>", "how has my thinking on X evolved", "show me the arc on X", "what have I said about X", "take me through X from the start", "where am I with X", or when the user needs to re-ground in a long-running decision.
allowed-tools:
  - mcp__phantom-reflective__phantom_memory_search
  - mcp__phantom-reflective__phantom_list_sessions
  - Read
argument-hint: "[topic]"
arguments:
  - topic
context: inline
---

# Thread: the evolution of thinking

## Inputs

- `$topic`: the specific topic the user wants to trace. Could be a project name, a decision, a person, a product, a question.

## Goal

Pull every mention of a specific topic from memory across sessions and channels, order them chronologically, cluster by time period and sub-theme, identify turning points where the user's view changed, and render as a narrative of evolution.

Not a log. Not a summary. A view of the shape of how the user changed their mind. The user should come away thinking "that is what I was actually doing, and I did not see it that clearly before."

## Steps

### 1. Search memory for the topic

Call `mcp__phantom-reflective__phantom_memory_search` with `query: "$topic"`, `memory_type: "all"`, `limit: 30`. Do NOT pass `days_back`. We want the full history.

**Success criteria**: you have at least three hits for the topic. If you have zero or one, tell the user honestly and stop ("I do not have enough history on this topic yet to build an arc. It looks like this is the first time you are raising it.").

### 2. Order and cluster chronologically

Sort the hits by their `started_at` or `valid_from` timestamp. Cluster them by time period:
- If the hits span less than 14 days, cluster by day.
- If they span 14 to 90 days, cluster by week.
- If they span more than 90 days, cluster by month.

Within each cluster, look for sub-themes. A single cluster might split into "technical concerns" and "people concerns" if both appear in the same week.

**Success criteria**: you have 2-6 time clusters with the hits assigned to each.

### 3. Identify turning points

Re-read the clusters in order. Mark a turning point when:
- The user's stated view of the topic visibly changed.
- New information landed that the user acknowledged shifted things.
- A decision was explicitly made ("I decided to", "we are going with").
- A commitment was made or withdrawn.
- An emotional tone shifted (frustration to calm, curiosity to conviction).

**Success criteria**: you have 1-4 turning points that you can cite to specific memory episodes.

### 4. Render as a narrative

Write a single flowing narrative, organized chronologically by cluster. Each cluster becomes a short paragraph starting with the date range. Turning points are called out inline with a leading date. Example:

> **Late March.** You first brought up the pricing decision after Anna pushed back on the tier structure. The framing was defensive; you kept looking for a reason to keep the current plan.
>
> **April 2.** _Turning point._ The conversation with Vercel's support shifted this. You said "maybe we are optimizing for the wrong user" and the shape of the question changed.
>
> **Last week.** You are now treating the pricing decision as a product decision, not a pricing decision. Four conversations this week circled the user segmentation question.

Close with two short sections:

**Where you are now.** One paragraph based on the most recent mentions. What the user currently thinks, in the user's own words if you can quote them accurately.

**What is unclear.** One or two open questions the arc has not yet resolved. This is honest. If everything is clear, say so.

**Success criteria**: under 500 words, every cluster and turning point is anchored to at least one memory episode, the "where you are now" paragraph reflects the most recent mentions.

## Rules

- Never invent turning points that are not in memory. If there are no turning points, say so and present the arc as a steady evolution.
- Never em-dash.
- Always cite at least one memory episode per cluster.
- Stay under 500 words total.
- Do not summarize every mention. Pick the hits that mark movement and skip the rest.
- If the topic has only recent hits (all from the last three days), tell the user honestly and suggest they come back in a week.
