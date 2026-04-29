---
name: ritual
x-phantom-source: built-in
description: Discover recurring behaviors from memory and offer to formalize them as scheduled jobs.
when_to_use: Use when the user says "ritual", "what are my patterns", "turn this into a routine", "make this recurring", "what do I do regularly", "what should I schedule", "automate this for me", or any similar pattern-formalization phrase. Also fires on a monthly cadence if enabled.
allowed-tools:
  - mcp__phantom-reflective__phantom_memory_search
  - mcp__phantom-reflective__phantom_list_sessions
  - mcp__phantom-scheduler__phantom_schedule
context: inline
---

# Ritual: latent patterns to scheduled jobs

## Goal

Find recurring behaviors in the user's history that emerged naturally over time without being formalized as scheduled jobs, and propose turning them into first-class schedules. The user does not need to remember to do the thing; the agent does it for them and delivers the result where they are.

The test is "what does the user already do on a cadence that the agent could prepare for them so they do not have to start from scratch each time." Not "what should the user be doing". Only what they already do.

## Steps

### 1. Pull the last 60 days of sessions

Call `mcp__phantom-reflective__phantom_list_sessions` with `days_back: 60`, `limit: 200`. Note the started_at timestamp, channel, and the first user message of each session if you can see it.

**Success criteria**: you have a list of 50+ sessions from the last two months with timestamps.

### 2. Look for temporal repetition

Cluster the sessions by:
- Day of week (Monday, Tuesday, ...).
- Time of day (bucket into morning, midday, afternoon, evening).
- Channel.
- Topic, if you can infer it from the first message.

A candidate ritual is a cluster where:
- Three or more sessions happened.
- They share day of week OR time of day (ideally both).
- They share topic or channel.
- They are spaced at roughly the same cadence (weekly, biweekly, monthly).

Example candidates:
- "Every Monday morning around 8:30 in #ops you ask for a standup."
- "Every second Friday in Slack DM you ask me to prepare a weekly review."
- "Every first of the month in #finance you ask for a cost breakdown."

**Success criteria**: you have identified 1-5 candidate rituals.

### 3. Verify with memory

For each candidate ritual, call `mcp__phantom-reflective__phantom_memory_search` with a query matching the topic and `days_back: 60`. Confirm that memory also shows the same pattern.

Discard any candidate that the session pattern suggests but memory does not support. Discard any where the cadence is off (the user did it three Mondays in a row, then stopped two weeks ago).

**Success criteria**: you have 1-3 verified rituals with strong evidence.

### 4. Propose formalization

Render each verified ritual as a proposal:

> **The Monday standup ritual.** For six of the last eight Mondays you opened #ops at roughly 8:30 and asked me for a standup. Want me to prepare the standup for you automatically and DM it to you at 8:25am Mondays? You can still ask me for it by hand; this is additive.

For each proposal, include:
- The cadence you observed, with counts ("six of the last eight").
- The proposed schedule in specific terms (day and time).
- What the agent would prepare (the work that runs on the schedule).
- Where it would deliver (Slack DM, channel, or email).
- A clear yes-or-no next step.

**Success criteria**: the user has 1-3 clear proposals they can accept or decline.

### 5. Create the schedule on approval

When the user says yes to a ritual, call `mcp__phantom-scheduler__phantom_schedule` with `action: "create"`. Build the `task` field as a complete self-contained prompt for the future run (the scheduled run will not have access to the current conversation). Use a `cron` schedule in the user's timezone if you know it, otherwise `at` or `every`.

Example call for the Monday standup:

```json
{
  "action": "create",
  "name": "monday-standup",
  "description": "Weekly Monday morning standup, delivered before the user asks.",
  "schedule": { "kind": "cron", "expr": "25 8 * * 1", "tz": "America/Los_Angeles" },
  "task": "Run the `standup` skill. Pull the last 72 hours of activity from memory, focus on commitments and channels, and deliver as a short morning briefing.",
  "delivery": { "channel": "slack", "target": "owner" }
}
```

Confirm the schedule was created by showing the user the next run time and how to cancel it.

**Success criteria**: the schedule exists and the user knows how to manage it.

## Rules

- Never propose a ritual the user has not already been doing on their own. That is prescriptive; this skill is descriptive.
- Never create a schedule without explicit user approval.
- Never em-dash.
- Never propose more than three rituals in one pass. The user should leave with a clear picture, not a list they will not read.
- Always include the cadence count ("four of the last six") so the user knows the evidence is real.
- If you have no verified rituals after reading 60 days of history, tell the user honestly and suggest they come back after a few more weeks of use.
