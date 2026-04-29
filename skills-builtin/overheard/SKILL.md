---
name: overheard
x-phantom-source: built-in
description: Find commitments the user made in the last two weeks and did not follow through on. A promises audit.
when_to_use: Use when the user says "overheard", "what did I promise", "what am I behind on", "promises audit", "am I dropping balls", "what did I commit to", "what do I owe people", or any similar commitment-check phrase. Also runs automatically once per day at a user-configured time if enabled.
allowed-tools:
  - mcp__phantom-reflective__phantom_memory_search
  - mcp__phantom-reflective__phantom_list_sessions
context: inline
---

# Overheard: the promises audit

## Goal

Find promises the user made in conversations (in Slack, in email, in messages) that start with phrases like "I'll send", "I will", "let me get back to you", "by Friday", "next week", "I'll follow up", and check whether there is evidence in subsequent memory of follow-through. Surface the gaps as a promises audit, with context for each and a draft action.

The shadow backlog most people carry. The user does not need to be reminded of every forgotten ping; they need the two or three that actually matter.

## Steps

### 1. Pull the last 14 days of memory

Call `mcp__phantom-reflective__phantom_memory_search` with `query: "I will"`, `days_back: 14`, `limit: 30`. Then call it again with `query: "let me"` and merge. Then `query: "follow up"`, and merge. Then `query: "by Friday"` and merge. The merge should deduplicate by episode id.

**Success criteria**: you have a pool of recent episodes that contain commitment language.

### 2. Extract candidate commitments

For each episode, read the detail and pull out phrases where the user was the one making the commitment, not receiving one. Common patterns:
- "I will send you..."
- "Let me get back to you on..."
- "I'll check with <person> and let you know."
- "By Friday I'll have..."
- "Next week I'll..."
- "I'll follow up on..."

Skip commitments that are clearly to yourself, to the agent, or to no one in particular ("I will make more coffee"). Skip commitments that the user has already negated ("I thought I'd send X but actually I'm not going to").

**Success criteria**: you have a list of 5-15 candidate commitments with the original context, who the promise was to (if known), and when it was made.

### 3. Check for follow-through

For each candidate, search memory again for follow-up evidence. The query is a short paraphrase of what was promised. Example: if the commitment was "I'll send Anna the revised doc by Friday", search for "send Anna doc" or "revised doc Anna" with `days_back: 14`.

Evidence of follow-through looks like:
- A later episode where the user clearly sent the thing.
- A later episode where the user explicitly said it was done.
- A later episode where someone thanked the user for the thing.
- A later episode where the topic was closed ("we decided to cancel that").

If none of those are present and the commitment's stated deadline has passed or is about to pass, it is an open promise.

**Success criteria**: you have classified each candidate as "done", "open", or "unclear".

### 4. Surface the top 3-5 open promises

Pick the most important open promises. "Most important" means:
- The recipient is a known person (not "someone in the channel").
- The deadline is past or within 24 hours.
- It has not been renegotiated.
- It is the kind of thing that matters if it drops (a deliverable, a followup, a decision).

Skip low-stakes promises ("I'll check", "I'll think about it") unless they are the only ones open.

Render each as:

> **To Anna, committed Tuesday.** You said you would send the revised pricing doc "by Friday." I do not see evidence in memory that it has been sent. Three days overdue. Want me to draft the followup?

**Success criteria**: under 400 words total, 3-5 open promises, each anchored to a specific memory episode, each ending with a concrete next-step offer.

### 5. Offer to draft followups

For each open promise, offer to draft the followup message in the user's voice. Do not draft until the user says yes. When the user says yes, pull a few recent messages from memory that show the user's tone, then write the draft as a suggestion.

**Success criteria**: the user either says "yes draft those" or "no I've got it". Either is fine. Do not force the draft.

## Rules

- Never moralize about broken commitments. The tone is "here is what I saw", not "here is what you should do".
- Never em-dash.
- Never surface more than five open promises. Density beats coverage.
- Never fabricate a recipient. If you cannot tell who the promise was to, say "to someone in <channel>" and let the user fill in the gap.
- Always anchor each promise to a real memory episode.
- Always offer the followup draft, but never send it without explicit approval.
