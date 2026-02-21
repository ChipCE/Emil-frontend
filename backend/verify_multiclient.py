import requests
import uuid
import time
import sys

BASE_URL = "http://localhost:8000/api"

def test_multiclient():
    client_a = str(uuid.uuid4())
    client_b = str(uuid.uuid4())
    
    print(f"Client A: {client_a}")
    print(f"Client B: {client_b}")
    
    # 1. Register clients (by polling or status update)
    # We'll poll queue to 'register' them
    requests.get(f"{BASE_URL}/queue", params={"client_id": client_a})
    requests.get(f"{BASE_URL}/queue", params={"client_id": client_b})
    
    # Check status
    status = requests.get(f"{BASE_URL}/status").json()
    print("Initial Status:", status)
    if client_a not in status["clients"] or client_b not in status["clients"]:
        print("FAIL: Clients not registered")
        return False
        
    # 2. Target Client A
    print("\n--- Testing Targeted Command (A) ---")
    requests.post(f"{BASE_URL}/applyProfile", json={"profile": "test_a", "client_id": client_a})
    
    # Poll A
    q_a = requests.get(f"{BASE_URL}/queue", params={"client_id": client_a}).json()
    # Poll B
    q_b = requests.get(f"{BASE_URL}/queue", params={"client_id": client_b}).json()
    
    print(f"Queue A: {q_a}")
    print(f"Queue B: {q_b}")
    
    if q_a and q_a.get("payload", {}).get("profile") == "test_a":
        print("PASS: Client A received command")
    else:
        print("FAIL: Client A did not receive command")
        return False
        
    if q_b is None:
        print("PASS: Client B did not receive command")
    else:
        print("FAIL: Client B received command intended for A")
        return False

    # 3. Broadcast
    print("\n--- Testing Broadcast Command ---")
    requests.post(f"{BASE_URL}/applyProfile", json={"profile": "test_broadcast"})
    
    q_a = requests.get(f"{BASE_URL}/queue", params={"client_id": client_a}).json()
    q_b = requests.get(f"{BASE_URL}/queue", params={"client_id": client_b}).json()
    
    print(f"Queue A: {q_a}")
    print(f"Queue B: {q_b}")
    
    if q_a and q_a.get("payload", {}).get("profile") == "test_broadcast":
        print("PASS: Client A received broadcast")
    else:
        print("FAIL: Client A missed broadcast")
        return False
        
    if q_b and q_b.get("payload", {}).get("profile") == "test_broadcast":
        print("PASS: Client B received broadcast")
    else:
        print("FAIL: Client B missed broadcast")
        return False

    print("\nAll Tests Passed!")
    return True

if __name__ == "__main__":
    try:
        if test_multiclient():
            sys.exit(0)
        else:
            sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
