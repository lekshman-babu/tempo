import os
import anthropic

    
def load_prompt(file_path):
    with open(file_path) as f:
        return f.read()

async def get_coach_response(session_json: str) -> str:
    """Call OpenAI and return the full response."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return "Coach is offline. Add ANTHROPIC_API_KEY to your .env file."

    print("key is read")
    client = anthropic.AsyncAnthropic(api_key=api_key)
    message = await client.messages.create(
        model       = "claude-haiku-4-5-20251001",
        max_tokens  = 1024,
        temperature = 0.7,
        system      = load_prompt("prompt/system_prompt.txt"),
        messages    = [
            {
                "role": "user",
                "content": load_prompt('prompt/user_message_template.txt').format(session_json=session_json)
            }
        ]
    )
    return message.content[0].text