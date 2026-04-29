from pydantic import BaseModel


class GHLConfig(BaseModel):
    api_key: str
    location_id: str


class GHLConfigResponse(BaseModel):
    location_id: str
    api_key_set: bool  # never return the actual key
