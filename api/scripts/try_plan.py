"""Run the planning loop (Gemini on Vertex AI) on a fixture brief, without Firestore. Usage: python scripts/try_plan.py brief.json out.json"""
import asyncio, json, sys, time, logging
from dotenv import load_dotenv
load_dotenv("../.env")
sys.path.insert(0, ".")
from app.agents import architect
from app.compliance import lda

logging.basicConfig(level=logging.INFO); logging.getLogger("httpx").setLevel(logging.WARNING)


async def main():
    brief = json.load(open(sys.argv[1]))
    t0 = time.time()
    async for ev, data in architect.make_plan({"id": "local", "brief": brief}):
        if ev == "stage":
            print(f"[{time.time()-t0:5.0f}s] {data['message']}", flush=True)
        elif ev == "compliance":
            print(f"        {lda.status_line(data['report'])}", flush=True)
        elif ev == "_result":
            json.dump(data["plan"], open(sys.argv[2], "w"), indent=1)
            print("history", data["history"])
    print(f"done in {time.time()-t0:.0f}s")

asyncio.run(main())
