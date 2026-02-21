import json
import urllib.request

def post_json(url, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read().decode())

print("=" * 60)
print("STEP 1: Send 'Open P1 Plant' through shim")
print("=" * 60)
step1 = post_json("http://localhost:56401/api/ai/v1/completions", {
    "messages": [
        {"content": "Hello", "role": "user"},
        {"content": "Hello! How can I help you?", "role": "assistant"},
        {"content": "Open the P1 Plant", "role": "user"}
    ],
    "tools": [
        {"type": "function", "function": {"name": "navigate_to_comos_object_by_name", "description": "Locate object", "parameters": {"type": "object", "required": ["objectName"], "properties": {"objectName": {"type": "string"}}, "additionalProperties": False}, "strict": True}},
        {"type": "function", "function": {"name": "open_report", "description": "Open report", "parameters": {"type": "object", "required": [], "properties": {"objectName": {"type": "string"}}, "additionalProperties": False}, "strict": True}}
    ],
    "model": "serviceipid-gateway",
    "seed": 0
})

print(json.dumps(step1, indent=2))
choice = step1["choices"][0]
msg = choice["message"]
print(f"\nfinish_reason: {choice.get('finish_reason')}")
print(f"has function_call: {'function_call' in msg}")
print(f"has tool_calls: {'tool_calls' in msg}")

if "function_call" not in msg:
    print("\nERROR: No function_call in response!")
    exit(1)

fc = msg["function_call"]
print(f"\nfunction_call: {json.dumps(fc)}")

print()
print("=" * 60)
print("STEP 2: Send tool result to /evaluation (simulating COMOS client)")
print("=" * 60)

# COMOS client sends the conversation with the tool result
step2 = post_json("http://localhost:56401/api/ai/v1/completions/evaluation", {
    "messages": [
        {"role": "user", "content": "Open the P1 Plant"},
        {
            "role": "assistant",
            "content": "",
            "function_call": fc
        },
        {
            "role": "function",
            "name": fc["name"],
            "content": "Successfully navigated to P1 Plant in COMOS navigator."
        }
    ],
    "tools": [
        {"type": "function", "function": {"name": "navigate_to_comos_object_by_name", "description": "Locate object", "parameters": {"type": "object", "required": ["objectName"], "properties": {"objectName": {"type": "string"}}, "additionalProperties": False}, "strict": True}},
        {"type": "function", "function": {"name": "open_report", "description": "Open report", "parameters": {"type": "object", "required": [], "properties": {"objectName": {"type": "string"}}, "additionalProperties": False}, "strict": True}}
    ],
    "model": "serviceipid-gateway",
    "sessionId": "test-full-flow"
})

print(json.dumps(step2, indent=2))
choice2 = step2["choices"][0]
msg2 = choice2["message"]
print(f"\nfinish_reason: {choice2.get('finish_reason')}")
print(f"content: {msg2.get('content', '')[:200]}")
print(f"has function_call: {'function_call' in msg2}")
print(f"has tool_calls: {'tool_calls' in msg2}")

print()
print("=" * 60)
print("SUCCESS! Full tool-calling flow works!")
print("=" * 60)
