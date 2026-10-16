from fastapi import FastAPI
from .agents import Planner, run_tool

app = FastAPI()

@app.post("/ask")
def ask(question: str):
    plan = Planner().plan(question)
    if plan.needs_tool:
        return run_tool(plan.tool, question)
    return plan.answer

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app)
