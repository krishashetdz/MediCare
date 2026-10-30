"""Preview bridge only. MediVault's original Express API remains authoritative."""
import os
from pathlib import Path
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from starlette.responses import Response

load_dotenv(Path(__file__).parent / '.env')
UPSTREAM = os.environ['MEDIVAULT_UPSTREAM']
app = FastAPI()

@app.api_route('/api/{path:path}', methods=['GET','POST','PUT','PATCH','DELETE','OPTIONS'])
async def bridge(path: str, request: Request):
    headers = {k:v for k,v in request.headers.items() if k.lower() not in {'host','content-length'}}
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.request(request.method, UPSTREAM + '/api/' + path,
            params=request.query_params, content=await request.body(), headers=headers)
    result = Response(response.content, status_code=response.status_code)
    for key,value in response.headers.multi_items():
        if key.lower() not in {'content-length','transfer-encoding','connection','content-encoding'}:
            result.headers.append(key,value)
    return result