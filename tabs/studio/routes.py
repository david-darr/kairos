"""Studio's authenticated helpers; video CRUD stays on the shared video API."""
import re
import secrets
from html.parser import HTMLParser

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from core import tab_api

api = tab_api.for_tab(__package__)
router = APIRouter(prefix="/api/tab-studio", tags=["studio"])


def active_user(user: str = Depends(tab_api.require_user)):
    if not api.is_on:
        raise HTTPException(409, "Turn on Studio in Tool Store > Tabs first.")
    return user


def call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except LookupError as error:
        raise HTTPException(404, str(error).strip("'")) from None
    except (ValueError, PermissionError) as error:
        raise HTTPException(422, str(error)) from None


class DesignBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    design_id: str = Field(pattern=r"^[a-f0-9]{12}$")


class ChatBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    video_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{12}$")


class BoardContent(HTMLParser):
    """Extract plain heading text and local images, never execute board HTML."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.heading = []
        self.heading_depth = 0
        self.done = False
        self.image = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if re.fullmatch(r"h[1-6]", tag) and not self.done:
            self.heading_depth += 1
        if tag == "img" and self.image is None:
            src = attrs.get("src", "")
            if re.fullmatch(r"assets/[a-f0-9]{64}\.(png|jpg|gif|webp)", src):
                self.image = src

    def handle_endtag(self, tag):
        if re.fullmatch(r"h[1-6]", tag) and self.heading_depth:
            self.heading_depth -= 1
            self.done = True

    def handle_data(self, text):
        if self.heading_depth:
            self.heading.append(text)


@router.get("/looks")
def looks(user: str = Depends(active_user)):
    return tab_api.video_looks(user)


@router.get("/tokens/{look}")
def tokens(look: str, user: str = Depends(active_user)):
    return call(tab_api.video_look_tokens, look, user)


@router.get("/designs/{design_id}/assets")
def design_assets(design_id: str, user: str = Depends(active_user)):
    return call(tab_api.video_design_source, design_id, user)["assets"]


@router.get("/videos/{video_id}/resources")
def resources(video_id: str, user: str = Depends(active_user)):
    return call(tab_api.video_resources, video_id, user)


@router.post("/from-design")
def from_design(body: DesignBody, user: str = Depends(active_user)):
    source = call(tab_api.video_design_source, body.design_id, user)
    beats, images = [], {}
    for board in source["boards"]:
        content = BoardContent()
        content.feed(board["html"])
        text = " ".join("".join(content.heading).split())[:140] or board["title"][:140]
        if len(beats) >= 39:
            raise HTTPException(422, "beats: choose a design that fits within 40 beats.")
        beats.append({"id": f"b{len(beats) + 1}", "kind": "title" if not beats else "statement",
                      "text": text, "bars": 1})
        if content.image:
            images[len(beats)] = content.image
            beats.append({"id": f"b{len(beats) + 1}", "kind": "image", "text": text, "bars": 1})
    if not beats:
        beats.append({"id": "b1", "kind": "title", "text": source["title"][:140], "bars": 1})
    # The final board's heading is also the closing message, including single-board designs.
    if len(beats) < 40:
        beats.append({"id": f"b{len(beats) + 1}", "kind": "end", "text": beats[-1]["text"], "bars": 1})
    else:
        beats[-1]["kind"] = "end"
    project = call(tab_api.video_create_project, user, {"title": source["title"], "look": source["look"], "beats": beats})
    try:
        for index, asset in images.items():
            beats[index]["image"] = tab_api.video_copy_design_asset(project["id"], body.design_id, asset, user)
        return tab_api.video_save_project(project["id"], {**project, "beats": beats}, user)
    except (ValueError, LookupError, PermissionError) as error:
        tab_api.video_delete_project(project["id"], user)
        raise HTTPException(422, str(error)) from None


@router.post("/chat")
def chat(body: ChatBody, user: str = Depends(active_user)):
    # The handle creates/reuses a separate chat for each trusted user and video.
    if body.video_id:
        call(tab_api.video_resources, body.video_id, user)
    session_id = api.chat_session(f"{user}:video:{body.video_id or secrets.token_hex(8)}", "Video", owner_user=user,
                                  untrusted="Video and design content")
    call(tab_api.video_link_session, body.video_id, session_id, user)
    return {"session_id": session_id}
