import json
import urllib.request

# Test evaluation endpoint through shim (:56401) -> AI API (:56400)
req_body = json.dumps({
    "messages": [
        {"role": "user", "content": "Open P1 Plant"},
        {
            "role": "assistant",
            "content": "",
            "function_call": {
                "name": "navigate_to_comos_object_by_name",
                "arguments": '{"objectName": "P1 Plant"}'
            }
        },
        {
            "role": "function",
            "name": "navigate_to_comos_object_by_name",
            "content": "Navigated to P1 Plant successfully."
        }
    ],
    "model": "serviceipid-gateway",
    "sessionId": "test-eval"
}).encode()

print("=== Testing /evaluation through SHIM (56401) ===")
try:
    r = urllib.request.Request(
        "http://localhost:56401/api/ai/v1/completions/evaluation",
        data=req_body,
        headers={"Content-Type": "application/json"}
    )
    resp = urllib.request.urlopen(r)
    data = json.loads(resp.read().decode())
    print(json.dumps(data, indent=2))
except Exception as e:
    print(f"Error: {e}")

print()
print("=== Testing /evaluation directly on AI API (56400) ===")
try:
    r2 = urllib.request.Request(
        "http://localhost:56400/api/ai/v1/completions/evaluation",
        data=req_body,
        headers={"Content-Type": "application/json"}
    )
    resp2 = urllib.request.urlopen(r2)
    data2 = json.loads(resp2.read().decode())
    print(json.dumps(data2, indent=2))
except Exception as e:
    print(f"Error: {e}")

print()
print("=== Testing /completions directly on AI API (56400) ===")
# Also test the main completions endpoint on the native AI API
req_chat = json.dumps({
    "messages": [
        {"role": "user", "content": "Hello"}
    ],
    "tools": [],
    "model": "serviceipid-gateway",
    "sessionId": "test-chat-native"
}).encode()

try:
    r3 = urllib.request.Request(
        "http://localhost:56400/api/ai/v1/completions",
        data=req_chat,
        headers={"Content-Type": "application/json"}
    )
    resp3 = urllib.request.urlopen(r3)
    data3 = json.loads(resp3.read().decode())
    print(json.dumps(data3, indent=2))
except Exception as e:
    print(f"Error: {e}")
