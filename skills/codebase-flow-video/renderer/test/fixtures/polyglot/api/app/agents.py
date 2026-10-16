import openai

class Planner:
    def plan(self, question):
        reply = openai.chat.completions.create(model="gpt", messages=[question])
        return self.parse(reply)

    def parse(self, reply):
        return reply

def run_tool(name, question):
    match name:
        case "search":
            return search(question)
        case _:
            return None

def search(q):
    return [q]
