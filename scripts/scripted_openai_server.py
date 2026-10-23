"""Test fixture: deterministic OpenAI-compatible replies for live question checks."""
import argparse
import json

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
import uvicorn

app = FastAPI()
QUESTIONS = [
    {"question": "Which layout should the dashboard use?", "header": "Layout", "options": [
        {"label": "Two columns", "description": "Side by side panels"},
        {"label": "Single column", "description": "One scrolling stack"},
        {"label": "Tabs", "description": "Switch between panels"}]},
    {"question": "Which widgets should be on it?", "header": "Widgets", "multiSelect": True,
     "options": [{"label": label} for label in ("Calendar", "Tasks", "Weather")]},
]


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": "scripted-local", "object": "model", "owned_by": "test"}]}


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    last = body["messages"][-1]
    message = {"role": "assistant", "content": "Thanks. " + str(last.get("content", ""))}
    if last["role"] == "user":
        message = {"role": "assistant", "content": None, "tool_calls": [
            {"id": "scripted-ask", "type": "function", "function": {
                "name": "ask_user", "arguments": json.dumps({"questions": QUESTIONS})}}]}
    finish = "tool_calls" if "tool_calls" in message else "stop"
    base = {"id": "scripted", "model": body.get("model", "scripted-local"), "created": 0}
    if body.get("stream"):
        delta = dict(message)
        if "tool_calls" in delta:
            delta["tool_calls"] = [{"index": 0, **delta["tool_calls"][0]}]
        async def events():
            yield "data: " + json.dumps({**base, "object": "chat.completion.chunk", "choices": [
                {"index": 0, "delta": delta, "finish_reason": None}]}) + "\n\n"
            yield "data: " + json.dumps({**base, "object": "chat.completion.chunk", "choices": [
                {"index": 0, "delta": {}, "finish_reason": finish}]}) + "\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(events(), media_type="text/event-stream")
    return {**base, "object": "chat.completion", "choices": [
        {"index": 0, "message": message, "finish_reason": finish}]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
