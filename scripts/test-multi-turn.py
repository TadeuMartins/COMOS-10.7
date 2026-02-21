#!/usr/bin/env python3
"""Test multi-turn conversation with echoed adapted responses (PascalCase aliases).
Simulates what COMOS desktop actually sends after a previous tool-calling round."""

import urllib.request, json, sys

SHIM = "http://localhost:56401"

def post(url, data):
    req = urllib.request.Request(url, json.dumps(data).encode(), {"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=45)
        return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"HTTP {e.code}: {body[:500]}")
        sys.exit(1)

# ─── Simulate what COMOS sends on the SECOND tool call ───
# The history contains the first round's adapted response (with all aliases)
# plus the evaluation result, then a new user message.
print("=" * 60)
print("TEST: Multi-turn /completions with echoed adapted history")
print("=" * 60)

multi_turn_payload = {
    "model": "serviceipid-gateway",
    "sessionId": "multi-turn-test",
    "messages": [
        {"role": "system", "content": "You are COMOS AI assistant."},
        {"role": "user", "content": "Navigate to P1 Plant"},
        # COMOS echoes back the full adapted response from round 1:
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call_old_123", "type": "function", "function": {"name": "navigate_to_comos_object_by_name", "arguments": "{\"objectName\":\"P1 Plant\"}"}}],
            "toolCalls": [{"id": "call_old_123", "type": "function", "function": {"name": "navigate_to_comos_object_by_name", "arguments": "{\"objectName\":\"P1 Plant\"}"}}],
            "function_call": {"name": "navigate_to_comos_object_by_name", "arguments": "{\"objectName\":\"P1 Plant\"}"},
            "FunctionCall": {"name": "navigate_to_comos_object_by_name", "arguments": "{\"objectName\":\"P1 Plant\"}"},
            "Content": "",
            "Role": "assistant"
        },
        # COMOS's tool result (role: "function" in COMOS format)
        {"role": "function", "name": "navigate_to_comos_object_by_name", "content": "Successfully navigated to P1 Plant."},
        # The eval result from round 1
        {
            "role": "assistant",
            "content": "Done! I navigated to P1 Plant.",
            "toolCalls": None,
            "Role": "assistant",
            "Content": "Done! I navigated to P1 Plant."
        },
        # New user message (round 2)
        {"role": "user", "content": "Now open the report for P1 Plant"}
    ],
    "tools": [
        {"type": "function", "function": {"name": "navigate_to_comos_object_by_name", "parameters": {"type": "object", "properties": {"objectName": {"type": "string"}}, "required": ["objectName"], "additionalProperties": False}}},
        {"type": "function", "function": {"name": "open_report", "parameters": {"type": "object", "properties": {"reportName": {"type": "string"}}, "required": ["reportName"], "additionalProperties": False}}}
    ]
}

r1 = post(f"{SHIM}/api/ai/v1/completions", multi_turn_payload)
print(json.dumps(r1, indent=2, ensure_ascii=False)[:1000])
fr = r1["choices"][0].get("finish_reason", "?")
msg = r1["choices"][0]["message"]
print(f"\nfinish_reason: {fr}")
print(f"has function_call: {bool(msg.get('function_call'))}")
print(f"has tool_calls: {bool(msg.get('tool_calls'))}")
if msg.get("content"):
    print(f"content: {msg['content'][:200]}")

# If we got a tool call, test the evaluation too
if fr == "function_call" and msg.get("function_call"):
    print("\n" + "=" * 60)
    print("TEST: Evaluation after multi-turn /completions")
    print("=" * 60)
    
    # Build eval payload including the new tool call + result
    eval_messages = multi_turn_payload["messages"] + [
        msg,  # The adapted assistant response
        {"role": "function", "name": msg["function_call"]["name"], "content": "Report opened successfully."}
    ]
    eval_payload = {
        "model": "serviceipid-gateway",
        "sessionId": "multi-turn-test",
        "messages": eval_messages,
        "tools": multi_turn_payload["tools"]
    }
    r2 = post(f"{SHIM}/api/ai/v1/completions/evaluation", eval_payload)
    msg2 = r2["choices"][0]["message"]
    print(f"finish_reason: {r2['choices'][0].get('finish_reason')}")
    print(f"content: {(msg2.get('content') or '')[:200]}")

print("\n" + "=" * 60)
print("SUCCESS!")
print("=" * 60)
