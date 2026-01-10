from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import redis
import json

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://192.168.178.128:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Redis connection
r = redis.Redis(host="localhost", port=6379, decode_responses=True)

TTL_SECONDS = 24 * 60 * 60  # 24h

class KeyUpdate(BaseModel):
    receiver_pub: str
    sender_pub: str
    new_sender_pub: str

@app.post("/update")
def post_update(data: KeyUpdate):
    key = f"pending:{data.receiver_pub}"

    # Push to list
    r.rpush(key, json.dumps(data.dict()))

    # Reset TTL mỗi lần có dữ liệu mới
    r.expire(key, TTL_SECONDS)

    return {"status": "stored"}

@app.get("/fetch")
def fetch_updates(pub: str):
    key = f"pending:{pub}"

    if not r.exists(key):
        return []

    pipe = r.pipeline()
    pipe.lrange(key, 0, -1)
    pipe.delete(key)
    results, _ = pipe.execute()

    return [json.loads(item) for item in results]

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=52000)