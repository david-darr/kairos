"""The person's approval of a long video's shot plan before it renders (Video Styles build spec, unit 4).

A long video (one in chapters, core/video_store.chapter_spans) takes many minutes of the machine to render, so its shot
plan goes to the person first: each chapter with its shots, what is on screen and the narration line, with measured
times once video_narrate has run. Only the person approves (routes/video_routes.py); no model tool does. Shorts and
other videos without chapters keep today's flow.

The approval belongs to the plan as it was approved: a hash of everything the plan says (title, look, voice, chapters,
each shot's kind, words, line, scene, camera and transition, the cast and the style pack), not of the measured lengths, so
narrating again does not undo it but a changed line or a new chapter does. Stored beside the project as plan.json.
"""
from __future__ import annotations

import hashlib
import json
import time

from core import video_narration, video_store
from core.atomic_io import read_json, write_json_atomic

STATES = ("awaiting_approval", "approved", "rejected")
_MEASURED = {"spoken", "seconds"}


def plan_hash(project) -> str:
    body = {"title": project["title"], "look": project["look"], "narration": project.get("narration"),
            "chapters": project.get("chapters") or [], "cast": project.get("cast") or [], "palette": project.get("palette"),
            "style_pack": project.get("style_pack"), "aspects": project["aspects"],
            "beats": [{k: v for k, v in b.items() if k not in _MEASURED} for b in project["beats"]]}
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:24]


def _clock(t):
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def plan_text(project) -> str:
    """The shot plan with a chapter heading over each chapter's shots."""
    text = video_narration.plan_text(project)
    if not video_store.chaptered(project):
        return text
    lines = text.split("\n")
    head, shots = lines[0], lines[1:]
    out = [head + f" {len(project['chapters'])} chapters."]
    for n, span in enumerate(video_store.chapter_spans(project), 1):
        out.append(f"Chapter {n} at {_clock(span['start'])}: {span['title']} ({span['end'] - span['start']:.0f} s)")
        out += ["  " + line for line in shots[span["first"]:span["last"]]]
    return "\n".join(out)


def _path(video_id):
    return video_store._folder(video_id) / "plan.json"


def record(video_id) -> dict:
    data = read_json(str(_path(video_id)), None)
    return data if isinstance(data, dict) and data.get("status") in STATES else {}


def state(project) -> dict:
    """{status, ...}: none (never sent), awaiting_approval, approved or rejected for the plan as it is now, or changed
    (a plan was sent or approved, then the video changed, so it needs the person again)."""
    data = record(project["id"])
    if not data:
        return {"status": "none"}
    if data.get("hash") != plan_hash(project):
        return {**data, "status": "changed", "was": data["status"]}
    return data


def submit(video_id, by: str, post_id=None) -> dict:
    """Send the plan as it is now to the person. A plan already approved as it is stays approved."""
    project = video_store.get(video_id)
    if not video_store.chaptered(project):
        raise ValueError("chapters: only a long video in chapters needs its plan approved; render a Short as it is.")
    current = state(project)
    if current["status"] == "approved":
        return current
    with video_store._lock("video:" + video_id):
        data = {"status": "awaiting_approval", "hash": plan_hash(project), "version": project["version"],
                "text": plan_text(project)[:60000], "seconds": round(video_store.duration(project), 1),
                "chapters": [{"title": s["title"], "start": round(s["start"], 2)} for s in video_store.chapter_spans(project)],
                "submitted_by": str(by or "")[:80], "submitted_at": time.time(), "post_id": post_id}
        write_json_atomic(str(_path(video_id)), data)
    return data


def decide(video_id, approve: bool, by: str, reason: str = "") -> dict:
    """The person's decision on the plan as it is now (person routes only). Approving a plan that was never sent, or
    that changed since, approves what the person is looking at: the current plan."""
    project = video_store.get(video_id)
    if not video_store.chaptered(project):
        raise ValueError("chapters: this video has no chapters, so it has no plan to approve.")
    with video_store._lock("video:" + video_id):
        old = record(video_id)
        data = {**old, "status": "approved" if approve else "rejected", "hash": plan_hash(project), "version": project["version"],
                "text": plan_text(project)[:60000], "seconds": round(video_store.duration(project), 1),
                "chapters": [{"title": s["title"], "start": round(s["start"], 2)} for s in video_store.chapter_spans(project)],
                "decided_by": str(by or "")[:80], "decided_at": time.time(), "reason": str(reason or "")[:500]}
        write_json_atomic(str(_path(video_id)), data)
    return data


def problems(project) -> list[str]:
    """Why a long video cannot render yet: its plan is not approved as it is now."""
    if not video_store.chaptered(project):
        return []
    current = state(project)
    if current["status"] == "approved":
        return []
    why = {"none": "has not been sent to the person", "awaiting_approval": "is waiting for the person",
           "rejected": "was rejected" + (f" ({current.get('reason')})" if current.get("reason") else ""),
           "changed": "changed after it was " + ("approved" if current.get("was") == "approved" else "sent")}[current["status"]]
    return [f"The shot plan of this long video {why}. A long video renders only after the person approves its plan: "
            "send it with video_submit_plan (or content_studio_submit_plan for a team post), or approve it in Studio."]


def waiting() -> list[dict]:
    """This account's long videos whose plan waits for the person, newest first."""
    out = []
    for project in video_store._list():
        if not video_store.chaptered(project):
            continue
        current = state(project)
        if current["status"] == "awaiting_approval":
            out.append({"video_id": project["id"], "title": project["title"], **{k: current.get(k) for k in (
                "text", "seconds", "chapters", "submitted_by", "submitted_at", "post_id", "version")}})
    return out


def notify(project, data) -> bool:
    """An item in the person's Inbox, as the Content Studio Producer (when the account has the team)."""
    try:
        from services.content_studio import delivery, studio
        minutes = round(data.get("seconds", 0) / 60, 1)
        return delivery._send(studio, f"Long video plan to approve: {project['title']}",
                              f"\"{project['title']}\" ({minutes:g} minutes, {len(data.get('chapters') or [])} chapters) has a shot plan "
                              "waiting. Read it and approve or reject it in Studio > Content > Approvals. It renders only after you approve it.",
                              False, None)
    except Exception:
        return False
