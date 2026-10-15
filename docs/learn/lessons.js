window.LESSONS=[
  {
    "title": "Meet your AI workspace",
    "where": "A guide to your AI workspace",
    "steps": [
      "Choose a model",
      "Bring a short brief",
      "Review a useful result"
    ],
    "tryit": "Learn the workspace, then try a complete workflow.",
    "notes": "This guide uses the October 14, 2026 development snapshot 5563c2b and the Kairos website. Kairos 2.1.0 is now public; some controls differ from this snapshot. Screens contain synthetic example data. Use the arrow keys to navigate, select 1/2/3 for a step, and N for notes. View real UI shows a screenshot you can enlarge.",
    "image": "home",
    "section": "Welcome",
    "kind": "home",
    "demo": [
      "Choose a model",
      "Bring a short brief",
      "Review a useful result"
    ]
  },
  {
    "title": "Pick your first workflow",
    "where": "Your route through this guide",
    "steps": [
      "Chat and knowledge",
      "Bots and repeat work",
      "Tools, code and control"
    ],
    "tryit": "Start with one model and one useful task.",
    "notes": "You do not need to enable every feature. A plain chat and a vault are a useful starting point. The guide continues through the entire functional surface, including advanced automation and developer features.",
    "image": "",
    "section": "Welcome",
    "kind": "home",
    "demo": [
      "Chat and knowledge",
      "Bots and repeat work",
      "Tools, code and control"
    ]
  },
  {
    "title": "Know which build you have",
    "where": "Version context",
    "steps": [
      "Public release: Kairos 2.1.0",
      "Guide snapshot: October 14, 2026",
      "Forge remains Preview"
    ],
    "tryit": "Check your installed version. Some controls differ from these screenshots.",
    "notes": "Kairos 2.1.0 was released on October 15, 2026. The illustrated workflows and real UI screenshots in this guide were prepared from development commit 5563c2b on October 14. The 2.1.0 release adds later bot profile, conversation-panel and phone-thread refinements, so some controls look different. The guide keeps this snapshot explicit. Forge remains Preview; phone access is through the host and Tailscale, not a native iOS release.",
    "image": null,
    "section": "Welcome",
    "kind": "list",
    "demo": [
      "Public release: Kairos 2.1.0",
      "Screens: dev 5563c2b",
      "Forge: Preview"
    ]
  },
  {
    "title": "Install and choose a vault",
    "where": "Download and first launch",
    "steps": [
      "Download your platform",
      "Vault: Practice notes",
      "Open your workspace"
    ],
    "tryit": "Open kairos-agents.com and select your platform.",
    "notes": "No separate Python installation is required for a packaged desktop install. The apps are not code-signed yet, so the operating system may show a first-run warning. Windows updates download in the background and install when quitting. On Mac, download the new DMG and replace the app. Intel Mac and packaged Linux builds are not supplied. Keep a copy of an existing vault before pointing any agent at important work.",
    "image": null,
    "section": "Setup",
    "kind": "form",
    "demo": [
      "Download your platform",
      "Vault: Practice notes",
      "Open your workspace"
    ]
  },
  {
    "title": "Connect your first model",
    "where": "Settings > Add Models, or /setup",
    "steps": [
      "Settings > Add Models",
      "Sign in to a provider",
      "Select model in composer"
    ],
    "tryit": "Connect one provider and send a small test prompt.",
    "notes": "There is no default model. Claude Code ships with Kairos. The guide can install Codex after your approval and guide sign-in. API connections need their own provider account and key. An OpenAI-compatible endpoint can be local or remote. Subscriptions and API usage may cost money. Cloud model requests leave the computer for the selected provider. Model choices and reasoning controls vary by provider.",
    "image": "chat",
    "section": "Setup",
    "kind": "form",
    "demo": [
      "Settings > Add Models",
      "Sign in to a provider",
      "Select model in composer"
    ]
  },
  {
    "title": "Run a local model",
    "where": "Cookbook",
    "steps": [
      "Cookbook > choose a model",
      "Download > start engine",
      "Select it in chat"
    ],
    "tryit": "Ask the local model to summarize a short sample note.",
    "notes": "Cookbook can download and run local models through the built-in llama.cpp engine, without installing Ollama separately. Existing Ollama servers are also supported. Model size, memory and hardware determine what can run well. Local models avoid sending model inference to a cloud provider, but a connected external tool can still send data. Tool support and quality depend on the chosen model.",
    "image": "cookbook",
    "section": "Setup",
    "kind": "list",
    "demo": [
      "Cookbook > choose a model",
      "Download > start engine",
      "Select it in chat"
    ]
  },
  {
    "title": "Write your first request",
    "where": "Chats > New chat",
    "steps": [
      "Chats > New chat",
      "Draft a 30-minute agenda",
      "Read, refine, or Stop"
    ],
    "tryit": "Try: “Turn these notes into a concise meeting agenda.”",
    "notes": "For a first request, include the desired result, relevant source material and the format. Example: “Using the attached notes, draft a 30-minute project check-in agenda with decisions first.” Replies support Markdown and copyable code. Use Stop while a turn runs if the request has gone in the wrong direction. A context meter appears when the provider reports usage. It measures conversation capacity, not your account bill.",
    "image": null,
    "section": "Conversation",
    "kind": "chat",
    "demo": [
      "Chats > New chat",
      "Draft a 30-minute agenda",
      "Read, refine, or Stop"
    ]
  },
  {
    "title": "Give the chat context",
    "where": "Composer > +, and workspace controls",
    "steps": [
      "Composer > +",
      "Attach brief.md",
      "Choose the workspace folder"
    ],
    "tryit": "Attach a sample brief and ask for a one-page summary.",
    "notes": "A workspace folder is the area the model works in. A project is a separate grouping of instructions and Library documents across chats. Attachments are request material, while an artifact is a file returned by the model. Screenshots can be added from the desktop capture feature on Windows. Folder and permission restrictions still apply to file tools. Avoid attaching unrelated sensitive material.",
    "image": null,
    "section": "Conversation",
    "kind": "files",
    "demo": [
      "Composer > +",
      "Attach brief.md",
      "Choose the workspace folder"
    ]
  },
  {
    "title": "Create a project",
    "where": "Chats > project picker",
    "steps": [
      "Project picker > create",
      "Product launch + tone.md",
      "Start a chat in the project"
    ],
    "tryit": "Make a “Product launch” project with a brief and tone guide.",
    "notes": "Project instructions and Library documents provide reusable context across independent chats and model choices. Chats retain their own transcripts. Keep project instructions focused: audience, goal, source hierarchy and conventions. Use separate chats for research, drafting and review instead of overloading one transcript. The project picker is above chat history.",
    "image": null,
    "section": "Conversation",
    "kind": "files",
    "demo": [
      "Project picker > create",
      "Product launch + tone.md",
      "Start a chat in the project"
    ]
  },
  {
    "title": "Use mentions and commands",
    "where": "Composer > @ or /",
    "steps": [
      "Type @ in composer",
      "Choose brief.md",
      "Ask: summarize @brief.md"
    ],
    "tryit": "Type /help, then try an @ reference in a sample request.",
    "notes": "The current dev build includes mentions for skills, tools and automations alongside files, notes and chats. “Use a skill” is also available from the composer menu. Agent mentions hand work to a selected agent and return its result to the originating chat. /setup opens model setup, /forge opens the coding workspace, /computer opens computer use, and /find searches the conversation. Mentioning a tool does not bypass permission or installation requirements.",
    "image": null,
    "section": "Conversation",
    "kind": "chat",
    "demo": [
      "Type @ in composer",
      "Choose brief.md",
      "Ask: summarize @brief.md"
    ]
  },
  {
    "title": "Explore chat controls",
    "where": "Chat tools and Settings > Shortcuts",
    "steps": [
      "Open message actions",
      "Fork a conversation",
      "Try a second approach"
    ],
    "tryit": "Fork a sample conversation to explore a second approach.",
    "notes": "The chat tools expose conversation actions and viewing choices, including a terminal-style view. Voice input and spoken replies are available, with Open Mic in voice settings. Up to three read-only helpers can work in parallel when enabled. The running-work overlay lets you follow active chats while elsewhere in the app. Quick Entry and the command palette have shortcuts listed in Settings. The Windows usage notch reports Claude/Codex limits separately from the conversation context meter.",
    "image": null,
    "section": "Conversation",
    "kind": "chat",
    "demo": [
      "Open message actions",
      "Fork a conversation",
      "Try a second approach"
    ]
  },
  {
    "title": "Review a generated file",
    "where": "Chat > artifact card",
    "steps": [
      "Open artifact card",
      "Select a sentence > comment",
      "Send: make this more direct"
    ],
    "tryit": "Select a sentence and ask Kairos to make it more direct.",
    "notes": "Images, PDFs, Markdown, code/text, static HTML and Office files have in-app previews. The resizable pane supports multiple document tabs and version choices. Selection can target slide shapes, spreadsheet cells, text lines or page regions, depending on the viewer. Requests about a file made in another chat return to that file’s originating chat. Office previews run locally and slide layouts are approximate, so check important exports in their intended application.",
    "image": "artifact",
    "section": "Conversation",
    "kind": "document",
    "demo": [
      "Open artifact card",
      "Select a sentence > comment",
      "Send: make this more direct"
    ]
  },
  {
    "title": "Keep sources beside chat",
    "where": "Chat > follow a link or request a page",
    "steps": [
      "Open a reference link",
      "Read beside the draft",
      "Open in browser if blocked"
    ],
    "tryit": "Open a public reference page beside a draft.",
    "notes": "In the Electron desktop app the side browser is a sandboxed browser view with its own cookies and no access to Kairos’s backend. A normal browser session uses an embedded frame, and some sites refuse to load there. Open-in-new-tab remains available. This reference browser differs from computer use: the latter gives an agent a separate contained browser it can operate.",
    "image": null,
    "section": "Conversation",
    "kind": "browser",
    "demo": [
      "Open a reference link",
      "Read beside the draft",
      "Open in browser if blocked"
    ]
  },
  {
    "title": "Explore your vault",
    "where": "Library > Vault",
    "steps": [
      "Library > Vault > Browse",
      "Open a Markdown note",
      "Map > follow a linked note"
    ],
    "tryit": "Open one note, follow a link and find its source file.",
    "notes": "The vault is a folder of Markdown notes. It remains portable and readable without Kairos. The linked Map provides another way into the same files. Connect your intended vault during setup and keep its instructions and indexes organized. A model’s ability to use it depends on the instructions and permissions you give it; do not assume every conversation automatically reads every note.",
    "image": "vault",
    "section": "Knowledge",
    "kind": "graph",
    "demo": [
      "Library > Vault > Browse",
      "Open a Markdown note",
      "Map > follow a linked note"
    ]
  },
  {
    "title": "Track a note and its due date",
    "where": "Notes",
    "steps": [
      "Notes > add practice note",
      "Set priority and due date",
      "Check Calendar for the date"
    ],
    "tryit": "Add “Prepare project check-in” with a due date.",
    "notes": "Checkbox items in the vault’s Active Priorities.md sync into Notes on launch, grouped by their vault headings. Completing a synced item in the app updates the checkbox in that file. Due-dated notes appear on the calendar. Keep one authoritative priority list rather than copying the same task into several unrelated places.",
    "image": "notes",
    "section": "Knowledge",
    "kind": "list",
    "demo": [
      "Notes > add practice note",
      "Set priority and due date",
      "Check Calendar for the date"
    ]
  },
  {
    "title": "Find documents in Library",
    "where": "Library > Documents & files",
    "steps": [
      "Library > Documents & files",
      "Choose a file or Drive source",
      "Open it or add to a project"
    ],
    "tryit": "Import a sample reference and attach it to a project.",
    "notes": "Library includes documents and Files by chat. The latter groups uploaded attachments and generated files with the conversation that owns them. A project can select Library documents as shared context. Google Drive is a separate Library source that an admin connects through Google sign-in, with browsing and previews. Connecting a cloud source is optional.",
    "image": "library",
    "section": "Knowledge",
    "kind": "files",
    "demo": [
      "Library > Documents & files",
      "Choose a file or Drive source",
      "Open it or add to a project"
    ]
  },
  {
    "title": "Put an event on your calendar",
    "where": "Calendar",
    "steps": [
      "Calendar > add event",
      "Project review, 2:00 PM",
      "Save > check Week view"
    ],
    "tryit": "Create a sample event, then confirm its time in Week view.",
    "notes": "Calendar combines events with due-dated notes and enabled tab sources. Google Calendar can be read and edited in the Calendar UI and through chat after an admin connects the account. CalDAV and iCal sources have different capabilities, so do not assume every subscribed calendar is writable. Verify timezone, date and connected source before changing an important event.",
    "image": "calendar",
    "section": "Knowledge",
    "kind": "calendar",
    "demo": [
      "Calendar > add event",
      "Project review, 2:00 PM",
      "Save > check Week view"
    ]
  },
  {
    "title": "Connect and review email",
    "where": "Email and connection settings",
    "steps": [
      "Email > connect IMAP / SMTP",
      "Open a sample message",
      "Review a draft before sending"
    ],
    "tryit": "Ask for a draft reply to a non-sensitive sample message.",
    "notes": "IMAP reads messages and SMTP sends them. Credentials are stored encrypted on the local machine. A request that sends mail uses the selected provider and requires the appropriate permissions. Keep a draft-first habit for new workflows. Google sign-in for Drive/Calendar is not the same as configuring an IMAP/SMTP mailbox. Optional CRM can extract follow-ups and support AI replies from connected mail.",
    "image": "email",
    "section": "Knowledge",
    "kind": "document",
    "demo": [
      "Email > connect IMAP / SMTP",
      "Open a sample message",
      "Review a draft before sending"
    ]
  },
  {
    "title": "Meet your persistent bots",
    "where": "Agents",
    "steps": [
      "Agents > choose a bot",
      "Read its role and limits",
      "Open its Chat, Work or Memory"
    ],
    "tryit": "Design a bot that organizes sample research notes.",
    "notes": "Bots have their own identity, goals/routines, memory, chats and inbox. They wake on work and events rather than running an always-on idle loop. Agents run with automatic tool approvals inside their configured limits. Their configured scope is a real trust decision. The current Agents page shows “Your bots,” items waiting on you and teams.",
    "image": "agents",
    "section": "Bots",
    "kind": "bots",
    "demo": [
      "Agents > choose a bot",
      "Read its role and limits",
      "Open its Chat, Work or Memory"
    ]
  },
  {
    "title": "Create a focused bot",
    "where": "Agents > New agent or bot > Settings",
    "steps": [
      "Agents > create a bot",
      "Name: Launch reviewer",
      "Set model, workspace and limits"
    ],
    "tryit": "Create a sample bot that can work only in a practice folder.",
    "notes": "An admin manages agents. Define what the bot should do, what it should ask about and which sources it can use. Set tool and workspace limits before assigning work. Review any daily cap and operational settings. A bot’s /setup can help with configuration but cannot widen its own access. Turn off a bot to stop it from taking new work. A chat model’s own provider limits still apply.",
    "image": null,
    "section": "Bots",
    "kind": "form",
    "demo": [
      "Agents > create a bot",
      "Name: Launch reviewer",
      "Set model, workspace and limits"
    ]
  },
  {
    "title": "Keep bot conversations separate",
    "where": "Agent > Chat",
    "steps": [
      "Bot > Chat > + New chat",
      "Review this sample brief",
      "Inspect the reply; Stop if needed"
    ],
    "tryit": "Give your research bot two unrelated sample questions.",
    "notes": "Each bot thread has its own transcript, run cursor, model choice, approval state and Stop control. A thread belongs to the bot; it is not one shared transcript for every assignment. Bot replies arrive as a completed response, with live activity and elapsed time during the run. Ordinary chats keep streaming. The floating bot window offers a compact place to continue a bot conversation.",
    "image": "bot",
    "section": "Bots",
    "kind": "chat",
    "demo": [
      "Bot > Chat > + New chat",
      "Review this sample brief",
      "Inspect the reply; Stop if needed"
    ]
  },
  {
    "title": "Read a bot's work receipt",
    "where": "Agent > Work",
    "steps": [
      "Bot > Work",
      "Open a report or question",
      "Read the result and respond"
    ],
    "tryit": "Open a sample report and send a correction.",
    "notes": "The inbox distinguishes reports, questions, reviews and work state. Items needing intervention also appear on the Agents overview. Follow the result back to its thread or run history. If a bot stops at a browser send action, use Open computer and take over. Dismiss an item only after dealing with its substance. Bot notifications can surface on desktop and configured phone notifications.",
    "image": "computer",
    "section": "Bots",
    "kind": "list",
    "demo": [
      "Bot > Work",
      "Open a report or question",
      "Read the result and respond"
    ]
  },
  {
    "title": "Inspect and correct memory",
    "where": "Agent > Memory",
    "steps": [
      "Bot > Memory",
      "Open a remembered fact",
      "Correct it or use Undo"
    ],
    "tryit": "Teach a sample preference, then correct it and inspect memory.",
    "notes": "The dev implementation keeps topic memory and recent-work context, supports memory recall and an undo journal, and treats your corrections as higher-priority material. Saved memory is a working record, not proof that its contents are true. Avoid putting secrets into ordinary memory. Team work returns learning as reports and corrections rather than granting direct access to another bot’s private memory.",
    "image": "bot-memory",
    "section": "Bots",
    "kind": "graph",
    "demo": [
      "Bot > Memory",
      "Open a remembered fact",
      "Correct it or use Undo"
    ]
  },
  {
    "title": "Set up a routine",
    "where": "Agent > Routines",
    "steps": [
      "Bot > Routines > add",
      "Every weekday: review notes",
      "Save; use Pause or Edit"
    ],
    "tryit": "Set up a weekly review using a practice folder.",
    "notes": "Routines describe recurring or event-driven work for a specific bot. Review the schedule or trigger, tools and output before enabling one. Pause keeps the routine without letting it run. Editing an active workflow is different from rerunning a past job. Inspect its work receipt/history to confirm what happened. Do not create a live schedule that sends or modifies important data until the workflow has been checked.",
    "image": "routines",
    "section": "Bots",
    "kind": "flow",
    "demo": [
      "Bot > Routines > add",
      "Every weekday: review notes",
      "Save; use Pause or Edit"
    ]
  },
  {
    "title": "Give a team a mission",
    "where": "Agents > Teams",
    "steps": [
      "Agents > Teams",
      "Research, draft, then review",
      "Set shared limits; track results"
    ],
    "tryit": "Give a sample team a brief, research task and review task.",
    "notes": "A team is organized around a shared mission. A lead plans and reviews while teammates do assigned work. Bots can pass assignments to one another in the dev implementation. Team tool limits constrain work on that team. This is a separate feature from chat’s read-only helpers: persistent bots retain identity, while helpers assist a bounded conversation.",
    "image": null,
    "section": "Bots",
    "kind": "bots",
    "demo": [
      "Agents > Teams",
      "Research, draft, then review",
      "Set shared limits; track results"
    ]
  },
  {
    "title": "Schedule a useful task",
    "where": "Tasks",
    "steps": [
      "Tasks > add prompt",
      "Daily practice-note summary",
      "Set model, time and delivery"
    ],
    "tryit": "Schedule a harmless daily summary of a practice note.",
    "notes": "Built-ins include a daily brief, tidy-up work and skill audits. Tasks can deliver output to a connected channel instead of leaving it only in the app. The computer running Kairos must be available for local scheduled work. Task workspace and tool restrictions still apply. Community automations install turned off, so review them before enabling. Run a harmless manual test before relying on a schedule.",
    "image": "tasks",
    "section": "Automation",
    "kind": "flow",
    "demo": [
      "Tasks > add prompt",
      "Daily practice-note summary",
      "Set model, time and delivery"
    ]
  },
  {
    "title": "Start work from an event",
    "where": "Tasks > triggers and hooks",
    "steps": [
      "Choose trigger or hook",
      "Select event and action",
      "Review filters before enabling"
    ],
    "tryit": "Describe a “new repository event” workflow before enabling it.",
    "notes": "Webhooks start work from an external event. Lifecycle hooks react to tool activity, replies or runs, with available actions such as posting a webhook, updating a vault note, notifying a channel or running a command. Hooks and triggers are advanced setup. Read their tool/agent filters and failure behavior. Do not expose a local listener publicly or paste a secret webhook URL into a shared guide.",
    "image": null,
    "section": "Automation",
    "kind": "flow",
    "demo": [
      "Choose trigger or hook",
      "Select event and action",
      "Review filters before enabling"
    ]
  },
  {
    "title": "Inspect a run",
    "where": "Settings > Runs, or a work receipt",
    "steps": [
      "Settings > Runs",
      "Open the matching run",
      "Read tools, errors and delivery"
    ],
    "tryit": "Find the tool call that produced a sample file.",
    "notes": "Run timelines show recorded tool calls, elapsed time, errors and results. They are useful when a chat said “done” but the output is not where you expected. Delivery status is separate from generation: a task can finish while channel delivery fails. Logs and run records may include sensitive request content, so inspect before sharing them. A run log is not a replacement for reviewing the resulting file.",
    "image": null,
    "section": "Automation",
    "kind": "list",
    "demo": [
      "Settings > Runs",
      "Open the matching run",
      "Read tools, errors and delivery"
    ]
  },
  {
    "title": "Review an item in the Store",
    "where": "Tool Store",
    "steps": [
      "Tool Store > choose item",
      "Read source and scan findings",
      "Install; configure before enabling"
    ],
    "tryit": "Inspect one skill and one automation before installing.",
    "notes": "Store categories include tabs, skills, MCP tools and automations. Admin installs use scans and review gates. Dangerous scan findings block installation, while caution findings require confirmation. A scan is a screening tool, not a guarantee of safety. “Build with Kairos” uses bundled builder instructions. Sign in to GitHub and preview public files before submitting an item as a review pull request.",
    "image": "tool-store",
    "section": "Extensions",
    "kind": "list",
    "demo": [
      "Tool Store > choose item",
      "Read source and scan findings",
      "Install; configure before enabling"
    ]
  },
  {
    "title": "Invoke a reusable skill",
    "where": "Tool Store > Skills; composer > Use a skill",
    "steps": [
      "Composer > Use a skill",
      "Choose the writing skill",
      "Ask it to improve a sample brief"
    ],
    "tryit": "Use a writing skill with a sample brief.",
    "notes": "Skills are reusable instructions, distinct from tools that perform actions. Computer use can record your actions during takeover and turn the recording into a skill after you review it. Keep recordings free of passwords and private account content. The saved skill still works within normal tool permissions. Installing instructions does not make unavailable software or model capabilities appear automatically.",
    "image": null,
    "section": "Extensions",
    "kind": "chat",
    "demo": [
      "Composer > Use a skill",
      "Choose the writing skill",
      "Ask it to improve a sample brief"
    ]
  },
  {
    "title": "Connect an MCP tool",
    "where": "Tool Store > Tools",
    "steps": [
      "Tool Store > Tools",
      "Connect server; finish sign-in",
      "Review tool approval and health"
    ],
    "tryit": "Connect one read-only service and ask for a small lookup.",
    "notes": "MCP servers expose tools that models can call. Some run locally; others contact outside services. Read the server’s permissions and data destination before enabling it. Kairos performs health checks and holds newly discovered tools for approval. A skill can teach when to use these tools, but it does not grant access. Disable an unused server to reduce unnecessary connections.",
    "image": null,
    "section": "Extensions",
    "kind": "form",
    "demo": [
      "Tool Store > Tools",
      "Connect server; finish sign-in",
      "Review tool approval and health"
    ]
  },
  {
    "title": "Add a workspace tab",
    "where": "Tool Store > Tabs",
    "steps": [
      "Tool Store > Tabs",
      "Choose School or CRM",
      "Review code; approve and add"
    ],
    "tryit": "Read the School and CRM descriptions and choose one.",
    "notes": "School and CRM are prebuilt tabs. School provides a place for school-related workflows; CRM helps with client mail, extracted tasks and AI replies. Read each card for the sources it uses. “Build a tab” starts a guided builder request. A tab archive or GitHub folder can be installed. Admin approval is tied to source fingerprints, and changes revoke approval. Approved Python tab code runs with Kairos’s privileges. User tab code and saved data live separately and survive app updates.",
    "image": "school",
    "section": "Extensions",
    "kind": "list",
    "demo": [
      "Tool Store > Tabs",
      "Choose School or CRM",
      "Review code; approve and add"
    ]
  },
  {
    "title": "Connect coursework in School",
    "where": "School > Canvas connection",
    "steps": [
      "School > Canvas connection",
      "Save > Sync Now",
      "Open a course and assignment"
    ],
    "tryit": "Open one sample assignment and locate its due date and source.",
    "notes": "Enable the School tab from Tool Store > Tabs. An API connection provides richer descriptions and source links when you have a Canvas token; an iCal feed provides a calendar-based alternative. Use Save and Sync Now in the connection area. The overview shows courses, overdue items and upcoming assignments for the next 14 days. Open a course, inspect an assignment and keep a draft under Your work. Per-course chat accumulates context, with a Sync memory control. Saving a draft or marking progress is not the same as submitting an assignment to the school.",
    "image": "school",
    "section": "Extensions",
    "kind": "calendar",
    "demo": [
      "School > Canvas connection",
      "Save > Sync Now",
      "Open a course and assignment"
    ]
  },
  {
    "title": "Review CRM follow-ups",
    "where": "CRM",
    "steps": [
      "CRM > select sources",
      "Scan now > inspect evidence",
      "Review task or draft a reply"
    ],
    "tryit": "Open a sample follow-up and inspect its source evidence.",
    "notes": "Enable CRM in Tool Store > Tabs. It reads only the email accounts and message connections you choose. Each extracted follow-up retains source links and quoted evidence, plus deadline and priority reasoning when available. Review proposals and uncertain items rather than treating extraction as authoritative. Set a model and scan schedule in its settings. Draft a reply or open a task-specific chat, and review before sending. Assigning a task to an agent creates a Work Board backlog card; moving it to Ready begins work. CRM can surface due dates in Calendar and add a Home card.",
    "image": "crm",
    "section": "Extensions",
    "kind": "list",
    "demo": [
      "CRM > select sources",
      "Scan now > inspect evidence",
      "Review task or draft a reply"
    ]
  },
  {
    "title": "Start a Forge session",
    "where": "Forge Preview",
    "steps": [
      "Forge Preview > open project",
      "Choose base and worktree",
      "Select Plan or Build"
    ],
    "tryit": "Use Plan on a small practice repository.",
    "notes": "Forge is admin-only and remains Preview. A worktree is a separate working folder for a branch, so parallel sessions can keep edits apart. Plan asks the agent to inspect and reason without making changes. Build permits edits within its configured workspace. Choose the intended base branch and model before starting. A normal chat project and a Forge Git project are different forms of organization.",
    "image": "forge",
    "section": "Forge",
    "kind": "code",
    "demo": [
      "Forge Preview > open project",
      "Choose base and worktree",
      "Select Plan or Build"
    ]
  },
  {
    "title": "Review a code change",
    "where": "Forge > session > Changes",
    "steps": [
      "Forge > Changes",
      "Open the changed file's diff",
      "Revert file or inspect Undo"
    ],
    "tryit": "Review a harmless text change in a practice repository.",
    "notes": "Forge records changes and file checkpoints. “Undo” restores a turn’s eligible file changes; inspect overlap warnings before restoring over newer work. A Git commit and a file checkpoint serve different purposes. Keep checkpoints for local recovery and Git history for project history. Confirm actual files and tests before using a generated change.",
    "image": "forge-session",
    "section": "Forge",
    "kind": "code",
    "demo": [
      "Forge > Changes",
      "Open the changed file's diff",
      "Revert file or inspect Undo"
    ]
  },
  {
    "title": "Run and inspect your app",
    "where": "Forge > Explorer, Git, Terminal and Run app",
    "steps": [
      "Forge > Run app",
      "Approve the project command",
      "Open App Preview; review Git"
    ],
    "tryit": "Run a sample app, then inspect it in App Preview.",
    "notes": "The editor supports file changes beside the session. The real terminal belongs to the human and is admin-only; it is off over Remote Access by default. Git supports staging, commits, branch switches and pulls when a merge is not needed. Push and merge-back ask first, and pushes never force. App Preview starts the project’s server after approval. Starting a server executes project code, so use a repository you trust.",
    "image": null,
    "section": "Forge",
    "kind": "code",
    "demo": [
      "Forge > Run app",
      "Approve the project command",
      "Open App Preview; review Git"
    ]
  },
  {
    "title": "Use the contained computer",
    "where": "Chat /computer, or agent > Work",
    "steps": [
      "Enable computer use + Docker",
      "Watch live view; use Stop",
      "Take over > Hand back"
    ],
    "tryit": "Navigate a harmless public page in the contained browser.",
    "notes": "Computer use never falls back to controlling your real desktop. The optional agent desktop adds offline document applications in the contained environment. Both features start off. Passwords, payment information and codes require takeover. Inspected buy, send and post controls stop for the person even when automatic approvals are active. Browser access to local/private network addresses is blocked. Kept agent logins are opt-in; Forget logins removes them.",
    "image": null,
    "section": "Computer use",
    "kind": "browser",
    "demo": [
      "Enable computer use + Docker",
      "Watch live view; use Stop",
      "Take over > Hand back"
    ]
  },
  {
    "title": "Connect a channel",
    "where": "Settings > Channels and Discord bots",
    "steps": [
      "Settings > Channels",
      "Choose connector and senders",
      "Test a private message"
    ],
    "tryit": "Connect a private test channel before routing real work.",
    "notes": "Discord can reach the assistant and named agents. Additional connector choices include Telegram, Slack, Signal, Matrix, Mattermost, IRC, iMessage, email and ntfy. Availability, platform prerequisites and two-way behavior depend on the connector. Restrict allowed senders and channel access. Shared sessions and vault context make channels useful, but they also mean the channel’s access rules matter.",
    "image": null,
    "section": "Access",
    "kind": "form",
    "demo": [
      "Settings > Channels",
      "Choose connector and senders",
      "Test a private message"
    ]
  },
  {
    "title": "Open Kairos on your phone",
    "where": "Settings > Remote Access",
    "steps": [
      "Settings > Remote Access",
      "Tailscale + login + HTTPS",
      "Open private URL on phone"
    ],
    "tryit": "Check the private address from a phone on your tailnet.",
    "notes": "The remote listener binds to the Tailscale address, not the public internet. It requires login and serves HTTPS. The phone browser has responsive navigation, chat-history drawers and notifications in the October 14 development snapshot. PWA and push behavior depend on the browser and permission settings. Kairos still runs on the host computer; this is not an independently running native iOS app or offline device-sync system.",
    "image": "mobile",
    "section": "Access",
    "kind": "phone",
    "demo": [
      "Settings > Remote Access",
      "Tailscale + login + HTTPS",
      "Open private URL on phone"
    ]
  },
  {
    "title": "Review permissions",
    "where": "Settings > Permissions and agent limits",
    "steps": [
      "Settings > Permissions",
      "Read requested tool and scope",
      "Allow only the intended access"
    ],
    "tryit": "Review permissions after completing your first workflow.",
    "notes": "Kairos has app-wide remembered permissions plus agent/task workspace limits and review flows. Automatic agent approvals apply only within configured limits and do not mean every action is harmless. Optional accounts use password hashing and support TOTP two-factor sign-in, with an admin/non-admin split. Use authentication for access beyond localhost. Stored app credentials are encrypted, while model CLIs manage their own sign-in stores.",
    "image": null,
    "section": "Control",
    "kind": "form",
    "demo": [
      "Settings > Permissions",
      "Read requested tool and scope",
      "Allow only the intended access"
    ]
  },
  {
    "title": "Back up app data and notes",
    "where": "Settings > Backup",
    "steps": [
      "Settings > Backup > export",
      "Choose credential inclusion",
      "Back up vault folder separately"
    ],
    "tryit": "Create a backup before a major configuration change.",
    "notes": "The app backup covers chats, notes, agents and settings. Encrypted credentials and their encryption key are omitted unless you choose to include them. Treat an archive containing both as sensitive. Restore keeps a safety copy of replaced data. Logs and checkpoint history are excluded, and vault notes need a separate backup. On Windows, the app retains the existing %APPDATA%/JARVIS/data location through the Kairos rename.",
    "image": null,
    "section": "Control",
    "kind": "files",
    "demo": [
      "Settings > Backup > export",
      "Choose credential inclusion",
      "Back up vault folder separately"
    ]
  },
  {
    "title": "Arrange your workspace",
    "where": "Settings > Appearance, Layout and Shortcuts",
    "steps": [
      "Settings > Layout",
      "Choose tabs and Home cards",
      "Set appearance and shortcuts"
    ],
    "tryit": "Keep your most-used tabs visible and hide one you do not need.",
    "notes": "Home includes recent chats, projects, upcoming events, connected systems and activity. Layout settings control visible tabs and Home cards; supported tabs can add their own cards. The app remembers sidebar and chat-history layout independently. Appearance includes custom halftone pictures. Settings lists shortcuts for features such as Quick Entry and the command palette. A usage overlay/notch on Windows can show Claude/Codex limits.",
    "image": null,
    "section": "Control",
    "kind": "home",
    "demo": [
      "Settings > Layout",
      "Choose tabs and Home cards",
      "Set appearance and shortcuts"
    ]
  },
  {
    "title": "Find why a job failed",
    "where": "Setup checks and run history",
    "steps": [
      "No reply? Check /setup",
      "No action? Check run and scope",
      "No delivery? Check channel"
    ],
    "tryit": "Reproduce the problem with a small, non-sensitive request.",
    "notes": "Use /setup to reopen the model guide and retry a failed connection. Check provider usage limits, account sign-in and the model selected for the chat. For file work, inspect the workspace folder. For computer use, verify Docker and feature enablement. For scheduled work, check that Kairos and its host are running. For Google or email, verify the intended account and connection. Read the actual error before repeating a potentially consequential action.",
    "image": null,
    "section": "Practice",
    "kind": "list",
    "demo": [
      "No reply? Check /setup",
      "No action? Check run and scope",
      "No delivery? Check channel"
    ]
  },
  {
    "title": "Practice a complete workflow",
    "where": "A first complete workflow",
    "steps": [
      "Project + brief.md",
      "Draft > artifact > comment",
      "Assign a bot a narrow review"
    ],
    "tryit": "Use sample material, then inspect the artifact and run history.",
    "notes": "Suggested exercise: create a practice project, attach a short brief, ask for a meeting agenda, open the generated file and comment on one sentence. Then assign a narrow review to a named bot. Inspect its thread, Work tab and memory. Only after the manual run works should you consider a routine. No external sending or publishing is needed for the exercise.",
    "image": null,
    "section": "Practice",
    "kind": "flow",
    "demo": [
      "Project + brief.md",
      "Draft > artifact > comment",
      "Assign a bot a narrow review"
    ]
  },
  {
    "title": "Start with one useful job",
    "where": "kairos-agents.com",
    "steps": [
      "Choose your model",
      "Bring the right context",
      "Review and keep the result"
    ],
    "tryit": "Start with your next real task.",
    "notes": "Reference: the public website, README.md at dev commit 5563c2b, current static frontend and synthetic demo fixtures, and the Agents 2.0 build notes. Development features shown here may differ from the public installer. For details, open the project README and relevant Settings pages. This guide is editable source, with presenter notes for every slide.",
    "image": null,
    "section": "Practice",
    "kind": "home",
    "demo": [
      "Choose your model",
      "Bring the right context",
      "Review and keep the result"
    ]
  }
];
