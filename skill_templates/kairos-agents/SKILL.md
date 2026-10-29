---
name: kairos-agents
description: Set up and work with Kairos agents - named bots with a job, standing instructions, memory, routines, an inbox and channels.
---

# Kairos agents

An agent is a named bot that keeps working when nobody is chatting: it has a
job (role), standing instructions (its soul), a model, its own memory, goals
and routines, an inbox, and chats. Only admins create and direct agents. People
set them up on the Agents page; you help from a chat.

## What an agent has

- **Job and soul.** The role and the standing instructions every run starts
  from. An agent changes its own setup only after the person agreed in the
  chat, with `agent_configure_self`; `agent_setup_undo` reverses one change by
  its receipt id.
- **Memory.** `agent_remember` writes a note later runs will have;
  `agent_read_topic` reads one memory topic file when its subject comes up.
- **Goals and routines.** Recurring work is a scheduled task bound to the
  agent. Create it from the agent's page, or read `build-automation` and use
  `create_task` with the agent. Test a new routine with Run now before relying
  on the schedule.
- **Cards.** One-off work on the Work Board; Ready cards run on their own.
- **Inbox.** Questions (`agent_ask`), reports and results for the person.

## Talking to an agent

- **Agents page > Chat.** A chat that belongs to the person who started it.
- **Channels** (Discord and other connectors): address the agent by name.
  `job: <text>` queues a Ready card for it instead of chatting.

## Agents working together

- `hand_to_agent` hands work to another agent by name or id.
- `agent_assign` gives work to a bot on the agent's Peers list;
  `agent_answer_assignment` answers a peer's question or escalates it.
- `delegate` sends one to three read-only research jobs to helpers in
  parallel; `helper_results` collects them.

## Things to know

- Agents run in Auto: their actions are approved without asking, and every one
  is audited in Settings > Permissions. That includes sending email, so give an
  agent only the access its job needs.
- Agent runs are fenced to the agent's own folder and the folders its work names.
- With accounts on, an agent's records (CRM tasks, notes) are its owner's. A
  chat or routine with no owner uses the only account on a one-account install;
  otherwise save the routine in Tasks, or start the chat from the agent's page.
