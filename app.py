# app.py — slim orchestrator (Odysseus-style: wiring only, no business logic here)
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# A backup chosen in Settings is swapped in here, before any module below
# reads the data folder (core/backup.py, roadmap phase 8). Most services load
# their files when imported.
from core import backup as _backup
_RESTORED = _backup.apply_pending_restore()

from core.constants import STATIC_DIR
from core.middleware import SecurityHeadersMiddleware
from core import custom_tabs, tab_hooks, image_gen, remote_access, task_scheduler, vault_sync
from core.builtin_tasks import autoenable_builtins, migrate_builtin_schedules
from services.store_catalog import start_watch as start_store_watch, stop_watch as stop_store_watch
from core.channels import discord_channel
from core.connectors import hub as connector_hub
from routes import (
    auth_routes,
    chat_routes,
    session_routes,
    skills_routes,
    notes_routes,
    task_routes,
    calendar_routes,
    email_routes,
    settings_routes,
    model_routes,
    model_setup_routes,
    speech_routes,
    call_routes,
    workspace_routes,
    forge_routes,
    system_routes,
    store_routes,
    integrations_routes,
    creative_routes, addon_routes,
    google_routes,
    channels_routes,
    document_routes,
    vault_routes,
    cookbook_routes,
    remote_routes,
    project_routes,
    swarm_routes,
    permission_routes,
    sandbox_routes,
    checkpoint_routes,
    agent_routes,
    connector_routes,
    computer_routes,
    trigger_routes,
    hook_routes,
    tool_routes,
    run_routes,
    notification_routes,
)
from routes import cli_routes  # Kairos CLI terminal pairing (core/cli_access.py)
from routes import design_routes  # The Design canvas (vault: Design Canvas (Build Spec))
from core import llamacpp_engine
from services import chat_service, mobile_notifications, skills_service, swarm_service

from core import logs as log_files  # installs the chat/task tag on every record

logging.basicConfig(level=logging.INFO, format=log_files.LOG_FORMAT)

# Also log to files in the data directory. In a packaged install the backend
# is a child process of Electron and its output goes to Electron's own stdout
# — i.e. nowhere a user or a support session can see it. Diagnosing anything
# meant reproducing it outside the app (which is exactly what the 2026-09-03
# remote-access investigation had to do). Rotating, capped, and in the data
# directory so it survives updates and never grows unbounded; readable in
# Settings > Admin > Logs (core/logs.py).
try:
    from core.constants import DATA_DIR

    log_files.setup(os.path.join(DATA_DIR, "logs"))
except Exception:  # never let logging setup stop the app from booting
    logging.getLogger(__name__).exception("couldn't set up file logging")


class _ProactorResetNoiseFilter(logging.Filter):
    """Drop a specific, non-actionable asyncio traceback on Windows.

    Every local HTTP call (Ollama polling especially) tears down its
    connection afterwards, and Windows' Proactor event loop raises
    ConnectionResetError [WinError 10054] inside
    _ProactorBasePipeTransport._call_connection_lost while doing so. The
    request itself has already succeeded — this fires purely on cleanup —
    but asyncio logs it at ERROR with a full traceback, dozens of times a
    session. David spotted it in the logs and reasonably read it as a real
    fault (2026-09-03); worse, the volume buries errors that do matter.

    Scoped as tightly as possible so it can never hide a genuine problem:
    only records from the asyncio logger, only when the exception really is
    a ConnectionResetError, and only from that one transport callback.
    Anything else — including any other ConnectionResetError — still logs.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name != "asyncio":
            return True
        exc = record.exc_info[1] if record.exc_info else None
        if not isinstance(exc, ConnectionResetError):
            return True
        return "_call_connection_lost" not in str(record.getMessage())


logging.getLogger("asyncio").addFilter(_ProactorResetNoiseFilter())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    from services import agent_calls

    # Replaces the deprecated @app.on_event("startup"/"shutdown") pair —
    # FastAPI's own docs mark those deprecated in favor of this single
    # context manager; identical behavior, one modern mechanism.
    # Vault <-> Notes reconciliation before anything reads Notes (David's ask
    # 2026-09-03: the app reported "no priorities" while the connected vault
    # was full of them). See core/vault_sync.py.
    from core import tool_access
    tool_access.sweep_screens()
    vault_sync.sync_on_startup()
    if _RESTORED:  # a backup swapped in before the imports (core/backup.py)
        from core import events
        if _RESTORED.get("ok"):
            events.emit("backup.restored", f"Restored from a backup; the data before it is kept at {_RESTORED['safety_copy']}.")
        else:
            events.emit("backup.restore_failed", f"Restoring a backup failed and nothing changed: {_RESTORED.get('error')}",
                        level="error")
    # Bundled skills (build-custom-tab, humanizer) copied into the user's
    # skills folder on first run — data/ isn't packaged, so they can only
    # arrive from skill_templates/. Per-slug once-only; see the function.
    skills_service.seed_default_skills()
    from core import addons
    addons.migrate()
    if addons.enabled('roblox'):
        custom_tabs.mount_one(_app, 'roblox')
    # Moves already-enabled built-ins onto a wall-clock schedule when their
    # definition gained one (the Daily Brief, 2026-09-04). Without this, the
    # new 6am default would only ever apply to people who enable it AFTER
    # updating — anyone already running it would keep the drifting interval
    # forever, which is precisely the group the fix is for.
    migrate_builtin_schedules()
    # Switches on automations that are meant to just run (daily sync, email
    # triage). Once per install — see autoenable_builtins() for why it can't
    # resurrect something the user turned off.
    autoenable_builtins()
    await tab_hooks.reconcile()
    # Turns off pulled community installs (services/store_catalog.py).
    start_store_watch()
    from services import background_tasks; background_tasks.start()
    # Bot conversations: reconcile uncertain dispatches and restart waiting queues.
    from services import bot_chat_service; await bot_chat_service.startup()
    from services import bot_skill_library
    bot_skill_library.migrate_global()
    from routes import bot_memory_routes
    from services import bot_memory_upkeep
    async def tidy_notebook(bot_id):
        return await bot_memory_upkeep.tidy(bot_id, force=True) or {"passes": []}
    bot_memory_routes.tidy_runner = tidy_notebook
    from core import bot_app_events
    bot_app_events.start()
    # Bots Phases 4-6: rooms mark cut-off turns and resume their queues, incidents listen for failed turns,
    # the front desk exists and keeps its watch, warm caches and run-detail pruning run in the background.
    from services import bot_rooms, bot_incidents, front_desk, bot_keep_warm, bot_sweeps
    from core import front_desk_tick
    await bot_rooms.startup()
    bot_incidents.start()
    try:
        front_desk.ensure()
    except Exception:
        logging.getLogger(__name__).exception("the front desk could not be set up; Bots home offers to bring it back")
    front_desk_tick.start()
    bot_keep_warm.start()
    bot_sweeps.start()
    from services import bot_cards, bot_automation_changes, chat_live
    def publish_bot_resource(packet):
        record = packet.get("card") or packet.get("receipt") or {}
        thread = record.get("thread_id")
        if thread:
            chat_live.broadcast_owner({**packet, "sessionId": thread})
    remove_card_listener = bot_cards.store().add_listener(publish_bot_resource)
    bot_automation_changes.store().add_listener(publish_bot_resource)
    task_scheduler.start()
    # Tool-result search text for old chats: batched in a daemon thread so it never holds the
    # store lock against startup (core/session_manager_store.py).
    from core import session_manager_store; session_manager_store.start_background_migration()
    await discord_channel.start()
    # Every other messaging platform (core/connectors), each supervised so a
    # bad token or an outage is a status in Settings, not a failed boot.
    await connector_hub.start_all()
    # Restores the remote listener across restarts if the user turned it on
    # (core/remote_access.py). Never raises — a machine that's dropped off
    # the tailnet must still boot normally.
    await remote_access.start_if_enabled()
    await swarm_service.startup(_app)
    try:
        # Startup after Swarm must share its cleanup boundary (2026-10-15).
        from core import mobile_activity
        mobile_activity.recover()
        mobile_notifications.start()
        from services import bot_push
        bot_push.start()
        await agent_calls.recover()
        yield
    finally:
        remove_card_listener()
        bot_automation_changes.store()._listeners.remove(publish_bot_resource)
        from services.forge_apps import forge_apps
        from services.forge_terminals import forge_terminals
        try:
            forge_apps.shutdown()
        finally:
            forge_terminals.shutdown()
        await stop_store_watch()
        try:
            await swarm_service.shutdown(_app)
        finally:
            from core import computer
            await computer.manager.close_all()
            await remote_access.stop()
            await agent_calls.shutdown()
            await background_tasks.stop()
            session_manager_store.stop_background_migration()
            task_scheduler.stop()
            bot_app_events.stop()
            await front_desk_tick.stop()
            bot_keep_warm.stop()
            bot_sweeps.stop()
            from services import bot_data
            bot_data.close_all()
            from core import bot_rooms_store
            bot_rooms_store.close()
            from services import bot_memory_upkeep, bot_turn_context
            await bot_memory_upkeep.shutdown()
            await bot_turn_context.shutdown()
            await discord_channel.stop()
            await connector_hub.stop_all()
            await tab_hooks.stop_all()
            from services import chat_live
            await chat_live.shutdown()
            await mobile_notifications.shutdown()
            await chat_service.shutdown()
            # Do not leave the built-in model process orphaned at shutdown.
            llamacpp_engine.stop()
            from core import speech_acceleration
            speech_acceleration.stop()


app = FastAPI(title="Kairos", lifespan=lifespan)

app.add_middleware(SecurityHeadersMiddleware)

app.include_router(auth_routes.router)
app.include_router(session_routes.router)
app.include_router(chat_routes.router)
from routes import background_task_routes; app.include_router(background_task_routes.router)
app.include_router(skills_routes.router)
app.include_router(notes_routes.router)
app.include_router(task_routes.router)
app.include_router(calendar_routes.router)
app.include_router(email_routes.router)
app.include_router(settings_routes.router)
app.include_router(model_routes.router)
app.include_router(model_setup_routes.router)
app.include_router(speech_routes.router)
app.include_router(call_routes.router)
app.include_router(workspace_routes.router)
app.include_router(forge_routes.router)
app.include_router(system_routes.router)
app.include_router(store_routes.router)
app.include_router(integrations_routes.router)
app.include_router(creative_routes.router)
app.include_router(addon_routes.router)
app.include_router(google_routes.router)
app.include_router(channels_routes.router)
app.include_router(document_routes.router)
app.include_router(vault_routes.router)
app.include_router(cookbook_routes.router)
app.include_router(remote_routes.router)
app.include_router(project_routes.router)
app.include_router(swarm_routes.router)
app.include_router(permission_routes.router)
from routes import notch_routes; app.include_router(notch_routes.router)
app.include_router(sandbox_routes.router)
app.include_router(checkpoint_routes.router)
# Bots Phase 1 routers (conversations at /api/bot-chat, attention at /api/bot-attention), declared
# before the generic /api/agents routes; /api/notifications stays device enrollment.
from routes import bot_chat_routes, bot_attention_routes
app.include_router(bot_chat_routes.router)
app.include_router(bot_attention_routes.router)
# A missing optional Bots module leaves its UI's visible recovery in place.
from importlib import import_module as _bots_import_module
for _bots_extra_name in ("routes.bot_voice_routes", "routes.bot_onboarding_routes"):
    try:
        _bots_extra = _bots_import_module(_bots_extra_name)
    except ModuleNotFoundError as _bots_missing:
        if _bots_missing.name != _bots_extra_name:
            raise
    else:
        app.include_router(_bots_extra.router)
# Bots Phase 2 resources (memory, skills, grants, connections) beneath /api/bots, one aggregate router.
from routes import bot_resources_routes; app.include_router(bot_resources_routes.router)
from routes import bot_teams_routes; app.include_router(bot_teams_routes.router)
# Bots Phase 5 front desk and Phase 6 workbench, data, widgets, usage and lifecycle: each mounted once.
from routes import (front_desk_routes, front_desk_make_routes, front_desk_watch_routes, front_desk_work_routes,
                    bot_data_routes, bot_widget_routes, bot_workbench_routes, bot_usage_routes, bot_lifecycle_routes)
for _bots_router in (front_desk_routes, front_desk_make_routes, front_desk_watch_routes, front_desk_work_routes,
                     bot_data_routes, bot_widget_routes, bot_workbench_routes, bot_usage_routes, bot_lifecycle_routes):
    app.include_router(_bots_router.router)
app.include_router(agent_routes.router)
app.include_router(computer_routes.router)
app.include_router(connector_routes.router)
app.include_router(trigger_routes.router)
app.include_router(hook_routes.router)
app.include_router(tool_routes.router)
app.include_router(run_routes.router)
app.include_router(notification_routes.router)
app.include_router(cli_routes.router)
app.include_router(cli_routes.files_router)
app.include_router(design_routes.router)
app.include_router(design_routes.systems_router)
app.include_router(design_routes.render_router)

# Developer Mode (David's ask 2026-09-01) — the only app.py edit a custom
# tab ever needs. Eligible folder tabs and approved legacy routes get
# mounted; adding a tab is purely new files, see core/custom_tabs.py.
# Tabs the user builds live in the data directory so app updates can't wipe
# them (David's ask 2026-09-03). migrate_user_tabs() relocates any created by
# an older build, before discovery runs.
custom_tabs.migrate_user_tabs()
custom_tabs.mount_all(app)
app.include_router(system_routes.custom_views_router)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
# User-built tab views use a guarded route that verifies the approved source
# fingerprint before returning JavaScript (routes/system_routes.py).
# Generated images (David's ask 2026-09-10 — image generation for chat and
# Discord). StaticFiles needs the directory to exist before mounting, same
# reason custom_tabs.ensure_user_tab_dirs() runs before its own mount above.
os.makedirs(image_gen.GENERATED_DIR, exist_ok=True)
app.mount(image_gen.GENERATED_URL_PREFIX, StaticFiles(directory=image_gen.GENERATED_DIR), name="generated-images")
# Generated Office/PDF files (David's ask 2026-09-10, same session — a
# pptx/docx/xlsx/pdf a skill builds locally via Bash, not an image pulled
# from a URL). See core/image_gen.py's GENERATED_FILES_DIR comment.
os.makedirs(image_gen.GENERATED_FILES_DIR, exist_ok=True)
app.mount(image_gen.GENERATED_FILES_URL_PREFIX, StaticFiles(directory=image_gen.GENERATED_FILES_DIR), name="generated-files")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(f"{STATIC_DIR}/index.html")


@app.get("/sw.js")
async def service_worker() -> FileResponse:
    return FileResponse(f"{STATIC_DIR}/sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store", "Service-Worker-Allowed": "/"})


@app.get("/usage-overlay")
async def usage_overlay_page() -> FileResponse:
    # The path has no .html suffix, so the middleware's no-store rule misses it;
    # a cached copy kept the retired edge handles on screen after an update.
    return FileResponse(f"{STATIC_DIR}/usage-overlay.html", headers={"Cache-Control": "no-store"})


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


