#!/usr/bin/env python3
"""Test with the EXACT payload that COMOS desktop sends.
Reproduces the real bug: assistant message stripped of tool_calls."""

import urllib.request, json, sys

SHIM = "http://localhost:56401"

def post(url, data):
    req = urllib.request.Request(url, json.dumps(data).encode(), {"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"HTTP {e.code}: {body[:800]}")
        sys.exit(1)

# COMOS tools (abbreviated — 2 tools for testing)
TOOLS = [
    {"function":{"name":"navigate_to_comos_object_by_name","description":"Locate the first COMOS object with the given name","parameters":{"type":"object","required":["objectName"],"properties":{"objectName":{"type":"string","description":"Exact name of the Comos object"}},"additionalProperties":False}},"type":"function"},
    {"function":{"name":"open_report","description":"Open the Comos report document","parameters":{"type":"object","required":[],"properties":{"objectName":{"type":"string","description":"Name of the report document"}},"additionalProperties":False},"strict":True},"type":"function"},
]

# ── The EXACT payload COMOS sends on the 3rd request ──────────────
# After: hello → Hi! → navigate to P001 → tool executed → user says more
# COMOS STRIPS tool_calls from the assistant message!
payload = {
    "messages": [
        {"content":"hello","role":"user"},
        {"content":"Hi! How can I help you in COMOS today?","role":"assistant"},
        {"content":"navigate to P001","role":"user"},
        # ↓ NAKED assistant — COMOS stripped all tool_calls/function_call fields!
        {"content":"","role":"assistant"},
        # ↓ Tool result with PascalCase toolCallId (COMOS format)
        {"content":"{ success = True, ComosObject = System.__ComObject, objectNameOrLabel = P001, SystemUID = A3BQHN7NAR, SystemType = 8, message = Navigated to the object }","role":"tool","toolCallId":"call_QJtPKmsQiLY9YouTz2qhX9ge"},
        # ↓ New user message
        {"content":"open p001 pump","role":"user"}
    ],
    "tools": TOOLS,
    "seed": 0
}

print("=" * 60)
print("TEST: Exact COMOS payload with stripped assistant + tool")
print("  messages[3] = naked assistant (no tool_calls)")
print("  messages[4] = tool result (toolCallId only)")
print("=" * 60)
print()

r = post(f"{SHIM}/api/ai/v1/completions", payload)
msg = r["choices"][0]["message"]
fr = r["choices"][0].get("finish_reason", "?")

print(f"Status: OK")
print(f"finish_reason: {fr}")
if msg.get("function_call"):
    print(f"function_call: {msg['function_call']['name']}({msg['function_call']['arguments']})")
if msg.get("content"):
    print(f"content: {msg['content'][:200]}")

print()
print("=" * 60)
print("SUCCESS! Orphan tool message was healed.")
print("=" * 60)
