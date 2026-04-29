---
name: echo
x-phantom-source: built-in
description: Before answering a substantive question, quietly check whether the user has already resolved this question in the past.
when_to_use: Use when the user asks a substantive question that might have been asked and resolved before. Substantive questions are things like "how should I do X", "what is the right way to Y", "which approach is better", "what did we decide about Z". Do NOT fire on greetings, small talk, status checks, or operational queries like "what time is it" or "are you online". Before deriving a new answer, run a memory similarity check. If a strong prior match exists, surface it inline and ask whether anything has changed.
allowed-tools:
  - mcp__phantom-reflective__phantom_memory_search
context: inline
---

# Echo: the prior-answer surfacer

## Goal

Respect the user's past thinking. Before deriving a new answer to a substantive question, check whether the user already resolved this question weeks or months ago. If yes, surface the prior answer inline and ask whether anything has changed. If no, proceed to answer normally without mentioning that you looked.

The user should feel like you remember what they already decided, not like you are doing paperwork.

## Steps

### 1. Classify the question

Determine whether the question is substantive. Skip if:
- It is a greeting or acknowledgment ("hey", "thanks", "got it").
- It is an operational query ("are you online", "what time is it", "are you working on X").
- It is an imperative with no open decision ("send this to Anna", "delete that file").
- It is clearly a first-time question with no prior context ("what does this error mean in this new log line").

Proceed if:
- The user is asking for a recommendation or opinion.
- The user is asking "what did we decide" or "what is the right way".
- The user is weighing options on something they have discussed before.
- The user is asking a question that sounds like it could have been asked before.

**Success criteria**: you have a yes or no on whether to run the echo check. If no, do not call the search tool at all.

### 2. Search memory for prior answers

Call `mcp__phantom-reflective__phantom_memory_search` with `query: "<the user's question in your own words>"`, `memory_type: "all"`, `limit: 5`. The query should be a restatement of the semantic intent, not a literal copy of the user's words.

**Success criteria**: you have a list of 0-5 hits with similarity scores.

### 3. Judge the match

Examine the top hit. It is a strong match if all of these hold:
- Similarity score is above 0.80 if the tool returns one.
- The hit is at least 3 days old.
- The hit actually addresses the same question, not just the same keywords.
- You can clearly see what the prior conclusion was.

If the top hit is NOT a strong match, proceed to answer the question normally from scratch. Do not mention the echo check to the user.

**Success criteria**: you have a clear yes or no on the match.

### 4. Surface the prior answer if there is one

If there is a strong match, respond BEFORE deriving a new answer:

> You asked something very similar on [date] and you landed on [paraphrase of the prior conclusion]. Has anything changed since then, or is that still your view?

Wait for the user's response.

If the user says "no, things are different now" or explains what changed, proceed to derive a new answer informed by the new context.

If the user says "yes, that is still my view", acknowledge and ask what they want to do with that. Sometimes they just needed the reminder.

**Success criteria**: the user is aware of their prior thinking, and you have their explicit signal on whether to rebuild from scratch or honor the prior answer.

## Rules

- Never surface weak matches. A low-confidence echo is worse than no echo because it erodes the user's trust in your memory.
- Never em-dash.
- Never mention that you ran the echo check if it did not fire. The user should not see the machinery when it does not apply.
- Be brief on the surface: two sentences, not four.
- If the prior conclusion has expired (for example, it is about a project that has since shipped), treat it as a weak match and proceed normally.
- Always paraphrase the prior conclusion in your own words. Do not copy-paste from memory.
