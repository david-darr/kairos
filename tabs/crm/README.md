# CRM prebuilt tab

## Private preview upgrade contract

The private Windows preview is **Kairos 2.1.1-crm.1 / CRM 1.2.1**, built from stable `v2.1.0` plus `a4fc712`, `1592f18` and `53ba315` on the local `preview/crm-chris` branch (metadata commit `a42c34e`). It is not a public release. The next public release accepting these users must be **2.1.1 or higher**, contain these CRM changes, retain app ID `com.davidmichael.jarvis`, and keep the ordinary `%APPDATA%/JARVIS` profile. Do not require uninstalling the preview or switching to a named dev instance. Stable-only updates and disabled downgrades are intentional; do not reintroduce prerelease-channel trapping.

The installer keeps application data outside the install directory. Preserve `data/tab-data/crm/crm.json`, its task IDs, completion receipts, ownership, source provenance and unknown fields, along with the profile's encryption key and other app data. Before public distribution, repeat packaged startup/data-migration/restore checks and verify a preview-created task and completion receipt are still readable. The private preview passed these checks with synthetic data, plus updater fixtures for stable 2.1.1 and 2.2.0; the actual future release still requires its own verification. CRM contract suites include `test_crm.py`, `test_crm_completion.py`, `test_crm_daily.py`, `test_crm_source_links.py` and `test_crm_chat_access.py`.

CRM is offered in Tool Store > Tabs for every installation. Its source ships in the application; personal data stays in `data/tab-data/crm/crm.json`. Fresh installations have no sources, model selection, sample tasks or enabled scanning. Removing the tab disables it and preserves records.

The tab is a folder package: `tabs/crm/tab.json` declares metadata and hooks, `routes.py` exports its router, `view.js` exports `render`, and `service.py` owns an atomic JSON store through `core.tab_api`. Existing `crm.json` is adopted once. Models, mail, auth, Library access and backlog cards go through `core.tab_api`; the base app dispatches declared hooks without naming this tab. `view.css` is loaded from the manifest. The stylesheet uses shared appearance tokens.

## Source collection and extraction

An administrator selects existing Email accounts, Slack/Telegram/email connectors, Discord bots or Library documents in Sources. Messaging sources capture newly admitted messages only, optionally limited to conversation IDs. Existing connector admission rules still apply. Historical messaging imports, Gmail Pub/Sub and attachment OCR are outside this implementation.

The dedicated mailbox reader includes read and unread messages in the selected folder and lookback. It uses read-only IMAP selection, UID search/fetch, UIDVALIDITY identity, a size check and BODY.PEEK. MIME bodies become plain text; attachments and embedded content are not executed. A bounded set of earlier references supplies thread context. Gmail source links use the native message ID; generic IMAP has no universal web permalink. Slack uses `chat.getPermalink`, Telegram public messages and Discord use native URLs when available. URLs and source identities come from adapters, never the model.

### Opening the original email

**Open source** opens the original Gmail message in the person's default browser on desktop, or a new tab in web mode. It selects the connected account with `authuser`, and converts the provider's immutable `X-GM-MSGID` to its web-interface hexadecimal ID. New scans capture this read-only metadata. Existing tasks resolve their message link on first click and cache it in the captured message and task evidence, without changing task status. **View captured text** remains a separate source/evidence viewer.

Resolution verifies UIDVALIDITY before using a stored UID. If the folder was rebuilt, it looks up the exact RFC Message-ID instead. When a moved message or unavailable mailbox prevents direct resolution, Gmail opens an exact `in:anywhere rfc822msgid:` search, with a notice explaining the fallback. Unsupported mail providers retain the captured-text viewer; no provider URL is invented. Uncached mailbox lookups require administrator connection access; other owners can use stored links or metadata-only fallbacks. The original-message API scopes every read to the authenticated task owner.

The desktop bridge validates HTTPS URLs and rejects embedded credentials, loopback and the backend origin before opening the OS browser. Web mode reserves its tab during the click to avoid async popup blocking and removes the opener before navigating. Link tests use isolated IMAP/provider fixtures and intercepted browser launches; they do not open or send real email. Provider identifier behavior was checked against [Google's IMAP extensions documentation](https://developers.google.com/workspace/gmail/imap/imap-extensions).

Scans durably queue messages before extraction, then commit tasks and the processed marker together. Retries are capped at three until a person retries failed messages. Per-owner background jobs prevent overlapping scans; failures remain visible by source. Automatic scans run only while Kairos is running and CRM is enabled. Pausing a source or disabling CRM during extraction prevents publication and retains the queue. Administrator access is checked again before publication.

Extraction uses a selected local/API model through Kairos's existing transport, with no tools or executor. Claude CLI uses an empty tool set, strict empty MCP configuration, temporary working directory, empty settings/skills/plugins and no session persistence. Codex CLI is excluded from unattended extraction until an equivalent tool-free boundary exists. Source text is wrapped as untrusted data. Output is strictly validated, including exact evidence and deadline quotes and task matches restricted to the same owner/source/thread. Local input is bounded against its configured context size; truncated or ambiguous results require review.

Relative deadlines use the message timestamp and configured IANA timezone. No deadline quote means no deadline. Date-only precision is preserved. Windows timezone data is supplied by the hash-pinned `tzdata` dependency. Quotes from earlier context, inferred dates or incomplete context require review. Model classifications still need user judgment; exact quote validation establishes provenance, not semantic accuracy.

## Follow-ups and review

Tasks have deadlines, priority explanations, contact/project fields, source evidence, status, notes and optional snoozing. Contacts groups follow-ups by their recorded contact; it does not merge identities across providers. Later messages can propose changes; they do not overwrite edits or reopen completed/dismissed work. A clear current-message confirmation that the same whole action was completed closes an existing task automatically. Ambiguous confirmations remain suggestions. Users can manage manual tasks without connection-admin access.

### Automatic completion (1.1)

Models find open CRM tasks from ordinary chats using `list_tab_tasks` and read current requirements with `read_tab_task` (tab `crm` and the returned ID). Both tools are read-only, shared across Claude, Codex and local/API models, and filter by the chat owner's identity. CRM supplies generic `task_items` and `task_context` hooks rather than putting tab imports into the base app. Disabled or unapproved tabs do not expose records. Ownerless chats/background agents cannot read private tab tasks when accounts are enabled. Source text is wrapped as untrusted data and taints the turn like other external evidence. The task's own chat supplies its ID and context directly and refreshes that context when requirements or evidence change. Completing work does not require a model-controlled status mutation or internal-browser access.

While CRM is enabled and Kairos is running, the passive `on_chat_turn(user, turn)` hook queues matching owned tasks after a successful chat run. This includes ordinary chats, task chats and agent chats with an identifiable owner. Failed/stopped runs and ownerless chats with accounts enabled do not emit completion receipts. Task chats bind their authenticated owner, including existing unowned task chats. No tab-specific implementation imports were added to base chat code.

The model selected under CRM > Sources checks the entire task against the new turn, with exact evidence quotes and recorded action results. It can recognize a person's report such as "I sent the revised proposal" and an assistant's completed work. Drafts, plans, negations, partial work and unverified claims about external actions stay open. Matching is limited to linked tasks or relevant task/contact/project terms. No reader model is chosen implicitly. Manual reports outside Kairos require an observable confirmation in a connected source or a chat; the app cannot detect unreported offline work.

Linked Work Board cards marked Done close their CRM task without a model. Successful assignment outputs in Review go through the same whole-task check using the assignment's actual recorded actions; the Work Board card itself stays in Review. A reply successfully sent from CRM supplies a completion receipt for that task, but an unrelated acknowledgement or promise does not satisfy a task to send the actual deliverable. Mailbox scan scheduling is separate from completion checks.

Receipts are queued durably with bounded retries and deduplication. Completion compares the task version captured before classification, so an edit, reopen, dismissal or tab removal during the check prevents stale writes. A task keeps its completion actor, source kind, exact quote and chat/run/card/message identifiers. Explicit reopens clear the displayed completion and do not replay old receipts. The detail panel shows why work closed and retains Reopen. Background status updates preserve an open chat, unsent text and keyboard focus. Home and Calendar read the same CRM status.

Validated locally with `scripts/test_crm_completion.py`, the existing CRM/tab/chat/work-board checks and the CRM renderer smoke test. A live local `llama3.2:latest` check distinguished five synthetic cases: manual completion, a future plan, partial work, an unverified assistant claim, and an assistant action supported by a successful send receipt. Real email sending was not used for these tests.

### Daily Sent-mail completion (1.2)

The default-on **Check Sent mail daily for completed tasks** setting runs independently of Auto scan, at 9 AM in the CRM timezone. It catches up on the latest daily slot when Kairos next runs, and persists successful slots across restarts. Kairos must be running with CRM enabled and its reader model configured. The check reads only accounts with an enabled email source selected by that administrator. It discovers the actual Sent folder through IMAP LIST metadata, then uses the same read-only mailbox reader. It never sends email or marks messages read.

Open send/email/reply/forward tasks, including manual tasks and tasks from other enabled sources, are compared against Sent mail within Email lookback. The sender must be the connected account; explicit recipient addresses must agree, or name-only tasks need a matching named recipient and an unambiguous model decision. Messages must postdate task creation and explicit reopen. The tool-free reader checks the full purpose and deliverable, with actual attachment names when relevant, rather than treating any email as fulfillment. Quoted history, ambiguous identity, partial replies, promises, oversized/truncated evidence and unrelated messages do not establish completion. Mail sent through an unconfigured alias may remain unmatched.

Completion uses the existing version guard, stores the exact quote and message/account/folder identifiers, and offers **View completion email** when the provider supplies a URL (Gmail includes the exact-ID fallback). Sources shows the latest successful check, running state and failures. Failures retry after an hour without recording the daily slot as successful. Each account is bounded to its newest 1,000 messages in the lookback; incomplete coverage is reported explicitly. The daily check revisits that window so newly added or edited tasks can be considered, while reopened tasks cannot replay older sends. Offline work with no evidence in connected sources still requires a chat report or manual status change.

`scripts/test_crm_daily.py` exercises daily persistence/catch-up, real reconciliation flow with simulated mailbox/model responses, recipient and ownership matching, stale evidence, reopens, concurrent edits, quoted history, disabled sources, context limits and Sent-folder discovery. No real mailbox or outbound send is used.

Active, reviewed CRM deadlines appear through the `calendar_items` hook. Calendar PATCHes the returned `toggle_url` with `completed`, updating CRM status; completed work remains in CRM's Done view. Assignment creates a backlog card in the existing Work Board and requires a separate Ready/Run action.

CRM also declares `home_cards(user)`. It supplies a list card, Follow-ups,
with up to five open tasks ordered by overdue first and then soonest due.
Dates use the owner's timezone; rows show a due date or Today and the contact
or evidence source, plus Overdue, Today or Review badges where appropriate.
The empty text is "No open follow-ups." A second stat card shows the open
count with the overdue count in its detail. Done and dismissed tasks are
excluded. Both cards use only the owner's in-memory records and make no
model or network calls.

Show these cards in Settings > Layout under From your tabs. New cards are
hidden by default; their saved visibility and position survive CRM being
turned off and back on. Home renders native dashboard sections and every
card link opens CRM. Core keeps at most two valid unique cards per tab,
strips HTML and control characters, and applies the two-second hook limit.
The shared [Home card contract](../../skill_templates/build-custom-tab/SKILL.md)
documents stat, list and progress fields, limits and an example.

## Validation performed locally

- `python scripts/test_crm.py`: 28 isolated checks cover ownership, atomic rollback, deadlines, exact evidence, deduplication, proposals, bounded input, read-only UID collection, selected conversation scopes, failures/retries, asynchronous scan status, pause during extraction, shipped-tab visibility and tool-free model options.
- `python scripts/test_connectors.py`: 24 connector checks pass, including admission before CRM capture and Slack's returned permalink.
- Existing tool and integration checks pass; `python scripts/test_chat.py DependencyPinningTests CustomTabApprovalTests` passes all five targeted checks.
- `node scripts/run-electron-test.cjs crm-smoke`: actual renderer with isolated synthetic API, desktop/mobile layouts, manual editing, completion/reopening, settings, contacts, empty states and source text safety. External requests are rejected by the harness.
- A temporary live scan against local `llama3.2:latest` extracted a synthetic proposal request, resolved Friday 3pm to `2026-10-09T15:00:00-04:00`, retained its exact quote and created no duplicate on a repeated scan. Temporary records were removed after the check. Real mailbox ingestion and native provider links have not been exercised against connected accounts.

`Kairos (crm)` is a separate local review profile at `%APPDATA%/JARVIS-crm`, port 8431, using this checkout. It starts with CRM enabled, a local extraction connection, review-all enabled and automatic scanning off. Add an account in Email or Settings > Channels, or a document in Library, then select it under CRM > Sources. The installed app and existing dev profile are separate.

## Harness references

These patterns informed the implementation; no external harness code is required at runtime.

- [Hermes email inbox triage](https://github.com/NousResearch/hermes-agent/blob/main/skills/email/email-inbox-triage/SKILL.md): thread context and actionable dispositions informed evidence-based follow-ups and priority explanations.
- [Hermes email gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/email/): transport metadata informed source identity and threaded evidence, while personal mailbox scans use a separate reader.
- [Hermes scheduled tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/): deterministic collection is separated from model reasoning and scan history is separated from extracted work.
- OpenClaw's email automation was examined as a reference for stable dispatch identity and treating incoming mail as untrusted input. Provider-specific Gmail push ingestion remains future work.
