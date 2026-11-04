"""Admin image connection routes share the avatar's saved key and daily spending limit."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core import image_providers
from core.middleware import require_admin

router = APIRouter(prefix="/api/image-provider", dependencies=[Depends(require_admin)])


class ImageProviderBody(BaseModel):
    kind: Optional[str] = Field(None, max_length=30)
    key: Optional[str] = Field(None, max_length=400)
    base_url: Optional[str] = Field(None, max_length=2000)
    model: Optional[str] = Field(None, max_length=120)
    daily_limit: Optional[int] = None


@router.get("")
async def state():
    return image_providers.provider_state()


@router.put("")
async def save(body: ImageProviderBody):
    try:
        if body.key is None:
            if body.daily_limit is None or body.kind is not None or body.base_url is not None or body.model is not None:
                raise ValueError("Paste the connection's key to change the image server.")
            if not image_providers.provider_state()["configured"]:
                raise ValueError("Save an image connection before setting its daily limit.")
            image_providers.set_daily_limit(body.daily_limit)
            return image_providers.provider_state()
        return image_providers.save_provider(body.kind, body.key, body.base_url, body.model, body.daily_limit)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.delete("")
async def clear():
    return image_providers.clear_provider()


@router.post("/test")
async def test():
    return await image_providers.test()
